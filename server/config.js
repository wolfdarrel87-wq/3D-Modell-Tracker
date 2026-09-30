'use strict';

const path = require('node:path');
const { DAY_MS, HOUR_MS, MINUTE_MS } = require('./util/time');
const { blockedHostReason } = require('./domain/images');

/** Vertrauenswürdiges Gerät: exakt 30 × 24 Stunden ab Anmeldung, absolut, ohne Verlängerung. */
const TRUSTED_DEVICE_TTL_MS = 30 * DAY_MS;

const ENVIRONMENTS = ['preview', 'production', 'test'];

/**
 * Anmeldequellen:
 *  - 'email-code':        Druckplatte verschickt selbst einen E-Mail-Code (Preview/Test ohne Cloudflare).
 *  - 'cloudflare-access': Cloudflare Access hat die E-Mail bereits per Code bestätigt; Druckplatte
 *                         verlangt KEINEN zweiten Code und registriert das Gerät auf Basis dieser Identität.
 */
const AUTH_MODES = ['email-code', 'cloudflare-access'];

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function list(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function originOf(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} enthält keine gültige URL: ${value}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${name} muss http(s) verwenden: ${value}`);
  return url.origin;
}

function loadConfig(env = process.env, overrides = {}) {
  const port = Number(env.PORT || 8080);
  const teamDomain = String(env.CF_ACCESS_TEAM_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const aud = String(env.CF_ACCESS_AUD || '').trim();
  const publicBaseUrl = String(env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  const cfAccess = teamDomain && aud ? { teamDomain, aud } : null;

  const config = {
    env: env.DRUCKPLATTE_ENV || 'preview',
    host: env.HOST || '127.0.0.1',
    port,
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data', 'preview')),
    publicDir: path.resolve(__dirname, '..', 'public'),
    publicBaseUrl,
    // Nur explizit konfigurierte Origins – niemals aus dem Host-Header abgeleitet.
    allowedOrigins: [...new Set([originOf(publicBaseUrl, 'PUBLIC_BASE_URL'), ...list(env.ALLOWED_ORIGINS).map((o) => originOf(o, 'ALLOWED_ORIGINS'))])],
    mailProductionEnabled: bool(env.MAIL_PRODUCTION_ENABLED, false),
    adminEmails: list(env.ADMIN_EMAILS),
    adminPasswordHash: env.ADMIN_PASSWORD_HASH || '',
    loginAllowlist: list(env.LOGIN_ALLOWLIST),
    trustProxy: bool(env.TRUST_PROXY, false),
    authPepper: env.AUTH_PEPPER || '',
    sessionTtlMs: Number(env.SESSION_TTL_HOURS || 12) * HOUR_MS,
    trustedDeviceTtlMs: TRUSTED_DEVICE_TTL_MS,
    otpTtlMs: 10 * 60 * 1000,
    otpMaxAttempts: 5,
    cfAccess,
    cfAccessPartial: Boolean(teamDomain) !== Boolean(aud),
    allowWithoutCfAccess: bool(env.ALLOW_WITHOUT_CF_ACCESS, false),
    authMode: env.AUTH_MODE || (cfAccess ? 'cloudflare-access' : 'email-code'),
    // Ein Gerät wird im Cloudflare-Modus nur bei einer frischen Access-Anmeldung registriert.
    cfAccessMaxLoginAgeMs: Number(env.CF_ACCESS_MAX_LOGIN_AGE_MINUTES || 10) * MINUTE_MS,
    // Externe Bild-URLs: standardmäßig keine. Nur exakt diese Hostnamen (https) wären erlaubt.
    imageHostAllowlist: list(env.IMAGE_HOST_ALLOWLIST),
    ...overrides,
  };

  validateConfig(config);
  return config;
}

function validateConfig(config) {
  if (!ENVIRONMENTS.includes(config.env)) {
    throw new Error(`DRUCKPLATTE_ENV muss einer von ${ENVIRONMENTS.join(', ')} sein`);
  }
  if (config.mailProductionEnabled) {
    // Sicherheitsriegel: Dieser Build enthält bewusst keinen Produktions-Mailtransport.
    throw new Error('MAIL_PRODUCTION_ENABLED=true wird in diesem Build nicht unterstützt (kein Produktions-Mailtransport integriert).');
  }
  if (config.trustedDeviceTtlMs !== TRUSTED_DEVICE_TTL_MS) {
    throw new Error('Die Laufzeit vertrauenswürdiger Geräte ist fest auf 30 Tage gesetzt.');
  }
  if (!(config.sessionTtlMs > 0) || config.sessionTtlMs > TRUSTED_DEVICE_TTL_MS) {
    throw new Error('SESSION_TTL_HOURS muss größer 0 und höchstens 30 Tage sein.');
  }

  // Cloudflare Access: halbe Konfiguration ist immer ein Fehler.
  if (config.cfAccessPartial) {
    throw new Error('Cloudflare Access unvollständig konfiguriert: CF_ACCESS_TEAM_DOMAIN und CF_ACCESS_AUD müssen beide gesetzt sein.');
  }
  if (!AUTH_MODES.includes(config.authMode)) throw new Error(`AUTH_MODE muss einer von ${AUTH_MODES.join(', ')} sein`);
  if (config.authMode === 'cloudflare-access' && !config.cfAccess) {
    throw new Error('AUTH_MODE=cloudflare-access braucht CF_ACCESS_TEAM_DOMAIN und CF_ACCESS_AUD.');
  }
  if (config.authMode === 'email-code' && config.cfAccess) {
    // Sonst: Cloudflare-Code + Druckplatte-Code = zwei Codes für dieselbe Anmeldung.
    throw new Error('AUTH_MODE=email-code zusammen mit Cloudflare Access würde zwei E-Mail-Codes verlangen. Mit Access AUTH_MODE=cloudflare-access verwenden.');
  }
  if (!(config.cfAccessMaxLoginAgeMs > 0) || config.cfAccessMaxLoginAgeMs > DAY_MS) {
    throw new Error('CF_ACCESS_MAX_LOGIN_AGE_MINUTES muss größer 0 und höchstens 1440 sein.');
  }

  for (const host of config.imageHostAllowlist) {
    // Gleiche Regeln wie bei der Prüfung jeder Bild-URL: keine IPs, kein localhost, keine internen Namen.
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || blockedHostReason(host)) {
      throw new Error(`IMAGE_HOST_ALLOWLIST darf nur öffentliche Hostnamen enthalten (keine IPs, kein localhost, keine internen Namen): ${host}`);
    }
  }

  if (config.env === 'production') {
    if (!/^https:\/\//.test(config.publicBaseUrl)) throw new Error('PUBLIC_BASE_URL muss in Produktion https:// verwenden.');
    const insecure = config.allowedOrigins.filter((o) => !o.startsWith('https://'));
    if (insecure.length) throw new Error(`ALLOWED_ORIGINS muss in Produktion https:// verwenden: ${insecure.join(', ')}`);
    if (config.adminEmails.length && !config.adminPasswordHash) throw new Error('ADMIN_PASSWORD_HASH fehlt.');
    // Fail closed: ohne Cloudflare Access startet die Produktion nicht – außer bei bewusstem Override.
    if (!config.cfAccess && !config.allowWithoutCfAccess) {
      throw new Error(
        'Produktion ohne Cloudflare Access verweigert: CF_ACCESS_TEAM_DOMAIN und CF_ACCESS_AUD setzen ' +
          '(nur bei bewusster Entscheidung ALLOW_WITHOUT_CF_ACCESS=true).',
      );
    }
  }
}

module.exports = { loadConfig, validateConfig, TRUSTED_DEVICE_TTL_MS, AUTH_MODES };
