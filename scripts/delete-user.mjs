// Utility: delete a user and its dependent rows by username.
//   node scripts/delete-user.mjs <username>
// Reads DATABASE_URL from the environment or a local .env file.
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

function dbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const p = path.resolve(".env");
  if (fs.existsSync(p)) {
    const line = fs.readFileSync(p, "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
    if (line) return line.slice("DATABASE_URL=".length).replace(/^"|"$/g, "");
  }
  throw new Error("DATABASE_URL not found");
}

const username = process.argv[2];
if (!username) { console.error("usage: node scripts/delete-user.mjs <username>"); process.exit(1); }

const sql = postgres(dbUrl(), { prepare: false, ssl: "require", max: 1 });
try {
  const rows = await sql`select id from users where username_lower = ${username.toLowerCase()}`;
  if (!rows.length) { console.log("no such user:", username); }
  else {
    const id = rows[0].id;
    await sql`delete from sessions where user_id = ${id}`;
    await sql`delete from bets where user_id = ${id}`;
    await sql`delete from records where user_id = ${id}`;
    await sql`delete from topup_requests where user_id = ${id}`;
    await sql`delete from inventory where user_id = ${id}`;
    await sql`delete from star_wins where user_id = ${id}`;
    await sql`delete from users where id = ${id}`;
    console.log("deleted user", username, "(id", id + ")");
  }
  const n = await sql`select count(*)::int as n from users`;
  console.log("users remaining:", n[0].n);
} finally {
  await sql.end();
}
