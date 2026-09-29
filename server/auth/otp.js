'use strict';

const { randomId, randomOtpCode, hmacHex, safeEqualHex } = require('../util/crypto');

function hashCode(pepper, otpId, code) {
  return hmacHex(pepper, `otp:${otpId}:${code}`);
}

/** Erzeugt einen neuen 6-stelligen Code; ältere offene Codes derselben Adresse werden ungültig. */
function issueOtp(draft, { email, now, ttlMs, pepper }) {
  for (const otp of draft.otps) {
    if (otp.email === email && !otp.consumedAt) otp.consumedAt = now;
  }
  const code = randomOtpCode();
  const id = randomId('otp');
  draft.otps.push({ id, email, codeHash: hashCode(pepper, id, code), createdAt: now, expiresAt: now + ttlMs, attempts: 0, consumedAt: null });
  return { code };
}

/**
 * Prüft einen Code. Fehlversuche werden mitgezählt (die Transaktion wird auch bei
 * Fehlschlag gespeichert); nach maxAttempts ist der Code verbraucht.
 */
function verifyOtp(draft, { email, code, now, pepper, maxAttempts }) {
  const otp = draft.otps
    .filter((o) => o.email === email && !o.consumedAt && now < o.expiresAt)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!otp) return { ok: false, reason: 'no_code' };
  otp.attempts += 1;
  const valid = /^\d{6}$/.test(String(code || '')) && safeEqualHex(hashCode(pepper, otp.id, String(code)), otp.codeHash);
  if (!valid) {
    if (otp.attempts >= maxAttempts) otp.consumedAt = now;
    return { ok: false, reason: 'invalid' };
  }
  otp.consumedAt = now;
  return { ok: true };
}

module.exports = { issueOtp, verifyOtp };
