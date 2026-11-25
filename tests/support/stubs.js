'use strict';
/*
 * HANYA UNTUK PENGUJIAN OTOMATIS.
 * - Stub OpenAI: meniru endpoint /v1/embeddings dan /v1/chat/completions secara deterministik,
 *   agar tes tidak memakan kuota API dan hasilnya bisa diulang.
 * - Stub web: halaman-halaman uji untuk fitur sumber link.
 * Aplikasi sungguhan tetap memanggil OpenAI asli lewat OPENAI_API_KEY.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const words = (s) => (s.toLowerCase().match(/[a-z0-9]{4,}/g) || []);

function vec(text) {
  const v = new Array(64).fill(0);
  for (const w of words(text)) {
    let hsh = 0; for (const ch of w) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
    v[hsh % 64] += 1;
  }
  return v;
}

function judge(userMsg) {
  const claim = (userMsg.match(/<klaim>\n([\s\S]*?)\n<\/klaim>/) || [])[1] || '';
  const src = [...userMsg.matchAll(/<sumber[^>]*>\n([\s\S]*?)\n<\/sumber>/g)].map((m) => m[1]).join(' ');
  const srcWords = new Set(words(src));
  const cw = [...new Set(words(claim))];
  const ratio = cw.length ? cw.filter((w) => srcWords.has(w)).length / cw.length : 0;
  if (ratio >= 0.6) return { verdict: 'SUPPORTED', score: Math.min(1, ratio + 0.2), reason: 'Klaim sesuai dengan isi sumber.' };
  if (ratio >= 0.3) return { verdict: 'PARTIAL', score: ratio, reason: 'Hanya sebagian klaim yang ada di sumber.' };
  return { verdict: 'NOT_SUPPORTED', score: ratio / 2, reason: 'Klaim tidak ditemukan di sumber yang dilampirkan.' };
}

function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });
}

function startOpenAIStub() {
  const srv = http.createServer(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || '{}');
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/embeddings')) {
      const input = Array.isArray(body.input) ? body.input : [body.input];
      return res.end(JSON.stringify({ object: 'list', data: input.map((t, i) => ({ object: 'embedding', index: i, embedding: vec(t) })), model: body.model }));
    }
    if (req.url.endsWith('/chat/completions')) {
      const user = body.messages.find((m) => m.role === 'user').content;
      const out = judge(user);
      return res.end(JSON.stringify({ id: 'stub', object: 'chat.completion', created: 0, model: body.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(out) } }] }));
    }
    res.statusCode = 404; res.end('{}');
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

const ARTICLE = `<!doctype html><html><head><title>Kurang Tidur Turunkan Daya Ingat Mahasiswa</title></head><body>
<nav>menu</nav><article><h1>Kurang Tidur Turunkan Daya Ingat Mahasiswa</h1>
<p>Sebuah penelitian terhadap 120 mahasiswa menemukan bahwa mahasiswa yang tidur tujuh sampai delapan jam memiliki skor daya ingat
23 persen lebih tinggi dibanding mahasiswa yang tidur kurang dari lima jam.</p>
<p>Para peneliti menyebut kurang tidur menurunkan konsentrasi dan kemampuan mengingat materi kuliah, terutama menjelang ujian.
Mereka menyarankan mahasiswa menjaga jadwal tidur yang teratur.</p></article><script>alert('x')</script></body></html>`;

function startWebStub() {
  const pdf = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'jurnal_valid.pdf'));
  const srv = http.createServer((req, res) => {
    switch (req.url) {
      case '/artikel': res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(ARTICLE);
      case '/pendek': res.setHeader('Content-Type', 'text/html'); return res.end('<html><body><p>Halo.</p></body></html>');
      case '/dok.pdf': res.setHeader('Content-Type', 'application/pdf'); return res.end(pdf);
      case '/gambar.png': res.setHeader('Content-Type', 'image/png'); return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      case '/ke-instagram': res.statusCode = 302; res.setHeader('Location', 'https://www.instagram.com/p/abc/'); return res.end();
      default: res.statusCode = 404; return res.end('not found');
    }
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

module.exports = { startOpenAIStub, startWebStub };
