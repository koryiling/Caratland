// 大胃王 (replica) — Cloudflare Worker API.
// public/ is served by the edge; anything unmatched falls through to here.
//
// No process runs between requests. That's fine: the draw is a pure function
// of the round number, so a round's outcome exists whether or not anyone is
// watching. Settlement happens lazily on the next request that needs it.

import {
  animalById, CYCLE_MS, drawFor, isPlate, phaseAt,
  publicConfig, resolveWinners, roundIdAt,
} from './wheel.js';
import {
  hashPassword, newUserId, randomSecret, randomToken, verifyPassword,
} from './auth.js';

const STARTING_COINS = 100_000;
const MAX_RECORDS = 200;
const MAX_ROUNDS_PER_REQUEST = 20;   // keeps one request off the CPU limit

/* ---- helpers ---- */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const fail = (status, code, error) => json({ error, code }, status);

const ALL_PERMS = ['appeals', 'manual', 'password', 'users', 'admins', 'seats'];

const permsOf = (row) =>
  row.is_super ? ALL_PERMS : (row.perms ? row.perms.split(',').filter(Boolean) : []);

const hasPerm = (row, perm) => !!row.is_super || permsOf(row).includes(perm);

const AVATARS = ['🐰', '🐻', '🐱', '🐶', '🦊', '🐼', '🐨', '🐯', '🦁', '🐮',
  '🐷', '🐸', '🐵', '🐔', '🐧', '🦄', '🐙', '🦖', '🐳', '🦉'];

// Gift catalogue. The receiver keeps RECEIVER_SHARE of the cost.
const RECEIVER_SHARE = 0.7;
// Gift ladder — shared with the Star Travel prizes so values are consistent
// across the whole app.
// `img` is a PNG under public/gifts/ (named by cost). The client shows it when
// the file exists and falls back to the emoji otherwise, so a missing image
// never breaks the UI. Kept sorted by cost (the room grid renders in order).
const GIFTS = [
  { id: 'balloon', emoji: '🎈',  name: '气球',       cost: 266,    img: 'gifts/g266.png' },
  { id: 'bouquet', emoji: '💐',  name: '花束',       cost: 500,    img: 'gifts/g500.png' },
  { id: 'giftbox', emoji: '🎁',  name: '礼物盒',     cost: 1000,   img: 'gifts/g1000.png' },
  { id: 'yibubu',  emoji: '🌱',  name: '一布布',     cost: 1000,   img: 'gifts/g1000b.png' },
  { id: 'cupcake', emoji: '🧁',  name: '杯子蛋糕',   cost: 2500,   img: 'gifts/g2500.png' },
  { id: 'erbubu',  emoji: '🌙',  name: '二布布',     cost: 2500,   img: 'gifts/g2500b.png' },
  { id: 'love',    emoji: '💞',  name: '心动520',    cost: 5200,   img: 'gifts/g5200.png' },
  { id: 'star',    emoji: '⭐',  name: '星辰',       cost: 6600,   img: 'gifts/g6600.png' },
  { id: 'chest',   emoji: '🧰',  name: '皇家宝箱',   cost: 10000,  img: 'gifts/g10000.png' },
  { id: 'unicorn', emoji: '🦄',  name: '梦幻独角兽', cost: 28800,  img: 'gifts/g28800.png' },
  { id: 'trophy',  emoji: '🏆',  name: '荣耀奖杯',   cost: 33440,  img: 'gifts/g33440.png' },
  { id: 'car',     emoji: '🏎️', name: '梦幻跑车',   cost: 52000,  img: 'gifts/g52000.png' },
  { id: 'castle',  emoji: '🏰',  name: '梦幻城堡',   cost: 100000, img: 'gifts/g100000.png' },
  { id: 'ring',    emoji: '💍',  name: '永恒钻戒',   cost: 131400, img: 'gifts/g131400.png' },
  { id: 'cruiser', emoji: '🛸',  name: '梦幻星舰',   cost: 334400, img: 'gifts/g334400.png' },
];
const giftById = new Map(GIFTS.map((g) => [g.id, g]));

// Room-wide announcements by value: 5000+ announces (no frame), 6660–18800
// gets a silver frame, above 18800 a golden frame. Below 5000: no announce.
const ANNOUNCE_MIN = 5_000;
function frameTier(value) {
  if (value > 18_800) return 'gold';
  if (value >= 6_660) return 'silver';
  if (value >= ANNOUNCE_MIN) return 'none';
  return null;
}

// Game-win broadcasts (wheel + Star Travel): announce wins of 1w+ (10,000),
// silver frame at 1w, gold at 5w (50,000). Below 1w: no broadcast.
const GAME_ANNOUNCE = 10_000;
const gameTier = (value) => (value >= 50_000 ? 'gold' : value >= 10_000 ? 'silver' : null);

/* ---- Star Travel (server-authoritative) ----
   The client only renders: purchases, voyage rolls and wishing-pool rolls
   all happen here, so balances can never be spoofed by the browser.       */

const STAR_REWARDS = [
  { gold: 5, prob: 0.41903 }, { gold: 10, prob: 0.17053 }, { gold: 50, prob: 0.13155 },
  { gold: 100, prob: 0.19976 }, { gold: 166, prob: 0.05359 }, { gold: 266, prob: 0.01754 },
  { gold: 500, prob: 0.00633 }, { gold: 2500, prob: 0.00136 }, { gold: 5200, prob: 0.00031 },
];
const MOON_REWARDS = [
  { gold: 10, prob: 0.29488 }, { gold: 50, prob: 0.28012 }, { gold: 100, prob: 0.20149 },
  { gold: 266, prob: 0.14743 }, { gold: 500, prob: 0.05406 }, { gold: 1000, prob: 0.01573 },
  { gold: 2500, prob: 0.00452 }, { gold: 6600, prob: 0.00147 }, { gold: 28800, prob: 0.00026 },
  { gold: 52000, prob: 0.00007 },
];
const SUN_REWARDS = [
  { gold: 500, prob: 0.36637 }, { gold: 1000, prob: 0.36855 }, { gold: 2500, prob: 0.18210 },
  { gold: 5200, prob: 0.05094 }, { gold: 6600, prob: 0.02385 }, { gold: 28800, prob: 0.00455 },
  { gold: 33440, prob: 0.00228 }, { gold: 52000, prob: 0.00103 }, { gold: 131400, prob: 0.00027 },
  { gold: 334400, prob: 0.00006 },
];
const STAR_MODES = {
  star: { col: 'stars', rewards: STAR_REWARDS, packs: { 1: 100, 10: 1000, 30: 3000 }, errCode: 'not_enough_stars', errMsg: '星星不足' },
  moon: { col: 'moons', rewards: MOON_REWARDS, packs: { 1: 300, 10: 3000, 30: 9000 }, errCode: 'not_enough_moons', errMsg: '月亮不足' },
  sun: { col: 'suns', rewards: SUN_REWARDS, packs: { 1: 3000, 10: 30000, 30: 90000 }, errCode: 'not_enough_suns', errMsg: '太阳不足' },
};

// Prize catalog: gold value -> gift skin. Bag item_key is String(gold).
const STAR_GIFTS = {
  5: { emoji: '🐛', name: '小虫虫' }, 10: { emoji: '🍭', name: '棒棒糖' },
  50: { emoji: '🧦', name: '幸运袜' }, 100: { emoji: '🦆', name: '呱呱鸭' },
  166: { emoji: '🎀', name: '蝴蝶结' }, 266: { emoji: '🎈', name: '飘飘球' },
  500: { emoji: '🌮', name: '塔可君' }, 1000: { emoji: '🕹️', name: '游戏王' },
  2500: { emoji: '🍕', name: '披萨侠' }, 3000: { emoji: '🦖', name: '小恐龙' },
  5200: { emoji: '💌', name: '心动信' }, 6600: { emoji: '🪩', name: '迪斯科' },
  10000: { emoji: '🛼', name: '轮滑鞋' }, 13140: { emoji: '💘', name: '一生一世' },
  28800: { emoji: '🦄', name: '独角兽' }, 33440: { emoji: '🏆', name: '大奖杯' },
  52000: { emoji: '🏎️', name: '跑车君' }, 66660: { emoji: '🐉', name: '福气龙' },
  88000: { emoji: '🛥️', name: '土豪艇' }, 99900: { emoji: '🏰', name: '梦幻堡' },
  131400: { emoji: '💍', name: '钻戒王' }, 334400: { emoji: '🛸', name: '外星舰' },
};

const WISH_TARGETS = [3000, 5200, 10000, 13140, 28800, 52000, 66660, 88000, 99900, 131400];
const wishFullCost = (v) => Math.round((v * (6200 / 5200)) / 10) * 10;   // 100% needs target×~1.19

// Crypto-uniform [0, 1) — Math.random() is not for money.
function starRandom() {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
}
function starPick(rewards) {
  const r = starRandom();
  let acc = 0;
  for (const x of rewards) { acc += x.prob; if (r <= acc) return x.gold; }
  return rewards[rewards.length - 1].gold;
}

// Big star wins (10k+) broadcast to every room feed, same framing as the wheel.
async function starAnnounce(db, me, value, qty = 1) {
  const tier = gameTier(value);
  if (!tier) return;
  const skin = STAR_GIFTS[value];
  await db.prepare(
    `INSERT INTO chat (user_id, username, color, avatar, text, kind, at)
     VALUES (?, ?, ?, ?, ?, 'bcast', ?)`
  ).bind(me.id, me.username, me.color, me.avatar ?? '🐰',
    JSON.stringify({ type: 'star', winner: me.username, emoji: skin.emoji, name: skin.name, value, qty, tier }),
    Date.now()).run();
}

const publicUser = (row) => ({
  id: row.id,
  username: row.username,
  color: row.color,
  avatar: row.avatar ?? '🐰',
  bio: row.bio ?? '',
  seat: row.seat ?? null,
  birthday: row.birthday ?? null,
  coins: row.coins,
  stars: row.stars ?? 0,
  moons: row.moons ?? 0,
  suns: row.suns ?? 0,
  isAdmin: !!row.is_admin,
  isSuper: !!row.is_super,
  perms: permsOf(row),
});

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

// Append-only audit trail. Every money movement and access change goes
// through here so "who gave whom how much, and when" is always answerable.
function logAction(db, { action, actor, target, amount = null, detail = null }) {
  return db.prepare(
    `INSERT INTO audit_log
       (at, action, actor_id, actor_name, target_id, target_name, amount, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    Date.now(), action,
    actor?.id ?? null, actor?.username ?? null,
    target?.id ?? null, target?.username ?? null,
    amount, detail
  ).run();
}

// The draw secret never changes once minted. Cache it in module scope so
// /api/state (polled every second by every player) doesn't re-query it on
// every call — one fewer DB round-trip per poll, which matters under load.
let cachedSecret = null;
async function getSecret(db) {
  if (cachedSecret) return cachedSecret;

  const row = await db.prepare('SELECT value FROM meta WHERE key = ?').bind('secret').first();
  if (row) return (cachedSecret = row.value);

  // First ever call — mint the draw secret. INSERT OR IGNORE means a race
  // between two cold requests still ends with exactly one secret.
  const secret = randomSecret();
  await db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING')
    .bind('secret', secret).run();
  const stored = await db.prepare('SELECT value FROM meta WHERE key = ?').bind('secret').first();
  return (cachedSecret = stored.value);
}

async function userForToken(db, request) {
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  if (!token) return null;
  return db.prepare(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'
  ).bind(token).first();
}

async function startSession(db, userId) {
  const token = randomToken();
  await db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)')
    .bind(token, userId, Date.now()).run();
  return token;
}

/* ---- Settlement ----
   Idempotent by construction: the record id is "<round>-<user>", and the
   payout only applies while that record's `paid` flag is still 0. Two
   players triggering the same round concurrently cannot double-pay.        */

async function settleDueRounds(db, secret, currentRound) {
  // Settle whole rounds only: pick the oldest due rounds, then load each
  // round's bets in full. (A LIMIT over raw bet rows could split a round —
  // the final DELETE would then discard the unfetched bets unpaid.)
  const due = await db.prepare(
    'SELECT DISTINCT round_id FROM bets WHERE round_id < ? ORDER BY round_id LIMIT ?'
  ).bind(currentRound, MAX_ROUNDS_PER_REQUEST).all();

  if (!due.results?.length) return;

  const at = Date.now();

  for (const { round_id: roundId } of due.results) {
    const pending = await db.prepare(
      'SELECT user_id, animal_id, stake FROM bets WHERE round_id = ?'
    ).bind(roundId).all();

    const slips = new Map();
    for (const bet of pending.results ?? []) {
      const slip = slips.get(bet.user_id) ?? [];
      slip.push(bet);
      slips.set(bet.user_id, slip);
    }

    const spot = await drawFor(roundId, secret);
    const winnerIds = new Set(resolveWinners(spot).map((a) => a.id));
    const plate = isPlate(spot) ? 1 : 0;

    for (const [userId, bets] of slips) {
      const rows = bets.map((bet) => {
        const hit = winnerIds.has(bet.animal_id);
        return {
          animalId: bet.animal_id,
          stake: bet.stake,
          hit,
          win: hit ? bet.stake * animalById.get(bet.animal_id).payout : 0,
        };
      });

      const staked = rows.reduce((sum, r) => sum + r.stake, 0);
      const won = rows.reduce((sum, r) => sum + r.win, 0);
      const id = `${roundId}-${userId}`;

      // One transaction. Statement 2 sees statement 1's insert, so a fresh
      // record pays out once; an existing paid one fails the guard.
      await db.batch([
        db.prepare(
          `INSERT INTO records
             (id, round_id, user_id, at, landed_id, landed_name, is_plate,
              rows_json, staked, won, net, paid)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT (id) DO NOTHING`
        ).bind(id, roundId, userId, at, spot.id, spot.name, plate,
               JSON.stringify(rows), staked, won, won - staked),

        db.prepare(
          `UPDATE users SET coins = coins + ?
            WHERE id = ? AND (SELECT paid FROM records WHERE id = ?) = 0`
        ).bind(won, userId, id),

        db.prepare('UPDATE records SET paid = 1 WHERE id = ?').bind(id),
      ]);

      // Broadcast big wheel wins (1w+) to the room's "game" feed, framed by size.
      if (won >= GAME_ANNOUNCE) {
        const u = await db.prepare('SELECT username, color, avatar FROM users WHERE id = ?').bind(userId).first();
        if (u) {
          await db.prepare(
            `INSERT INTO chat (user_id, username, color, avatar, text, kind, at) VALUES (?, ?, ?, ?, ?, 'bcast', ?)`
          ).bind(userId, u.username, u.color, u.avatar ?? '🐰',
            JSON.stringify({ type: 'wheel', winner: u.username, amount: won, tier: gameTier(won) }),
            at).run();
        }
      }
    }

    await db.prepare('DELETE FROM bets WHERE round_id = ?').bind(roundId).run();
  }
}

/* ---- Leaderboard window ----
   Cloudflare runs in UTC; players don't. TZ_OFFSET_MINUTES shifts the
   day/week/month boundaries to local time (default UTC+8).                 */

function windowStart(range, offsetMinutes) {
  const offsetMs = offsetMinutes * 60_000;
  const local = new Date(Date.now() + offsetMs);

  const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const shifted = new Date(start);

  if (range === 'week') {
    shifted.setUTCDate(shifted.getUTCDate() - ((shifted.getUTCDay() + 6) % 7)); // Monday
  } else if (range === 'month') {
    shifted.setUTCDate(1);
  }
  return shifted.getTime() - offsetMs;
}

/* ---- Routes ---- */

async function handle(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  const db = env.DB;

  if (!pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });

  const method = request.method;
  const me = await userForToken(db, request);

  if (pathname === '/api/config' && method === 'GET') {
    return json({ ...publicConfig, avatars: AVATARS });
  }

  /* -- auth -- */

  if (pathname === '/api/register' && method === 'POST') {
    const { username = '', password = '', color = '#7aa84e' } = await readJson(request);
    const name = String(username).trim();
    const lower = name.toLowerCase();

    if (!/^[\w一-龥]{2,16}$/.test(name)) {
      return fail(400, 'bad_username', '用户名需 2–16 位字母、数字或中文');
    }
    if (String(password).length < 4) return fail(400, 'short_password', '密码至少 4 位');
    if (!/^#[0-9a-f]{6}$/i.test(color)) return fail(400, 'bad_color', '颜色格式无效');

    const taken = await db.prepare('SELECT id FROM users WHERE username_lower = ?')
      .bind(lower).first();
    if (taken) return fail(409, 'name_taken', '该用户名已被使用');

    // The reserved name becomes THE superadmin — but only while no super
    // exists, so it can't be claimed a second time. Regular admins are made
    // later by the super, via /api/admin/grant.
    let isSuper = 0;
    if (lower === String(env.ADMIN_USER ?? '').toLowerCase()) {
      const existing = await db.prepare('SELECT id FROM users WHERE is_super = 1').first();
      if (!existing) isSuper = 1;
    }

    const { salt, hash } = await hashPassword(String(password));

    // 90k possible ids, so a clash is rare but not impossible — check before
    // using one rather than letting a duplicate primary key surface as a 500.
    let id = null;
    for (let attempt = 0; attempt < 25 && !id; attempt++) {
      const candidate = newUserId();
      const clash = await db.prepare('SELECT id FROM users WHERE id = ?')
        .bind(candidate).first();
      if (!clash) id = candidate;
    }
    if (!id) return fail(503, 'id_exhausted', '无法分配用户 ID，请重试');

    // A per-user starting avatar, spread across the set by id digits.
    const avatar = AVATARS[Number(id) % AVATARS.length];

    await db.prepare(
      `INSERT INTO users
         (id, username, username_lower, salt, hash, color, avatar, coins, is_admin, is_super, must_reset, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).bind(id, name, lower, salt, hash, color, avatar, STARTING_COINS, isSuper, isSuper, Date.now()).run();

    const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    await logAction(db, {
      action: 'register', target: user, amount: STARTING_COINS,
      detail: isSuper ? 'superadmin' : null,
    });
    return json({ token: await startSession(db, id), user: publicUser(user) });
  }

  if (pathname === '/api/login' && method === 'POST') {
    const { username = '', password = '' } = await readJson(request);
    const user = await db.prepare('SELECT * FROM users WHERE username_lower = ?')
      .bind(String(username).trim().toLowerCase()).first();

    if (user?.must_reset) {
      return fail(409, 'needs_reset', '密码已被管理员清除，请设置新密码');
    }
    // Same message either way — don't reveal which usernames exist.
    if (!user || !(await verifyPassword(String(password), user.salt, user.hash))) {
      return fail(401, 'bad_credentials', '用户名或密码错误');
    }
    return json({ token: await startSession(db, user.id), user: publicUser(user) });
  }

  if (pathname === '/api/reset-password' && method === 'POST') {
    const { username = '', password = '' } = await readJson(request);
    const user = await db.prepare('SELECT * FROM users WHERE username_lower = ?')
      .bind(String(username).trim().toLowerCase()).first();

    // Only reachable while an admin has flagged the account.
    if (!user?.must_reset) return fail(403, 'reset_not_allowed', '该账号未开放重设密码');
    if (String(password).length < 4) return fail(400, 'short_password', '密码至少 4 位');

    const { salt, hash } = await hashPassword(String(password));
    await db.prepare('UPDATE users SET salt = ?, hash = ?, must_reset = 0 WHERE id = ?')
      .bind(salt, hash, user.id).run();

    const updated = await db.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
    return json({ token: await startSession(db, user.id), user: publicUser(updated) });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const token = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return json({ ok: true });
  }

  /* -- game -- */

  if (pathname === '/api/state' && method === 'GET') {
    const now = Date.now();
    const { roundId, phase, msLeft } = phaseAt(now);
    const secret = await getSecret(db);

    await settleDueRounds(db, secret, roundId);

    // The previous round's outcome is derivable, so nothing needs storing.
    const previous = await drawFor(roundId - 1, secret);
    const winners = resolveWinners(previous);

    let fresh = me;
    let myBets = {};
    if (me) {
      // Mark presence — this poll means the player is online right now.
      await db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(now, me.id).run();
      fresh = await db.prepare('SELECT * FROM users WHERE id = ?').bind(me.id).first();
      const bets = await db.prepare(
        'SELECT animal_id, stake FROM bets WHERE round_id = ? AND user_id = ?'
      ).bind(roundId, me.id).all();
      for (const bet of bets.results ?? []) myBets[bet.animal_id] = bet.stake;
    }

    // How many players are in on this round — shown live on the board.
    const bettors = await db.prepare(
      'SELECT COUNT(DISTINCT user_id) AS n, COALESCE(SUM(stake), 0) AS total FROM bets WHERE round_id = ?'
    ).bind(roundId).first();

    return json({
      now, roundId, phase, msLeft,
      bettors: bettors?.n ?? 0,
      betTotal: bettors?.total ?? 0,
      lastResult: {
        roundId: roundId - 1,
        landedId: previous.id,
        landedName: previous.name,
        landedArt: previous.art,
        isPlate: isPlate(previous),
        winnerIds: winners.map((a) => a.id),
      },
      me: fresh ? publicUser(fresh) : null,
      myBets,
    });
  }

  // Personal dashboard: everything the player has staked, won and been given.
  if (pathname === '/api/me/stats' && method === 'GET') {
    if (!me) return fail(401, 'auth_required', '请先登录');

    const bets = await db.prepare(
      `SELECT COUNT(*) AS rounds,
              COALESCE(SUM(staked), 0) AS staked,
              COALESCE(SUM(won), 0)    AS won,
              COALESCE(SUM(CASE WHEN net > 0 THEN 1 ELSE 0 END), 0) AS wins,
              COALESCE(SUM(CASE WHEN net < 0 THEN 1 ELSE 0 END), 0) AS losses
         FROM records WHERE user_id = ?`
    ).bind(me.id).first();

    // Top-ups arrive two ways — an approved request, or a manual credit.
    const approved = await db.prepare(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM topup_requests WHERE user_id = ? AND status = 'approved'"
    ).bind(me.id).first();
    const manual = await db.prepare(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM audit_log WHERE target_id = ? AND action = 'topup_manual'"
    ).bind(me.id).first();

    return json({
      rounds: bets.rounds,
      wins: bets.wins,
      losses: bets.losses,
      spend: Number(bets.staked),             // total staked
      income: Number(bets.won),               // total returned by the wheel
      net: Number(bets.won) - Number(bets.staked),    // profit or loss
      topups: Number(approved?.total ?? 0) + Number(manual?.total ?? 0),
      coins: me.coins,
    });
  }

  // Players edit their own profile. Username changes go through the same
  // uniqueness check as registration.
  if (pathname === '/api/me/update' && method === 'POST') {
    if (!me) return fail(401, 'auth_required', '请先登录');
    const { username, birthday, color, avatar, bio } = await readJson(request);

    if (username !== undefined) {
      const name = String(username).trim();
      const lower = name.toLowerCase();
      if (!/^[\w一-龥]{2,16}$/.test(name)) {
        return fail(400, 'bad_username', '用户名需 2–16 位字母、数字或中文');
      }
      const taken = await db.prepare(
        'SELECT id FROM users WHERE username_lower = ? AND id != ?'
      ).bind(lower, me.id).first();
      if (taken) return fail(409, 'name_taken', '该用户名已被使用');

      await db.prepare('UPDATE users SET username = ?, username_lower = ? WHERE id = ?')
        .bind(name, lower, me.id).run();
    }

    if (birthday !== undefined) {
      const value = String(birthday ?? '').trim();
      if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return fail(400, 'bad_birthday', '生日格式需为 YYYY-MM-DD');
      }
      await db.prepare('UPDATE users SET birthday = ? WHERE id = ?')
        .bind(value || null, me.id).run();
    }

    if (color !== undefined) {
      if (!/^#[0-9a-f]{6}$/i.test(color)) return fail(400, 'bad_color', '颜色格式无效');
      await db.prepare('UPDATE users SET color = ? WHERE id = ?').bind(color, me.id).run();
    }

    if (avatar !== undefined) {
      if (!AVATARS.includes(avatar)) return fail(400, 'bad_avatar', '无效的头像');
      await db.prepare('UPDATE users SET avatar = ? WHERE id = ?').bind(avatar, me.id).run();
      // Keep the seat/chat display in sync with the new avatar.
      await db.prepare('UPDATE chat SET avatar = ? WHERE user_id = ?').bind(avatar, me.id).run();
    }

    if (bio !== undefined) {
      const value = String(bio ?? '').slice(0, 200);
      await db.prepare('UPDATE users SET bio = ? WHERE id = ?').bind(value, me.id).run();
    }

    const updated = await db.prepare('SELECT * FROM users WHERE id = ?').bind(me.id).first();
    return json({ user: publicUser(updated) });
  }

  // Change your own password (must supply the current one). This is the only
  // self-service password change: admins can only *clear* a password, and the
  // superadmin can't even be cleared — so this is how the owner replaces the
  // password chosen at bootstrap registration.
  if (pathname === '/api/me/password' && method === 'POST') {
    if (!me) return fail(401, 'auth_required', '请先登录');
    const { currentPassword = '', newPassword = '' } = await readJson(request);
    if (!(await verifyPassword(String(currentPassword), me.salt, me.hash))) {
      return fail(401, 'bad_credentials', '当前密码错误');
    }
    if (String(newPassword).length < 4) return fail(400, 'short_password', '新密码至少 4 位');

    const { salt, hash } = await hashPassword(String(newPassword));
    const token = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
    await db.batch([
      db.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?').bind(salt, hash, me.id),
      // Sign out every OTHER session; keep the one making this request alive.
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').bind(me.id, token),
    ]);
    return json({ ok: true });
  }

  /* -- online room: 9 seats + chat -- */

  if (pathname === '/api/room' && method === 'GET') {
    const { results = [] } = await db.prepare(
      'SELECT id, username, color, avatar, seat FROM users WHERE seat IS NOT NULL'
    ).all();

    // Charm (total gift value received) per seated user — the 💚 under each mic.
    let charm = new Map();
    const seatedIds = results.map((u) => u.id);
    if (seatedIds.length) {
      const marks = seatedIds.map(() => '?').join(',');
      const { results: charmRows = [] } = await db.prepare(
        `SELECT to_id AS uid, SUM(received) AS total FROM gifts
          WHERE to_id IN (${marks}) AND from_id <> to_id GROUP BY to_id`
      ).bind(...seatedIds).all();
      charm = new Map(charmRows.map((r) => [r.uid, r.total]));
    }

    const seats = Array.from({ length: 9 }, () => null);
    for (const u of results) {
      if (u.seat >= 1 && u.seat <= 9) {
        seats[u.seat - 1] = {
          userId: u.id, username: u.username, color: u.color,
          avatar: u.avatar ?? '🐰', charm: charm.get(u.id) ?? 0,
        };
      }
    }

    const { results: msgs = [] } = await db.prepare(
      'SELECT id, user_id, username, color, avatar, text, kind, at FROM chat ORDER BY at DESC LIMIT 200'
    ).all();

    // Everyone active in the last 90s — the online-people list.
    const { results: onlineRows = [] } = await db.prepare(
      'SELECT id, username, color, avatar FROM users WHERE last_seen >= ? ORDER BY LOWER(username) LIMIT 100'
    ).bind(Date.now() - 90_000).all();

    const asRow = await db.prepare("SELECT value FROM meta WHERE key = 'admin_seats'").first();
    let adminSeats = [];
    try { adminSeats = asRow ? JSON.parse(asRow.value) : []; } catch { adminSeats = []; }

    return json({
      seats,
      adminSeats,
      online: onlineRows.map((u) => ({
        userId: u.id, username: u.username, color: u.color, avatar: u.avatar ?? '🐰',
      })),
      mySeat: me?.seat ?? null,
      messages: msgs.reverse().map((m) => ({
        id: m.id, userId: m.user_id, username: m.username,
        color: m.color, avatar: m.avatar ?? '🐰', text: m.text,
        kind: m.kind ?? 'msg', at: m.at,
      })),
    });
  }

  if (pathname === '/api/room/sit' && method === 'POST') {
    if (!me) return fail(401, 'auth_required', '请先登录');
    const { seat } = await readJson(request);
    const n = Number(seat);
    if (!Number.isInteger(n) || n < 1 || n > 9) return fail(400, 'bad_seat', '无效的座位');

    // Admin-only seats: only admins / superadmin may sit.
    const asRow = await db.prepare("SELECT value FROM meta WHERE key = 'admin_seats'").first();
    let adminSeats = [];
    try { adminSeats = asRow ? JSON.parse(asRow.value) : []; } catch { adminSeats = []; }
    if (adminSeats.includes(n) && !me.is_admin && !me.is_super) {
      return fail(403, 'admin_seat', '该座位仅限管理员');
    }

    const holder = await db.prepare('SELECT id FROM users WHERE seat = ?').bind(n).first();
    if (holder && holder.id !== me.id) return fail(409, 'seat_taken', '该座位已被占用');

    // One seat per person: leaving the old one is implicit in setting the new.
    await db.prepare('UPDATE users SET seat = ? WHERE id = ?').bind(n, me.id).run();
    return json({ ok: true, seat: n });
  }

  if (pathname === '/api/room/leave' && method === 'POST') {
    if (!me) return fail(401, 'auth_required', '请先登录');
    await db.prepare('UPDATE users SET seat = NULL WHERE id = ?').bind(me.id).run();
    return json({ ok: true });
  }

  if (pathname === '/api/room/chat' && method === 'POST') {
    if (!me) return fail(401, 'auth_required', '请先登录');
    const { text } = await readJson(request);
    const body = String(text ?? '').trim();
    if (!body) return fail(400, 'empty_message', '消息不能为空');
    if (body.length > 200) return fail(400, 'message_too_long', '消息过长（最多 200 字）');

    await db.prepare(
      'INSERT INTO chat (user_id, username, color, avatar, text, at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(me.id, me.username, me.color, me.avatar ?? '🐰', body, Date.now()).run();
    return json({ ok: true });
  }

  if (pathname === '/api/gifts/catalog' && method === 'GET') {
    return json({ gifts: GIFTS });
  }

  /* -- bag (Star Travel winnings, giftable in the room) -- */

  if (pathname === '/api/bag' && method === 'GET') {
    const userId = String(url.searchParams.get('userId') ?? me?.id ?? '').trim();
    if (!userId) return fail(400, 'bad_target', '缺少用户');
    const { results = [] } = await db.prepare(
      'SELECT item_key, emoji, name, value, count FROM inventory WHERE user_id = ? AND count > 0 ORDER BY value ASC'
    ).bind(userId).all();
    return json({
      items: results.map((r) => ({ key: r.item_key, emoji: r.emoji, name: r.name, value: r.value, count: r.count })),
    });
  }

  // NOTE: the old client-trusting endpoints (/api/bag/add, /api/bag/remove,
  // /api/coins/adjust, /api/star-wallet/adjust, /api/star/announce) are gone —
  // any browser could mint currency through them. The star game now runs
  // through /api/star/buy, /api/star/voyage and /api/star/wish below, where
  // the server owns every roll and every balance change.

  // Star history: the global 5000+ feed and the player's own plays, newest
  // first, plus totals.
  if (pathname === '/api/star/history' && method === 'GET') {
    // Newest 15 big wins only.
    const big = await db.prepare(
      'SELECT username, emoji, name, value, qty, at FROM star_wins WHERE value >= 5000 ORDER BY at DESC LIMIT 15'
    ).all();
    const mineRows = me ? await db.prepare(
      'SELECT emoji, name, value, qty, at FROM star_wins WHERE user_id = ? ORDER BY at DESC LIMIT 50'
    ).bind(me.id).all() : { results: [] };
    const bigTotal = await db.prepare('SELECT COUNT(*) AS n FROM star_wins WHERE value >= 5000').first();
    const mineTotal = me ? await db.prepare(
      'SELECT COALESCE(SUM(qty),0) AS n FROM star_wins WHERE user_id = ?'
    ).bind(me.id).first() : { n: 0 };

    return json({
      global: (big.results ?? []).map((r) => ({
        username: r.username, emoji: r.emoji, name: r.name, value: r.value, qty: r.qty, at: r.at,
      })),
      mine: (mineRows.results ?? []).map((r) => ({
        emoji: r.emoji, name: r.name, value: r.value, qty: r.qty, at: r.at,
      })),
      globalTotal: bigTotal?.n ?? 0,
      mineTotal: mineTotal?.n ?? 0,
    });
  }

  // Give a bag item to another player. The receiver keeps 70% of its value as
  // coins (like a coin gift); the item leaves the sender's bag.
  if (pathname === '/api/bag/give' && method === 'POST') {
    if (!me) return fail(401, 'auth_required', '请先登录');
    const { toUserId, key, qty } = await readJson(request);
    const k = String(key ?? '').trim();
    const n = Math.max(1, Math.trunc(Number(qty) || 1));

    const target = await db.prepare('SELECT * FROM users WHERE id = ?')
      .bind(String(toUserId ?? '').trim()).first();
    if (!target) return fail(404, 'user_not_found', '找不到该用户');
    // Self-gifting is allowed.

    const item = await db.prepare('SELECT * FROM inventory WHERE user_id = ? AND item_key = ?')
      .bind(me.id, k).first();
    if (!item || item.count < n) return fail(400, 'not_enough_items', '背包物品不足');

    const totalValue = item.value * n;
    const received = Math.floor(totalValue * RECEIVER_SHARE);
    const now = Date.now();
    const tier = frameTier(totalValue);
    const kind = tier ? 'bcast' : 'gift';

    await db.batch([
      db.prepare('UPDATE inventory SET count = count - ? WHERE user_id = ? AND item_key = ?').bind(n, me.id, k),
      db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').bind(received, target.id),
      db.prepare(
        `INSERT INTO gifts (from_id, from_name, to_id, to_name, gift_id, emoji, cost, received, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(me.id, me.username, target.id, target.username, `bag:${k}`, item.emoji, totalValue, received, now),
      db.prepare(
        `INSERT INTO chat (user_id, username, color, avatar, text, kind, at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(me.id, me.username, me.color, me.avatar ?? '🐰',
        JSON.stringify({ from: me.username, to: target.username, emoji: item.emoji, name: item.name, cost: totalValue, tier }),
        kind, now),
    ]);

    return json({ ok: true });
  }

  // Buy a currency pack with coins. Price comes from the server table only.
  if (pathname === '/api/star/buy' && method === 'POST') {
    if (!me) return fail(401, 'auth_required', '请先登录');
    const { kind, qty } = await readJson(request);
    const mode = STAR_MODES[String(kind)];
    const n = Math.trunc(Number(qty));
    const price = mode?.packs[n];
    if (!price) return fail(400, 'bad_pack', '无效的兑换包');

    // One UPDATE changes both columns; the WHERE is the balance check, so it
    // either debits coins and credits the currency together, or does nothing.
    const bought = await db.prepare(
      `UPDATE users SET coins = coins - ?, ${mode.col} = ${mode.col} + ?
         WHERE id = ? AND coins >= ?`
    ).bind(price, n, me.id, price).run();
    if (bought.meta.changes !== 1) return fail(400, 'insufficient', '金币不足');

    const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(me.id).first();
    return json({ user: publicUser(user) });
  }

  // One voyage batch: spend `count` of the mode's currency, roll the prizes
  // server-side, bank them into the bag — all gated on the payment.
  if (pathname === '/api/star/voyage' && method === 'POST') {
    if (!me) return fail(401, 'auth_required', '请先登录');
    const { kind, count } = await readJson(request);
    const mode = STAR_MODES[String(kind)];
    const n = Math.trunc(Number(count));
    if (!mode || !Number.isInteger(n) || n < 1 || n > 30) return fail(400, 'bad_count', '无效的次数');

    // Charge first, balance-checked. If nothing was debited, the player
    // doesn't have enough currency — bail before rolling anything.
    const charged = await db.prepare(
      `UPDATE users SET ${mode.col} = ${mode.col} - ? WHERE id = ? AND ${mode.col} >= ?`
    ).bind(n, me.id, n).run();
    if (charged.meta.changes !== 1) return fail(400, mode.errCode, mode.errMsg);

    // Paid — now roll (server randomness) and bank the prizes. These writes
    // don't touch currency, so they can't overdraw; batch keeps them atomic.
    const items = Array.from({ length: n }, () => starPick(mode.rewards));
    const counts = new Map();
    for (const g of items) counts.set(g, (counts.get(g) ?? 0) + 1);
    const prizes = [...counts.entries()];   // [goldValue, qty]

    const at = Date.now();
    const ops = [];
    for (const [g, q] of prizes) {
      ops.push(db.prepare(
        `INSERT INTO inventory (user_id, item_key, emoji, name, value, count)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, item_key) DO UPDATE SET count = inventory.count + excluded.count`
      ).bind(me.id, String(g), STAR_GIFTS[g].emoji, STAR_GIFTS[g].name, g, q));
      ops.push(db.prepare(
        'INSERT INTO star_wins (user_id, username, emoji, name, value, qty, at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(me.id, me.username, STAR_GIFTS[g].emoji, STAR_GIFTS[g].name, g, q, at));
    }
    await db.batch(ops);
    for (const [g, q] of prizes) await starAnnounce(db, me, g, q);

    const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(me.id).first();
    return json({ items, user: publicUser(user) });
  }

  // Wishing pool: pledge bag items toward a target; the server rolls.
  if (pathname === '/api/star/wish' && method === 'POST') {
    if (!me) return fail(401, 'auth_required', '请先登录');
    const { target, materials } = await readJson(request);
    const tv = Math.trunc(Number(target));
    if (!WISH_TARGETS.includes(tv)) return fail(400, 'bad_target', '无效的许愿目标');

    const entries = Object.entries(materials ?? {})
      .map(([k, q]) => [String(k).trim(), Math.trunc(Number(q))]);
    if (!entries.length || entries.length > 40) return fail(400, 'bad_materials', '无效的材料');
    for (const [k, q] of entries) {
      if (!STAR_GIFTS[k] || !Number.isInteger(q) || q < 1 || q > 10_000) {
        return fail(400, 'bad_materials', '无效的材料');
      }
    }

    // Ownership check up front for a clean error; the in-transaction guard
    // below still catches races.
    const { results: owned = [] } = await db.prepare(
      'SELECT item_key, count FROM inventory WHERE user_id = ?'
    ).bind(me.id).all();
    const ownMap = new Map(owned.map((r) => [r.item_key, r.count]));
    for (const [k, q] of entries) {
      if ((ownMap.get(k) ?? 0) < q) return fail(400, 'not_enough_items', '背包物品不足');
    }

    const matValue = entries.reduce((sum, [k, q]) => sum + Number(k) * q, 0);
    const prob = Math.min(1, matValue / wishFullCost(tv));
    const success = starRandom() < prob;

    // Unconditional decrements + a division-by-zero tripwire: if any count
    // went negative (a concurrent spend of the same items), the whole
    // transaction rolls back — materials can never be double-spent.
    const stmts = entries.map(([k, q]) =>
      db.prepare('UPDATE inventory SET count = count - ? WHERE user_id = ? AND item_key = ?')
        .bind(q, me.id, k));
    stmts.push(db.prepare(
      `SELECT 1 / (CASE WHEN EXISTS (
         SELECT 1 FROM inventory WHERE user_id = ? AND count < 0
       ) THEN 0 ELSE 1 END) AS guard`
    ).bind(me.id));
    if (success) {
      stmts.push(db.prepare(
        `INSERT INTO inventory (user_id, item_key, emoji, name, value, count)
         VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT (user_id, item_key) DO UPDATE SET count = inventory.count + excluded.count`
      ).bind(me.id, String(tv), STAR_GIFTS[tv].emoji, STAR_GIFTS[tv].name, tv));
    }
    try {
      await db.batch(stmts);
    } catch {
      return fail(400, 'not_enough_items', '背包物品不足');
    }

    if (success) {
      await db.prepare(
        'INSERT INTO star_wins (user_id, username, emoji, name, value, qty, at) VALUES (?, ?, ?, ?, ?, 1, ?)'
      ).bind(me.id, me.username, STAR_GIFTS[tv].emoji, STAR_GIFTS[tv].name, tv, Date.now()).run();
      await starAnnounce(db, me, tv);
    }

    return json({ success, prob, matValue });
  }

  if (pathname === '/api/gifts/send' && method === 'POST') {
    if (!me) return fail(401, 'auth_required', '请先登录');
    const { toUserId, giftId } = await readJson(request);
    const gift = giftById.get(String(giftId));
    if (!gift) return fail(400, 'bad_gift', '无效的礼物');

    const target = await db.prepare('SELECT * FROM users WHERE id = ?')
      .bind(String(toUserId ?? '').trim()).first();
    if (!target) return fail(404, 'user_not_found', '找不到该用户');
    // Self-gifting is allowed.

    // Deduct conditionally so two gifts can't overdraw. The receiver keeps
    // 70%; the remaining 30% is the owner's (superadmin's) cut.
    const deducted = await db.prepare(
      'UPDATE users SET coins = coins - ? WHERE id = ? AND coins >= ?'
    ).bind(gift.cost, me.id, gift.cost).run();
    if (deducted.meta.changes !== 1) {
      return fail(400, 'insufficient', '余额不足，请联系管理员充值');
    }

    const received = Math.floor(gift.cost * RECEIVER_SHARE);
    const ownerCut = gift.cost - received;   // the remaining 30% goes to the owner
    // The owner is the superadmin (the first `yue` registration). Credit their
    // 30% cut on every gift. If the owner is also the receiver they collect
    // both shares (100%); if no owner exists yet the cut is simply skipped.
    const owner = await db.prepare(
      'SELECT id FROM users WHERE is_super = 1 ORDER BY created_at LIMIT 1'
    ).first();
    const now = Date.now();
    const ops = [
      db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?').bind(received, target.id),
      db.prepare(
        `INSERT INTO gifts (from_id, from_name, to_id, to_name, gift_id, emoji, cost, received, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(me.id, me.username, target.id, target.username, gift.id, gift.emoji, gift.cost, received, now),
    ];
    if (owner && ownerCut > 0) {
      ops.push(db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?')
        .bind(ownerCut, owner.id));
    }

    // Every gift posts to the feed. 'gift' = a normal Gift-tab line; 'bcast'
    // (5000+) also triggers the room-wide banner, framed by value tier.
    const tier = frameTier(gift.cost);
    const kind = tier ? 'bcast' : 'gift';
    ops.push(db.prepare(
      `INSERT INTO chat (user_id, username, color, avatar, text, kind, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(me.id, me.username, me.color, me.avatar ?? '🐰',
      JSON.stringify({ from: me.username, to: target.username, emoji: gift.emoji, img: gift.img, name: gift.name, cost: gift.cost, tier }),
      kind, now));

    await db.batch(ops);

    const updated = await db.prepare('SELECT * FROM users WHERE id = ?').bind(me.id).first();
    return json({ ok: true, user: publicUser(updated), announced: gift.cost >= ANNOUNCE_MIN });
  }

  // Public profile — only the fields anyone may see. Coins/email never leave.
  if (pathname === '/api/profile' && method === 'GET') {
    const id = String(url.searchParams.get('id') ?? '').trim();
    const row = await db.prepare('SELECT id, username, color, avatar, bio FROM users WHERE id = ?')
      .bind(id).first();
    if (!row) return fail(404, 'user_not_found', '找不到该用户');
    return json({
      profile: {
        id: row.id, username: row.username, color: row.color,
        avatar: row.avatar ?? '🐰', bio: row.bio ?? '',
        isMe: !!me && me.id === row.id,
      },
    });
  }

  // Gifts a user has received, grouped by type with a count — for the profile.
  if (pathname === '/api/gifts/received' && method === 'GET') {
    const userId = String(url.searchParams.get('userId') ?? me?.id ?? '').trim();
    if (!userId) return fail(400, 'bad_target', '缺少用户');
    const { results = [] } = await db.prepare(
      `SELECT emoji, gift_id, COUNT(*) AS count, SUM(received) AS total
         FROM gifts WHERE to_id = ? GROUP BY gift_id, emoji ORDER BY total DESC`
    ).bind(userId).all();
    return json({
      gifts: results.map((r) => ({ emoji: r.emoji, giftId: r.gift_id, count: r.count, total: r.total })),
    });
  }

  // Wealth (most sent), Charm (most received), and the gift feed.
  if (pathname === '/api/gifts/boards' && method === 'GET') {
    const board = url.searchParams.get('board') ?? 'wealth';

    if (board === 'feed') {
      // The room shows 10; the full-records page asks for more via ?limit.
      // ?to=<id> narrows to gifts received by one user (their profile page).
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 10)));
      const to = String(url.searchParams.get('to') ?? '').trim();
      const query = to
        ? db.prepare('SELECT from_name, to_name, emoji, gift_id, cost, at FROM gifts WHERE to_id = ? ORDER BY at DESC LIMIT ?').bind(to, limit)
        : db.prepare('SELECT from_name, to_name, emoji, gift_id, cost, at FROM gifts ORDER BY at DESC LIMIT ?').bind(limit);
      const { results = [] } = await query.all();
      return json({
        board, entries: results.map((r) => ({
          from: r.from_name, to: r.to_name, emoji: r.emoji, cost: r.cost, at: r.at,
        })),
      });
    }

    const col = board === 'charm' ? 'to_id' : 'from_id';
    const nameCol = board === 'charm' ? 'to_name' : 'from_name';
    const amount = board === 'charm' ? 'received' : 'cost';
    // Self-gifts don't count toward either board — otherwise charm (and,
    // for the superadmin, wealth) could be farmed at little or no cost.
    const { results = [] } = await db.prepare(
      `SELECT ${col} AS uid, ${nameCol} AS name, SUM(${amount}) AS total, COUNT(*) AS times
         FROM gifts WHERE from_id <> to_id
         GROUP BY ${col}, ${nameCol} ORDER BY total DESC LIMIT 20`
    ).all();

    // Join the current colour/avatar for display.
    const enriched = [];
    for (const r of results) {
      const u = await db.prepare('SELECT color, avatar FROM users WHERE id = ?').bind(r.uid).first();
      enriched.push({
        userId: r.uid, name: r.name, total: r.total, times: r.times,
        color: u?.color ?? '#7aa84e', avatar: u?.avatar ?? '🐰',
      });
    }
    return json({ board, entries: enriched });
  }

  if (pathname === '/api/bet' && method === 'POST') {
    if (!me) return fail(401, 'auth_required', '请先登录');
    const { animalId, amount } = await readJson(request);
    const { roundId, phase } = phaseAt(Date.now());

    if (phase !== 'betting') return fail(409, 'closed', '本轮已封盘');
    if (!animalById.has(animalId)) return fail(400, 'bad_target', '无效的下注目标');

    const stake = Number(amount);
    if (!Number.isInteger(stake) || stake <= 0 || stake > 100_000_000) {
      return fail(400, 'bad_amount', '金额无效');
    }

    // One atomic statement: the CTE deducts (the WHERE clause is the balance
    // check, so concurrent bets can't overdraw) and the bet row is only
    // written when the deduction actually happened — an error between the
    // two can never burn a stake without recording the bet.
    const placed = await db.prepare(
      `WITH paid AS (
         UPDATE users SET coins = coins - ? WHERE id = ? AND coins >= ? RETURNING id
       )
       INSERT INTO bets (round_id, user_id, animal_id, stake)
       SELECT ?, ?, ?, ? FROM paid
       ON CONFLICT (round_id, user_id, animal_id) DO UPDATE SET stake = bets.stake + excluded.stake`
    ).bind(stake, me.id, stake, roundId, me.id, animalId, stake).run();

    if (placed.meta.changes !== 1) {
      return fail(400, 'insufficient', '余额不足，请联系管理员充值');
    }

    const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(me.id).first();
    const bets = await db.prepare(
      'SELECT animal_id, stake FROM bets WHERE round_id = ? AND user_id = ?'
    ).bind(roundId, me.id).all();

    const myBets = {};
    for (const bet of bets.results ?? []) myBets[bet.animal_id] = bet.stake;
    return json({ user: publicUser(user), myBets });
  }

  /* -- top-up requests (player side) -- */

  if (pathname === '/api/topup-request' && method === 'GET') {
    if (!me) return fail(401, 'auth_required', '请先登录');
    const { results = [] } = await db.prepare(
      `SELECT id, amount, status, created_at, decided_at FROM topup_requests
        WHERE user_id = ? ORDER BY id DESC LIMIT 10`
    ).bind(me.id).all();

    return json({
      request: results[0] ?? null,
      history: results.map((row) => ({
        id: row.id,
        amount: row.amount,
        status: row.status,
        createdAt: row.created_at,
        decidedAt: row.decided_at,
      })),
    });
  }

  if (pathname === '/api/topup-request' && method === 'POST') {
    if (!me) return fail(401, 'auth_required', '请先登录');
    const { amount } = await readJson(request);
    const want = Number(amount);

    if (!Number.isInteger(want) || want <= 0 || want > 1_000_000) {
      return fail(400, 'bad_amount', '金额无效');
    }
    // One open request at a time, so the queue can't be flooded.
    const open = await db.prepare(
      "SELECT id FROM topup_requests WHERE user_id = ? AND status = 'pending'"
    ).bind(me.id).first();
    if (open) return fail(409, 'request_pending', '你已有一个待审批的申请');

    await db.prepare(
      `INSERT INTO topup_requests (user_id, amount, status, credited, created_at)
       VALUES (?, ?, 'pending', 0, ?)`
    ).bind(me.id, want, Date.now()).run();

    await logAction(db, { action: 'topup_request', target: me, amount: want });
    return json({ ok: true });
  }

  if (pathname === '/api/records' && method === 'GET') {
    // Every player can see every player's records, by design.
    const userId = url.searchParams.get('userId');
    const query = userId
      ? db.prepare(
          `SELECT r.*, u.username, u.color FROM records r JOIN users u ON u.id = r.user_id
            WHERE r.user_id = ? ORDER BY r.at DESC LIMIT ?`
        ).bind(userId, MAX_RECORDS)
      : db.prepare(
          `SELECT r.*, u.username, u.color FROM records r JOIN users u ON u.id = r.user_id
            ORDER BY r.at DESC LIMIT ?`
        ).bind(MAX_RECORDS);

    const { results = [] } = await query.all();
    return json({
      records: results.map((row) => ({
        id: row.id,
        roundId: row.round_id,
        userId: row.user_id,
        username: row.username,
        color: row.color,
        at: row.at,
        landedId: row.landed_id,
        landedName: row.landed_name,
        isPlate: !!row.is_plate,
        rows: JSON.parse(row.rows_json),
        staked: row.staked,
        won: row.won,
        net: row.net,
      })),
    });
  }

  // Top 3 of the round that just finished — a fresh podium every game.
  // Only players who actually won appear, so it never shows a negative.
  if (pathname === '/api/round-top' && method === 'GET') {
    const target = roundIdAt(Date.now()) - 1;
    const { results = [] } = await db.prepare(
      `SELECT r.user_id, u.username, u.color, r.won, r.staked
         FROM records r JOIN users u ON u.id = r.user_id
        WHERE r.round_id = ? AND r.won > 0
        ORDER BY r.won DESC LIMIT 3`
    ).bind(target).all();

    return json({
      roundId: target,
      entries: results.map((row) => ({
        userId: row.user_id,
        username: row.username,
        color: row.color,
        won: row.won,
        staked: row.staked,
      })),
    });
  }

  if (pathname === '/api/leaderboard' && method === 'GET') {
    const range = url.searchParams.get('range') ?? 'day';
    if (!['day', 'week', 'month'].includes(range)) {
      return fail(400, 'bad_range', '无效的时间范围');
    }
    // Ranked by total staked, not by profit — so the board is always a
    // positive number and never exposes who is down.
    const offset = Number(env.TZ_OFFSET_MINUTES ?? 480);
    const { results = [] } = await db.prepare(
      `SELECT r.user_id, u.username, u.color,
              SUM(r.staked) AS spent, COUNT(*) AS rounds
         FROM records r JOIN users u ON u.id = r.user_id
        WHERE r.at >= ?
        GROUP BY r.user_id, u.username, u.color
        ORDER BY spent DESC
        LIMIT 20`
    ).bind(windowStart(range, offset)).all();

    return json({
      range,
      entries: results.map((row) => ({
        userId: row.user_id,
        username: row.username,
        color: row.color,
        spent: row.spent,
        rounds: row.rounds,
      })),
    });
  }

  /* -- admin -- */

  if (pathname.startsWith('/api/admin/')) {
    if (!me) return fail(401, 'auth_required', '请先登录');
    if (!me.is_admin) return fail(403, 'admin_required', '需要管理员权限');

    // Each route belongs to a permission category; a regular admin only
    // reaches the ones the super granted. lookup/search/users are shared
    // read helpers, so they need only *some* admin standing.
    const ROUTE_PERM = {
      '/api/admin/topups': 'appeals',
      '/api/admin/topup-decide': 'appeals',
      '/api/admin/reload': 'manual',
      '/api/admin/set-coins': 'manual',
      '/api/admin/clear-password': 'password',
      '/api/admin/delete-user': 'password',
      '/api/admin/grant': 'admins',
      '/api/admin/revoke': 'admins',
      '/api/admin/seat-kick': 'seats',
      '/api/admin/seat-assign': 'seats',
      '/api/admin/seat-mode': 'seats',
      '/api/admin/make-chat-admin': 'admins',
    };
    const needed = ROUTE_PERM[pathname];
    if (needed && !hasPerm(me, needed)) {
      return fail(403, 'no_permission', '没有该权限');
    }

    // Shared read helpers expose every user's balance and the money audit
    // trail — any money/user admin standing qualifies, but a seats-only
    // chat admin does not.
    const READ_ROUTES = new Set([
      '/api/admin/users', '/api/admin/admins', '/api/admin/audit',
      '/api/admin/lookup', '/api/admin/search', '/api/admin/topup-stats',
    ]);
    if (READ_ROUTES.has(pathname) && !me.is_super
        && !['manual', 'appeals', 'password', 'admins'].some((p) => hasPerm(me, p))) {
      return fail(403, 'no_permission', '没有该权限');
    }

    // Create or update a regular admin with a chosen set of permissions.
    // Super only. The super account itself cannot be demoted here.
    if (pathname === '/api/admin/grant' && method === 'POST') {
      if (!me.is_super) return fail(403, 'super_only', '仅超级管理员可操作');
      const { userId, perms } = await readJson(request);
      const target = await db.prepare('SELECT * FROM users WHERE id = ?')
        .bind(String(userId ?? '').trim()).first();
      if (!target) return fail(404, 'user_not_found', '找不到该用户 ID');
      if (target.is_super) return fail(403, 'super_only', '不能修改超级管理员');

      const clean = (Array.isArray(perms) ? perms : [])
        .filter((p) => ALL_PERMS.includes(p));
      const isAdmin = clean.length > 0 ? 1 : 0;

      await db.prepare('UPDATE users SET is_admin = ?, perms = ? WHERE id = ?')
        .bind(isAdmin, clean.join(','), target.id).run();
      const updated = await db.prepare('SELECT * FROM users WHERE id = ?').bind(target.id).first();
      await logAction(db, {
        action: isAdmin ? 'grant_admin' : 'revoke_admin', actor: me, target: updated,
        detail: clean.join(',') || 'none',
      });
      return json({ user: publicUser(updated) });
    }

    // Toggle a user as a chatroom admin — the "seats" permission only, nothing
    // else. Quick promotion from the room's person menu.
    if (pathname === '/api/admin/make-chat-admin' && method === 'POST') {
      const { userId } = await readJson(request);
      const target = await db.prepare('SELECT * FROM users WHERE id = ?')
        .bind(String(userId ?? '').trim()).first();
      if (!target) return fail(404, 'user_not_found', '找不到该用户');
      if (target.is_super) return fail(403, 'super_only', '不能修改超级管理员');

      const set = new Set(target.perms ? target.perms.split(',').filter(Boolean) : []);
      const nowOn = !set.has('seats');
      if (nowOn) set.add('seats'); else set.delete('seats');
      const perms = [...set];

      await db.prepare('UPDATE users SET is_admin = ?, perms = ? WHERE id = ?')
        .bind(perms.length ? 1 : 0, perms.join(','), target.id).run();
      await logAction(db, {
        action: nowOn ? 'grant_chat_admin' : 'revoke_chat_admin', actor: me, target,
      });
      return json({ ok: true, on: nowOn });
    }

    // Kick whoever is in a seat (seat-admins). No coin power needed.
    if (pathname === '/api/admin/seat-kick' && method === 'POST') {
      const { seat } = await readJson(request);
      const n = Number(seat);
      if (!Number.isInteger(n) || n < 1 || n > 9) return fail(400, 'bad_seat', '无效的座位');
      await db.prepare('UPDATE users SET seat = NULL WHERE seat = ?').bind(n).run();
      await logAction(db, { action: 'seat_kick', actor: me, detail: `seat ${n}` });
      return json({ ok: true });
    }

    // Pull a user into a seat (seat-admins). Frees the seat first if taken.
    if (pathname === '/api/admin/seat-assign' && method === 'POST') {
      const { userId, seat } = await readJson(request);
      const n = Number(seat);
      if (!Number.isInteger(n) || n < 1 || n > 9) return fail(400, 'bad_seat', '无效的座位');
      const target = await db.prepare('SELECT * FROM users WHERE id = ?')
        .bind(String(userId ?? '').trim()).first();
      if (!target) return fail(404, 'user_not_found', '找不到该用户');
      await db.batch([
        db.prepare('UPDATE users SET seat = NULL WHERE seat = ?').bind(n),   // free target seat
        db.prepare('UPDATE users SET seat = ? WHERE id = ?').bind(n, target.id),
      ]);
      await logAction(db, { action: 'seat_assign', actor: me, target, detail: `seat ${n}` });
      return json({ ok: true });
    }

    // Mark / unmark a seat as admin-only (super / seat-admins). Kicks a
    // non-admin sitting there when it's locked.
    if (pathname === '/api/admin/seat-mode' && method === 'POST') {
      const { seat, adminOnly } = await readJson(request);
      const n = Number(seat);
      if (!Number.isInteger(n) || n < 1 || n > 9) return fail(400, 'bad_seat', '无效的座位');

      const row = await db.prepare("SELECT value FROM meta WHERE key = 'admin_seats'").first();
      let set = [];
      try { set = row ? JSON.parse(row.value) : []; } catch { set = []; }
      set = set.filter((x) => x !== n);
      if (adminOnly) set.push(n);
      set.sort((a, b) => a - b);

      await db.prepare(
        "INSERT INTO meta (key, value) VALUES ('admin_seats', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
      ).bind(JSON.stringify(set)).run();

      if (adminOnly) {
        const holder = await db.prepare('SELECT id, is_admin, is_super FROM users WHERE seat = ?').bind(n).first();
        if (holder && !holder.is_admin && !holder.is_super) {
          await db.prepare('UPDATE users SET seat = NULL WHERE id = ?').bind(holder.id).run();
        }
      }
      await logAction(db, { action: 'seat_mode', actor: me, detail: `seat ${n} ${adminOnly ? 'admin-only' : 'open'}` });
      return json({ ok: true, adminSeats: set });
    }

    if (pathname === '/api/admin/users' && method === 'GET') {
      const { results = [] } = await db.prepare(
        'SELECT * FROM users ORDER BY LOWER(username)'
      ).all();
      const onlineCutoff = Date.now() - 90_000;
      return json({
        users: results.map((row) => ({
          ...publicUser(row),
          mustReset: !!row.must_reset,
          online: (row.last_seen ?? 0) >= onlineCutoff,
        })),
      });
    }

    // Just the admins, for the Admins category.
    if (pathname === '/api/admin/admins' && method === 'GET') {
      const { results = [] } = await db.prepare(
        'SELECT * FROM users WHERE is_admin = 1 ORDER BY is_super DESC, LOWER(username)'
      ).all();
      return json({ admins: results.map(publicUser) });
    }

    // Step 1 of the top-up flow: the admin keys in an ID and gets the name
    // back, so they can confirm they're crediting the right person before
    // any money moves.
    if (pathname === '/api/admin/lookup' && method === 'GET') {
      const target = await db.prepare('SELECT * FROM users WHERE id = ?')
        .bind(String(url.searchParams.get('userId') ?? '').trim()).first();
      if (!target) return fail(404, 'user_not_found', '找不到该用户 ID');
      return json({ user: { ...publicUser(target), mustReset: !!target.must_reset } });
    }

    // Search by ID or username — the password-reset page needs to find people
    // who, by definition, can't tell you their ID because they're locked out.
    if (pathname === '/api/admin/search' && method === 'GET') {
      const q = String(url.searchParams.get('q') ?? '').trim();
      if (!q) return json({ users: [] });

      const { results = [] } = await db.prepare(
        `SELECT * FROM users
          WHERE id = ? OR username_lower LIKE ?
          ORDER BY LOWER(username) LIMIT 10`
      ).bind(q, `%${q.toLowerCase()}%`).all();

      return json({
        users: results.map((row) => ({ ...publicUser(row), mustReset: !!row.must_reset })),
      });
    }

    /* -- approval queue -- */

    if (pathname === '/api/admin/topups' && method === 'GET') {
      const status = url.searchParams.get('status') ?? 'pending';
      const { results = [] } = await db.prepare(
        `SELECT t.*, u.username, u.color, u.coins
           FROM topup_requests t JOIN users u ON u.id = t.user_id
          WHERE t.status = ?
          ORDER BY t.created_at DESC LIMIT 100`
      ).bind(status).all();

      return json({
        requests: results.map((row) => ({
          id: row.id,
          userId: row.user_id,
          username: row.username,
          color: row.color,
          coins: row.coins,
          amount: row.amount,
          status: row.status,
          createdAt: row.created_at,
        })),
      });
    }

    if (pathname === '/api/admin/topup-decide' && method === 'POST') {
      const { id, action } = await readJson(request);
      if (!['approve', 'reject'].includes(action)) {
        return fail(400, 'bad_action', '无效的操作');
      }

      const req = await db.prepare(
        `SELECT t.*, u.username FROM topup_requests t JOIN users u ON u.id = t.user_id
          WHERE t.id = ?`
      ).bind(Number(id)).first();
      if (!req) return fail(404, 'request_not_found', '找不到该申请');
      if (req.status !== 'pending') return fail(409, 'already_decided', '该申请已处理');

      if (action === 'reject') {
        const done = await db.prepare(
          `UPDATE topup_requests SET status = 'rejected', decided_at = ?, decided_by = ?
            WHERE id = ? AND status = 'pending'`
        ).bind(Date.now(), me.id, req.id).run();
        if (done.meta.changes !== 1) return fail(409, 'already_decided', '该申请已处理');

        await logAction(db, {
          action: 'topup_reject', actor: me,
          target: { id: req.user_id, username: req.username }, amount: req.amount,
        });
        return json({ ok: true, status: 'rejected' });
      }

      // Same guard pattern as settlement: statement 2 only fires while the
      // row it just approved is still uncredited, so a double approve —
      // whether from a double click or two admins at once — pays once.
      await db.batch([
        db.prepare(
          `UPDATE topup_requests SET status = 'approved', decided_at = ?, decided_by = ?
            WHERE id = ? AND status = 'pending'`
        ).bind(Date.now(), me.id, req.id),

        db.prepare(
          `UPDATE users SET coins = coins + ?
            WHERE id = ?
              AND (SELECT status FROM topup_requests WHERE id = ?) = 'approved'
              AND (SELECT credited FROM topup_requests WHERE id = ?) = 0`
        ).bind(req.amount, req.user_id, req.id, req.id),

        db.prepare('UPDATE topup_requests SET credited = 1 WHERE id = ?').bind(req.id),
      ]);

      const updated = await db.prepare('SELECT * FROM users WHERE id = ?')
        .bind(req.user_id).first();
      await logAction(db, {
        action: 'topup_approve', actor: me, target: updated,
        amount: req.amount, detail: `balance ${updated.coins}`,
      });
      return json({ ok: true, status: 'approved', user: publicUser(updated) });
    }

    /* -- history and stats -- */

    if (pathname === '/api/admin/audit' && method === 'GET') {
      const action = url.searchParams.get('action');
      // Default page is 10; the UI asks for more on demand. One extra row is
      // fetched so the client can tell whether a "show more" button is needed.
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 10)));
      const probe = limit + 1;

      const query = action
        ? db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY at DESC LIMIT ?')
            .bind(action, probe)
        : db.prepare('SELECT * FROM audit_log ORDER BY at DESC LIMIT ?').bind(probe);

      const { results = [] } = await query.all();
      const hasMore = results.length > limit;
      return json({
        hasMore,
        entries: results.slice(0, limit).map((row) => ({
          id: row.id, at: row.at, action: row.action,
          actorId: row.actor_id, actorName: row.actor_name,
          targetId: row.target_id, targetName: row.target_name,
          amount: row.amount, detail: row.detail,
        })),
      });
    }

    // Who has received the most coins — today and all time.
    if (pathname === '/api/admin/topup-stats' && method === 'GET') {
      const offset = Number(env.TZ_OFFSET_MINUTES ?? 480);
      const CREDITED = "action IN ('topup_manual','topup_approve')";

      const rank = async (since) => {
        const { results = [] } = await db.prepare(
          `SELECT target_id, target_name, SUM(amount) AS total, COUNT(*) AS times
             FROM audit_log
            WHERE ${CREDITED} AND amount > 0 AND at >= ?
            GROUP BY target_id, target_name
            ORDER BY total DESC LIMIT 20`
        ).bind(since).all();
        return results.map((row) => ({
          userId: row.target_id,
          username: row.target_name,
          total: row.total,
          times: row.times,
        }));
      };

      return json({
        today: await rank(windowStart('day', offset)),
        allTime: await rank(0),
      });
    }

    if (pathname === '/api/admin/reload' && method === 'POST') {
      const { userId, amount } = await readJson(request);
      const target = await db.prepare('SELECT * FROM users WHERE id = ?')
        .bind(String(userId ?? '').trim()).first();
      if (!target) return fail(404, 'user_not_found', '找不到该用户 ID');

      const delta = Number(amount);
      if (!Number.isInteger(delta) || delta === 0) return fail(400, 'bad_amount', '充值金额无效');
      if (target.coins + delta < 0) {
        return fail(400, 'negative_balance', '扣款后余额会为负');
      }

      await db.prepare('UPDATE users SET coins = coins + ? WHERE id = ?')
        .bind(delta, target.id).run();
      const updated = await db.prepare('SELECT * FROM users WHERE id = ?').bind(target.id).first();
      await logAction(db, {
        action: 'topup_manual', actor: me, target: updated, amount: delta,
        detail: `${target.coins} -> ${updated.coins}`,
      });
      return json({ user: publicUser(updated) });
    }

    // Set an absolute balance — used by "clear to 0" and by keying in an
    // exact figure. Logged as a manual top-up with the signed difference.
    if (pathname === '/api/admin/set-coins' && method === 'POST') {
      const { userId, coins } = await readJson(request);
      const target = await db.prepare('SELECT * FROM users WHERE id = ?')
        .bind(String(userId ?? '').trim()).first();
      if (!target) return fail(404, 'user_not_found', '找不到该用户 ID');

      const value = Number(coins);
      if (!Number.isInteger(value) || value < 0) return fail(400, 'bad_amount', '金额无效');

      const delta = value - target.coins;
      await db.prepare('UPDATE users SET coins = ? WHERE id = ?').bind(value, target.id).run();
      const updated = await db.prepare('SELECT * FROM users WHERE id = ?').bind(target.id).first();
      await logAction(db, {
        action: 'topup_manual', actor: me, target: updated, amount: delta,
        detail: `set to ${value}`,
      });
      return json({ user: publicUser(updated) });
    }

    // Forgot-password: the admin clears it, the user sets the new one.
    // The admin never sees or chooses it.
    if (pathname === '/api/admin/clear-password' && method === 'POST') {
      const { userId } = await readJson(request);
      const target = await db.prepare('SELECT * FROM users WHERE id = ?')
        .bind(String(userId ?? '').trim()).first();
      if (!target) return fail(404, 'user_not_found', '找不到该用户 ID');
      // The superadmin account is never cleared here — not even by itself,
      // since that both risks a lockout and would invalidate the very session
      // making the request. Recovery is via the DWW_ADMIN_PASSWORD env var.
      // A regular admin can be cleared, but only by the super.
      if (target.is_super) {
        return fail(403, 'admin_protected', '不能清除超级管理员的密码');
      }
      if (target.is_admin && !me.is_super) {
        return fail(403, 'super_only', '仅超级管理员可操作管理员账号');
      }

      await db.batch([
        db.prepare(
          'UPDATE users SET salt = NULL, hash = NULL, must_reset = 1 WHERE id = ?'
        ).bind(target.id),
        // Sign them out everywhere.
        db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id),
      ]);

      await logAction(db, { action: 'clear_password', actor: me, target });
      return json({ user: { ...publicUser(target), mustReset: true } });
    }

    // Deleting an account is destructive and irreversible, so it requires the
    // admin to echo the exact username back — a deliberate confirmation gate.
    if (pathname === '/api/admin/delete-user' && method === 'POST') {
      const { userId, confirm } = await readJson(request);
      const target = await db.prepare('SELECT * FROM users WHERE id = ?')
        .bind(String(userId ?? '').trim()).first();
      if (!target) return fail(404, 'user_not_found', '找不到该用户 ID');
      // The superadmin account can never be deleted. A regular admin can be,
      // but only by the super.
      if (target.is_super) return fail(403, 'admin_protected', '不能删除超级管理员');
      if (target.is_admin && !me.is_super) {
        return fail(403, 'super_only', '仅超级管理员可删除管理员账号');
      }
      if (String(confirm ?? '').trim() !== target.username) {
        return fail(400, 'confirm_mismatch', '确认用户名不匹配');
      }

      await db.batch([
        db.prepare('DELETE FROM bets WHERE user_id = ?').bind(target.id),
        db.prepare('DELETE FROM records WHERE user_id = ?').bind(target.id),
        db.prepare('DELETE FROM topup_requests WHERE user_id = ?').bind(target.id),
        db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id),
        db.prepare('DELETE FROM users WHERE id = ?').bind(target.id),
      ]);

      // The audit row is kept — the account is gone but the record of its
      // deletion stays.
      await logAction(db, { action: 'delete_user', actor: me, target });
      return json({ ok: true });
    }
  }

  return fail(404, 'not_found', 'Not found');
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (error) {
      console.error(error);
      return fail(500, 'server_error', '服务器错误');
    }
  },
};
