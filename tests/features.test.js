'use strict';
/* Uji fungsional alur BENAR: semua fitur tersimpan ke database dan terbaca lagi dari API. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startOpenAIStub, startWebStub } = require('./support/stubs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rujuk-feat-'));
let server, base, ai, web, webBase;

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, form) {
    const h = {}; if (this.cookie) h.Cookie = this.cookie;
    let payload = form;
    if (!form && body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    const res = await fetch(base + url, { method, headers: h, body: payload });
    const sc = res.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    let json = null; try { json = await res.json(); } catch { /* */ }
    return { status: res.status, body: json };
  }
}

before(async () => {
  ai = await startOpenAIStub(); web = await startWebStub();
  webBase = `http://127.0.0.1:${web.address().port}`;
  Object.assign(process.env, {
    NODE_ENV: 'test', DB_PATH: path.join(tmp, 'f.db'), UPLOAD_DIR: path.join(tmp, 'up'),
    OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: `http://127.0.0.1:${ai.address().port}/v1`, JWT_SECRET: 'y'.repeat(48), ALLOW_PRIVATE_URLS: 'true',
  });
  const app = require('../server/app');
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); ai.close(); web.close(); });

test('alur lengkap: daftar → sumber → tweet → like → komentar → retweet → hapus', async () => {
  const a = new Client(); const b = new Client();
  assert.equal((await a.req('POST', '/api/auth/register', { username: 'sinta', display_name: 'Sinta', email: 's@mail.com', password: 'Kuat12345', confirm_password: 'Kuat12345' })).status, 201);
  assert.equal((await b.req('POST', '/api/auth/register', { username: 'raka', display_name: 'Raka', email: 'r@mail.com', password: 'Kuat12345', confirm_password: 'Kuat12345' })).status, 201);
  assert.equal((await a.req('GET', '/api/auth/me')).body.user.username, 'sinta');

  // Logout lalu login lagi
  await a.req('POST', '/api/auth/logout'); a.cookie = '';
  assert.equal((await a.req('GET', '/api/auth/me')).status, 401);
  assert.equal((await a.req('POST', '/api/auth/login', { identifier: 's@mail.com', password: 'Kuat12345' })).status, 200);

  // Sumber PDF + link
  const fd = new FormData(); fd.append('category', 'jurnal');
  fd.append('file', new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', 'jurnal_valid.pdf'))], { type: 'application/pdf' }), 'jurnal.pdf');
  const pdf = await a.req('POST', '/api/sources/pdf', undefined, fd);
  assert.equal(pdf.status, 201); assert.ok(pdf.body.source.chunk_count >= 1);
  assert.equal(pdf.body.source.title, 'Pengaruh Tidur terhadap Daya Ingat Mahasiswa');
  const lnk = await a.req('POST', '/api/sources/link', { url: `${webBase}/artikel`, category: 'artikel' });
  assert.equal(lnk.status, 201); assert.equal(lnk.body.source.title, 'Kurang Tidur Turunkan Daya Ingat Mahasiswa');
  const dup = await a.req('POST', '/api/sources/link', { url: `${webBase}/artikel`, category: 'artikel' });
  assert.equal(dup.status, 200); assert.equal(dup.body.duplicate, true);
  assert.equal((await a.req('GET', '/api/sources')).body.sources.length, 2);

  // Tweet dengan PDF + link (dua-duanya)
  const t = await a.req('POST', '/api/posts', { content: 'Kurang tidur menurunkan konsentrasi dan kemampuan mengingat materi kuliah mahasiswa.', source_ids: [pdf.body.source.id, lnk.body.source.id] });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  const pid = t.body.post.id;
  assert.equal(t.body.post.sources.length, 2);
  assert.equal(t.body.post.verification.verdict, 'SUPPORTED');

  // PDF publik bisa diunduh tamu setelah dilampirkan
  const file = await fetch(`${base}/api/sources/${pdf.body.source.id}/file`);
  assert.equal(file.status, 200); assert.equal(file.headers.get('content-type'), 'application/pdf');

  // Like (idempoten) & unlike
  assert.equal((await b.req('POST', `/api/posts/${pid}/like`)).body.like_count, 1);
  assert.equal((await b.req('POST', `/api/posts/${pid}/like`)).body.like_count, 1);
  assert.equal((await a.req('POST', `/api/posts/${pid}/like`)).body.like_count, 2);
  assert.equal((await a.req('DELETE', `/api/posts/${pid}/like`)).body.like_count, 1);

  // Komentar tanpa sumber
  const c = await b.req('POST', `/api/posts/${pid}/comments`, { content: 'Menarik, <b>terima kasih</b> sumbernya!' });
  assert.equal(c.status, 201); assert.equal(c.body.comment_count, 1);
  assert.equal(c.body.comment.content, 'Menarik, <b>terima kasih</b> sumbernya!'); // disimpan apa adanya, dirender sebagai teks
  assert.equal((await a.req('DELETE', `/api/comments/${c.body.comment.id}`)).status, 403);

  // Retweet oleh Raka dengan sumber miliknya sendiri
  const lb = await b.req('POST', '/api/sources/link', { url: `${webBase}/dok.pdf`, category: 'paper' });
  assert.equal(lb.status, 201);
  const rt = await b.req('POST', '/api/posts', { content: 'Setuju, peneliti menyarankan jadwal tidur yang teratur selama masa ujian.', source_ids: [lb.body.source.id], parent_id: pid });
  assert.equal(rt.status, 201, JSON.stringify(rt.body));
  assert.equal(rt.body.post.kind, 'retweet'); assert.equal(rt.body.post.parent.id, pid);

  // Feed & detail & profil membaca dari DB
  const feed = await b.req('GET', '/api/posts');
  assert.equal(feed.body.posts.length, 2);
  const orig = feed.body.posts.find((p) => p.id === pid);
  assert.equal(orig.like_count, 1); assert.equal(orig.comment_count, 1); assert.equal(orig.retweet_count, 1); assert.equal(orig.liked_by_me, true);
  assert.equal((await a.req('GET', `/api/posts/${pid}`)).body.comments.length, 1);
  const prof = await a.req('GET', '/api/users/raka');
  assert.equal(prof.body.user.retweet_count, 1);
  assert.equal((await a.req('GET', '/api/posts?user=sinta')).body.posts.length, 1);
  assert.equal((await a.req('PATCH', '/api/me', { display_name: 'Sinta W.', bio: 'Mahasiswa SE' })).body.user.bio, 'Mahasiswa SE');

  // Riwayat verifikasi
  const logs = await a.req('GET', '/api/me/verifications');
  assert.equal(logs.body.logs[0].accepted, true);

  // Sumber yang dipakai tidak bisa dihapus; hapus tweet oleh bukan pemilik ditolak; pemilik boleh
  assert.equal((await a.req('DELETE', `/api/sources/${pdf.body.source.id}`)).status, 409);
  assert.equal((await b.req('DELETE', `/api/posts/${pid}`)).status, 403);
  assert.equal((await a.req('DELETE', `/api/posts/${pid}`)).status, 200);
  const after = await b.req('GET', `/api/posts/${rt.body.post.id}`);
  assert.equal(after.body.post.parent, null); // retweet tetap ada, tweet asli sudah dihapus
});
