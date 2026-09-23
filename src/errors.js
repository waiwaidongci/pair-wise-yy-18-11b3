'use strict';

class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || null;
  }
}

function badRequest(message, code) {
  return new ApiError(400, message, code);
}

function notFound(message, code) {
  return new ApiError(404, message || 'not found', code);
}

function conflict(message, code) {
  return new ApiError(409, message, code);
}

module.exports = { ApiError, badRequest, notFound, conflict };
