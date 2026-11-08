// Database layer with one async API and two backends:
//   • Turso (free cloud SQLite) over its HTTP API — used when TURSO_DATABASE_URL is set.
//     Survives restarts, so it works on free hosting (e.g. Render free).
//   • Local SQLite file via Node's built-in node:sqlite — for local use or hosts with a disk.
// API: await db.get(sql, args) -> row | undefined, db.all(...) -> rows, db.run(...) -> { changes, lastInsertRowid }
const path = require('path');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'subscriber',
    tier TEXT NOT NULL DEFAULT 'free',
    premium_until TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS briefs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    brief_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    published_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brief_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    heading TEXT NOT NULL,
    body_md TEXT NOT NULL DEFAULT '',
    premium INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS sections_brief ON sections(brief_id, position)`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    order_id TEXT,
    payment_id TEXT,
    amount_paise INTEGER,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // App secrets (session key, push keys) live here so they survive restarts on free hosting.
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

// ---------- local file backend ----------
function localDb(dataDir) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'news.db'));
  db.exec('PRAGMA journal_mode = WAL');
  const norm = (args) => (args || []).map((a) => (typeof a === 'boolean' ? (a ? 1 : 0) : a === undefined ? null : a));
  return {
    kind: 'local file',
    async get(sql, args) { return db.prepare(sql).get(...norm(args)); },
    async all(sql, args) { return db.prepare(sql).all(...norm(args)); },
    async run(sql, args) {
      const r = db.prepare(sql).run(...norm(args));
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
  };
}

// ---------- Turso backend (Hrana over HTTP, v2 pipeline API) ----------
function tursoDb(url, token) {
  const base = url.replace(/^libsql:\/\//, 'https://').replace(/\/$/, '');
  const encode = (v) => {
    if (v === null || v === undefined) return { type: 'null' };
    if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
    if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
    if (typeof v === 'bigint') return { type: 'integer', value: v.toString() };
    return { type: 'text', value: String(v) };
  };
  const decode = (c) => {
    if (!c || c.type === 'null') return null;
    if (c.type === 'integer') return Number(c.value);
    if (c.type === 'float') return Number(c.value);
    if (c.type === 'blob') return Buffer.from(c.base64, 'base64');
    return c.value;
  };
  async function execute(sql, args) {
    const res = await fetch(`${base}/v2/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, args: (args || []).map(encode) } }, { type: 'close' }] }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Turso HTTP ${res.status}: ${text.slice(0, 200)}`);
    const out = JSON.parse(text).results[0];
    if (out.type !== 'ok') throw new Error(`Turso error: ${out.error?.message || 'unknown'}`);
    const r = out.response.result;
    const cols = r.cols.map((c) => c.name);
    return {
      rows: r.rows.map((row) => Object.fromEntries(row.map((cell, i) => [cols[i], decode(cell)]))),
      changes: Number(r.affected_row_count || 0),
      lastInsertRowid: r.last_insert_rowid == null ? null : Number(r.last_insert_rowid),
    };
  }
  return {
    kind: 'Turso',
    async get(sql, args) { return (await execute(sql, args)).rows[0]; },
    async all(sql, args) { return (await execute(sql, args)).rows; },
    async run(sql, args) { const r = await execute(sql, args); return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }; },
  };
}

async function open(dataDir) {
  const url = process.env.TURSO_DATABASE_URL;
  const db = url ? tursoDb(url, process.env.TURSO_AUTH_TOKEN || '') : localDb(dataDir);
  for (const stmt of SCHEMA) await db.run(stmt);
  db.getSetting = async (key) => (await db.get('SELECT value FROM settings WHERE key = ?', [key]))?.value;
  db.setSetting = (key, value) => db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
  return db;
}

module.exports = { open };
