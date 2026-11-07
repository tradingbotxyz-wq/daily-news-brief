const { DatabaseSync } = require('node:sqlite');
const path = require('path');

function open(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'news.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'subscriber',      -- subscriber | admin
      tier TEXT NOT NULL DEFAULT 'free',             -- free | premium
      premium_until TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS briefs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      brief_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',          -- draft | published
      source TEXT NOT NULL DEFAULT 'manual',          -- manual | claude
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      published_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brief_id INTEGER NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      heading TEXT NOT NULL,
      body_md TEXT NOT NULL DEFAULT '',
      premium INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      provider TEXT NOT NULL,
      order_id TEXT,
      payment_id TEXT,
      amount_paise INTEGER,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

module.exports = { open };
