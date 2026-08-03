// One-off: load schema.postgres.sql into the database in DATABASE_URL.
//
// The onetwo DB briefly held a minimal `users` table (different shape, 0 rows)
// from the earlier auth prototype. If that leftover table is present (detected
// by the absence of a `coins` column), it is dropped so the real schema can
// create the full one. A `users` table that already has `coins` is left alone.
//
// Usage:  node scripts/load-schema.mjs
// Reads DATABASE_URL from the environment, or from a local .env file.

import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

function loadEnv() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.resolve(".env");
  if (fs.existsSync(envPath)) {
    const line = fs.readFileSync(envPath, "utf8")
      .split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
    if (line) return line.slice("DATABASE_URL=".length).replace(/^"|"$/g, "");
  }
  throw new Error("DATABASE_URL not found (env or .env)");
}

const sql = postgres(loadEnv(), { prepare: false, ssl: "require", max: 1 });

try {
  const hasCoins = await sql`
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'users' and column_name = 'coins'`;
  const usersExists = await sql`
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'users'`;

  if (usersExists.length && !hasCoins.length) {
    console.log("Dropping leftover minimal `users` table (wrong shape, no coins column)…");
    await sql.unsafe("DROP TABLE IF EXISTS users CASCADE").simple();
  }

  const schema = fs.readFileSync("schema.postgres.sql", "utf8");
  await sql.unsafe(schema).simple();

  const tables = await sql`
    select table_name from information_schema.tables
    where table_schema = 'public' order by table_name`;
  console.log("Tables now present:", tables.map((t) => t.table_name).join(", "));

  const cols = await sql`
    select column_name from information_schema.columns
    where table_name = 'users' and column_name in ('coins', 'stars', 'moons')
    order by column_name`;
  console.log("users money columns:", cols.map((c) => c.column_name).join(", "));
} finally {
  await sql.end();
}
