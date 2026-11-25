'use strict';
/* Koneksi SQLite + skema. Semua query di aplikasi memakai prepared statement. */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true, mode: 0o700 });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name    TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash   TEXT NOT NULL,
  bio             TEXT NOT NULL DEFAULT '',
  failed_logins   INTEGER NOT NULL DEFAULT 0,
  locked_until    INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sources (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('pdf','link')),
  category       TEXT NOT NULL CHECK (category IN ('jurnal','buku','paper','dokumen','artikel')),
  title          TEXT NOT NULL,
  url            TEXT,
  file_name      TEXT,
  original_name  TEXT,
  sha256         TEXT,
  text_length    INTEGER NOT NULL,
  chunk_count    INTEGER NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sources_user ON sources(user_id);

CREATE TABLE IF NOT EXISTS source_chunks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id  INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  content    TEXT NOT NULL,
  embedding  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON source_chunks(source_id);

CREATE TABLE IF NOT EXISTS posts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL CHECK (kind IN ('tweet','retweet')),
  parent_id            INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  content              TEXT NOT NULL,
  verification_verdict TEXT NOT NULL,
  verification_score   REAL NOT NULL,
  verification_reason  TEXT NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_parent ON posts(parent_id);

CREATE TABLE IF NOT EXISTS post_sources (
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  source_id  INTEGER NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  PRIMARY KEY (post_id, source_id)
);

CREATE TABLE IF NOT EXISTS likes (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, post_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);

CREATE TABLE IF NOT EXISTS verification_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  content     TEXT NOT NULL,
  source_ids  TEXT NOT NULL,
  verdict     TEXT NOT NULL,
  score       REAL NOT NULL,
  reason      TEXT NOT NULL,
  accepted    INTEGER NOT NULL,
  post_id     INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

module.exports = db;
