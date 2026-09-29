'use strict';

const { randomToken, randomId, hmacHex } = require('../util/crypto');
const { serializeCookie } = require('../util/http');

// __Host-: nur mit Secure, Path=/ und ohne Domain gültig – Subdomains können ihn nicht überschreiben.
const DEVICE_COOKIE = '__Host-dp_device';
const TOKEN_MAX_LENGTH = 200;

function hashDeviceToken(pepper, token) {
  return hmacHex(pepper, `device:${token}`);
}

/**
 * Registriert ein neues vertrauenswürdiges Gerät. Wird AUSSCHLIESSLICH nach erfolgreicher
 * E-Mail-Code-Anmeldung aufgerufen. Der Klartext-Token verlässt den Server nur als Cookie.
 */
function registerDevice(draft, { userId, label, now, pepper, ttlMs }) {
  const token = randomToken(32); // 256 Bit
  const device = {
    id: randomId('dev'),
    userId,
    tokenHash: hashDeviceToken(pepper, token),
    createdAt: now,
    expiresAt: now + ttlMs, // absolut – wird nie verlängert
    lastUsedAt: now,
    revokedAt: null,
    deviceLabel: label,
  };
  draft.devices.push(device);
  return { token, device };
}

/** Prüft einen Geräte-Token vollständig: existiert, nicht widerrufen, nicht abgelaufen, Konto aktiv. */
function checkDeviceToken(state, token, { now, pepper }) {
  if (!token) return { ok: false, reason: 'missing' };
  if (typeof token !== 'string' || token.length > TOKEN_MAX_LENGTH) return { ok: false, reason: 'malformed' };
  const hash = hashDeviceToken(pepper, token);
  const device = state.devices.find((d) => d.tokenHash === hash);
  if (!device) return { ok: false, reason: 'unknown' };
  if (device.revokedAt) return { ok: false, reason: 'revoked', device };
  if (now >= device.expiresAt) return { ok: false, reason: 'expired', device };
  const user = state.users.find((u) => u.id === device.userId);
  if (!user) return { ok: false, reason: 'user_missing', device };
  if (user.status !== 'active') return { ok: false, reason: 'user_blocked', device };
  return { ok: true, device, user };
}

function isDeviceActive(device, now) {
  return !device.revokedAt && now < device.expiresAt;
}

function revokeDevice(draft, deviceId, now) {
  const device = draft.devices.find((d) => d.id === deviceId);
  if (!device) return false;
  if (!device.revokedAt) device.revokedAt = now;
  draft.sessions = draft.sessions.filter((s) => s.deviceId !== deviceId);
  return true;
}

function revokeAllDevicesOfUser(draft, userId, now, { exceptDeviceId = null } = {}) {
  let count = 0;
  for (const device of draft.devices) {
    if (device.userId !== userId || device.id === exceptDeviceId) continue;
    if (!device.revokedAt) {
      device.revokedAt = now;
      count += 1;
    }
  }
  draft.sessions = draft.sessions.filter((s) => s.userId !== userId || (exceptDeviceId && s.deviceId === exceptDeviceId));
  return count;
}

/** Nur lastUsedAt wird aktualisiert – expiresAt bleibt unverändert (keine Sliding Expiration). */
function touchDevice(draft, deviceId, now) {
  const device = draft.devices.find((d) => d.id === deviceId);
  if (device) device.lastUsedAt = now;
}

function deviceCookie(token, device, now) {
  return serializeCookie(DEVICE_COOKIE, token, {
    maxAge: (device.expiresAt - now) / 1000,
    expires: device.expiresAt,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/',
  });
}

function clearDeviceCookie() {
  return serializeCookie(DEVICE_COOKIE, '', { maxAge: 0, expires: 0, httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
}

function publicDeviceInfo(device, currentDeviceId) {
  return {
    id: device.id,
    label: device.deviceLabel,
    createdAt: device.createdAt,
    lastUsedAt: device.lastUsedAt,
    expiresAt: device.expiresAt,
    current: device.id === currentDeviceId,
  };
}

module.exports = {
  DEVICE_COOKIE,
  hashDeviceToken,
  registerDevice,
  checkDeviceToken,
  isDeviceActive,
  revokeDevice,
  revokeAllDevicesOfUser,
  touchDevice,
  deviceCookie,
  clearDeviceCookie,
  publicDeviceInfo,
};
