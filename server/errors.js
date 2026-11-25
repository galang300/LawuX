'use strict';
/*
 * AppError = satu-satunya jenis error yang pesannya boleh sampai ke klien.
 * Route cukup `throw` / `next(err)`; error handler di app.js yang membalas
 * dengan format { error: { code, message, fields? } }.
 */
class AppError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (fields && Object.keys(fields).length > 0) this.fields = fields;
  }
}

const validationError = (fields, message = 'Data yang dikirim tidak valid.') =>
  new AppError(400, 'VALIDATION_ERROR', message, fields);
const unauthorized = (message = 'Silakan login terlebih dahulu.') =>
  new AppError(401, 'UNAUTHORIZED', message);
const forbidden = (message = 'Anda tidak berhak melakukan aksi ini.') =>
  new AppError(403, 'FORBIDDEN', message);
const notFound = (message = 'Data tidak ditemukan.') =>
  new AppError(404, 'NOT_FOUND', message);
const conflict = (message, fields) =>
  new AppError(409, 'CONFLICT', message, fields);

module.exports = { AppError, validationError, unauthorized, forbidden, notFound, conflict };
