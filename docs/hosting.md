# External-caller auth setup

> Process management (PM2 ecosystem, startup, restart, recovery) lives in `CLAUDE.md`. LAN access just works once PM2 is up — open `http://<mac-mini-ip>:3101`. This file only covers the two auth pieces external callers need to configure once: Google Pub/Sub's OIDC webhook signature and the service-token shape for headless callers (Pulsar, scheduler, agents).

## 1. Google Pub/Sub Webhook Auth (OIDC)

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
4. Restart the server (`pm2 restart mission-control`).

Without `PUBSUB_AUDIENCE` set the webhook returns 500. With it set, every request must include a valid OIDC JWT from the configured service account or it returns 401. The legacy `PUBSUB_WEBHOOK_SECRET` env var is no longer used — you can remove it from `.env`.

## 2. Service-Token Auth for Internal Callers (Pulsar, scheduler, etc.)

Routes like `/api/calendar/event` accept either an interactive NextAuth session (the dashboard) or a configured service token paired with `?onBehalfOf=<userId>`. This lets external services on your machine (Pulsar, the scheduler process, agents) write to your calendar without an interactive cookie.

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
