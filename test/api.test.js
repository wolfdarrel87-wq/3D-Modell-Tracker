'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { ADMIN_EMAIL, TINY_PNG, START, startServer, Browser, login, elevate, createOrder, latestMail, accessFixture } = require('./helpers');
const { loadConfig } = require('../server/config');
const { deviceLabelFromUserAgent } = require('../server/util/useragent');

async function withServer(fn, opts) {
  const server = await startServer(opts);
  try {
    await fn(server);
  } finally {
    await server.stop();
  }
}

test('Konfiguration: Sicherheitsriegel für Mailversand, Gerätelaufzeit und Produktion', () => {
  assert.throws(() => loadConfig({ MAIL_PRODUCTION_ENABLED: 'true' }), /MAIL_PRODUCTION_ENABLED/);
  assert.throws(() => loadConfig({}, { trustedDeviceTtlMs: 31 * 86400000 }), /30 Tage/);
  assert.throws(() => loadConfig({ SESSION_TTL_HOURS: '1000' }), /SESSION_TTL_HOURS/);
  assert.throws(() => loadConfig({ DRUCKPLATTE_ENV: 'production', PUBLIC_BASE_URL: 'http://x.test' }), /https/);
  assert.throws(() => loadConfig({ DRUCKPLATTE_ENV: 'staging' }), /DRUCKPLATTE_ENV/);
  const cfg = loadConfig({});
  assert.equal(cfg.env, 'preview');
  assert.equal(cfg.mailProductionEnabled, false);
  assert.equal(cfg.host, '127.0.0.1');
});

test('Statische Seiten: CSP, SPA-Pfade für Mail-Links, keine Server-Dateien', () =>
  withServer(async (server) => {
    const browser = new Browser(server);
    const index = await browser.get('/');
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(index.text, /<script src="\/app\.js"/);
    for (const p of ['/auftrag/DP-2026-000001', '/support', '/profil']) assert.equal((await browser.get(p)).status, 200, p);
    assert.equal((await browser.get('/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
    for (const p of ['/server/app.js', '/../package.json', '/data/preview/druckplatte.json', '/dev/outbox']) {
      assert.equal((await browser.get(p)).status, 404, p);
    }
  }));

test('Dev-Postausgang nur in der Preview-Umgebung', () =>
  withServer(
    async (server) => {
      const browser = new Browser(server);
      await browser.post('/api/auth/request-code', { email: 'anna@example.test' });
      const page = await browser.get('/dev/outbox');
      assert.equal(page.status, 200);
      assert.match(page.text, /Dev-Postausgang/);
      assert.match(page.text, /Keine echte E-Mail/);
    },
    { env: { DRUCKPLATTE_ENV: 'preview' } },
  ));

test('Eingaben: JSON-Pflicht, Größenlimit, Validierung', () =>
  withServer(async (server) => {
    const browser = new Browser(server);
    await login(server, browser, 'anna@example.test');
    const form = await fetch(`${server.baseUrl}/api/support`, {
      method: 'POST',
      headers: { cookie: browser.cookieHeader(), 'content-type': 'application/x-www-form-urlencoded', origin: server.origin },
      body: 'message=x',
    });
    assert.equal(form.status, 415);
    const huge = await browser.post('/api/support', { message: 'x'.repeat(20000) });
    assert.equal(huge.status, 413);
    const js = await browser.post('/api/orders', { type: 'idea', name: 'X', link: 'javascript:alert(1)', color: 'Weiß', filament: 'PLA' });
    assert.equal(js.status, 400);
    const badImage = await browser.post('/api/orders', { type: 'idea', name: 'X', link: '', color: 'Weiß', filament: 'PLA', image: 'data:image/png;base64,AAAA' });
    assert.equal(badImage.status, 400);
    const fakeMw = await browser.post('/api/orders', { type: 'model', name: 'X', link: 'https://evil.test/?makerworld.com', color: 'Weiß', filament: 'PLA' });
    assert.equal(fakeMw.status, 400, 'MakerWorld-Prüfung serverseitig und strikt');
    const cn = await browser.post('/api/orders', { type: 'model', name: 'CN', link: 'https://makerworld.com.cn/zh/models/1', color: 'Weiß', filament: 'PLA' });
    assert.equal(cn.status, 200);
    assert.equal(server.state.orders.length, 1);
  }));

test('Ideen-Workflow: Idee geht an Admin, Annahme → In Bearbeitung, Ablehnung löscht', () =>
  withServer(async (server) => {
    const anna = new Browser(server);
    await login(server, anna, 'anna@example.test');
    const admin = new Browser(server);
    await login(server, admin, ADMIN_EMAIL);
    await elevate(admin);
    const accept = await createOrder(anna, { type: 'idea', name: 'Kabelhalter', link: '', image: TINY_PNG });
    const reject = await createOrder(anna, { type: 'idea', name: 'Unmöglich', link: '' });
    assert.equal(accept.status, null);
    assert.equal((await admin.post('/api/admin/queue', { orderId: accept.id })).status, 409, 'offene Idee nicht einreihbar');
    const accepted = await admin.post(`/api/orders/${accept.id}/accept`);
    assert.equal(accepted.json.order.status, 'progress');
    assert.equal(accepted.json.order.dpRef, accept.dpRef, 'DP-Nummer bleibt bei Annahme gleich');
    assert.ok(latestMail(server, { to: 'anna@example.test', kind: 'idea_accepted' }));
    assert.equal((await admin.post(`/api/orders/${reject.id}/reject`)).status, 200);
    assert.deepEqual(server.state.orders.map((o) => o.name), ['Kabelhalter']);
  }));

test('Admin: Warteschlange sortieren, aktueller Druck, Fortschritt, Fertigstellung (ohne Drucker)', () =>
  withServer(async (server) => {
    const anna = new Browser(server);
    await login(server, anna, 'anna@example.test');
    const admin = new Browser(server);
    await login(server, admin, ADMIN_EMAIL);
    await elevate(admin);
    const a = await createOrder(anna, { name: 'A', link: 'https://makerworld.com/de/models/1' });
    const b = await createOrder(anna, { name: 'B', link: 'https://makerworld.com/de/models/2' });
    await admin.post('/api/admin/queue', { orderId: a.id });
    await admin.post('/api/admin/queue', { orderId: b.id });
    assert.equal((await admin.post('/api/admin/queue', { orderId: a.id })).status, 409);
    await admin.post(`/api/admin/queue/${b.id}/move`, { direction: 'up' });
    assert.deepEqual(server.state.queue, [b.id, a.id]);
    const live = await admin.post('/api/admin/printer/current', { orderId: b.id });
    assert.equal(live.json.currentPrint.order.name, 'B');
    assert.deepEqual(server.state.queue, [a.id]);
    assert.equal((await admin.post('/api/admin/printer/progress', { progress: 150 })).status, 400);
    await admin.post('/api/admin/printer/progress', { progress: 80, remainingMinutes: 20 });
    server.clock.advance(5 * 60 * 1000);
    const own = (await anna.get('/api/current-print')).json.currentPrint;
    assert.equal(own.remainingMinutes, 15, 'Restzeit läuft mit');
    await admin.post('/api/admin/printer/finish');
    assert.equal(server.state.orders.find((o) => o.id === b.id).status, 'ready');
    assert.equal(server.state.printer.currentOrderId, null);
    assert.ok(latestMail(server, { to: 'anna@example.test', kind: 'order_finished' }));
    await admin.del(`/api/admin/queue/${a.id}`);
    assert.deepEqual(server.state.queue, []);
    await admin.del(`/api/orders/${a.id}`);
    assert.equal(server.state.orders.length, 1);
  }));

test('Support: Nachricht an Admin, Admin sieht Liste, Löschen des Auftrags möglich', () =>
  withServer(async (server) => {
    const anna = new Browser(server);
    await login(server, anna, 'anna@example.test');
    const admin = new Browser(server);
    await login(server, admin, ADMIN_EMAIL);
    await elevate(admin);
    const order = await createOrder(anna, { name: 'Weg damit', link: 'https://makerworld.com/de/models/1', image: TINY_PNG });
    assert.equal((await anna.post('/api/support', { message: 'Bitte löschen', orderId: order.id })).status, 200);
    const list = (await admin.get('/api/support')).json.messages;
    assert.equal(list[0].userEmail, 'anna@example.test');
    assert.equal(list[0].dpRef, order.dpRef);
    assert.equal(list[0].orderExists, true);
    await admin.post(`/api/support/${list[0].id}/resolve`, { deleteOrder: true });
    assert.equal(server.state.orders.length, 0);
    assert.equal(server.state.support.length, 0);
  }));

test('Admin-Benutzerverwaltung: Selbstschutz und Sicherheitsreset', () =>
  withServer(async (server) => {
    const admin = new Browser(server);
    await login(server, admin, ADMIN_EMAIL);
    await elevate(admin);
    const anna = new Browser(server);
    await login(server, anna, 'anna@example.test');
    const users = (await admin.get('/api/admin/users')).json.users;
    const self = users.find((u) => u.email === ADMIN_EMAIL);
    const annaUser = users.find((u) => u.email === 'anna@example.test');
    assert.equal(annaUser.activeDevices, 1);
    assert.equal((await admin.post(`/api/admin/users/${self.id}/block`)).status, 409);
    assert.equal((await admin.del(`/api/admin/users/${self.id}`)).status, 409);
    const reset = await admin.post(`/api/admin/users/${annaUser.id}/reset-devices`);
    assert.equal(reset.json.revoked, 1);
    assert.equal((await anna.get('/api/me')).status, 401);
  }));

test('Gerätebezeichnung: grob, ohne Fingerprint', () => {
  assert.equal(deviceLabelFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0'), 'Edge · Windows');
  assert.equal(deviceLabelFromUserAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36'), 'Chrome · Android');
  assert.equal(deviceLabelFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'), 'Safari · macOS');
  assert.equal(deviceLabelFromUserAgent(''), 'Browser · Unbekanntes System');
});

test('Cloudflare Access: ohne gültiges Access-JWT kein Zugriff – Geräte-Cookie ersetzt Access nie', async () => {
  const access = accessFixture();
  const server = await startServer({ env: { CF_ACCESS_TEAM_DOMAIN: access.teamDomain, CF_ACCESS_AUD: access.aud }, fetchImpl: access.fetchImpl });
  try {
    const browser = new Browser(server);
    const jwt = (email, opts) => ({ headers: { 'cf-access-jwt-assertion': access.token(email, opts) } });
    const ANNA = 'anna@example.test';

    // Anpassung (Review, Punkt 4): Mit Cloudflare Access gibt es keinen zweiten Druckplatte-Code mehr.
    // Früher: request-code/verify-code zusätzlich zum Access-Code. Jetzt: access-session.
    assert.equal((await browser.post('/api/auth/access-session')).status, 401, 'ohne Access-JWT');
    assert.equal((await browser.post('/api/auth/access-session', {}, jwt(ANNA))).status, 200);
    assert.equal(server.outbox().length, 0, 'kein E-Mail-Code von Druckplatte');

    assert.equal((await browser.get('/api/me', jwt(ANNA))).status, 200, 'Access + Gerät');
    browser.closeBrowser();
    assert.equal((await browser.get('/api/me', jwt(ANNA))).status, 200, 'Gerät stellt Session wieder her');
    assert.equal((await browser.get('/api/me')).status, 401, 'Gerät allein umgeht Cloudflare Access nicht');
    assert.equal((await browser.get('/api/me', jwt(ANNA, { exp: Math.floor(START / 1000) - 60 }))).status, 401, 'abgelaufenes Access-JWT');
    assert.equal((await browser.get('/api/me', jwt(ANNA, { audience: 'andere-app' }))).status, 401, 'falsche AUD');
    assert.equal((await browser.get('/api/me', jwt(ANNA, { iss: 'https://evil.cloudflareaccess.com' }))).status, 401, 'falscher Aussteller');
    const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    assert.equal((await browser.get('/api/me', jwt(ANNA, { key: otherKey }))).status, 401, 'falsche Signatur');

    const asBen = await browser.get('/api/me', jwt('ben@example.test'));
    assert.equal(asBen.status, 401, 'Access-Identität Ben + Annas Gerät → kein Zugriff');
    assert.equal((await browser.get('/api/health')).status, 200);
  } finally {
    await server.stop();
  }
});
