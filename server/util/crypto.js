'use strict';

const crypto = require('node:crypto');

/** Kryptografisch sicherer Zufalls-Token (Standard: 32 Byte = 256 Bit). */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Interne, nicht fortlaufende ID. */
function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
}

function hmacHex(key, value) {
  return crypto.createHmac('sha256', key).update(String(value)).digest('hex');
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function randomOtpCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

const SCRYPT_DEFAULTS = { N: 16384, r: 8, p: 1, keyLen: 32 };

function scryptAsync(password, salt, keyLen, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLen, { ...opts, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Format: scrypt$N$r$p$saltBase64$hashBase64 */
async function hashPassword(password) {
  const { N, r, p, keyLen } = SCRYPT_DEFAULTS;
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(String(password), salt, keyLen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isInteger)) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (!salt.length || !expected.length) return false;
  const key = await scryptAsync(String(password), salt, expected.length, { N, r, p });
  return crypto.timingSafeEqual(key, expected);
}

module.exports = { randomToken, randomId, hmacHex, safeEqualHex, randomOtpCode, hashPassword, verifyPassword };
