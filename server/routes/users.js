'use strict';
/* /api/users/:username, /api/me, /api/me/verifications, /api/comments/:id */
const express = require('express');
const db = require('../db');
const { forbidden, notFound } = require('../errors');
const { validateProfile, idParam, usernameParam } = require('../validators');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const q = {
  profile: db.prepare(`
    SELECT u.id, u.username, u.display_name, u.bio, u.created_at,
           (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id AND p.kind = 'tweet') AS tweet_count,
           (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id AND p.kind = 'retweet') AS retweet_count,
           (SELECT COUNT(*) FROM sources s WHERE s.user_id = u.id) AS source_count
    FROM users u WHERE u.username = ?`),
  me: db.prepare('SELECT id, username, display_name, email, bio, created_at FROM users WHERE id = ?'),
  updateName: db.prepare('UPDATE users SET display_name = ? WHERE id = ?'),
  updateBio: db.prepare('UPDATE users SET bio = ? WHERE id = ?'),
  logs: db.prepare(`SELECT id, kind, content, source_ids, verdict, score, reason, accepted, post_id, created_at
                    FROM verification_logs WHERE user_id = ? ORDER BY id DESC LIMIT 50`),
  comment: db.prepare('SELECT id, user_id FROM comments WHERE id = ?'),
  delComment: db.prepare('DELETE FROM comments WHERE id = ?'),
};

// Profil publik: tanpa email.
router.get('/users/:username', (req, res) => {
  const username = usernameParam(req.params.username);
  const user = q.profile.get(username);
  if (!user) throw notFound('Pengguna tidak ditemukan.');
  res.json({ user });
});

const updateProfile = db.transaction((id, v) => {
  if (v.display_name !== undefined) q.updateName.run(v.display_name, id);
  if (v.bio !== undefined) q.updateBio.run(v.bio, id);
});

router.patch('/me', requireAuth, (req, res) => {
  const v = validateProfile(req.body);
  updateProfile(req.user.id, v);
  res.json({ user: q.me.get(req.user.id) });
});

router.get('/me/verifications', requireAuth, (req, res) => {
  const logs = q.logs.all(req.user.id).map((r) => {
    let sourceIds = [];
    try { sourceIds = JSON.parse(r.source_ids); } catch { /* */ }
    return { ...r, source_ids: Array.isArray(sourceIds) ? sourceIds : [], accepted: r.accepted === 1 };
  });
  res.json({ logs });
});

router.delete('/comments/:id', requireAuth, (req, res) => {
  const id = idParam(req.params.id);
  const c = q.comment.get(id);
  if (!c) throw notFound('Komentar tidak ditemukan.');
  if (c.user_id !== req.user.id) throw forbidden('Anda hanya bisa menghapus komentar milik sendiri.');
  q.delComment.run(id);
  res.json({ ok: true });
});

module.exports = router;
