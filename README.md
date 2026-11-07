# Bot Host

Apne PC par multiple Telegram bots (Node.js + Python) Docker containers mein host karo.

## Setup (ek baar)

1. **Docker Desktop** install karo (Windows/Mac) ya Docker Engine (Linux) aur usse start karo.
2. **Node.js 18+** install karo.
3. Is folder mein:
   ```
   npm install
   npm start
   ```
4. Browser mein kholo: **http://localhost:4000**

## Bot deploy karna

- **Node.js bot:** `index.js` + `package.json` upload karo
- **Python bot:** `bot.py` + `requirements.txt` upload karo
- Ya apne project ki ek `.zip` upload karo (subfolders wale bots ke liye)
- Token jaisi cheezein "Environment variables" mein likho, e.g. `BOT_TOKEN=123:ABC`
  aur code mein `process.env.BOT_TOKEN` / `os.environ["BOT_TOKEN"]` se padho.

Dependencies apne aap install hoti hain. Agar `package.json` / `requirements.txt` badlo
(Update files), to restart par dobara install hoti hain, warna skip (fast start).

## Kya automatic hai

| Cheez | Kaise |
|---|---|
| Crash par restart | Docker `--restart unless-stopped` |
| PC reboot ke baad bots wapas chalu | Docker daemon boot par containers start karta hai |
| Dashboard band ho jaye tab bhi bots chalte rahein | Bots dashboard se alag, Docker mein chalte hain |
| Har bot alag | Alag container, 512 MB RAM / 1 CPU limit (`BOT_MEMORY`, `BOT_CPUS`) |
| Logs | Dashboard mein live, size-capped (5 MB x 3) |

## Screen off / internet ke baare mein

- **Screen off** theek hai, lekin PC **sleep** nahi hona chahiye. Power settings mein
  "Sleep: Never" karo (laptop mein lid close par bhi "Do nothing").
- **Internet:** Host aur containers bina internet ke chalte rahte hain, lekin Telegram bot ko
  Telegram se baat karne ke liye internet chahiye. Net jaane par bot idle rehta hai,
  aur wapas aate hi library khud reconnect kar leti hai (agar code crash kare to Docker restart karega).
  Pehli deploy par internet zaroori hai (Docker image + dependencies download hongi);
  uske baad restart offline bhi ho jata hai.

## Dashboard khud boot par chalu karna (optional)

Bots to Docker se wapas aa jate hain. Dashboard ko bhi auto-start karna ho:
```
npm install -g pm2
pm2 start server.js --name bothost
pm2 save && pm2 startup
```
(Windows par Task Scheduler mein "At log on" par `node server.js` bhi chalega.)

## Phone se dashboard kholna (same Wi-Fi)

```
HOST=0.0.0.0 DASHBOARD_PASSWORD=apna-password npm start
```
Windows PowerShell: `$env:HOST="0.0.0.0"; $env:DASHBOARD_PASSWORD="apna-password"; npm start`

Phir phone par `http://<PC-ka-IP>:4000`. Password zaroor lagao, kyunki dashboard se code chalaya ja sakta hai.

## Settings (environment variables)

`PORT` (4000) • `HOST` (127.0.0.1) • `DASHBOARD_PASSWORD` • `DATA_DIR` • `BOT_MEMORY` (512m) • `BOT_CPUS` (1)
