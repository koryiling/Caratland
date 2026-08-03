// Standalone Node server for self-hosting (VPS/own server) — the counterpart
// of api/index.mjs, which is only used on Vercel. Serves the static files in
// public/ and hands every /api/* request to the same Web-standard worker in
// src/index.js. Run with: npm start  (see DEPLOY.md)

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import worker from './src/index.js';
import { makeD1 } from './db/d1-on-postgres.mjs';

// Load .env if present (pm2/systemd can also inject env directly).
try { process.loadEnvFile(); } catch {}

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public');

// --- Postgres pool (same settings as api/index.mjs) ---------------------
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set — copy .env.example to .env first.');
  process.exit(1);
}

const sql = postgres(url, {
  // Supabase's transaction pooler doesn't support prepared statements; also
  // harmless against a plain Postgres, so keep it off unconditionally.
  prepare: false,
  // Supabase requires TLS; a Postgres on the same box usually has none.
  // Set DATABASE_SSL=disable in .env when using a local database.
  ssl: process.env.DATABASE_SSL === 'disable' ? false : 'require',
  // Long-running process (unlike serverless): a small real pool is fine.
  max: 5,
  idle_timeout: 30,
  connect_timeout: 15,
  types: {
    // BIGINT epoch-ms columns → JS number (see api/index.mjs for why).
    int8: { to: 20, from: [20], serialize: (x) => String(x), parse: (x) => Number(x) },
    // NUMERIC aggregates → JS number, else "0" + "0" concatenates to "00".
    numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => Number(x) },
  },
});

const env = {
  DB: makeD1(sql),
  ADMIN_USER: process.env.ADMIN_USER,
  TZ_OFFSET_MINUTES: process.env.TZ_OFFSET_MINUTES,
};

// --- helpers ------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.jsx': 'text/babel; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// Node IncomingMessage -> Web Request (same conversion as api/index.mjs).
async function toWebRequest(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const target = `${proto}://${host}${req.url}`;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'content-length' || k === 'transfer-encoding' || k === 'connection') continue;
    if (Array.isArray(v)) v.forEach((val) => headers.append(k, val));
    else if (v != null) headers.set(k, v);
  }

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = chunks.length ? Buffer.concat(chunks) : undefined;
  }

  return new Request(target, { method: req.method, headers, body });
}

async function sendWebResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function serveStatic(res, pathname) {
  let file = decodeURIComponent(pathname);
  if (file === '/') file = '/index.html';
  // Resolve inside public/ only — reject traversal out of it.
  const full = normalize(join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }
  try {
    const data = await readFile(full);
    res.setHeader('Content-Type', MIME[extname(full).toLowerCase()] ?? 'application/octet-stream');
    if (extname(full) !== '.html') res.setHeader('Cache-Control', 'public, max-age=300');
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
}

// --- server -------------------------------------------------------------
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://x').pathname;
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const request = await toWebRequest(req);
      const response = await worker.fetch(request, env);
      return await sendWebResponse(res, response);
    }
    return await serveStatic(res, pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.statusCode = 500;
    res.end('Internal error');
  }
});

server.listen(PORT, () => {
  console.log(`Caratland listening on http://localhost:${PORT}`);
});

// Graceful shutdown so pm2 restarts don't drop in-flight requests.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => sql.end({ timeout: 5 }).then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
