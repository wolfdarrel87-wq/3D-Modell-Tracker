'use strict';

const { randomId } = require('../util/crypto');
const { HttpError } = require('../util/http');
const { revokeAllDevicesOfUser, isDeviceActive } = require('../auth/devices');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return null;
  return email;
}

function findUserByEmail(state, email) {
  return state.users.find((u) => u.email === email) || null;
}

function findOrCreateUser(draft, email, now) {
  let user = findUserByEmail(draft, email);
  if (!user) {
    user = { id: randomId('usr'), email, status: 'active', createdAt: now };
    draft.users.push(user);
  }
  return user;
}

function requireUser(draft, userId) {
  const user = draft.users.find((u) => u.id === userId);
  if (!user) throw new HttpError(404, 'not_found', 'Benutzer nicht gefunden');
  return user;
}

/** Sperren widerruft zusätzlich alle Geräte und Sessions – ein Gerät kann die Sperre nie umgehen. */
function blockUser(draft, userId, now) {
  const user = requireUser(draft, userId);
  user.status = 'blocked';
  user.blockedAt = now;
  revokeAllDevicesOfUser(draft, userId, now);
  return user;
}

function unblockUser(draft, userId) {
  const user = requireUser(draft, userId);
  user.status = 'active';
  delete user.blockedAt;
  return user;
}

/**
 * Cloudflare-Modus: Access-Anmeldungen bis einschließlich `now` dürfen kein neues Gerät mehr
 * registrieren (nach Abmelden/Sicherheitsreset ist eine NEUE Access-Anmeldung nötig).
 */
function requireReauth(draft, userId, now) {
  const user = draft.users.find((u) => u.id === userId);
  if (user) user.accessReauthAfter = now;
}

/** Sicherheitsreset: alle Geräte + Sessions des Benutzers widerrufen. */
function resetUserDevices(draft, userId, now) {
  requireUser(draft, userId);
  requireReauth(draft, userId, now);
  return revokeAllDevicesOfUser(draft, userId, now);
}

/**
 * Löscht das Konto: Geräte, Sessions und offene Codes werden entfernt, alte Cookies sind
 * damit wertlos. Aufträge bleiben für den Admin erhalten (inkl. DP-Nummer), verlieren aber den
 * Besitzer und sind ab sofort PRIVAT – ein gelöschtes Konto veröffentlicht nichts mehr.
 */
function deleteUser(draft, userId, now) {
  const user = requireUser(draft, userId);
  draft.users = draft.users.filter((u) => u.id !== userId);
  draft.devices = draft.devices.filter((d) => d.userId !== userId);
  draft.sessions = draft.sessions.filter((s) => s.userId !== userId);
  draft.otps = draft.otps.filter((o) => o.email !== user.email);
  for (const order of draft.orders) {
    if (order.ownerId === userId) {
      order.ownerId = null;
      order.ownerDeletedAt = now;
      order.isPublic = false;
    }
  }
  for (const message of draft.support) {
    if (message.userId === userId) message.userId = null;
  }
  return user;
}

function adminUserList(state, now) {
  return state.users
    .map((u) => ({
      id: u.id,
      email: u.email,
      status: u.status,
      createdAt: u.createdAt,
      activeDevices: state.devices.filter((d) => d.userId === u.id && isDeviceActive(d, now)).length,
      orders: state.orders.filter((o) => o.ownerId === u.id).length,
    }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

module.exports = { normalizeEmail, findUserByEmail, findOrCreateUser, requireReauth, blockUser, unblockUser, resetUserDevices, deleteUser, adminUserList };
