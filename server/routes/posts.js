'use strict';
/* /api/posts/* — tweet, retweet (quote + sumber sendiri), like, komentar. Hitungan selalu COUNT(*). */
const express = require('express');
const db = require('../db');
const { AppError, validationError, forbidden, notFound } = require('../errors');
const { validatePost, validateComment, idParam, cursorParam, usernameParam } = require('../validators');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { requireAI, verifyClaim, isAccepted } = require('../services/rag');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const PAGE_SIZE = 20;

const placeholders = (n) => new Array(n).fill('?').join(', ');

const POST_SELECT = `
  SELECT p.id, p.kind, p.parent_id, p.content, p.created_at, p.verification_verdict, p.verification_score,
         p.verification_reason, u.id AS author_id, u.username, u.display_name,
         (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
         (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
         (SELECT COUNT(*) FROM posts r WHERE r.parent_id = p.id) AS retweet_count
  FROM posts p JOIN users u ON u.id = p.user_id`;

const q = {
  feed: db.prepare(`${POST_SELECT} WHERE (? IS NULL OR p.id < ?) ORDER BY p.id DESC LIMIT ?`),
  feedByUser: db.prepare(`${POST_SELECT} WHERE u.username = ? AND (? IS NULL OR p.id < ?) ORDER BY p.id DESC LIMIT ?`),
  one: db.prepare(`${POST_SELECT} WHERE p.id = ?`),
  owner: db.prepare('SELECT id, user_id, content FROM posts WHERE id = ?'),
  insertPost: db.prepare(`INSERT INTO posts (user_id, kind, parent_id, content, verification_verdict, verification_score, verification_reason)
                          VALUES (?, ?, ?, ?, ?, ?, ?)`),
  insertPostSource: db.prepare('INSERT INTO post_sources (post_id, source_id) VALUES (?, ?)'),
  insertLog: db.prepare(`INSERT INTO verification_logs (user_id, kind, content, source_ids, verdict, score, reason, accepted, post_id)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  delPost: db.prepare('DELETE FROM posts WHERE id = ?'),
  like: db.prepare('INSERT OR IGNORE INTO likes (user_id, post_id) VALUES (?, ?)'),
  unlike: db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?'),
  likeCount: db.prepare('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?'),
  comments: db.prepare(`SELECT c.id, c.post_id, c.content, c.created_at, u.id AS author_id, u.username, u.display_name
                        FROM comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = ? ORDER BY c.id ASC LIMIT 500`),
  comment: db.prepare(`SELECT c.id, c.post_id, c.content, c.created_at, u.id AS author_id, u.username, u.display_name
                       FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?`),
  insertComment: db.prepare('INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)'),
  commentCount: db.prepare('SELECT COUNT(*) AS n FROM comments WHERE post_id = ?'),
};

// ------------------------------------------------------------------ serialisasi
function loadSources(postIds) {
  const map = new Map(postIds.map((id) => [id, []]));
  if (!postIds.length) return map;
  const rows = db.prepare(`SELECT ps.post_id, s.id, s.kind, s.category, s.title, s.url, s.original_name
                           FROM post_sources ps JOIN sources s ON s.id = ps.source_id
                           WHERE ps.post_id IN (${placeholders(postIds.length)}) ORDER BY s.id`).all(...postIds);
  for (const r of rows) {
    map.get(r.post_id).push({
      id: r.id, kind: r.kind, category: r.category, title: r.title, url: r.url, original_name: r.original_name,
      file_url: r.kind === 'pdf' ? `/api/sources/${r.id}/file` : null,
    });
  }
  return map;
}

function likedSet(postIds, viewerId) {
  if (!viewerId || !postIds.length) return new Set();
  const rows = db.prepare(`SELECT post_id FROM likes WHERE user_id = ? AND post_id IN (${placeholders(postIds.length)})`)
    .all(viewerId, ...postIds);
  return new Set(rows.map((r) => r.post_id));
}

function serialize(row, sources, liked) {
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    created_at: row.created_at,
    author: { id: row.author_id, username: row.username, display_name: row.display_name },
    sources: sources.get(row.id) || [],
    verification: { verdict: row.verification_verdict, score: row.verification_score, reason: row.verification_reason },
    like_count: row.like_count,
    comment_count: row.comment_count,
    retweet_count: row.retweet_count,
    liked_by_me: liked.has(row.id),
    parent_id: row.parent_id,
    parent: null,
  };
}

/** Ubah baris DB menjadi objek `post` sesuai kontrak API (termasuk tweet asli untuk retweet, satu tingkat). */
function hydratePosts(rows, viewerId) {
  const parentIds = [...new Set(rows.map((r) => r.parent_id).filter(Boolean))];
  const parentRows = parentIds.length
    ? db.prepare(`${POST_SELECT} WHERE p.id IN (${placeholders(parentIds.length)})`).all(...parentIds)
    : [];
  const allIds = [...new Set([...rows.map((r) => r.id), ...parentRows.map((r) => r.id)])];
  const sources = loadSources(allIds);
  const liked = likedSet(allIds, viewerId);
  const parents = new Map(parentRows.map((r) => [r.id, serialize(r, sources, liked)]));
  return rows.map((r) => {
    const p = serialize(r, sources, liked);
    p.parent = r.parent_id ? parents.get(r.parent_id) || null : null;
    return p;
  });
}

function hydrateOne(id, viewerId) {
  const row = q.one.get(id);
  return row ? hydratePosts([row], viewerId)[0] : null;
}

const serializeComment = (r) => ({
  id: r.id, post_id: r.post_id, content: r.content, created_at: r.created_at,
  author: { id: r.author_id, username: r.username, display_name: r.display_name },
});

// ------------------------------------------------------------------ feed & detail
router.get('/', optionalAuth, (req, res) => {
  const cursor = cursorParam(req.query.cursor);
  const viewerId = req.user ? req.user.id : null;
  let rows;
  if (req.query.user !== undefined) {
    const username = usernameParam(req.query.user, 'user');
    rows = q.feedByUser.all(username, cursor, cursor, PAGE_SIZE + 1);
  } else {
    rows = q.feed.all(cursor, cursor, PAGE_SIZE + 1);
  }
  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);
  res.json({ posts: hydratePosts(page, viewerId), next_cursor: hasMore ? page[page.length - 1].id : null });
});

router.get('/:id', optionalAuth, (req, res) => {
  const id = idParam(req.params.id);
  const post = hydrateOne(id, req.user ? req.user.id : null);
  if (!post) throw notFound('Tweet tidak ditemukan.');
  res.json({ post, comments: q.comments.all(id).map(serializeComment) });
});

// ------------------------------------------------------------------ tweet / retweet
function loadOwnedChunks(userId, sourceIds) {
  const owned = db.prepare(`SELECT id, title FROM sources WHERE user_id = ? AND id IN (${placeholders(sourceIds.length)})`)
    .all(userId, ...sourceIds);
  if (owned.length !== sourceIds.length) {
    throw validationError({ source_ids: 'Sebagian sumber tidak ditemukan atau bukan milik Anda.' }, 'Sumber tidak valid.');
  }
  const titles = new Map(owned.map((s) => [s.id, s.title]));
  const chunks = db.prepare(`SELECT source_id, content, embedding FROM source_chunks
                             WHERE source_id IN (${placeholders(sourceIds.length)}) ORDER BY source_id, idx`).all(...sourceIds);
  return chunks.map((c) => {
    let embedding;
    try { embedding = JSON.parse(c.embedding); } catch { embedding = []; }
    return { content: c.content, embedding, title: titles.get(c.source_id) || '' };
  });
}

const publish = db.transaction((userId, v, kind, result) => {
  // Cek ulang di dalam transaksi: sumber masih milik user & tweet asli masih ada.
  const owned = db.prepare(`SELECT COUNT(*) AS n FROM sources WHERE user_id = ? AND id IN (${placeholders(v.source_ids.length)})`)
    .get(userId, ...v.source_ids).n;
  if (owned !== v.source_ids.length) {
    throw validationError({ source_ids: 'Sebagian sumber tidak ditemukan atau bukan milik Anda.' }, 'Sumber tidak valid.');
  }
  if (v.parent_id && !q.owner.get(v.parent_id)) throw notFound('Tweet yang ingin di-retweet tidak ditemukan.');
  const postId = q.insertPost.run(userId, kind, v.parent_id, v.content, result.verdict, result.score, result.reason).lastInsertRowid;
  for (const sid of v.source_ids) q.insertPostSource.run(postId, sid);
  q.insertLog.run(userId, kind, v.content, JSON.stringify(v.source_ids), result.verdict, result.score, result.reason, 1, postId);
  return postId;
});

router.post('/', requireAuth, requireAI, wrap(async (req, res) => {
  const v = validatePost(req.body);
  const kind = v.parent_id ? 'retweet' : 'tweet';
  let parent = null;
  if (v.parent_id) {
    parent = q.owner.get(v.parent_id);
    if (!parent) throw notFound('Tweet yang ingin di-retweet tidak ditemukan.');
  }
  const chunks = loadOwnedChunks(req.user.id, v.source_ids);
  const result = await verifyClaim(v.content, chunks, parent ? parent.content : null);

  if (!isAccepted(result)) {
    q.insertLog.run(req.user.id, kind, v.content, JSON.stringify(v.source_ids), result.verdict, result.score, result.reason, 0, null);
    throw new AppError(422, 'NOT_SUPPORTED_BY_SOURCE',
      'Isi tweet tidak sesuai dengan sumber yang dilampirkan, sehingga tidak dipublikasikan.',
      { content: result.reason, verdict: result.verdict, score: result.score });
  }

  const postId = publish(req.user.id, v, kind, result);
  res.status(201).json({ post: hydrateOne(postId, req.user.id) });
}));

router.delete('/:id', requireAuth, (req, res) => {
  const id = idParam(req.params.id);
  const p = q.owner.get(id);
  if (!p) throw notFound('Tweet tidak ditemukan.');
  if (p.user_id !== req.user.id) throw forbidden('Anda hanya bisa menghapus tweet milik sendiri.');
  q.delPost.run(id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ like
function requirePost(id) {
  if (!q.owner.get(id)) throw notFound('Tweet tidak ditemukan.');
}

router.post('/:id/like', requireAuth, (req, res) => {
  const id = idParam(req.params.id);
  requirePost(id);
  q.like.run(req.user.id, id);
  res.json({ liked: true, like_count: q.likeCount.get(id).n });
});

router.delete('/:id/like', requireAuth, (req, res) => {
  const id = idParam(req.params.id);
  requirePost(id);
  q.unlike.run(req.user.id, id);
  res.json({ liked: false, like_count: q.likeCount.get(id).n });
});

// ------------------------------------------------------------------ komentar (tanpa sumber, tanpa AI)
router.get('/:id/comments', (req, res) => {
  const id = idParam(req.params.id);
  requirePost(id);
  res.json({ comments: q.comments.all(id).map(serializeComment) });
});

router.post('/:id/comments', requireAuth, (req, res) => {
  const id = idParam(req.params.id);
  const v = validateComment(req.body);
  requirePost(id);
  const cid = q.insertComment.run(id, req.user.id, v.content).lastInsertRowid;
  res.status(201).json({ comment: serializeComment(q.comment.get(cid)), comment_count: q.commentCount.get(id).n });
});

module.exports = { router, hydratePosts };
