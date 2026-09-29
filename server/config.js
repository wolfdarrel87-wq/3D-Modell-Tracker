'use strict';

const path = require('node:path');
const { DAY_MS, HOUR_MS } = require('./util/time');

/** Vertrauenswürdiges Gerät: exakt 30 × 24 Stunden ab Code-Anmeldung, absolut, ohne Verlängerung. */
const TRUSTED_DEVICE_TTL_MS = 30 * DAY_MS;

const ENVIRONMENTS = ['preview', 'production', 'test'];

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

function loadConfig(env = process.env, overrides = {}) {
  const port = Number(env.PORT || 8080);
  const teamDomain = String(env.CF_ACCESS_TEAM_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const aud = String(env.CF_ACCESS_AUD || '').trim();

  const config = {
    env: env.DRUCKPLATTE_ENV || 'preview',
    host: env.HOST || '127.0.0.1',
    port,
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data', 'preview')),
    publicDir: path.resolve(__dirname, '..', 'public'),
    publicBaseUrl: String(env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
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
    cfAccess: teamDomain && aud ? { teamDomain, aud } : null,
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
  if (config.env === 'production') {
    if (!/^https:\/\//.test(config.publicBaseUrl)) throw new Error('PUBLIC_BASE_URL muss in Produktion https:// verwenden.');
    if (config.adminEmails.length && !config.adminPasswordHash) throw new Error('ADMIN_PASSWORD_HASH fehlt.');
  }
}

module.exports = { loadConfig, validateConfig, TRUSTED_DEVICE_TTL_MS };
