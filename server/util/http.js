'use strict';

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name || name in out) continue;
    let value = part.slice(idx + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out[name] = value;
  }
  return out;
}

function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${value}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`);
  if (opts.expires !== undefined) parts.push(`Expires=${new Date(opts.expires).toUTCString()}`);
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure !== false) parts.push('Secure');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  return parts.join('; ');
}

function hasBody(req) {
  const len = req.headers['content-length'];
  if (len !== undefined) return Number(len) > 0;
  return req.headers['transfer-encoding'] !== undefined;
}

function readJsonBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    if (!hasBody(req)) {
      req.resume();
      resolve({});
      return;
    }
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) {
      req.resume();
      reject(new HttpError(415, 'unsupported_media_type', 'JSON erwartet'));
      return;
    }
    let size = 0;
    let failed = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limitBytes) {
        failed = true;
        reject(new HttpError(413, 'payload_too_large', 'Anfrage zu groß'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('kein Objekt');
        resolve(value);
      } catch {
        reject(new HttpError(400, 'invalid_json', 'Ungültiges JSON'));
      }
    });
    req.on('error', (err) => {
      if (!failed) reject(err);
    });
  });
}

function sendJson(res, status, body, cookies = []) {
  const payload = JSON.stringify(body);
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Vary: 'Cookie',
    'Content-Length': Buffer.byteLength(payload),
  };
  if (cookies.length) headers['Set-Cookie'] = cookies;
  res.writeHead(status, headers);
  res.end(payload);
}

function sendBuffer(res, status, buffer, contentType, extraHeaders = {}, cookies = []) {
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
    'Content-Length': buffer.length,
    ...extraHeaders,
  };
  if (cookies.length) headers['Set-Cookie'] = cookies;
  res.writeHead(status, headers);
  res.end(buffer);
}

module.exports = { HttpError, SECURITY_HEADERS, HTML_CSP, parseCookies, serializeCookie, readJsonBody, sendJson, sendBuffer };
