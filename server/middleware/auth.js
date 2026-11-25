'use strict';
/* Sesi: JWT HS256 di cookie httpOnly + SameSite=Strict (+ Secure di production). */
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');
const { unauthorized } = require('../errors');

const COOKIE = 'rujuk_token';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'strict',
  secure: config.isProd,
  path: '/',
});

const findUser = db.prepare(
  'SELECT id, username, display_name, email, bio, created_at FROM users WHERE id = ?',
);

function issueToken(res, user) {
  const token = jwt.sign({ sub: String(user.id) }, config.jwtSecret, { algorithm: 'HS256', expiresIn: '7d' });
  res.cookie(COOKIE, token, { ...cookieOptions(), maxAge: MAX_AGE_MS });
}

function clearToken(res) {
  res.clearCookie(COOKIE, cookieOptions());
}

/** Kembalikan user dari cookie, atau null jika tidak ada/tidak valid. Tidak pernah melempar. */
function userFromRequest(req) {
  const token = req.cookies && req.cookies[COOKIE];
  if (typeof token !== 'string' || token === '' || token.length > 2048) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (typeof payload.sub !== 'string' || !/^[1-9][0-9]{0,15}$/.test(payload.sub)) return null;
    return findUser.get(Number(payload.sub)) || null;
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const user = userFromRequest(req);
  if (!user) return next(unauthorized());
  req.user = user;
  return next();
}

function optionalAuth(req, res, next) {
  req.user = userFromRequest(req);
  next();
}

module.exports = { COOKIE, issueToken, clearToken, requireAuth, optionalAuth };
