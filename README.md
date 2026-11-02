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

## Updating a site that is already live
1. In the D1 Console run `migration.sql` once (adds likes boost, followers adjustment, video kind, shares and stories). If a line says "duplicate column", it was already applied.
2. Replace `public/index.html` and `src/worker.js` in GitHub with the new files. Cloudflare rebuilds on its own.
3. The R2 binding may be named `MEDIA` or `MEDIA_BUCKET`; the Worker accepts both.

## What now lives on the server
Posts (up to 5 pictures or one 30-second MP4), comments and replies, likes, shares, saves, follows, notifications, stories (24 hours), reels, people search, requests (resident -> Admin -> full form -> Chairman), projects, home banner, reports, Admin user/post management, support inbox, public and private chat with Seen ticks.
Still in the browser only: Settings lists for followers and follow requests, and live meetings.
