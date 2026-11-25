'use strict';
/* /api/sources/* — pustaka sumber (FORM 3b Upload PDF & FORM 3c Tambah link). */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const db = require('../db');
const { validationError, forbidden, notFound, conflict } = require('../errors');
const { validateSourceMeta, validateLinkInput, idParam } = require('../validators');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { requireAI, chunkText, embed } = require('../services/rag');
const { extractPdf, loadLink, assertEnoughText } = require('../services/sources');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const SOURCE_COLS = 'id, kind, category, title, url, original_name, text_length, chunk_count, created_at';
const FILE_NAME_RE = /^[a-f0-9]{32}\.pdf$/;

const q = {
  byId: db.prepare('SELECT id, user_id, kind, file_name, original_name FROM sources WHERE id = ?'),
  publicById: db.prepare(`SELECT ${SOURCE_COLS} FROM sources WHERE id = ?`),
  listMine: db.prepare(`SELECT ${SOURCE_COLS} FROM sources WHERE user_id = ? ORDER BY id DESC LIMIT 100`),
  dupPdf: db.prepare(`SELECT ${SOURCE_COLS} FROM sources WHERE user_id = ? AND kind = 'pdf' AND sha256 = ?`),
  dupLink: db.prepare(`SELECT ${SOURCE_COLS} FROM sources WHERE user_id = ? AND kind = 'link' AND url = ?`),
  insert: db.prepare(`INSERT INTO sources (user_id, kind, category, title, url, file_name, original_name, sha256, text_length, chunk_count)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  insertChunk: db.prepare('INSERT INTO source_chunks (source_id, idx, content, embedding) VALUES (?, ?, ?, ?)'),
  isUsed: db.prepare('SELECT 1 FROM post_sources WHERE source_id = ? LIMIT 1'),
  del: db.prepare('DELETE FROM sources WHERE id = ?'),
};

/** Simpan sumber + seluruh chunk dalam SATU transaksi. */
const saveSource = db.transaction((userId, s, chunks, vectors) => {
  const id = q.insert.run(userId, s.kind, s.category, s.title, s.url, s.file_name, s.original_name, s.sha256,
    s.text_length, chunks.length).lastInsertRowid;
  chunks.forEach((c, i) => q.insertChunk.run(id, i, c, JSON.stringify(vectors[i])));
  return id;
});

async function indexText(text, field) {
  const chunks = chunkText(text);
  if (!chunks.length) throw validationError({ [field]: 'Sumber tidak memiliki cukup teks untuk diverifikasi.' });
  const vectors = await embed(chunks);
  return { chunks, vectors };
}

const sanitizeName = (name) => String(name || '').replace(/[^\w.\- ]/g, '_').slice(0, 200) || 'dokumen.pdf';

// ------------------------------------------------------------------ upload PDF
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxPdfBytes, files: 1, fields: 5, fieldSize: 1024, parts: 7 },
});

router.post('/pdf', requireAuth, requireAI, upload.single('file'), wrap(async (req, res) => {
  const file = req.file;
  let fileErr = null;
  if (!file || !file.buffer || file.size === 0) {
    fileErr = 'File PDF wajib dipilih.';
  } else if (path.extname(String(file.originalname || '')).toLowerCase() !== '.pdf' || file.mimetype !== 'application/pdf') {
    fileErr = 'File harus berformat PDF.';
  } else if (file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    fileErr = 'Isi file bukan PDF (signature %PDF- tidak ditemukan).';
  }
  const meta = validateSourceMeta(req.body, fileErr ? { file: fileErr } : {});

  const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const existing = q.dupPdf.get(req.user.id, sha256);
  if (existing) return res.json({ source: existing, duplicate: true });

  const { text, title: pdfTitle } = await extractPdf(file.buffer, 'file');
  assertEnoughText(text, 'file');
  const { chunks, vectors } = await indexText(text, 'file');

  const originalName = sanitizeName(path.basename(String(file.originalname)));
  const fileName = `${crypto.randomBytes(16).toString('hex')}.pdf`;
  const target = path.join(config.uploadDir, fileName);
  fs.writeFileSync(target, file.buffer, { flag: 'wx', mode: 0o600 });

  let id;
  try {
    id = saveSource(req.user.id, {
      kind: 'pdf',
      category: meta.category,
      title: (meta.title || pdfTitle || originalName.replace(/\.pdf$/i, '') || 'Dokumen PDF').slice(0, 200),
      url: null,
      file_name: fileName,
      original_name: originalName,
      sha256,
      text_length: text.length,
    }, chunks, vectors);
  } catch (err) {
    fs.rmSync(target, { force: true });
    throw err;
  }
  return res.status(201).json({ source: q.publicById.get(id) });
}));

// ------------------------------------------------------------------ tambah link
router.post('/link', requireAuth, requireAI, wrap(async (req, res) => {
  const v = validateLinkInput(req.body);
  const existing = q.dupLink.get(req.user.id, v.url);
  if (existing) return res.json({ source: existing, duplicate: true });

  const page = await loadLink(v.url);
  const existingFinal = q.dupLink.get(req.user.id, page.finalUrl);
  if (existingFinal) return res.json({ source: existingFinal, duplicate: true });

  assertEnoughText(page.text, 'url');
  const { chunks, vectors } = await indexText(page.text, 'url');
  const id = saveSource(req.user.id, {
    kind: 'link',
    category: v.category,
    title: (v.title || page.title).slice(0, 200),
    url: page.finalUrl,
    file_name: null,
    original_name: null,
    sha256: null,
    text_length: page.text.length,
  }, chunks, vectors);
  return res.status(201).json({ source: q.publicById.get(id) });
}));

// ------------------------------------------------------------------ daftar, unduh, hapus
router.get('/', requireAuth, (req, res) => {
  res.json({ sources: q.listMine.all(req.user.id) });
});

router.get('/:id/file', optionalAuth, (req, res, next) => {
  const id = idParam(req.params.id);
  const s = q.byId.get(id);
  // 404 (bukan 403) untuk sumber milik orang lain yang belum publik: tidak membocorkan keberadaannya.
  if (!s || s.kind !== 'pdf') throw notFound('File tidak ditemukan.');
  const isOwner = req.user && req.user.id === s.user_id;
  if (!isOwner && !q.isUsed.get(id)) throw notFound('File tidak ditemukan.');
  if (!FILE_NAME_RE.test(s.file_name || '')) throw notFound('File tidak ditemukan.');

  const root = path.resolve(config.uploadDir);
  const full = path.resolve(root, s.file_name);
  if (!full.startsWith(root + path.sep)) throw notFound('File tidak ditemukan.');

  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return next(notFound('File tidak ditemukan.'));
    const name = sanitizeName(s.original_name);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', st.size);
    res.setHeader('Content-Disposition', `inline; filename="${name.replace(/"/g, '_')}"`);
    const stream = fs.createReadStream(full);
    stream.on('error', (e) => next(e));
    return stream.pipe(res);
  });
});

router.delete('/:id', requireAuth, (req, res) => {
  const id = idParam(req.params.id);
  const s = q.byId.get(id);
  if (!s) throw notFound('Sumber tidak ditemukan.');
  if (s.user_id !== req.user.id) throw forbidden('Anda hanya bisa menghapus sumber milik sendiri.');
  if (q.isUsed.get(id)) throw conflict('Sumber sudah dipakai di tweet sehingga tidak bisa dihapus.');
  try {
    q.del.run(id);
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      throw conflict('Sumber sudah dipakai di tweet sehingga tidak bisa dihapus.');
    }
    throw err;
  }
  if (s.kind === 'pdf' && FILE_NAME_RE.test(s.file_name || '')) {
    fs.rm(path.join(config.uploadDir, s.file_name), { force: true }, () => {});
  }
  res.json({ ok: true });
});

module.exports = router;
