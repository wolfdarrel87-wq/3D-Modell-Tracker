'use strict';

const { randomToken, randomId, hmacHex } = require('../util/crypto');
const { serializeCookie } = require('../util/http');

// Browser-Session-Cookie (ohne Max-Age): endet mit dem Browser. Das Gerät stellt danach
// innerhalb der 30 Tage ohne neuen Code eine neue Session her.
const SESSION_COOKIE = '__Host-dp_session';

function hashSessionToken(pepper, token) {
  return hmacHex(pepper, `session:${token}`);
}

function createSession(draft, { userId, deviceId, deviceExpiresAt, now, ttlMs, pepper }) {
  const token = randomToken(32);
  const session = {
    id: randomId('ses'),
    userId,
    deviceId,
    tokenHash: hashSessionToken(pepper, token),
    createdAt: now,
    // Eine Session überlebt ihr Gerät nie.
    expiresAt: Math.min(now + ttlMs, deviceExpiresAt),
    adminVerifiedAt: null,
  };
  draft.sessions.push(session);
  return { token, session };
}

function findSession(state, token, { now, pepper }) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const hash = hashSessionToken(pepper, token);
  const session = state.sessions.find((s) => s.tokenHash === hash);
  if (!session || now >= session.expiresAt) return null;
  return session;
}

function sessionCookie(token) {
  return serializeCookie(SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
}

function clearSessionCookie() {
  return serializeCookie(SESSION_COOKIE, '', { maxAge: 0, expires: 0, httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
}

module.exports = { SESSION_COOKIE, createSession, findSession, sessionCookie, clearSessionCookie, hashSessionToken };
