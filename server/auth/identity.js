'use strict';

const { HOUR_MS } = require('../util/time');
const { DEVICE_COOKIE, checkDeviceToken, touchDevice, clearDeviceCookie } = require('./devices');
const { SESSION_COOKIE, createSession, findSession, sessionCookie, clearSessionCookie } = require('./sessions');

const LAST_USED_WRITE_INTERVAL_MS = HOUR_MS;

/**
 * Ermittelt den Betrachter einer Anfrage ausschließlich aus serverseitig geprüften Cookies
 * (und optional dem Cloudflare-Access-JWT). Client-Angaben zu owner/email/user werden nie
 * berücksichtigt.
 *
 * Reihenfolge:
 *  1. Session-Cookie gültig UND an das Gerät aus dem Geräte-Cookie gebunden → angemeldet.
 *  2. Sonst: Geräte-Cookie gültig (nicht widerrufen, nicht abgelaufen, Konto aktiv) →
 *     neue Session OHNE E-Mail-Code. Es wird dabei NIE ein neues Gerät angelegt.
 *  3. Sonst: nicht angemeldet → E-Mail-Code erforderlich.
 */
function createIdentityResolver({ store, config, clock, pepper }) {
  function buildViewer(user, session, device) {
    const isAdminUser = config.adminEmails.includes(user.email);
    return {
      userId: user.id,
      email: user.email,
      role: isAdminUser ? 'admin' : 'user',
      isAdminUser,
      // Admin-Rechte nur mit Admin-Rolle UND in dieser Session bestätigtem Admin-Passwort.
      isAdmin: isAdminUser && Boolean(session.adminVerifiedAt),
      sessionId: session.id,
      deviceId: device.id,
      device,
    };
  }

  /**
   * @param cookies     geparste Request-Cookies
   * @param setCookie   Callback zum Setzen/Löschen von Cookies in der Antwort
   * @param accessEmail per Cloudflare Access bestätigte E-Mail (oder null, wenn Access nicht konfiguriert ist)
   */
  function resolve(cookies, setCookie, accessEmail = null) {
    const now = clock.now();
    const state = store.state;
    const deviceToken = cookies[DEVICE_COOKIE];
    const sessionToken = cookies[SESSION_COOKIE];

    const deviceCheck = checkDeviceToken(state, deviceToken, { now, pepper });
    if (deviceToken && !deviceCheck.ok) setCookie(clearDeviceCookie());
    const deviceMatchesAccess = deviceCheck.ok && (!accessEmail || deviceCheck.user.email === accessEmail);

    if (sessionToken) {
      const session = findSession(state, sessionToken, { now, pepper });
      if (session && deviceMatchesAccess && session.deviceId === deviceCheck.device.id && session.userId === deviceCheck.user.id) {
        if (now - deviceCheck.device.lastUsedAt >= LAST_USED_WRITE_INTERVAL_MS) {
          store.transaction((draft) => touchDevice(draft, deviceCheck.device.id, now));
        }
        return { status: 'ok', viewer: buildViewer(deviceCheck.user, session, deviceCheck.device), restored: false };
      }
      setCookie(clearSessionCookie());
    }

    if (deviceMatchesAccess) {
      const { device, user } = deviceCheck;
      const { token, session } = store.transaction((draft) => {
        touchDevice(draft, device.id, now);
        return createSession(draft, { userId: user.id, deviceId: device.id, deviceExpiresAt: device.expiresAt, now, ttlMs: config.sessionTtlMs, pepper });
      });
      setCookie(sessionCookie(token));
      return { status: 'ok', viewer: buildViewer(user, session, device), restored: true };
    }

    return { status: 'anonymous', accessEmail };
  }

  return { resolve };
}

module.exports = { createIdentityResolver };
