# Panduan Kontribusi

Terima kasih sudah tertarik berkontribusi ke Rujuk!

## Menyiapkan lingkungan
```bash
npm install
cp .env.example .env   # isi OPENAI_API_KEY untuk mencoba aplikasi; tes tidak membutuhkannya
npm test               # semua tes harus lulus
npm run dev
```

## Aturan kode
- CommonJS (`require`), `'use strict'`, indentasi 2 spasi, titik koma.
- Pesan error untuk pengguna dalam **Bahasa Indonesia**, singkat, dan menyebut cara memperbaikinya.
- Validasi input hanya di `server/validators.js` (whitelist). Route tidak memvalidasi secara ad-hoc.
- Lempar `AppError(status, code, message, fields)` dan biarkan error handler terpusat yang membalas.
- SQL **hanya** lewat prepared statement (`db.prepare('... ?')`). Jangan menggabungkan input ke string SQL.
- Frontend: render teks pengguna dengan `textContent` / `createTextNode`. **Jangan** `innerHTML` untuk data pengguna.
- Tidak ada `child_process` / `exec` dengan input pengguna.
- Tidak ada data dummy di frontend; semua angka dan daftar diambil dari API.
- Verifikasi AI memakai **OpenAI API resmi**. Jangan menambah mode "lolos otomatis" bila API key kosong.
  Stub OpenAI hanya boleh berada di `tests/support/`.

## Tes
- Setiap fitur baru disertai tes baru.
- Setiap kasus input tidak valid baru ditambahkan ke `tests/error-cases.test.js` dengan ID berurutan
  (R = registrasi, L = login, T = tweet, P = sumber/PDF/link, K = komentar).
- Jangan mengubah tes yang sudah ada hanya supaya lulus; perbaiki kodenya.

## Pull request
1. Fork, lalu buat branch dari `main` (`feat/...`, `fix/...`).
2. Pastikan `npm test` hijau dan `grep -n innerHTML public/` tidak menemukan penggunaan untuk data pengguna.
3. Jelaskan apa yang diubah dan alasannya. Sertakan tangkapan layar untuk perubahan UI.

## Di luar cakupan
Follow/follower, DM, notifikasi, upload gambar/video, login pihak ketiga, dan panel admin belum direncanakan.
Silakan buka issue untuk diskusi lebih dulu sebelum mengerjakannya.
