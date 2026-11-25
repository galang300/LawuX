'use strict';
/*
 * Konfigurasi aplikasi. Dibaca SEKALI saat modul pertama kali di-require.
 * - File .env dibaca tanpa dependensi tambahan dan TIDAK menimpa variabel yang sudah ada
 *   (tes otomatis & docker compose mengisi process.env lebih dulu).
 * - Saat NODE_ENV=test, file .env diabaikan sama sekali.
 * - Objek yang diekspor sengaja bisa diubah (tes mengubah config.allowPrivateUrls).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

function loadDotEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return; // .env tidak wajib ada
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2];
    const quoted = value.match(/^(['"])(.*)\1$/);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '');
    if (!Object.prototype.hasOwnProperty.call(process.env, key)) process.env[key] = value;
  }
}

if (process.env.NODE_ENV !== 'test') loadDotEnv(path.join(ROOT, '.env'));

function fail(message) {
  throw new Error(`Konfigurasi tidak valid: ${message}`);
}

/** Nilai string env; string kosong dianggap tidak diisi. */
function str(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function num(name, fallback, { min, max, integer = false }) {
  const raw = str(name);
  if (raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    fail(`${name} harus ${integer ? 'bilangan bulat' : 'angka'} antara ${min} dan ${max}.`);
  }
  return n;
}

function bool(name) {
  const raw = str(name, 'false').toLowerCase();
  if (raw !== 'true' && raw !== 'false') fail(`${name} harus true atau false.`);
  return raw === 'true';
}

const env = str('NODE_ENV', 'development');
if (!['development', 'production', 'test'].includes(env)) {
  fail('NODE_ENV harus development, production, atau test.');
}
const isProd = env === 'production';
const isTest = env === 'test';

let jwtSecret = str('JWT_SECRET');
if (jwtSecret.length < 32) {
  if (isProd) fail('JWT_SECRET wajib diisi minimal 32 karakter acak di production.');
  jwtSecret = crypto.randomBytes(48).toString('hex');
  if (!isTest) {
    console.warn('[config] JWT_SECRET kosong/terlalu pendek: memakai secret acak sementara. ' +
      'Semua sesi login hilang setiap server dimulai ulang. Isi JWT_SECRET di .env.');
  }
}

// Rujuk hanya mendukung OpenAI API resmi (api.openai.com). OPENAI_BASE_URL hanya dipakai tes otomatis
// untuk mengarahkan klien ke stub lokal, sehingga di luar NODE_ENV=test variabel ini ditolak.
const openaiBaseURL = str('OPENAI_BASE_URL');
if (openaiBaseURL && !isTest) {
  fail('OPENAI_BASE_URL hanya untuk tes otomatis. Rujuk hanya mendukung OpenAI API resmi; kosongkan variabel ini.');
}

const allowPrivateUrls = bool('ALLOW_PRIVATE_URLS');
if (allowPrivateUrls && isProd) fail('ALLOW_PRIVATE_URLS=true hanya boleh untuk tes otomatis, bukan production.');

const MB = 1024 * 1024;

const config = {
  env,
  isProd,
  isTest,
  port: num('PORT', 3000, { min: 1, max: 65535, integer: true }),
  jwtSecret,
  openai: {
    apiKey: str('OPENAI_API_KEY'),
    baseURL: openaiBaseURL || undefined,
    chatModel: str('OPENAI_CHAT_MODEL', 'gpt-4o-mini'),
    embedModel: str('OPENAI_EMBED_MODEL', 'text-embedding-3-small'),
  },
  verifyMinScore: num('VERIFY_MIN_SCORE', 0.7, { min: 0, max: 1 }),
  maxPdfBytes: num('MAX_PDF_MB', 10, { min: 1, max: 50 }) * MB,
  maxFetchBytes: num('MAX_FETCH_MB', 5, { min: 1, max: 50 }) * MB,
  fetchTimeoutMs: num('FETCH_TIMEOUT_MS', 15000, { min: 1000, max: 60000, integer: true }),
  minSourceTextChars: num('MIN_SOURCE_TEXT_CHARS', 200, { min: 1, max: 100000, integer: true }),
  maxChunksPerSource: num('MAX_CHUNKS_PER_SOURCE', 150, { min: 1, max: 1000, integer: true }),
  dbPath: path.resolve(ROOT, str('DB_PATH', './data/rujuk.db')),
  uploadDir: path.resolve(ROOT, str('UPLOAD_DIR', './uploads')),
  publicDir: path.join(ROOT, 'public'),
  allowPrivateUrls,
};

Object.defineProperty(config, 'aiConfigured', {
  enumerable: true,
  get() { return config.openai.apiKey !== ''; },
});

if (!isTest && !config.openai.apiKey) {
  console.warn('[config] OPENAI_API_KEY kosong: endpoint sumber & tweet akan membalas 503 AI_NOT_CONFIGURED.');
}

module.exports = config;
