'use strict';
/*
 * SEMUA aturan validasi input. Berbasis whitelist.
 * Setiap validator mengumpulkan semua error field sekaligus, lalu melempar
 * AppError 400 VALIDATION_ERROR dengan `fields`. Jika lolos, mengembalikan nilai yang sudah dibersihkan.
 */
const { validationError } = require('./errors');

const CATEGORIES = ['jurnal', 'buku', 'paper', 'dokumen', 'artikel'];

// Karakter kontrol (kecuali \t \n \r), zero-width, dan bidi override.
const FORBIDDEN_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/;
const LINE_BREAK_OR_TAB = /[\r\n\t]/;
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const ID_RE = /^[1-9][0-9]{0,15}$/;
const HTML_CHARS = /[<>"'`]/;

const MSG = {
  username: 'Username 3–20 karakter, hanya huruf, angka, dan garis bawah (_).',
  categoryList: `Kategori harus salah satu dari: ${CATEGORIES.join(', ')}.`,
};

/** Ambil properti milik objek sendiri saja (bukan dari prototype). */
function own(obj, key) {
  return obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/** Body harus objek biasa; selain itu dianggap kosong (semua field wajib akan gagal). */
function asObject(body) {
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

const cpLength = (s) => [...s].length;
const normalize = (s) => s.normalize('NFC').trim();

function finish(errors, value, message) {
  if (Object.keys(errors).length > 0) throw validationError(errors, message);
  return value;
}

/** Nama tampilan: dipakai di registrasi dan ubah profil. Mengembalikan [nilai, pesanError]. */
function checkDisplayName(raw) {
  if (typeof raw !== 'string') return [null, 'Nama tampilan wajib diisi.'];
  const v = normalize(raw);
  if (v === '') return [null, 'Nama tampilan wajib diisi.'];
  if (cpLength(v) > 50) return [null, 'Nama tampilan maksimal 50 karakter.'];
  if (FORBIDDEN_CHARS.test(v) || LINE_BREAK_OR_TAB.test(v)) {
    return [null, 'Nama tampilan tidak boleh mengandung baris baru atau karakter kontrol.'];
  }
  if (HTML_CHARS.test(v)) return [null, 'Nama tampilan tidak boleh mengandung karakter < > " \' `.'];
  return [v, null];
}

/** Teks bebas (tweet, komentar): 1..max code point, tanpa karakter kontrol/bidi. */
function checkText(raw, { label, max }) {
  if (typeof raw !== 'string') return [null, `${label} wajib diisi.`];
  const v = normalize(raw);
  if (v === '') return [null, `${label} wajib diisi.`];
  if (cpLength(v) > max) return [null, `${label} maksimal ${max} karakter.`];
  if (FORBIDDEN_CHARS.test(v)) return [null, `${label} mengandung karakter yang tidak diizinkan.`];
  return [v, null];
}

// ------------------------------------------------------------------ FORM 1 — Registrasi
function validateRegister(body) {
  const b = asObject(body);
  const errors = {};
  const out = {};

  const username = own(b, 'username');
  if (username === undefined || username === null || username === '') errors.username = 'Username wajib diisi.';
  else if (typeof username !== 'string' || !USERNAME_RE.test(username)) errors.username = MSG.username;
  else out.username = username;

  const [displayName, dnErr] = checkDisplayName(own(b, 'display_name'));
  if (dnErr) errors.display_name = dnErr; else out.display_name = displayName;

  const emailRaw = own(b, 'email');
  if (typeof emailRaw !== 'string' || emailRaw.trim() === '') {
    errors.email = 'Email wajib diisi.';
  } else {
    const email = emailRaw.trim().toLowerCase();
    if (email.length > 254 || !EMAIL_RE.test(email) || email.includes('..')) errors.email = 'Format email tidak valid.';
    else out.email = email;
  }

  const password = own(b, 'password');
  if (typeof password !== 'string' || password === '') {
    errors.password = 'Password wajib diisi.';
  } else if (cpLength(password) < 8) {
    errors.password = 'Password minimal 8 karakter.';
  } else if (Buffer.byteLength(password, 'utf8') > 72) {
    errors.password = 'Password maksimal 72 byte.';
  } else if (/\s/u.test(password)) {
    errors.password = 'Password tidak boleh mengandung spasi.';
  } else if (FORBIDDEN_CHARS.test(password)) {
    errors.password = 'Password mengandung karakter yang tidak diizinkan.';
  } else if (!/\p{L}/u.test(password) || !/\p{Nd}/u.test(password)) {
    errors.password = 'Password harus mengandung huruf dan angka.';
  } else if (out.username && password.toLowerCase().includes(out.username.toLowerCase())) {
    errors.password = 'Password tidak boleh memuat username.';
  } else {
    out.password = password;
  }

  const confirm = own(b, 'confirm_password');
  if (typeof confirm !== 'string' || confirm === '') errors.confirm_password = 'Konfirmasi password wajib diisi.';
  else if (confirm !== password) errors.confirm_password = 'Konfirmasi password tidak sama.';

  return finish(errors, out, 'Data registrasi tidak valid.');
}

// ------------------------------------------------------------------ FORM 2 — Login
function validateLogin(body) {
  const b = asObject(body);
  const errors = {};
  const out = {};

  const idRaw = own(b, 'identifier');
  if (typeof idRaw !== 'string' || idRaw.trim() === '') {
    errors.identifier = 'Username atau email wajib diisi.';
  } else {
    const identifier = idRaw.trim();
    if (identifier.length > 254 || /\s/u.test(identifier) || FORBIDDEN_CHARS.test(identifier)) {
      errors.identifier = 'Username atau email tidak valid.';
    } else {
      out.identifier = identifier;
    }
  }

  const password = own(b, 'password');
  if (typeof password !== 'string' || password === '') errors.password = 'Password wajib diisi.';
  else if (Buffer.byteLength(password, 'utf8') > 72) errors.password = 'Password tidak valid.';
  else out.password = password;

  return finish(errors, out, 'Data login tidak valid.');
}

// ------------------------------------------------------------------ FORM 3a — Tweet / Retweet
function validatePost(body) {
  const b = asObject(body);
  const errors = {};
  const out = {};

  const [content, cErr] = checkText(own(b, 'content'), { label: 'Isi tweet', max: 280 });
  if (cErr) errors.content = cErr; else out.content = content;

  const ids = own(b, 'source_ids');
  if (!Array.isArray(ids) || ids.length === 0) {
    errors.source_ids = 'Lampirkan minimal 1 sumber (PDF dan/atau link).';
  } else if (ids.length > 3) {
    errors.source_ids = 'Maksimal 3 sumber per tweet.';
  } else if (!ids.every((x) => Number.isSafeInteger(x) && x > 0)) {
    errors.source_ids = 'ID sumber tidak valid.';
  } else if (new Set(ids).size !== ids.length) {
    errors.source_ids = 'Sumber yang sama tidak boleh dilampirkan dua kali.';
  } else {
    out.source_ids = ids;
  }

  const parent = own(b, 'parent_id');
  if (parent === undefined || parent === null) {
    out.parent_id = null;
  } else if (!Number.isSafeInteger(parent) || parent <= 0) {
    errors.parent_id = 'ID tweet yang di-retweet tidak valid.';
  } else {
    out.parent_id = parent;
  }

  return finish(errors, out, 'Data tweet tidak valid.');
}

// ------------------------------------------------------------------ Komentar
function validateComment(body) {
  const b = asObject(body);
  const errors = {};
  const [content, err] = checkText(own(b, 'content'), { label: 'Komentar', max: 280 });
  if (err) errors.content = err;
  return finish(errors, { content }, 'Data komentar tidak valid.');
}

// ------------------------------------------------------------------ Profil
function validateProfile(body) {
  const b = asObject(body);
  const errors = {};
  const out = {};

  const dn = own(b, 'display_name');
  if (dn !== undefined) {
    const [v, err] = checkDisplayName(dn);
    if (err) errors.display_name = err; else out.display_name = v;
  }

  const bio = own(b, 'bio');
  if (bio !== undefined) {
    if (bio === null) {
      out.bio = '';
    } else if (typeof bio !== 'string') {
      errors.bio = 'Bio harus berupa teks.';
    } else {
      const v = normalize(bio);
      if (cpLength(v) > 160) errors.bio = 'Bio maksimal 160 karakter.';
      else if (FORBIDDEN_CHARS.test(v)) errors.bio = 'Bio mengandung karakter yang tidak diizinkan.';
      else out.bio = v;
    }
  }

  if (dn === undefined && bio === undefined) errors.display_name = 'Isi nama tampilan atau bio yang ingin diubah.';
  return finish(errors, out, 'Data profil tidak valid.');
}

// ------------------------------------------------------------------ FORM 3b/3c — metadata sumber
function checkCategory(raw) {
  if (raw === undefined || raw === null || raw === '') return [null, 'Kategori sumber wajib dipilih.'];
  if (typeof raw !== 'string' || !CATEGORIES.includes(raw.trim())) return [null, MSG.categoryList];
  return [raw.trim(), null];
}

function checkTitle(raw) {
  if (raw === undefined || raw === null) return [null, null];
  if (typeof raw !== 'string') return [null, 'Judul harus berupa teks.'];
  const v = normalize(raw);
  if (v === '') return [null, null];
  if (cpLength(v) > 200) return [null, 'Judul maksimal 200 karakter.'];
  if (FORBIDDEN_CHARS.test(v) || LINE_BREAK_OR_TAB.test(v)) {
    return [null, 'Judul tidak boleh mengandung baris baru atau karakter kontrol.'];
  }
  return [v, null];
}

/** Metadata sumber (kategori + judul). Dipakai bersama validasi file/link agar error terkumpul. */
function sourceMetaErrors(b) {
  const errors = {};
  const out = {};
  const [category, catErr] = checkCategory(own(b, 'category'));
  if (catErr) errors.category = catErr; else out.category = category;
  const [title, tErr] = checkTitle(own(b, 'title'));
  if (tErr) errors.title = tErr; else out.title = title;
  return { errors, out };
}

function validateSourceMeta(body, extraErrors = {}) {
  const { errors, out } = sourceMetaErrors(asObject(body));
  return finish({ ...extraErrors, ...errors }, out, 'Data sumber tidak valid.');
}

/** Cek format URL (tanpa jaringan). Blocklist & SSRF dicek di services/sources.js. */
function checkUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return [null, 'Link sumber wajib diisi.'];
  const v = raw.trim();
  if (v.length > 2048) return [null, 'Link maksimal 2048 karakter.'];
  if (/\s/u.test(v) || FORBIDDEN_CHARS.test(v)) return [null, 'Link mengandung karakter yang tidak diizinkan.'];
  let u;
  try { u = new URL(v); } catch { return [null, 'Format link tidak valid.']; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return [null, 'Link harus diawali http:// atau https://.'];
  if (u.username || u.password) return [null, 'Link tidak boleh berisi username/password.'];
  const host = u.hostname;
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
  if (!host || (!isIp && !host.includes('.')) || host.startsWith('.') || host.endsWith('.')) {
    return [null, 'Format link tidak valid.'];
  }
  u.hash = '';
  return [u.toString(), null];
}

function validateLinkInput(body) {
  const b = asObject(body);
  const { errors, out } = sourceMetaErrors(b);
  const [url, uErr] = checkUrl(own(b, 'url'));
  if (uErr) errors.url = uErr; else out.url = url;
  return finish(errors, out, 'Data link tidak valid.');
}

// ------------------------------------------------------------------ parameter path & query
function idParam(value, field = 'id') {
  if (typeof value !== 'string' || !ID_RE.test(value) || !Number.isSafeInteger(Number(value))) {
    throw validationError({ [field]: 'ID tidak valid.' }, 'Parameter tidak valid.');
  }
  return Number(value);
}

function cursorParam(value) {
  if (value === undefined || value === '') return null;
  return idParam(value, 'cursor');
}

function usernameParam(value, field = 'username') {
  if (typeof value !== 'string' || !USERNAME_RE.test(value)) {
    throw validationError({ [field]: MSG.username }, 'Parameter tidak valid.');
  }
  return value;
}

module.exports = {
  CATEGORIES,
  FORBIDDEN_CHARS,
  validateRegister,
  validateLogin,
  validatePost,
  validateComment,
  validateProfile,
  validateSourceMeta,
  validateLinkInput,
  idParam,
  cursorParam,
  usernameParam,
};
