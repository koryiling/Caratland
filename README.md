# onetwo — 大胃王 (replica)

Synchronized multiplayer animal-wheel game with betting, a Star Travel mini-game,
a chat room, gifting, top-ups, profiles, and an admin panel. Ported from the
`dww` project — **same app and layout, running on its own Supabase database.**

## Stack
- **Front-end:** static pages in `public/` (`index.html` game/wheel, `star.html`,
  `gifts.html`, `profile.html`, `buy.html`, `admin.html`, …), vanilla JS + a React
  (in-browser Babel) Star Travel game.
- **Back-end:** one Vercel serverless function `api/index.mjs` that adapts the
  Web-standard worker in `src/index.js` (routes, auth, wheel, settlement). A tiny
  D1-on-Postgres shim (`db/d1-on-postgres.mjs`) lets that worker talk to Supabase.
- **Database:** Supabase Postgres (transaction pooler, `prepare:false`).

## The wheel
- Rounds are derived from wall-clock time (60s betting + 5s draw), so every player
  is on the same round — no cron needed (`src/wheel.js`).
- Draws are provably fair: `HMAC(secret, round:N)`, reproducible and auditable.
- Settlement is lazy and idempotent — the next `/api/state` poll after a round
  ends pays winners exactly once.

## Stars & moons persist (onetwo change vs dww)
Star Travel's bought **stars** and **moons** are stored on the account
(`users.stars`, `users.moons`) via `/api/star-wallet/adjust`, so they no longer
disappear when you switch to the wheel or chat room — and are only spent when you
actually take a voyage. Won gold items already persist in the shared `inventory`
bag.

## Setup
1. Create a Supabase project; copy the **Transaction pooler** connection string.
2. Load the schema once: `node scripts/load-schema.mjs` (reads `DATABASE_URL`
   from `.env`, created by `vercel env pull .env`), or paste
   `schema.postgres.sql` into the Supabase SQL editor.
3. Environment variables (Vercel → Settings, and local `.env` — see `.env.example`):
   - `DATABASE_URL` — Supabase pooler string
   - `ADMIN_USER` — the username that becomes superadmin on first registration (`yue`)
   - `TZ_OFFSET_MINUTES` — leaderboard reset offset (`480` = UTC+8)
4. `npm install`, then `npm run dev` (vercel dev) locally, or push to deploy.

## Admin
The first account registered as `ADMIN_USER` (`yue`) becomes the superadmin —
manage users, top-ups, coins and permissions at `admin.html`.
