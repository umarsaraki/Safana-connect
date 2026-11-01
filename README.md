# Safana Connect (Cloudflare)

Everything runs on Cloudflare's free plan: static site, Worker API, D1 database, R2 pictures, Durable Object for live chat.

## What works today
- `public/index.html` is the whole website. Opened as a file it runs as a **demo preview**: data stays in the browser only.
- Deployed with the Worker it gains real **registration, login, sessions, Account/Security settings, Chat Hub (public and private, realtime, lock/unlock, read status, block, report), picture uploads and Help & Support storage**.
- Posts, comments, follows, requests, projects and banners still save only in the browser. The tables exist in `schema.sql`; the API for them is the next step.

## Deploy
1. `npm install -g wrangler` then `wrangler login`.
2. `wrangler d1 create safana-connect` and copy the `database_id` into `wrangler.toml`.
3. `wrangler d1 execute safana-connect --remote --file=schema.sql`
4. `wrangler r2 bucket create safana-media` (Cloudflare may ask for a payment method before enabling R2 even though the free allowance is generous).
5. Put your Admin and Chairman emails in `wrangler.toml` under `[vars]`.
6. `wrangler deploy`
7. Open the site and **register the Admin account first** (using `ADMIN_EMAIL`), then the Chairman. A role is only given to the first account with that email.

## Security notes
- Passwords: PBKDF2-SHA256 (100,000 rounds), random salt. Sessions: random token, stored hashed, HttpOnly cookie, 30 days. Five wrong passwords lock the account for 15 minutes.
- Permissions are checked in `src/worker.js` for every request. Private chats are visible only to the two participants. Admin and Chairman have no route to read them. Reports share only the reported message.
- Help & Support is Admin only (the Chairman is excluded). The cron trigger deletes messages and pictures 24 hours after creation, within about a minute.
- Pictures are checked by content, limited to 3 MB, and served from R2 only to people allowed to see them.
- Email and phone verification need an email or SMS service. They are not set up yet.
- Live meetings need LiveKit credentials (`LIVEKIT_URL` in `index.html`).
- 
