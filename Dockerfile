# syntax=docker/dockerfile:1
# bookworm-slim (glibc), bukan alpine.

# ---------- Stage 1: pasang dependensi. Toolchain (python3/make/g++) hanya ada di stage ini,
# dipakai bila prebuilt binary better-sqlite3 tidak bisa diunduh sehingga harus dikompilasi.
FROM node:22-bookworm-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---------- Stage 2: runtime production (tanpa compiler).
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/rujuk.db \
    UPLOAD_DIR=/uploads

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules

# Kode aplikasi milik root (read-only bagi user "node"): proses tidak bisa mengubah kodenya sendiri.
COPY . .

# Titik mount named volume. Volume baru mewarisi pemilik ini, jadi user "node" bisa menulis.
RUN mkdir -p /data /uploads && chown node:node /data /uploads && chmod 700 /data /uploads

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# node langsung (bukan npm start) agar SIGTERM sampai ke aplikasi dan npm tidak menulis cache/log.
CMD ["node", "server/index.js"]
