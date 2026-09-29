'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Serverseitiger Schlüssel für die HMAC-Hashes von Geräte-/Session-Tokens und E-Mail-Codes.
 * Wird er ausgetauscht, sind alle Geräte und Sessions sofort ungültig (globaler Sicherheitsreset).
 */
function loadPepper({ dataDir, authPepper }) {
  if (authPepper) {
    const key = Buffer.from(authPepper, 'base64');
    if (key.length < 32) throw new Error('AUTH_PEPPER muss mindestens 32 Byte (base64) lang sein.');
    return key;
  }
  const file = path.join(dataDir, 'auth-pepper.key');
  try {
    const key = fs.readFileSync(file);
    if (key.length >= 32) return key;
    throw new Error('zu kurz');
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`auth-pepper.key ungültig: ${err.message}`);
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
  return key;
}

module.exports = { loadPepper };
