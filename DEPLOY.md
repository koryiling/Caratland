# Deploying Caratland to your own server

Workflow: push to GitHub from your PC → pull + restart on the server.
Vercel deployment keeps working unchanged; the server uses `server.mjs`
instead of the Vercel function in `api/`.

## Every deploy (after one-time setup)

On your PC:

```sh
git add -A
git commit -m "your message"
git push origin main
```

On the server:

```sh
cd ~/Caratland && ./deploy.sh
```

That's it. `deploy.sh` pulls, installs deps, and restarts the app under pm2.

## One-time server setup

Assumes a fresh Ubuntu/Debian VPS. Adjust paths/user to taste.

1. **Install Node 22 and pm2**

   ```sh
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   sudo npm i -g pm2
   ```

2. **Clone the repo**

   ```sh
   git clone https://github.com/koryiling/Caratland.git ~/Caratland
   cd ~/Caratland
   chmod +x deploy.sh
   ```

3. **Create `.env`** (never commit it)

   ```sh
   cp .env.example .env
   nano .env
   ```

   - Keeping Supabase: paste the same `DATABASE_URL` you use on Vercel — done,
     your existing data carries over.
   - Local Postgres instead: install it, create a database, load the schema
     once (`psql < schema.postgres.sql` or `node scripts/load-schema.mjs`),
     set `DATABASE_URL` to it and add `DATABASE_SSL=disable`.

4. **First start**

   ```sh
   ./deploy.sh
   pm2 startup   # prints one sudo command — run it so the app survives reboots
   pm2 save
   ```

   The app now serves on port 3000 (change with `PORT` in `.env`).

5. **HTTPS / domain — put Caddy in front** (automatic TLS certificates)

   ```sh
   sudo apt-get install -y caddy
   ```

   `/etc/caddy/Caddyfile`:

   ```
   yourdomain.com {
       reverse_proxy localhost:3000
   }
   ```

   ```sh
   sudo systemctl reload caddy
   ```

   Point your domain's DNS A record at the server IP first.

## Useful commands on the server

```sh
pm2 logs caratland     # live logs
pm2 status             # is it running?
pm2 restart caratland  # manual restart
```
