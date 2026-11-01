# Putting Groco online (HTTPS, backups, phones)

Phones only allow GPS and background alerts on **https://** sites, and customers should never type passwords on plain http. You need HTTPS before real use.

## Option A: quick test on your own PC, with phones (free, 5 minutes)
Install Cloudflare Tunnel (`cloudflared`) or ngrok, then:
```
node server.js
cloudflared tunnel --url http://localhost:3000        # or:  ngrok http 3000
```
It prints an `https://....` address. Open `/`, `/staff.html` and `/admin.html` on that address from any phone. Set `TRUST_PROXY=1` in `.env`.

## Option B: real hosting
Any host that runs Node and gives you a **persistent disk** works (a small VPS from DigitalOcean / Hetzner / AWS Lightsail, or Render / Railway with a disk). Do not use hosting with a temporary disk: `groco.db`, `backups/` and `image/uploads/` would be wiped on every restart.

On a VPS (Ubuntu):
1. Install Node 20, copy the project, run `npm install --omit=dev`, `node setup-db.js --reset`.
2. Create `.env` from `.env.example` (set `JWT_SECRET`, `ADMIN_PASSWORD`, `TRUST_PROXY=1`, keys).
3. Keep it running: `npm i -g pm2 && pm2 start server.js --name groco && pm2 save && pm2 startup`.
4. HTTPS in front with Caddy (automatic free certificates). `/etc/caddy/Caddyfile`:
```
yourdomain.com {
    reverse_proxy localhost:3000
}
```
Point your domain's DNS A record to the server, `sudo systemctl reload caddy`. Done: `https://yourdomain.com`.

(If you prefer, set `SSL_KEY` and `SSL_CERT` to your certificate files and the app serves HTTPS itself.)

## Backups
* The app copies the database to `backups/` every day and keeps the newest 14.
* Download one regularly from **Admin > Settings & Backup** and store it off the server (Google Drive, another PC).
* To restore: stop the app, replace `groco.db` with a backup file (rename it to `groco.db`), start the app. Product photos live in `image/uploads/`, so copy that folder too.

## Before real customers
- Change the admin password and delete or change the demo picker/rider accounts.
- Set `JWT_SECRET` to a long random sentence.
- Test one full order: place, pay (Razorpay test keys), pick, pack, deliver, refund.
