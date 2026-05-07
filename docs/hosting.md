# Mission Control - Mac Mini Hosting Guide

Follow these steps on your Mac mini to host the Mission Control Next.js server 24/7.

## Prerequisites
1. Ensure Node.js is installed on your Mac mini.
2. Clone or transfer this `mission-control` repository to the Mac mini.
3. Open Terminal in the project folder.

## 1. Install Dependencies & Build
Run the following commands to prepare the production build:
```bash
npm install
npm run build
```

## 2. Install PM2
PM2 is a robust process manager that will keep your Next.js app running in the background and automatically restart it if it crashes.
```bash
npm install -g pm2
```

## 3. Start the Server
Start the Next.js production server using PM2:
```bash
pm2 start npm --name "mission-control" -- run start
```
You can verify it's running by typing `pm2 status`.

## 4. Enable Auto-Start on Reboot
To ensure the server starts immediately when you turn on or reboot the Mac mini:
```bash
pm2 startup
```
*PM2 will output a command starting with `sudo env PATH...`. Copy and paste that entire command into your terminal and press Enter.*

Finally, save the current PM2 list so it remembers to start `mission-control`:
```bash
pm2 save
```

## 5. Google Pub/Sub Webhook Auth (OIDC)

The Gmail push-notification webhook at `/api/gmail/webhook` verifies a Google-issued OIDC JWT on every request. Pub/Sub signs the token with a configured service account; mission-control checks the signature against Google's JWKS, the issuer (`https://accounts.google.com`), and the audience (the route URL).

1. **Pick a service account** in your Google Cloud project (or create a new one — `pubsub-mc-publisher@<project>.iam.gserviceaccount.com` is a reasonable name). Grant it `roles/iam.serviceAccountTokenCreator` on itself if Pub/Sub doesn't already have permission to mint tokens for it.
2. **Configure the push subscription** (Cloud Console → Pub/Sub → your subscription → Edit):
   - Push endpoint: `https://mc.local/api/gmail/webhook` (or whatever your reverse-proxy URL is).
   - Enable authentication.
   - Service account: the one from step 1.
   - **Audience**: the same URL — `https://mc.local/api/gmail/webhook`. This is the value you'll set in mission-control's `PUBSUB_AUDIENCE` env var, and the two must match exactly.
3. **Set the env var** in your untracked `.env`:
   ```
   PUBSUB_AUDIENCE=https://mc.local/api/gmail/webhook
   ```
4. Restart the server (`./launch-ms.sh --restart`).

Without `PUBSUB_AUDIENCE` set the webhook returns 500. With it set, every request must include a valid OIDC JWT from the configured service account or it returns 401. The legacy `PUBSUB_WEBHOOK_SECRET` env var is no longer used — you can remove it from `.env`.

## 6. Service-Token Auth for Internal Callers (Pulsar, scheduler, etc.)

Routes like `/api/calendar/event` accept either an interactive NextAuth session (the dashboard) or a configured service token paired with `?onBehalfOf=<userId>`. This lets external services on your machine (Pulsar, the future scheduler process, agents) write to your calendar without an interactive cookie.

To enable Pulsar to call the calendar route on your behalf:

1. **Generate a token**: `openssl rand -hex 32`
2. **Find your user id**: open the Internal Systems dash → look at the Account card → the id is on the session, or query `prisma/prod.db`:
   ```bash
   sqlite3 prisma/prod.db "SELECT id FROM User LIMIT 1;"
   ```
3. **Add to `.env`**:
   ```
   SERVICE_TOKEN_PULSAR=<token from step 1>
   SERVICE_TOKEN_PULSAR_USER_ID=<user id from step 2>
   ```
4. **Pulsar side**: include `Authorization: Bearer <token>` and `?onBehalfOf=<userId>` on every calendar call.

If either env var is missing, the calendar route falls back to session-only auth (interactive dashboard still works). Anonymous callers get 401; valid token + missing or mismatched `onBehalfOf` gets 403.

## 7. Accessing the App (Windows & Mac)
Your server is now running on port `3101` (by default).
1. On your Mac mini, open `System Settings` -> `Network` to find its local IP address (e.g., `192.168.1.10`).
2. On your Windows PC (or any device on your Wi-Fi), open Chrome or Edge and navigate to:
   `http://[MAC_MINI_IP_ADDRESS]:3101`
3. Click the "Install App" icon in the address bar to install it as a standalone PWA!
