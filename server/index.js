'use strict';
const config = require('./config');
const app = require('./app');
const db = require('./db');

const server = app.listen(config.port, () => {
  console.log(`[rujuk] ${config.env} berjalan di http://localhost:${config.port}`);
});

// Penting di Docker: node sebagai PID 1 tidak berhenti otomatis saat menerima SIGTERM.
function shutdown(signal) {
  console.log(`[rujuk] ${signal} diterima, menutup server...`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
