'use strict';

/**
 * Bot Host - runs each uploaded Telegram bot (Node.js or Python) in its own
 * Docker container. Containers use `--restart unless-stopped`, so Docker itself
 * restarts a bot after a crash and brings it back after a reboot, even while
 * this dashboard is closed.
 */

const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || '127.0.0.1'; // set HOST=0.0.0.0 to open from phone on same Wi-Fi
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const BOTS_DIR = path.join(DATA_DIR, 'bots');
const MEMORY = process.env.BOT_MEMORY || '512m';
const CPUS = process.env.BOT_CPUS || '1';
const PREFIX = 'bothost-';
const IMAGES = { node: 'node:20-slim', python: 'python:3.12-slim' };
const ENTRY = { node: 'index.js', python: 'bot.py' };

// Accept common spellings/cases so "Requirments.txt" or "Bot.py" still work.
const CANONICAL_NAMES = {
  'index.js': 'index.js',
  'package.json': 'package.json',
  'package-lock.json': 'package-lock.json',
  'bot.py': 'bot.py',
  'requirements.txt': 'requirements.txt',
  'requirments.txt': 'requirements.txt',
  'requirement.txt': 'requirements.txt',
};

fs.mkdirSync(BOTS_DIR, { recursive: true });

/* ------------------------------ helpers ------------------------------ */

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function cleanErr(e) {
  const raw = String((e && (e.stderr || e.message)) || e || 'Unknown error').trim();
  return raw.split('\n').filter(Boolean).slice(-3).join(' ');
}

function docker(args, { timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'bot';

function sanitizeEnv(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
    .join('\n');
}

const botDir = (id) => path.join(BOTS_DIR, id);
const appDirOf = (id) => path.join(botDir(id), 'app');
const containerName = (id) => PREFIX + id;

async function loadBot(id) {
  if (!/^[a-z0-9-]+$/.test(id)) throw httpError(400, 'Bad bot id');
  try {
    return JSON.parse(await fsp.readFile(path.join(botDir(id), 'meta.json'), 'utf8'));
  } catch {
    throw httpError(404, 'Bot not found');
  }
}

const saveBot = (bot) => fsp.writeFile(path.join(botDir(bot.id), 'meta.json'), JSON.stringify(bot, null, 2));

async function listBots() {
  const ids = await fsp.readdir(BOTS_DIR).catch(() => []);
  const bots = [];
  for (const id of ids) {
    try {
      bots.push(await loadBot(id));
    } catch {
      /* skip broken folders */
    }
  }
  return bots.sort((a, b) => a.createdAt - b.createdAt);
}

/* -------------------------- background jobs -------------------------- */
// Long operations (image download, install) run in the background; the UI polls.

const jobs = new Map();
const errors = new Map();

function runJob(id, label, fn) {
  if (jobs.has(id)) throw httpError(409, `Bot is busy: ${jobs.get(id)}`);
  jobs.set(id, label);
  errors.delete(id);
  fn()
    .catch((e) => errors.set(id, cleanErr(e)))
    .finally(() => jobs.delete(id));
}

/* ------------------------------ docker ------------------------------- */

async function inspect(id) {
  try {
    const { stdout } = await docker(
      ['inspect', '-f', '{{.State.Status}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.ExitCode}}', containerName(id)],
      { timeout: 15_000 }
    );
    const [status, startedAt, restarts, exitCode] = stdout.trim().split('|');
    return { status, startedAt, restarts: Number(restarts), exitCode: Number(exitCode) };
  } catch {
    return { status: 'not-created' };
  }
}

function buildCommand(type, appDir) {
  const has = (f) => fs.existsSync(path.join(appDir, f));
  let cmd = '';
  if (type === 'node') {
    if (has('package.json')) {
      cmd +=
        'H=$(md5sum package.json | cut -d" " -f1); ' +
        'if [ ! -d node_modules ] || [ "$(cat .deps_hash 2>/dev/null)" != "$H" ]; then ' +
        'echo "[bothost] installing dependencies..."; ' +
        'npm install --omit=dev --no-audit --no-fund && echo "$H" > .deps_hash || exit 1; fi; ';
    }
    cmd += 'echo "[bothost] starting bot"; exec node index.js';
  } else {
    if (has('requirements.txt')) {
      cmd +=
        'H=$(md5sum requirements.txt | cut -d" " -f1); ' +
        'if [ "$(cat .deps_hash 2>/dev/null)" != "$H" ]; then ' +
        'echo "[bothost] installing dependencies..."; ' +
        'pip install --no-cache-dir --disable-pip-version-check -r requirements.txt --target .deps ' +
        '&& echo "$H" > .deps_hash || exit 1; fi; ';
    }
    cmd += 'echo "[bothost] starting bot"; exec python -u bot.py';
  }
  return cmd;
}

async function createContainer(bot) {
  const name = containerName(bot.id);
  const appDir = appDirOf(bot.id);
  await docker(['rm', '-f', name]).catch(() => {});

  const envFile = path.join(botDir(bot.id), 'env.list');
  await fsp.writeFile(envFile, sanitizeEnv(bot.env) + '\n');

  const args = [
    'run', '-d',
    '--name', name,
    '--label', 'bothost=1',
    '--restart', 'unless-stopped', // auto-restart on crash + after reboot
    '--memory', MEMORY,
    '--cpus', CPUS,
    '--log-opt', 'max-size=5m',
    '--log-opt', 'max-file=3',
    '--env-file', envFile,
    '-e', 'PYTHONUNBUFFERED=1',
  ];
  if (bot.type === 'python') args.push('-e', 'PYTHONPATH=/app/.deps');
  args.push('-v', `${appDir}:/app`, '-w', '/app', IMAGES[bot.type], 'sh', '-c', buildCommand(bot.type, appDir));

  await docker(args, { timeout: 15 * 60_000 }); // first run may download the base image
}

/* ------------------------------ uploads ------------------------------ */

function extractZip(buf, appDir) {
  const zip = new AdmZip(buf);
  const norm = (e) => e.entryName.replace(/\\/g, '/').replace(/^\/+/, '');
  let entries = zip.getEntries().filter((e) => !e.isDirectory);

  const total = entries.reduce((n, e) => n + e.header.size, 0);
  if (total > 500 * 1024 * 1024) throw httpError(400, 'Zip is too large (500 MB max unpacked)');

  entries = entries.filter((e) => {
    const parts = norm(e).split('/');
    return !['node_modules', '.deps', '__pycache__', '.git', '__MACOSX'].some((x) => parts.includes(x));
  });

  const tops = new Set(entries.map((e) => norm(e).split('/')[0]));
  const hasRootFile = entries.some((e) => !norm(e).includes('/'));
  const stripTop = !hasRootFile && tops.size === 1; // zip made from a single folder

  for (const e of entries) {
    let rel = norm(e);
    if (stripTop) rel = rel.split('/').slice(1).join('/');
    const target = path.resolve(appDir, rel);
    if (!target.startsWith(appDir + path.sep)) continue; // block path traversal
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.getData());
  }
}

async function writeUploads(appDir, files) {
  await fsp.mkdir(appDir, { recursive: true });
  for (const f of files) {
    const name = path.basename(f.originalname || '');
    if (!name) continue;
    if (name.toLowerCase().endsWith('.zip')) extractZip(f.buffer, appDir);
    else await fsp.writeFile(path.join(appDir, name), f.buffer);
  }
  // normalise names like Bot.py / Requirments.txt
  for (const name of await fsp.readdir(appDir)) {
    const canon = CANONICAL_NAMES[name.toLowerCase()];
    if (canon && canon !== name) {
      await fsp.rename(path.join(appDir, name), path.join(appDir, canon));
    }
  }
}

function detectType(appDir) {
  if (fs.existsSync(path.join(appDir, 'index.js'))) return 'node';
  if (fs.existsSync(path.join(appDir, 'bot.py'))) return 'python';
  return null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 200 },
});

/* -------------------------------- app -------------------------------- */

const app = express();

if (PASSWORD) {
  const sha = (s) => crypto.createHash('sha256').update(s).digest();
  app.use((req, res, next) => {
    const h = req.headers.authorization || '';
    if (h.startsWith('Basic ')) {
      const given = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
      if (crypto.timingSafeEqual(sha(given), sha(PASSWORD))) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Bot Host"').status(401).send('Password required');
  });
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function describe(bot) {
  const st = await inspect(bot.id);
  return {
    id: bot.id,
    name: bot.name,
    type: bot.type,
    createdAt: bot.createdAt,
    ...st,
    busy: jobs.get(bot.id) || null,
    error: errors.get(bot.id) || null,
  };
}

app.get('/api/health', wrap(async (req, res) => {
  try {
    const { stdout } = await docker(['version', '--format', '{{.Server.Version}}'], { timeout: 10_000 });
    res.json({ docker: true, version: stdout.trim() });
  } catch (e) {
    res.json({ docker: false, error: cleanErr(e) });
  }
}));

app.get('/api/bots', wrap(async (req, res) => {
  const bots = await listBots();
  res.json(await Promise.all(bots.map(describe)));
}));

app.post('/api/bots', upload.array('files'), wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40) || 'bot';
  if (!req.files || !req.files.length) throw httpError(400, 'Please choose your bot files first');

  const id = `${slug(name)}-${crypto.randomBytes(2).toString('hex')}`;
  const dir = appDirOf(id);
  const cleanup = () => fsp.rm(botDir(id), { recursive: true, force: true });

  try {
    await writeUploads(dir, req.files);
  } catch (e) {
    await cleanup();
    throw e;
  }
  const type = detectType(dir);
  if (!type) {
    await cleanup();
    throw httpError(400, 'Could not find index.js (Node.js) or bot.py (Python) in the upload');
  }

  const bot = { id, name, type, env: sanitizeEnv(req.body.env), createdAt: Date.now() };
  await saveBot(bot);
  runJob(id, 'Creating container (first run downloads the image)...', () => createContainer(bot));
  res.status(202).json({ id });
}));

app.post('/api/bots/:id/files', upload.array('files'), wrap(async (req, res) => {
  const bot = await loadBot(req.params.id);
  if (!req.files || !req.files.length) throw httpError(400, 'Please choose files to upload');
  await writeUploads(appDirOf(bot.id), req.files);
  if (!fs.existsSync(path.join(appDirOf(bot.id), ENTRY[bot.type]))) {
    throw httpError(400, `${ENTRY[bot.type]} is missing after update`);
  }
  // Bot folder is mounted live; a restart picks up new code and re-installs deps if they changed.
  runJob(bot.id, 'Applying update...', async () => {
    const st = await inspect(bot.id);
    if (st.status === 'running' || st.status === 'restarting') {
      await docker(['restart', '-t', '10', containerName(bot.id)], { timeout: 60_000 });
    }
  });
  res.status(202).json({ ok: true });
}));

app.get('/api/bots/:id/env', wrap(async (req, res) => {
  const bot = await loadBot(req.params.id);
  res.json({ env: bot.env || '' });
}));

app.put('/api/bots/:id/env', wrap(async (req, res) => {
  const bot = await loadBot(req.params.id);
  bot.env = sanitizeEnv(req.body.env);
  await saveBot(bot);
  // env vars are fixed at container creation, so recreate it
  runJob(bot.id, 'Applying new settings...', () => createContainer(bot));
  res.status(202).json({ ok: true });
}));

app.post('/api/bots/:id/:action(start|stop|restart)', wrap(async (req, res) => {
  const bot = await loadBot(req.params.id);
  const name = containerName(bot.id);
  const action = req.params.action;

  runJob(bot.id, { start: 'Starting...', stop: 'Stopping...', restart: 'Restarting...' }[action], async () => {
    const st = await inspect(bot.id);
    if (action === 'stop') {
      if (st.status !== 'not-created') await docker(['stop', '-t', '10', name]);
    } else if (st.status === 'not-created') {
      await createContainer(bot);
    } else if (action === 'restart') {
      await docker(['restart', '-t', '10', name]);
    } else if (st.status !== 'running') {
      await docker(['start', name]);
    }
  });
  res.status(202).json({ ok: true });
}));

app.get('/api/bots/:id/logs', wrap(async (req, res) => {
  const bot = await loadBot(req.params.id);
  const tail = Math.min(Math.max(Number(req.query.tail) || 200, 1), 2000);
  try {
    const { stdout, stderr } = await docker(['logs', '--tail', String(tail), '--timestamps', containerName(bot.id)], {
      timeout: 20_000,
    });
    const lines = (stdout + stderr).split('\n').filter(Boolean);
    lines.sort((a, b) => (a.slice(0, 30) < b.slice(0, 30) ? -1 : a.slice(0, 30) > b.slice(0, 30) ? 1 : 0));
    res.json({ logs: lines.join('\n') });
  } catch {
    res.json({ logs: '' });
  }
}));

app.delete('/api/bots/:id', wrap(async (req, res) => {
  const bot = await loadBot(req.params.id);
  if (jobs.has(bot.id)) throw httpError(409, `Bot is busy: ${jobs.get(bot.id)}`);
  await docker(['rm', '-f', containerName(bot.id)]).catch(() => {});
  await fsp.rm(botDir(bot.id), { recursive: true, force: true });
  errors.delete(bot.id);
  res.json({ ok: true });
}));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  res.status(status).json({ error: cleanErr(err) });
});

app.listen(PORT, HOST, () => {
  console.log(`Bot Host running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (HOST === '0.0.0.0' && !PASSWORD) {
    console.log('WARNING: open to your network without a password. Set DASHBOARD_PASSWORD.');
  }
});
