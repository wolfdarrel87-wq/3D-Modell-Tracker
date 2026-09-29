'use strict';

const crypto = require('node:crypto');

const JWKS_CACHE_MS = 10 * 60 * 1000;
const CLOCK_SKEW_S = 30;

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/**
 * Optionale Prüfung des Cloudflare-Access-JWT (Header Cf-Access-Jwt-Assertion bzw. Cookie
 * CF_Authorization). Ist Access konfiguriert, wird jede API-Anfrage ohne gültiges Access-JWT
 * abgewiesen – Druckplatte-Geräte-Cookies können Cloudflare Access also niemals ersetzen.
 */
function createCfAccessVerifier({ teamDomain, aud, fetchImpl = globalThis.fetch }) {
  const issuer = `https://${teamDomain}`;
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  let cache = { keys: new Map(), fetchedAt: 0 };

  async function loadKeys(nowMs, force) {
    if (!force && cache.keys.size && nowMs - cache.fetchedAt < JWKS_CACHE_MS) return cache.keys;
    const res = await fetchImpl(certsUrl);
    if (!res.ok) throw new Error(`JWKS-Abruf fehlgeschlagen (${res.status})`);
    const body = await res.json();
    const keys = new Map();
    for (const jwk of body.keys || []) {
      if (jwk.kty === 'RSA' && jwk.kid) keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    }
    cache = { keys, fetchedAt: nowMs };
    return keys;
  }

  async function verifyToken(token, nowMs) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };
    let header;
    let payload;
    try {
      header = b64urlJson(parts[0]);
      payload = b64urlJson(parts[1]);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (header.alg !== 'RS256' || !header.kid) return { ok: false, reason: 'alg' };
    let keys = await loadKeys(nowMs, false);
    if (!keys.has(header.kid)) keys = await loadKeys(nowMs, true);
    const key = keys.get(header.kid);
    if (!key) return { ok: false, reason: 'unknown_key' };
    const signatureValid = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
    if (!signatureValid) return { ok: false, reason: 'signature' };
    const nowS = Math.floor(nowMs / 1000);
    if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S <= nowS) return { ok: false, reason: 'expired' };
    if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_S > nowS) return { ok: false, reason: 'not_yet_valid' };
    if (payload.iss !== issuer) return { ok: false, reason: 'issuer' };
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) return { ok: false, reason: 'audience' };
    const email = String(payload.email || '').trim().toLowerCase();
    if (!email) return { ok: false, reason: 'no_email' };
    return { ok: true, email };
  }

  async function verifyRequest(req, cookies, nowMs) {
    const token = req.headers['cf-access-jwt-assertion'] || cookies.CF_Authorization;
    if (!token) return { ok: false, reason: 'missing' };
    try {
      return await verifyToken(token, nowMs);
    } catch {
      return { ok: false, reason: 'jwks_unavailable' };
    }
  }

  return { verifyToken, verifyRequest };
}

module.exports = { createCfAccessVerifier };
