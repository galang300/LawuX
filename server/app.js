'use strict';
/* App Express: middleware keamanan, routing, error handler terpusat. Diekspor TANPA listen() (dipakai tes). */
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const db = require('./db');
const { AppError, notFound } = require('./errors');

fs.mkdirSync(config.uploadDir, { recursive: true, mode: 0o700 });

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);

// ------------------------------------------------------------ HTTP hardening
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
}));

// ------------------------------------------------------------ rate limit (dilewati saat NODE_ENV=test)
function limiter(max, { writesOnly = false } = {}) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => config.isTest || (writesOnly && !WRITE_METHODS.has(req.method)),
    handler: (req, res, next) =>
      next(new AppError(429, 'RATE_LIMITED', 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.')),
  });
}
app.use('/api/auth', limiter(20));
app.use('/api/sources', limiter(15, { writesOnly: true }));
app.use(['/api/posts', '/api/comments'], limiter(60, { writesOnly: true }));

// ------------------------------------------------------------ cek Origin untuk method tulis
// Origin kosong diizinkan (curl, fetch dari Node). Origin ada tetapi host-nya beda → 403.
app.use((req, res, next) => {
  if (!WRITE_METHODS.has(req.method)) return next();
  const origin = req.get('origin');
  if (origin === undefined) return next();
  let originHost = null;
  try { originHost = new URL(origin).host; } catch { /* Origin tidak valid, mis. "null" */ }
  if (!originHost || originHost !== req.get('host')) {
    return next(new AppError(403, 'BAD_ORIGIN', 'Permintaan dari situs lain ditolak.'));
  }
  return next();
});

// ------------------------------------------------------------ parser
app.use('/api', express.json({ limit: '50kb', strict: true }));
app.use('/api', cookieParser());
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// ------------------------------------------------------------ routes
app.get('/api/health', (req, res) => {
  db.prepare('SELECT 1').get();
  res.json({ ok: true, ai_configured: config.aiConfigured });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/sources', require('./routes/sources'));
app.use('/api/posts', require('./routes/posts').router);
app.use('/api', require('./routes/users'));

app.use('/api', (req, res, next) => next(notFound('Endpoint tidak ditemukan.')));
app.use(express.static(config.publicDir, { dotfiles: 'ignore', index: 'index.html' }));
app.use((req, res, next) => next(notFound('Halaman tidak ditemukan.')));

// ------------------------------------------------------------ error handler terpusat
const MULTER_MESSAGES = {
  LIMIT_FILE_SIZE: () => `Ukuran PDF maksimal ${Math.round(config.maxPdfBytes / (1024 * 1024))} MB.`,
  LIMIT_FILE_COUNT: () => 'Hanya boleh mengunggah satu file.',
  LIMIT_UNEXPECTED_FILE: () => 'File harus dikirim lewat isian "file".',
  LIMIT_FIELD_VALUE: () => 'Isian terlalu panjang.',
  LIMIT_FIELD_KEY: () => 'Nama isian terlalu panjang.',
  LIMIT_FIELD_COUNT: () => 'Terlalu banyak isian.',
  LIMIT_PART_COUNT: () => 'Terlalu banyak isian.',
};

function toAppError(err) {
  if (err instanceof AppError) return err;
  if (err && err.type === 'entity.too.large') {
    return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Data yang dikirim terlalu besar.');
  }
  if (err && typeof err.type === 'string' && err.status >= 400 && err.status < 500) {
    // entity.parse.failed, charset/encoding tidak didukung, dll. dari body-parser
    return new AppError(400, 'BAD_JSON', 'Format JSON tidak valid.');
  }
  if (err && err.name === 'MulterError') {
    const msg = (MULTER_MESSAGES[err.code] || (() => 'Unggahan tidak valid.'))();
    const fieldName = ['LIMIT_FILE_SIZE', 'LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE'].includes(err.code)
      ? 'file' : (err.field || 'file');
    return new AppError(400, 'VALIDATION_ERROR', 'Unggahan tidak valid.', { [fieldName]: msg });
  }
  console.error(err); // detail hanya di log server
  return new AppError(500, 'INTERNAL', 'Terjadi kesalahan pada server.');
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const e = toAppError(err);
  if (res.headersSent) return res.end();
  const body = { error: { code: e.code, message: e.message } };
  if (e.fields) body.error.fields = e.fields;
  return res.status(e.status).json(body);
});

module.exports = app;
