'use strict';
/*
 * Sumber rujukan: ekstraksi teks PDF (unpdf) dan pengambilan link (anti-SSRF).
 * "Jangan percaya link": blocklist media sosial, tolak IP privat (dicek pada alamat yang BENAR-BENAR
 * dipakai untuk koneksi lewat `lookup`, sehingga tidak bisa diakali DNS rebinding), redirect manual
 * maks 3 hop dengan cek ulang, batas waktu & ukuran unduhan, jenis konten hanya HTML/PDF/teks.
 */
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const cheerio = require('cheerio');
const config = require('../config');
const { AppError, validationError } = require('../errors');

// ------------------------------------------------------------------ blocklist domain media sosial
const BLOCKED_DOMAINS = [
  'instagram.com', 'instagr.am', 'ig.me',
  'tiktok.com', 'douyin.com',
  'facebook.com', 'fb.com', 'fb.watch', 'fb.me', 'messenger.com',
  'twitter.com', 'x.com', 't.co',
  'threads.net', 'threads.com',
  'snapchat.com', 'pinterest.com', 'pin.it',
  'linkedin.com', 'lnkd.in',
  'reddit.com', 'redd.it',
  'tumblr.com', 'quora.com',
  'youtube.com', 'youtu.be',
  'whatsapp.com', 'wa.me', 't.me', 'telegram.org', 'telegram.me',
  'discord.com', 'discord.gg',
  'weibo.com', 'vk.com', 'likee.video', 'kwai.com', 'kuaishou.com',
  'bsky.app', 'mastodon.social', 'line.me',
  'bit.ly', 'tinyurl.com', 's.id',
];

const MSG = {
  social: 'Link media sosial atau pemendek link tidak diterima. Gunakan sumber ilmiah/berita/dokumen, bukan media sosial.',
  private: 'Alamat internal/privat tidak diizinkan.',
  unreadablePdf: 'PDF tidak dapat dibaca.',
  tooLittleText: 'Sumber tidak memiliki cukup teks untuk diverifikasi.',
  contentType: 'Jenis konten tidak didukung.',
  tooManyRedirects: 'Link terlalu banyak dialihkan (maksimal 3 kali).',
  unreachable: 'Halaman tidak dapat diakses. Periksa link lalu coba lagi.',
  timeout: 'Halaman terlalu lama merespons. Coba lagi atau gunakan link lain.',
};

const urlError = (msg) => validationError({ url: msg }, 'Link sumber tidak valid.');

function isBlockedHost(hostname) {
  const h = hostname.toLowerCase().replace(/\.+$/, '');
  return BLOCKED_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

// ------------------------------------------------------------------ IP privat (SSRF)
function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc * 256) + Number(o), 0);
}

const V4_BLOCKS = [
  ['10.0.0.0', 8], ['127.0.0.0', 8], ['0.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['224.0.0.0', 3],
].map(([base, bits]) => [ipv4ToInt(base), bits]);

function isPrivateV4(ip) {
  const n = ipv4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    return n >= base && n < base + size;
  });
}

/** Ubah IPv6 menjadi 8 grup angka 16-bit. Mengembalikan null jika tidak valid. */
function expandV6(ip) {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  // Ekor IPv4 (mis. ::ffff:127.0.0.1) diubah ke dua grup hex.
  const v4 = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    s = s.slice(0, -v4[1].length) + `${(Math.floor(n / 65536)).toString(16)}:${(n % 65536).toString(16)}`;
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = parts.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...new Array(Math.max(0, fill)).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  return groups.map((g) => parseInt(g || '0', 16));
}

function isPrivateIp(ip) {
  const family = net.isIP(ip.replace(/^\[|\]$/g, ''));
  if (family === 4) return isPrivateV4(ip);
  if (family !== 6) return true; // bukan IP valid → anggap tidak aman
  const g = expandV6(ip);
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
  // IPv4-mapped (::ffff:a.b.c.d) dan IPv4-compatible (::a.b.c.d)
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    const v4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
    return isPrivateV4(v4);
  }
  return false;
}

/** Cek URL sebelum setiap hop: protokol, kredensial, blocklist, dan IP literal privat. */
function assertUrlAllowed(u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw urlError('Link harus diawali http:// atau https://.');
  if (u.username || u.password) throw urlError('Link tidak boleh berisi username/password.');
  if (isBlockedHost(u.hostname)) throw urlError(MSG.social);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !config.allowPrivateUrls && isPrivateIp(host)) throw urlError(MSG.private);
}

/** dns.lookup yang menolak alamat privat. Dipakai http(s).request sehingga IP yang dicek = IP yang dihubungi. */
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!config.allowPrivateUrls && addresses.some((a) => isPrivateIp(a.address))) {
      const e = new Error('private address'); e.code = 'EPRIVATE';
      return callback(e);
    }
    if (options && options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

function requestOnce(u, deadline) {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(urlError(MSG.timeout));
    const req = lib.request(u, {
      method: 'GET',
      lookup: safeLookup,
      headers: {
        'User-Agent': 'RujukBot/1.0 (verifikasi sumber)',
        Accept: 'text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.1',
        'Accept-Encoding': 'identity',
      },
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT_RUJUK' })), remaining);
    req.on('response', (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400) {
        res.resume();
        clearTimeout(timer);
        return resolve({ status, location: res.headers.location });
      }
      if (status < 200 || status >= 300) {
        res.resume();
        clearTimeout(timer);
        return resolve({ status });
      }
      const type = String(res.headers['content-type'] || '').toLowerCase();
      const kind = contentKind(type);
      if (!kind) {
        res.destroy();
        clearTimeout(timer);
        return reject(urlError(MSG.contentType));
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > config.maxFetchBytes) {
        res.destroy();
        clearTimeout(timer);
        return reject(urlError(`Ukuran halaman melebihi ${Math.round(config.maxFetchBytes / (1024 * 1024))} MB.`));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > config.maxFetchBytes) {
          res.destroy();
          clearTimeout(timer);
          reject(urlError(`Ukuran halaman melebihi ${Math.round(config.maxFetchBytes / (1024 * 1024))} MB.`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status, kind, type, body: Buffer.concat(chunks) });
      });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

function contentKind(type) {
  const base = type.split(';')[0].trim();
  if (base === 'text/html' || base === 'application/xhtml+xml') return 'html';
  if (base === 'application/pdf') return 'pdf';
  if (base === 'text/plain') return 'text';
  return null;
}

function mapNetworkError(err) {
  if (err instanceof AppError) return err;
  if (err && err.code === 'EPRIVATE') return urlError(MSG.private);
  if (err && err.code === 'ETIMEDOUT_RUJUK') return urlError(MSG.timeout);
  if (err && (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN')) return urlError('Domain tidak ditemukan. Periksa link lalu coba lagi.');
  return urlError(MSG.unreachable);
}

/**
 * Ambil link dengan redirect manual (maks 3 hop, cek ulang setiap hop).
 * Mengembalikan { finalUrl, kind: 'html'|'pdf'|'text', body: Buffer, type }.
 */
async function fetchLink(urlString) {
  const deadline = Date.now() + config.fetchTimeoutMs;
  let u = new URL(urlString);
  for (let hop = 0; hop <= 3; hop += 1) {
    assertUrlAllowed(u);
    let r;
    try {
      r = await requestOnce(u, deadline);
    } catch (err) {
      throw mapNetworkError(err);
    }
    if (r.location !== undefined || (r.status >= 300 && r.status < 400)) {
      if (!r.location) throw urlError(MSG.unreachable);
      if (hop === 3) throw urlError(MSG.tooManyRedirects);
      try { u = new URL(r.location, u); } catch { throw urlError(MSG.unreachable); }
      u.hash = '';
      continue;
    }
    if (r.status < 200 || r.status >= 300) throw urlError(`Halaman tidak tersedia (HTTP ${r.status}).`);
    return { finalUrl: u.toString(), kind: r.kind, type: r.type, body: r.body };
  }
  throw urlError(MSG.tooManyRedirects);
}

// ------------------------------------------------------------------ ekstraksi teks
function cleanText(text) {
  return String(text)
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

let unpdfPromise;
const loadUnpdf = () => { unpdfPromise = unpdfPromise || import('unpdf'); return unpdfPromise; };

/** Ekstrak { text, title } dari buffer PDF. Melempar 400 field `fieldName` jika PDF tidak terbaca. */
async function extractPdf(buffer, fieldName = 'file') {
  const { getDocumentProxy, extractText, getMeta } = await loadUnpdf();
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    let title = null;
    try {
      const meta = await getMeta(pdf);
      const t = meta && meta.info && typeof meta.info.Title === 'string' ? cleanText(meta.info.Title) : '';
      if (t && t.toLowerCase() !== 'untitled') title = t;
    } catch { /* metadata opsional */ }
    return { text: cleanText(text), title };
  } catch {
    throw validationError({ [fieldName]: MSG.unreadablePdf }, 'Sumber tidak valid.');
  } finally {
    if (pdf) { try { await pdf.destroy(); } catch { /* */ } }
  }
}

function decodeBody(buffer, type) {
  const m = /charset=([^;]+)/i.exec(type || '');
  try {
    return new TextDecoder(m ? m[1].trim().replace(/"/g, '') : 'utf-8').decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

function extractHtml(html) {
  const $ = cheerio.load(html);
  const title = cleanText($('meta[property="og:title"]').attr('content') || $('title').first().text() || '');
  $('script, style, nav, footer, header, aside, form, iframe, svg, noscript, template').remove();
  $('br').replaceWith('\n');
  $('p, div, li, tr, section, article, main, blockquote, pre, h1, h2, h3, h4, h5, h6').each((_, el) => {
    $(el).append('\n\n');
  });
  let root = $('article').first();
  if (!root.length) root = $('main').first();
  if (!root.length) root = $('body').first();
  const text = cleanText(root.length ? root.text() : $.root().text());
  return { text, title: title || null };
}

/** Ambil link lalu ekstrak teksnya. Mengembalikan { finalUrl, text, title }. */
async function loadLink(urlString) {
  const r = await fetchLink(urlString);
  let out;
  if (r.kind === 'pdf') {
    if (r.body.subarray(0, 5).toString('latin1') !== '%PDF-') throw urlError(MSG.contentType);
    out = await extractPdf(r.body, 'url');
  } else if (r.kind === 'html') {
    out = extractHtml(decodeBody(r.body, r.type));
  } else {
    out = { text: cleanText(decodeBody(r.body, r.type)), title: null };
  }
  if (!out.title) {
    const u = new URL(r.finalUrl);
    out.title = (u.hostname + (u.pathname !== '/' ? u.pathname : '')).slice(0, 200);
  }
  return { finalUrl: r.finalUrl, text: out.text, title: out.title.slice(0, 200) };
}

function assertEnoughText(text, field) {
  if (!text || text.length < config.minSourceTextChars) {
    throw validationError({ [field]: MSG.tooLittleText }, 'Sumber tidak valid.');
  }
}

module.exports = {
  BLOCKED_DOMAINS,
  isBlockedHost,
  isPrivateIp,
  assertUrlAllowed,
  fetchLink,
  loadLink,
  extractPdf,
  extractHtml,
  cleanText,
  assertEnoughText,
};
