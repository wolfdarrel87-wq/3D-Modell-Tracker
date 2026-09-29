'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../server/config');
const { createApp } = require('../server/app');
const { createLogger } = require('../server/util/log');
const { hashPassword } = require('../server/util/crypto');

const ADMIN_EMAIL = 'admin@druckplatte.test';
const ADMIN_PASSWORD = 'test-admin-passwort-2026';
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const START = Date.UTC(2026, 8, 27, 12, 0, 0); // 27.09.2026 14:00 Uhr deutscher Zeit

const UA = {
  chromeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  safariIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
};

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let adminHashPromise = null;

function fakeClock(start = START) {
  let t = start;
  return {
    now: () => t,
    set: (value) => {
      t = value;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'druckplatte-test-'));
}

async function startServer({ dataDir = tempDir(), clock = fakeClock(), env = {}, fetchImpl } = {}) {
  adminHashPromise = adminHashPromise || hashPassword(ADMIN_PASSWORD);
  const config = loadConfig({
    DRUCKPLATTE_ENV: 'test',
    DATA_DIR: dataDir,
    ADMIN_EMAILS: ADMIN_EMAIL,
    ADMIN_PASSWORD_HASH: await adminHashPromise,
    PUBLIC_BASE_URL: 'https://druckplatte.test',
    ...env,
  });
  const logs = [];
  const logger = createLogger({ log: (line) => logs.push(line), error: (line) => logs.push(line) });
  const app = createApp({ config, clock, logger, fetchImpl });
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    app,
    server,
    baseUrl,
    dataDir,
    clock,
    logs,
    config,
    get state() {
      return app.store.state;
    },
    outbox: () => app.mail.list(),
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      app.close();
    },
  };
}

/** Parst Set-Cookie-Header in { name, value, attrs }. */
function parseSetCookie(raw) {
  const [pair, ...attrParts] = raw.split(';');
  const idx = pair.indexOf('=');
  const attrs = {};
  for (const part of attrParts) {
    const [k, ...v] = part.trim().split('=');
    attrs[k.toLowerCase()] = v.length ? v.join('=') : true;
  }
  return { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim(), attrs, raw };
}

/**
 * Minimaler „Browser“ mit Cookie-Speicher. Persistente Cookies (Max-Age/Expires) überleben
 * closeBrowser(); Session-Cookies nicht – wie in einem echten Browser.
 */
class Browser {
  constructor(server, { userAgent = UA.chromeWindows } = {}) {
    this.server = server;
    this.userAgent = userAgent;
    this.jar = new Map();
    this.responses = [];
  }

  now() {
    return this.server.clock.now();
  }

  cookieHeader() {
    const now = this.now();
    const parts = [];
    for (const [name, c] of this.jar) {
      if (c.expiresAt !== null && c.expiresAt <= now) {
        this.jar.delete(name);
        continue;
      }
      parts.push(`${name}=${c.value}`);
    }
    return parts.join('; ');
  }

  storeCookies(setCookies) {
    for (const raw of setCookies) {
      const cookie = parseSetCookie(raw);
      let expiresAt = null;
      if (cookie.attrs['max-age'] !== undefined) expiresAt = this.now() + Number(cookie.attrs['max-age']) * 1000;
      else if (cookie.attrs.expires) expiresAt = Date.parse(cookie.attrs.expires);
      if (expiresAt !== null && expiresAt <= this.now()) this.jar.delete(cookie.name);
      else this.jar.set(cookie.name, { value: cookie.value, expiresAt, attrs: cookie.attrs, raw });
    }
  }

  async request(method, urlPath, body, { headers = {} } = {}) {
    const init = {
      method,
      redirect: 'manual',
      headers: { 'user-agent': this.userAgent, ...headers },
    };
    const cookie = this.cookieHeader();
    if (cookie) init.headers.cookie = cookie;
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(this.server.baseUrl + urlPath, init);
    const setCookies = res.headers.getSetCookie();
    this.storeCookies(setCookies);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* kein JSON */
    }
    const result = { status: res.status, json, text, headers: res.headers, setCookies };
    this.responses.push(result);
    return result;
  }

  get(p, opts) {
    return this.request('GET', p, undefined, opts);
  }
  post(p, body = {}, opts) {
    return this.request('POST', p, body, opts);
  }
  patch(p, body = {}, opts) {
    return this.request('PATCH', p, body, opts);
  }
  del(p, opts) {
    return this.request('DELETE', p, undefined, opts);
  }

  /** Browser schließen: Session-Cookies verschwinden, persistente Cookies bleiben. */
  closeBrowser() {
    for (const [name, c] of this.jar) if (c.expiresAt === null) this.jar.delete(name);
  }

  cookie(name) {
    const c = this.jar.get(name);
    return c ? c.value : undefined;
  }

  setCookie(name, value, expiresAt = null) {
    this.jar.set(name, { value, expiresAt, attrs: {}, raw: '' });
  }

  /** Öffnet einen Link aus einer E-Mail (absolute URL) im selben Browser. */
  async openMailLink(link) {
    const url = new URL(link);
    const page = await this.get(url.pathname + url.search);
    const me = await this.get('/api/me');
    return { page, me };
  }
}

function latestMail(server, { to, kind }) {
  const mails = server.outbox().filter((m) => (!to || m.to === to) && (!kind || m.kind === kind));
  return mails[mails.length - 1] || null;
}

function mailLinks(mail) {
  return (mail.text.match(/https?:\/\/\S+/g) || []).map((l) => l.replace(/[).,]+$/, ''));
}

async function login(server, browser, email) {
  const requested = await browser.post('/api/auth/request-code', { email });
  assert.equal(requested.status, 200, requested.text);
  const mail = latestMail(server, { to: email, kind: 'login_code' });
  assert.ok(mail, 'Code-Mail fehlt');
  const code = /Anmeldecode lautet: (\d{6})/.exec(mail.text)[1];
  const verified = await browser.post('/api/auth/verify-code', { email, code });
  assert.equal(verified.status, 200, verified.text);
  return verified;
}

async function elevate(browser, password = ADMIN_PASSWORD) {
  const res = await browser.post('/api/admin/elevate', { password });
  assert.equal(res.status, 200, res.text);
  return res;
}

async function createOrder(browser, fields) {
  const res = await browser.post('/api/orders', {
    type: 'model',
    color: 'Weiß',
    filament: 'PLA',
    note: '',
    image: '',
    isPublic: false,
    ...fields,
  });
  assert.equal(res.status, 200, res.text);
  return res.json.order;
}

function activeDevices(server, email) {
  const user = server.state.users.find((u) => u.email === email);
  if (!user) return [];
  const now = server.clock.now();
  return server.state.devices.filter((d) => d.userId === user.id && !d.revokedAt && now < d.expiresAt);
}

function allDevices(server, email) {
  const user = server.state.users.find((u) => u.email === email);
  return user ? server.state.devices.filter((d) => d.userId === user.id) : [];
}

module.exports = {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  DAY,
  HOUR,
  START,
  UA,
  TINY_PNG,
  fakeClock,
  tempDir,
  startServer,
  parseSetCookie,
  Browser,
  latestMail,
  mailLinks,
  login,
  elevate,
  createOrder,
  activeDevices,
  allDevices,
};
