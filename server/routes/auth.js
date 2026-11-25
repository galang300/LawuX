'use strict';
/* /api/auth/* — FORM 1 (registrasi) & FORM 2 (login). */
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { AppError, conflict, unauthorized } = require('../errors');
const { validateRegister, validateLogin } = require('../validators');
const { issueToken, clearToken, requireAuth } = require('../middleware/auth');

const router = express.Router();

const BCRYPT_COST = 12;
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;
const LOGIN_FAILED = 'Username/email atau password salah.';

// Hash dummy: dipakai saat user tidak ditemukan agar waktu respons seragam (anti user-enumeration).
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_COST);

const q = {
  byUsername: db.prepare('SELECT id FROM users WHERE username = ?'),
  byEmail: db.prepare('SELECT id FROM users WHERE email = ?'),
  insert: db.prepare('INSERT INTO users (username, display_name, email, password_hash) VALUES (?, ?, ?, ?)'),
  publicUser: db.prepare('SELECT id, username, display_name, email, bio, created_at FROM users WHERE id = ?'),
  loginByUsername: db.prepare('SELECT id, password_hash, failed_logins, locked_until FROM users WHERE username = ?'),
  loginByEmail: db.prepare('SELECT id, password_hash, failed_logins, locked_until FROM users WHERE email = ?'),
  incFailed: db.prepare('UPDATE users SET failed_logins = failed_logins + 1 WHERE id = ? RETURNING failed_logins'),
  lock: db.prepare('UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?'),
  resetFailed: db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?'),
};

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function lockedError(lockedUntil) {
  const minutes = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 60000));
  return new AppError(423, 'ACCOUNT_LOCKED',
    `Akun dikunci sementara karena terlalu banyak percobaan login gagal. Coba lagi dalam ${minutes} menit.`);
}

router.post('/register', wrap(async (req, res) => {
  const v = validateRegister(req.body);

  const fields = {};
  if (q.byUsername.get(v.username)) fields.username = 'Username sudah dipakai.';
  if (q.byEmail.get(v.email)) fields.email = 'Email sudah terdaftar.';
  if (Object.keys(fields).length) throw conflict('Username atau email sudah terdaftar.', fields);

  const hash = await bcrypt.hash(v.password, BCRYPT_COST);
  let id;
  try {
    id = q.insert.run(v.username, v.display_name, v.email, hash).lastInsertRowid;
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw conflict('Username atau email sudah terdaftar.', { username: 'Username atau email sudah terdaftar.' });
    }
    throw err;
  }
  const user = q.publicUser.get(id);
  issueToken(res, user);
  res.status(201).json({ user });
}));

const registerFailure = db.transaction((userId) => {
  const { failed_logins: n } = q.incFailed.get(userId);
  if (n >= MAX_FAILED) {
    const until = Date.now() + LOCK_MS;
    q.lock.run(until, userId);
    return until;
  }
  return null;
});

router.post('/login', wrap(async (req, res) => {
  const v = validateLogin(req.body);
  const row = v.identifier.includes('@')
    ? q.loginByEmail.get(v.identifier.toLowerCase())
    : q.loginByUsername.get(v.identifier);

  if (row && row.locked_until && row.locked_until > Date.now()) throw lockedError(row.locked_until);

  const ok = await bcrypt.compare(v.password, row ? row.password_hash : DUMMY_HASH);
  if (!row || !ok) {
    if (row) {
      const lockedUntil = registerFailure(row.id);
      if (lockedUntil) throw lockedError(lockedUntil);
    }
    throw new AppError(401, 'INVALID_CREDENTIALS', LOGIN_FAILED);
  }

  q.resetFailed.run(row.id);
  const user = q.publicUser.get(row.id);
  issueToken(res, user);
  res.json({ user });
}));

router.post('/logout', (req, res) => {
  clearToken(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  if (!req.user) throw unauthorized();
  res.json({ user: req.user });
});

module.exports = router;
