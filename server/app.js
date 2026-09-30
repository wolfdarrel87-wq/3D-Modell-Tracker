'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { Store } = require('./store');
const { systemClock, DAY_MS, MINUTE_MS } = require('./util/time');
const { HttpError, buildHtmlCsp, SECURITY_HEADERS, parseCookies, readJsonBody, sendJson, sendBuffer } = require('./util/http');
const { RateLimiter } = require('./util/ratelimit');
const { createLogger } = require('./util/log');
const { deviceLabelFromUserAgent } = require('./util/useragent');
const { verifyPassword } = require('./util/crypto');
const { loadPepper } = require('./auth/pepper');
const devices = require('./auth/devices');
const sessions = require('./auth/sessions');
const { issueOtp, verifyOtp } = require('./auth/otp');
const { createIdentityResolver } = require('./auth/identity');
const { createCfAccessVerifier } = require('./auth/cfAccess');
const orders = require('./domain/orders');
const queue = require('./domain/queue');
const users = require('./domain/users');
const support = require('./domain/support');
const { createPrivacy } = require('./domain/privacy');
const images = require('./domain/images');
const { createOutboxMailer } = require('./mail/mailer');
const templates = require('./mail/templates');

const JSON_LIMIT = 4 * 1024 * 1024; // Bilder als data:-URL (max. 2,5 MB binär)
const SMALL_JSON_LIMIT = 16 * 1024;

const SPA_PATHS = [/^\/$/, /^\/index\.html$/, /^\/auftrag\/[^/]{1,64}$/, /^\/support$/, /^\/profil$/];
// Lokal ausgelieferte Schriften (keine Anfragen an Google), nur exakt diese Dateien.
const FONT_FILE = /^\/fonts\/([a-z0-9-]+\.woff2)$/;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// Kennzeichen einer weitergeleiteten Anfrage (Tunnel/Reverse-Proxy auf demselben Rechner).
const PROXY_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'cf-connecting-ip', 'cf-ray', 'true-client-ip'];

/** Nur direkte Anfragen vom selben Rechner – nicht über einen lokalen Tunnel/Proxy weitergereichte. */
function isDirectLocalRequest(req) {
  return LOOPBACK.has(req.socket.remoteAddress) && !PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function createApp({ config, clock = systemClock, logger = createLogger(), mailer, fetchImpl } = {}) {
  const store = new Store({ dataDir: config.dataDir }).open();
  const pepper = loadPepper(config);
  const mail = mailer || createOutboxMailer({ dataDir: config.dataDir, clock });
  const cfAccess = config.cfAccess ? createCfAccessVerifier({ ...config.cfAccess, fetchImpl }) : null;
  const identity = createIdentityResolver({ store, config, clock, pepper });
  const baseUrl = config.publicBaseUrl;
  const allowedOrigins = new Set(config.allowedOrigins);
  const privacy = createPrivacy({ imageHostAllowlist: config.imageHostAllowlist });
  const htmlCsp = buildHtmlCsp({ imageHosts: config.imageHostAllowlist });

  const limits = {
    codeRequestPerEmail: new RateLimiter({ windowMs: 15 * MINUTE_MS, max: 5 }),
    codeRequestPerIp: new RateLimiter({ windowMs: 15 * MINUTE_MS, max: 30 }),
    codeVerifyPerEmail: new RateLimiter({ windowMs: 15 * MINUTE_MS, max: 10 }),
    adminElevate: new RateLimiter({ windowMs: 15 * MINUTE_MS, max: 5 }),
    // Cloudflare-Modus: neue Geräte pro Identität begrenzen (Wiederherstellungen zählen nicht)
    accessRegisterPerEmail: new RateLimiter({ windowMs: 15 * MINUTE_MS, max: 10 }),
  };

  // ---------------------------------------------------------------- Hilfen

  function roleOf(user) {
    return config.adminEmails.includes(user.email) ? 'admin' : 'user';
  }

  function clientIp(req) {
    if (config.trustProxy) {
      const forwarded = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  /**
   * CSRF-Schutz für ändernde Anfragen, fail closed: Origin muss vorhanden sein und exakt einer
   * konfigurierten Origin entsprechen (PUBLIC_BASE_URL, ALLOWED_ORIGINS). Der Host-Header wird
   * dafür nie verwendet. Es gibt keine Server-zu-Server-Endpunkte, die davon ausgenommen wären.
   */
  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) throw new HttpError(403, 'origin_required', 'Anfrage ohne Herkunftsangabe abgelehnt');
    if (!allowedOrigins.has(origin)) throw new HttpError(403, 'bad_origin', 'Ungültige Herkunft der Anfrage');
  }

  async function sendMail(to, message) {
    if (!to) return;
    try {
      await mail.send({ to, ...message });
    } catch (err) {
      logger.error('Mailversand fehlgeschlagen', { kind: message.kind, error: err.message });
    }
  }

  async function notifyOwner(order, message) {
    const owner = order && order.ownerId ? store.state.users.find((u) => u.id === order.ownerId) : null;
    if (owner) await sendMail(owner.email, message);
  }

  function storeImage(input) {
    const parsed = images.parseImageInput(input, { allowlist: config.imageHostAllowlist });
    if (parsed.kind === 'data') return images.saveImageFile(config.dataDir, parsed);
    if (parsed.kind === 'url') return { kind: 'url', url: parsed.url };
    return null;
  }

  function orderResponse(order, viewer) {
    return { order: privacy.orderForViewer(store.state, order, viewer) };
  }

  function liveResponse(ctx) {
    return privacy.buildLiveView(store.state, ctx.viewer, ctx.now);
  }

  function clearAuthCookies(ctx) {
    ctx.setCookie(devices.clearDeviceCookie());
    ctx.setCookie(sessions.clearSessionCookie());
  }

  // ---------------------------------------------------------------- Routing

  const routes = [];
  function add(method, pattern, auth, handler, { bodyLimit = SMALL_JSON_LIMIT } = {}) {
    const keys = [];
    const regex = new RegExp(
      `^${pattern.replace(/:([A-Za-z]+)/g, (_, key) => {
        keys.push(key);
        return '([^/]+)';
      })}$`,
    );
    routes.push({ method, regex, keys, auth, handler, bodyLimit });
  }

  // auth: 'public' (auch ohne Cloudflare Access), 'none' (ohne Anmeldung), 'user', 'admin'
  add('GET', '/api/health', 'public', () => ({ ok: true, env: config.env, authMode: config.authMode }));

  function requireEmailCodeMode() {
    if (config.authMode !== 'email-code') {
      // Mit Cloudflare Access gibt es bewusst keinen zweiten Druckplatte-Code.
      throw new HttpError(404, 'not_available', 'Die Anmeldung läuft über Cloudflare Access – kein zusätzlicher Code nötig');
    }
  }

  /**
   * Registriert NACH einer erfolgreichen Anmeldung (E-Mail-Code ODER frisch bestätigte
   * Cloudflare-Access-Identität) genau ein vertrauenswürdiges Gerät für diesen Browser und
   * eine Session. Muss in einer Store-Transaktion laufen. Ein evtl. noch vorhandenes Gerät
   * dieses Browsers wird dabei widerrufen (Token-Rotation).
   */
  function registerLogin(draft, { email, ctx, now }) {
    const user = users.findOrCreateUser(draft, email, now);
    if (user.status !== 'active') return { ok: false, blocked: true };
    const previous = devices.checkDeviceToken(draft, ctx.cookies[devices.DEVICE_COOKIE], { now, pepper });
    if (previous.device) devices.revokeDevice(draft, previous.device.id, now);
    const registered = devices.registerDevice(draft, {
      userId: user.id,
      label: deviceLabelFromUserAgent(ctx.req.headers['user-agent']),
      now,
      pepper,
      ttlMs: config.trustedDeviceTtlMs,
    });
    const created = sessions.createSession(draft, {
      userId: user.id,
      deviceId: registered.device.id,
      deviceExpiresAt: registered.device.expiresAt,
      now,
      ttlMs: config.sessionTtlMs,
      pepper,
    });
    return { ok: true, user, device: registered.device, deviceToken: registered.token, sessionToken: created.token };
  }

  function finishLogin(ctx, result) {
    if (result.blocked) throw new HttpError(403, 'account_blocked', 'Dein Konto ist gesperrt. Bitte wende dich an den Admin.');
    ctx.setCookie(devices.deviceCookie(result.deviceToken, result.device, ctx.now));
    ctx.setCookie(sessions.sessionCookie(result.sessionToken));
    return {
      ok: true,
      user: { email: result.user.email, role: roleOf(result.user) },
      device: devices.publicDeviceInfo(result.device, result.device.id),
    };
  }

  // ---- Anmeldung über Cloudflare Access (Produktionsmodell: kein zweiter Code)

  add('POST', '/api/auth/access-session', 'none', (ctx) => {
    if (config.authMode !== 'cloudflare-access') throw new HttpError(404, 'not_found', 'Nicht gefunden');
    const email = users.normalizeEmail(ctx.accessEmail);
    if (!email) throw new HttpError(401, 'access_required', 'Cloudflare-Access-Anmeldung erforderlich');

    // Vorhandenes gültiges Gerät dieser Identität → nur Session wiederherstellen, KEIN neues Gerät.
    const who = identity.resolve(ctx.cookies, ctx.setCookie, email);
    if (who.status === 'ok') {
      return { ok: true, restored: true, user: { email: who.viewer.email, role: who.viewer.role }, device: devices.publicDeviceInfo(who.viewer.device, who.viewer.deviceId) };
    }

    // Neues Gerät nur nach FRISCHER Access-Anmeldung – sonst würde nach 30 Tagen still ein neues
    // Gerät entstehen, ohne dass jemand einen Code eingegeben hat.
    // Nach „Abmelden“ oder einem Sicherheitsreset zählt nur eine Access-Anmeldung, die DANACH
    // stattfand (sekundengenau, im Zweifel ablehnen) – sonst wäre Abmelden in den ersten Minuten wirkungslos.
    const issuedAt = ctx.accessIat === null || ctx.accessIat === undefined ? null : ctx.accessIat * 1000;
    const known = users.findUserByEmail(store.state, email);
    const reauthAfter = known && known.accessReauthAfter ? Math.floor(known.accessReauthAfter / 1000) * 1000 : null;
    const fresh =
      issuedAt !== null &&
      issuedAt <= ctx.now + 30 * 1000 &&
      ctx.now - issuedAt <= config.cfAccessMaxLoginAgeMs &&
      (reauthAfter === null || issuedAt > reauthAfter);
    if (!fresh) {
      throw new HttpError(401, 'access_reauth_required', 'Bitte bei Cloudflare Access neu anmelden, um dieses Gerät zu registrieren', {
        logoutUrl: '/cdn-cgi/access/logout',
      });
    }
    const allowlisted = !config.loginAllowlist.length || config.loginAllowlist.includes(email) || config.adminEmails.includes(email);
    if (!allowlisted) throw new HttpError(403, 'not_allowed', 'Dieses Konto ist für Druckplatte nicht freigeschaltet');
    if (!limits.accessRegisterPerEmail.hit(email, ctx.now)) throw new HttpError(429, 'rate_limited', 'Zu viele neue Geräte – bitte später erneut versuchen');
    const result = store.transaction((draft) => registerLogin(draft, { email, ctx, now: ctx.now }));
    return { ...finishLogin(ctx, result), registered: true };
  });

  // ---- Anmeldung per E-Mail-Code (nur ohne Cloudflare Access, z. B. Preview/Test)

  add('POST', '/api/auth/request-code', 'none', async (ctx) => {
    requireEmailCodeMode();
    const email = users.normalizeEmail(ctx.body.email);
    if (!email) throw new HttpError(400, 'invalid_email', 'Bitte eine gültige E-Mail-Adresse eingeben');
    if (!limits.codeRequestPerIp.hit(ctx.ip, ctx.now) || !limits.codeRequestPerEmail.hit(email, ctx.now)) {
      throw new HttpError(429, 'rate_limited', 'Zu viele Anfragen – bitte in ein paar Minuten erneut versuchen');
    }
    const allowlisted = !config.loginAllowlist.length || config.loginAllowlist.includes(email) || config.adminEmails.includes(email);
    const matchesAccess = !ctx.accessEmail || ctx.accessEmail === email;
    if (allowlisted && matchesAccess) {
      const { code } = store.transaction((draft) => issueOtp(draft, { email, now: ctx.now, ttlMs: config.otpTtlMs, pepper }));
      try {
        await mail.send({ to: email, ...templates.loginCodeMail(code) });
      } catch (err) {
        logger.error('Code-Mail fehlgeschlagen', { error: err.message });
        throw new HttpError(502, 'mail_failed', 'Der Code konnte nicht versendet werden');
      }
    }
    // Einheitliche Antwort – verrät nicht, ob es die Adresse gibt.
    return { ok: true, message: 'Falls die Adresse berechtigt ist, wurde ein Code gesendet.' };
  });

  add('POST', '/api/auth/verify-code', 'none', (ctx) => {
    requireEmailCodeMode();
    const email = users.normalizeEmail(ctx.body.email);
    const code = typeof ctx.body.code === 'string' ? ctx.body.code.trim() : '';
    if (!email) throw new HttpError(400, 'invalid_email', 'Bitte eine gültige E-Mail-Adresse eingeben');
    if (!limits.codeVerifyPerEmail.hit(email, ctx.now)) throw new HttpError(429, 'rate_limited', 'Zu viele Versuche – bitte später erneut versuchen');
    if (ctx.accessEmail && ctx.accessEmail !== email) {
      throw new HttpError(403, 'access_mismatch', 'Die E-Mail muss zur Cloudflare-Access-Anmeldung passen');
    }
    const now = ctx.now;
    const result = store.transaction((draft) => {
      const check = verifyOtp(draft, { email, code, now, pepper, maxAttempts: config.otpMaxAttempts });
      if (!check.ok) return { ok: false };
      // Gerät wird NUR nach erfolgreicher Anmeldung registriert – nie durch Mail-Links oder Seitenaufrufe.
      return registerLogin(draft, { email, ctx, now });
    });
    if (!result.ok && !result.blocked) throw new HttpError(400, 'invalid_code', 'Code ungültig oder abgelaufen');
    return finishLogin(ctx, result);
  });

  add('POST', '/api/auth/logout', 'user', (ctx) => {
    store.transaction((draft) => {
      devices.revokeDevice(draft, ctx.viewer.deviceId, ctx.now);
      users.requireReauth(draft, ctx.viewer.userId, ctx.now);
    });
    clearAuthCookies(ctx);
    return { ok: true };
  });

  add('GET', '/api/me', 'user', (ctx) => ({
    user: { email: ctx.viewer.email, role: ctx.viewer.role },
    isAdmin: ctx.viewer.isAdmin,
    device: devices.publicDeviceInfo(ctx.viewer.device, ctx.viewer.deviceId),
    restored: ctx.restored,
    env: config.env,
    authMode: config.authMode,
    imageUrlHosts: config.imageHostAllowlist,
    serverTime: ctx.now,
  }));

  // ---- Vertrauenswürdige Geräte

  add('GET', '/api/devices', 'user', (ctx) => ({
    devices: store.state.devices
      .filter((d) => d.userId === ctx.viewer.userId && devices.isDeviceActive(d, ctx.now))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .map((d) => devices.publicDeviceInfo(d, ctx.viewer.deviceId)),
  }));

  add('POST', '/api/devices/:id/revoke', 'user', (ctx) => {
    const device = store.state.devices.find((d) => d.id === ctx.params.id && d.userId === ctx.viewer.userId);
    if (!device) throw new HttpError(404, 'not_found', 'Gerät nicht gefunden');
    store.transaction((draft) => devices.revokeDevice(draft, device.id, ctx.now));
    const current = device.id === ctx.viewer.deviceId;
    if (current) clearAuthCookies(ctx);
    return { ok: true, loggedOut: current };
  });

  add('POST', '/api/devices/revoke-others', 'user', (ctx) => {
    const revoked = store.transaction((draft) =>
      devices.revokeAllDevicesOfUser(draft, ctx.viewer.userId, ctx.now, { exceptDeviceId: ctx.viewer.deviceId }),
    );
    return { ok: true, revoked };
  });

  // ---- Datenschutz-Projektionen (Live-Sync, Aktueller Druck, Warteschlange, Aufträge)

  add('GET', '/api/live', 'user', (ctx) => liveResponse(ctx));
  add('GET', '/api/current-print', 'user', (ctx) => ({ currentPrint: privacy.buildCurrentPrintView(store.state, ctx.viewer, ctx.now) }));
  add('GET', '/api/queue', 'user', (ctx) => ({ queue: privacy.buildQueueView(store.state, ctx.viewer) }));
  add('GET', '/api/orders', 'user', (ctx) => privacy.buildOrdersView(store.state, ctx.viewer));

  // ---- Aufträge & Ideen

  add(
    'POST',
    '/api/orders',
    'user',
    (ctx) => {
      const fields = orders.validateOrderFields(ctx.body);
      const image = storeImage(ctx.body.image);
      let order;
      try {
        // Speichern + DP-Nummer in EINER Transaktion.
        order = store.transaction((draft) => orders.createOrder(draft, { viewer: ctx.viewer, fields, image, now: ctx.now }));
      } catch (err) {
        images.deleteImageFile(config.dataDir, image);
        throw err;
      }
      return orderResponse(order, ctx.viewer);
    },
    { bodyLimit: JSON_LIMIT },
  );

  add(
    'PATCH',
    '/api/orders/:id',
    'user',
    async (ctx) => {
      const body = { ...ctx.body };
      let image;
      if (ctx.viewer.isAdmin && Object.prototype.hasOwnProperty.call(body, 'image')) {
        image = storeImage(body.image);
        delete body.image;
      }
      let result;
      try {
        result = store.transaction((draft) => orders.updateOrder(draft, { orderId: ctx.params.id, viewer: ctx.viewer, body, image, now: ctx.now }));
      } catch (err) {
        images.deleteImageFile(config.dataDir, image);
        throw err;
      }
      if (result.replacedImage) images.deleteImageFile(config.dataDir, result.replacedImage);
      const { order, previousStatus } = result;
      if (order.accepted && order.status && order.status !== previousStatus) {
        await notifyOwner(order, templates.statusMail(baseUrl, order));
      }
      return orderResponse(order, ctx.viewer);
    },
    { bodyLimit: JSON_LIMIT },
  );

  add('DELETE', '/api/orders/:id', 'admin', (ctx) => {
    const order = store.transaction((draft) => orders.deleteOrder(draft, ctx.params.id));
    images.deleteImageFile(config.dataDir, order.image);
    return { ok: true };
  });

  add('POST', '/api/orders/:id/accept', 'admin', async (ctx) => {
    const order = store.transaction((draft) => orders.acceptIdea(draft, ctx.params.id, ctx.now));
    await notifyOwner(order, templates.ideaAcceptedMail(baseUrl, order));
    return orderResponse(order, ctx.viewer);
  });

  add('POST', '/api/orders/:id/reject', 'admin', (ctx) => {
    const order = store.transaction((draft) => orders.rejectIdea(draft, ctx.params.id));
    images.deleteImageFile(config.dataDir, order.image);
    return { ok: true };
  });

  add('GET', '/api/images/:key', 'user', (ctx) => {
    const order = store.state.orders.find((o) => o.image && o.image.kind === 'file' && o.image.key === ctx.params.key);
    if (!order || !privacy.canViewImage(order, ctx.viewer)) throw new HttpError(404, 'not_found', 'Nicht gefunden');
    const buffer = images.readImageFile(config.dataDir, ctx.params.key);
    if (!buffer) throw new HttpError(404, 'not_found', 'Nicht gefunden');
    return { __binary: { buffer, contentType: order.image.mime } };
  });

  // ---- Support

  add('POST', '/api/support', 'user', (ctx) => {
    store.transaction((draft) => support.createSupportMessage(draft, { viewer: ctx.viewer, body: ctx.body, now: ctx.now }));
    return { ok: true };
  });

  add('GET', '/api/support', 'admin', () => ({ messages: support.adminSupportList(store.state) }));

  add('POST', '/api/support/:id/resolve', 'admin', async (ctx) => {
    const deleteOrder = ctx.body.deleteOrder === true;
    const result = store.transaction((draft) => {
      const entry = support.resolveSupportMessage(draft, ctx.params.id);
      let removedOrder = null;
      if (deleteOrder && entry.orderId && draft.orders.some((o) => o.id === entry.orderId)) {
        removedOrder = orders.deleteOrder(draft, entry.orderId);
      }
      const user = entry.userId ? draft.users.find((u) => u.id === entry.userId) : null;
      return { entry, removedOrder, email: user ? user.email : null };
    });
    if (result.removedOrder) images.deleteImageFile(config.dataDir, result.removedOrder.image);
    await sendMail(result.email, templates.supportResolvedMail(baseUrl, result.entry));
    return { ok: true };
  });

  // ---- Admin-Modus (zusätzliches Admin-Passwort pro Session)

  add('POST', '/api/admin/elevate', 'user', async (ctx) => {
    if (!ctx.viewer.isAdminUser) throw new HttpError(403, 'forbidden', 'Dieses Konto ist kein Admin-Konto');
    if (!config.adminPasswordHash) throw new HttpError(503, 'admin_password_missing', 'Admin-Passwort ist nicht konfiguriert');
    if (!limits.adminElevate.hit(ctx.viewer.userId, ctx.now)) throw new HttpError(429, 'rate_limited', 'Zu viele Versuche – bitte später erneut versuchen');
    const password = ctx.body.password;
    const valid = typeof password === 'string' && password.length <= 256 && (await verifyPassword(password, config.adminPasswordHash));
    if (!valid) throw new HttpError(403, 'wrong_password', 'Falsches Admin-Passwort');
    store.transaction((draft) => {
      const session = draft.sessions.find((s) => s.id === ctx.viewer.sessionId);
      if (session) session.adminVerifiedAt = ctx.now;
    });
    return { ok: true, isAdmin: true };
  });

  add('POST', '/api/admin/leave', 'user', (ctx) => {
    store.transaction((draft) => {
      const session = draft.sessions.find((s) => s.id === ctx.viewer.sessionId);
      if (session) session.adminVerifiedAt = null;
    });
    return { ok: true, isAdmin: false };
  });

  // ---- Warteschlange & aktueller Druck (nur Anzeige – keine Druckersteuerung)

  add('POST', '/api/admin/queue', 'admin', (ctx) => {
    store.transaction((draft) => queue.enqueue(draft, String(ctx.body.orderId || '')));
    return liveResponse(ctx);
  });
  add('POST', '/api/admin/queue/:id/move', 'admin', (ctx) => {
    store.transaction((draft) => queue.move(draft, ctx.params.id, ctx.body.direction));
    return liveResponse(ctx);
  });
  add('DELETE', '/api/admin/queue/:id', 'admin', (ctx) => {
    store.transaction((draft) => queue.dequeue(draft, ctx.params.id));
    return liveResponse(ctx);
  });
  add('POST', '/api/admin/printer/current', 'admin', async (ctx) => {
    const result = store.transaction((draft) => queue.setCurrent(draft, String(ctx.body.orderId || ''), ctx.now));
    if (result.previousStatus !== result.order.status) await notifyOwner(result.order, templates.statusMail(baseUrl, result.order));
    return liveResponse(ctx);
  });
  add('POST', '/api/admin/printer/progress', 'admin', (ctx) => {
    store.transaction((draft) => queue.setProgress(draft, ctx.body, ctx.now));
    return liveResponse(ctx);
  });
  add('POST', '/api/admin/printer/finish', 'admin', async (ctx) => {
    const result = store.transaction((draft) => queue.finishCurrent(draft, ctx.now));
    if (result && result.previousStatus !== 'ready') await notifyOwner(result.order, templates.statusMail(baseUrl, result.order));
    return liveResponse(ctx);
  });
  add('POST', '/api/admin/printer/clear', 'admin', (ctx) => {
    store.transaction((draft) => queue.clearCurrent(draft));
    return liveResponse(ctx);
  });

  // ---- Benutzerverwaltung (Admin)

  add('GET', '/api/admin/users', 'admin', (ctx) => ({ users: users.adminUserList(store.state, ctx.now) }));
  add('POST', '/api/admin/users/:id/block', 'admin', (ctx) => {
    if (ctx.params.id === ctx.viewer.userId) throw new HttpError(409, 'self', 'Du kannst dich nicht selbst sperren');
    store.transaction((draft) => users.blockUser(draft, ctx.params.id, ctx.now));
    return { ok: true };
  });
  add('POST', '/api/admin/users/:id/unblock', 'admin', (ctx) => {
    store.transaction((draft) => users.unblockUser(draft, ctx.params.id));
    return { ok: true };
  });
  add('POST', '/api/admin/users/:id/reset-devices', 'admin', (ctx) => {
    const revoked = store.transaction((draft) => users.resetUserDevices(draft, ctx.params.id, ctx.now));
    if (ctx.params.id === ctx.viewer.userId) clearAuthCookies(ctx);
    return { ok: true, revoked };
  });
  add('DELETE', '/api/admin/users/:id', 'admin', (ctx) => {
    if (ctx.params.id === ctx.viewer.userId) throw new HttpError(409, 'self', 'Du kannst dein eigenes Konto nicht löschen');
    store.transaction((draft) => users.deleteUser(draft, ctx.params.id, ctx.now));
    return { ok: true };
  });

  function matchRoute(method, pathname) {
    let pathMatched = false;
    for (const route of routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params = {};
      route.keys.forEach((key, i) => {
        try {
          params[key] = decodeURIComponent(m[i + 1]);
        } catch {
          throw new HttpError(400, 'bad_request', 'Ungültige Adresse');
        }
      });
      return { route, params };
    }
    if (pathMatched) throw new HttpError(405, 'method_not_allowed', 'Methode nicht erlaubt');
    throw new HttpError(404, 'not_found', 'Nicht gefunden');
  }

  // ---------------------------------------------------------------- Statische Dateien

  function sendStatic(res, file, contentType, extraHeaders = {}) {
    const buffer = fs.readFileSync(path.join(config.publicDir, file));
    sendBuffer(res, 200, buffer, contentType, { 'Cache-Control': 'no-cache', ...extraHeaders });
  }

  function renderOutbox() {
    const mails = mail.list ? mail.list().reverse() : [];
    const items = mails
      .map(
        (m) => `<article><header><strong>${escapeHtml(m.subject)}</strong><span>${escapeHtml(m.to)} · ${escapeHtml(new Date(m.createdAt).toLocaleString('de-DE'))}</span></header><pre>${escapeHtml(m.text)}</pre></article>`,
      )
      .join('');
    return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Druckplatte – Dev-Postausgang</title><style>
      body{font-family:system-ui,sans-serif;background:#17161A;color:#F2F1ED;margin:0;padding:20px;}
      h1{font-size:18px;margin:0 0 6px}p{color:#9C9AA3;font-size:13px;margin:0 0 16px}
      article{background:#201F24;border:1px solid #38363E;border-radius:12px;padding:12px 14px;margin-bottom:10px;max-width:760px}
      header{display:flex;flex-wrap:wrap;gap:4px 12px;justify-content:space-between;font-size:13px}header span{color:#9C9AA3}
      pre{white-space:pre-wrap;word-break:break-word;font-size:13px;margin:10px 0 0}
    </style></head><body><h1>📬 Dev-Postausgang (nur Preview)</h1><p>Keine echte E-Mail wurde versendet. MAIL_PRODUCTION_ENABLED=false.</p>${items || '<p>Noch keine Nachrichten.</p>'}</body></html>`;
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Methode nicht erlaubt');
    if (pathname === '/app.js') return sendStatic(res, 'app.js', 'text/javascript; charset=utf-8');
    const font = FONT_FILE.exec(pathname);
    if (font && fs.existsSync(path.join(config.publicDir, 'fonts', font[1]))) {
      return sendStatic(res, path.join('fonts', font[1]), 'font/woff2', { 'Cache-Control': 'public, max-age=604800' });
    }
    if (SPA_PATHS.some((re) => re.test(pathname))) {
      return sendStatic(res, 'index.html', 'text/html; charset=utf-8', { 'Content-Security-Policy': htmlCsp });
    }
    // Dev-Postausgang (enthält Anmeldecodes): nur Preview und nur von diesem Rechner aus.
    if (pathname === '/dev/outbox' && config.env === 'preview' && isDirectLocalRequest(req)) {
      const html = Buffer.from(renderOutbox(), 'utf8');
      return sendBuffer(res, 200, html, 'text/html; charset=utf-8', {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      });
    }
    throw new HttpError(404, 'not_found', 'Nicht gefunden');
  }

  // ---------------------------------------------------------------- Request-Handler

  async function handler(req, res) {
    const startedAt = Date.now();
    const cookiesOut = [];
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
      if (!pathname.startsWith('/api/')) {
        serveStatic(req, res, pathname);
        return;
      }
      const { route, params } = matchRoute(req.method, pathname);
      const cookies = parseCookies(req.headers.cookie);
      const ctx = {
        req,
        params,
        cookies,
        now: clock.now(),
        ip: clientIp(req),
        setCookie: (cookie) => cookiesOut.push(cookie),
        viewer: null,
        accessEmail: null,
        accessIat: null,
        restored: false,
        body: {},
      };
      if (req.method !== 'GET' && req.method !== 'HEAD') checkOrigin(req);

      if (cfAccess && route.auth !== 'public') {
        const access = await cfAccess.verifyRequest(req, cookies, ctx.now);
        if (!access.ok) throw new HttpError(401, 'access_required', 'Cloudflare-Access-Anmeldung erforderlich');
        ctx.accessEmail = access.email;
        ctx.accessIat = access.iat;
      }

      if (route.auth === 'user' || route.auth === 'admin') {
        const who = identity.resolve(cookies, ctx.setCookie, ctx.accessEmail);
        if (who.status !== 'ok') throw new HttpError(401, 'login_required', 'Anmeldung erforderlich');
        ctx.viewer = who.viewer;
        ctx.restored = who.restored;
        if (route.auth === 'admin' && !ctx.viewer.isAdmin) throw new HttpError(403, 'admin_required', 'Admin-Anmeldung erforderlich');
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') ctx.body = await readJsonBody(req, route.bodyLimit);

      const result = await route.handler(ctx);
      if (result && result.__binary) {
        sendBuffer(
          res,
          200,
          result.__binary.buffer,
          result.__binary.contentType,
          { 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'", 'Content-Disposition': 'inline', Vary: 'Cookie' },
          cookiesOut,
        );
        return;
      }
      sendJson(res, 200, result === undefined ? { ok: true } : result, cookiesOut);
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
      } else if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.code, message: err.message, ...(err.extra || {}) }, cookiesOut);
      } else {
        logger.error('Unerwarteter Fehler', { path: pathname, error: err && err.message });
        sendJson(res, 500, { error: 'internal', message: 'Interner Serverfehler' }, cookiesOut);
      }
    } finally {
      logger.info('http', { method: req.method, path: pathname, status: res.statusCode, ms: Date.now() - startedAt });
    }
  }

  // ---------------------------------------------------------------- Wartung

  /** Entfernt abgelaufene Sessions/Codes sofort und abgelaufene/widerrufene Geräte nach 30 Tagen. */
  function runMaintenance() {
    const now = clock.now();
    const keepDevice = (d) => !((d.revokedAt && now - d.revokedAt > 30 * DAY_MS) || now - d.expiresAt > 30 * DAY_MS);
    const keepSession = (s) => s.expiresAt > now;
    const keepOtp = (o) => o.expiresAt > now - DAY_MS;
    const state = store.state;
    const removable = state.devices.some((d) => !keepDevice(d)) || state.sessions.some((s) => !keepSession(s)) || state.otps.some((o) => !keepOtp(o));
    let removed = { devices: 0, sessions: 0, otps: 0 };
    if (removable) {
      removed = store.transaction((draft) => {
        const before = { devices: draft.devices.length, sessions: draft.sessions.length, otps: draft.otps.length };
        draft.devices = draft.devices.filter(keepDevice);
        draft.sessions = draft.sessions.filter(keepSession);
        draft.otps = draft.otps.filter(keepOtp);
        return {
          devices: before.devices - draft.devices.length,
          sessions: before.sessions - draft.sessions.length,
          otps: before.otps - draft.otps.length,
        };
      });
    }
    for (const limiter of Object.values(limits)) limiter.prune(now);
    return removed;
  }

  function close() {
    store.close();
  }

  return { handler, store, config, clock, mail, runMaintenance, close, SECURITY_HEADERS };
}

module.exports = { createApp };
