'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ADMIN_EMAIL,
  DAY,
  HOUR,
  START,
  UA,
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
} = require('./helpers');

const DEVICE = '__Host-dp_device';
const SESSION = '__Host-dp_session';
const THIRTY_DAYS_S = 30 * 24 * 60 * 60;
const ANNA = 'anna@example.test';
const BEN = 'ben@example.test';

async function withServer(fn, opts) {
  const server = await startServer(opts);
  try {
    await fn(server);
  } finally {
    await server.stop();
  }
}

function codeMailCount(server, email) {
  return server.outbox().filter((m) => m.to === email && m.kind === 'login_code').length;
}

test('W: neues Endgerät → E-Mail-Code erforderlich', () =>
  withServer(async (server) => {
    const browser = new Browser(server);
    const me = await browser.get('/api/me');
    assert.equal(me.status, 401);
    assert.equal(me.json.error, 'login_required');
    assert.equal(browser.cookie(DEVICE), undefined);
    assert.equal(server.state.devices.length, 0);
  }));

test('X: Code erfolgreich → Gerät registriert, sicherer Cookie, serverseitig nur Hash', () =>
  withServer(async (server) => {
    const browser = new Browser(server);
    const res = await login(server, browser, ANNA);
    const token = browser.cookie(DEVICE);
    assert.ok(token && token.length >= 43, 'Token mit mind. 256 Bit erwartet');
    assert.equal(Buffer.from(token, 'base64url').length, 32);

    assert.equal(server.state.devices.length, 1);
    const device = server.state.devices[0];
    assert.match(device.tokenHash, /^[0-9a-f]{64}$/);
    assert.notEqual(device.tokenHash, token);
    assert.equal(device.expiresAt - device.createdAt, 30 * DAY);
    assert.equal(device.deviceLabel, 'Chrome · Windows');

    const fileContent = fs.readFileSync(path.join(server.dataDir, 'druckplatte.json'), 'utf8');
    assert.ok(!fileContent.includes(token), 'Klartext-Token darf nicht gespeichert werden');
    assert.ok(!fileContent.includes(browser.cookie(SESSION)), 'Klartext-Session-Token darf nicht gespeichert werden');
    assert.ok(!JSON.stringify(res.json).includes(token), 'Token darf nicht im JSON stehen');
  }));

test('Cookie-Flags: HttpOnly, Secure, SameSite=Lax, Path=/, persistente Laufzeit max. 30 Tage', () =>
  withServer(async (server) => {
    const browser = new Browser(server);
    const res = await login(server, browser, ANNA);
    const cookies = res.setCookies.map(parseSetCookie);
    const device = cookies.find((c) => c.name === DEVICE);
    const session = cookies.find((c) => c.name === SESSION);

    assert.equal(device.attrs.httponly, true);
    assert.equal(device.attrs.secure, true);
    assert.equal(device.attrs.samesite, 'Lax');
    assert.equal(device.attrs.path, '/');
    assert.equal(device.attrs.domain, undefined, '__Host- Cookies dürfen keine Domain haben');
    assert.equal(Number(device.attrs['max-age']), THIRTY_DAYS_S);
    assert.ok(Number(device.attrs['max-age']) <= THIRTY_DAYS_S);
    assert.equal(Date.parse(device.attrs.expires), server.state.devices[0].expiresAt);
    assert.equal(server.state.devices[0].expiresAt, START + 30 * DAY);

    // Session-Cookie: Browser-Session (kein Max-Age/Expires), ebenfalls HttpOnly/Secure.
    assert.equal(session.attrs.httponly, true);
    assert.equal(session.attrs.secure, true);
    assert.equal(session.attrs.samesite, 'Lax');
    assert.equal(session.attrs['max-age'], undefined);
    assert.equal(session.attrs.expires, undefined);
  }));

test('Y/Z/AA/AB: Website erneut öffnen, Browser schließen, neue Session, Neustart → kein Code', async () => {
  const dataDir = tempDir();
  const clock = fakeClock();
  let server = await startServer({ dataDir, clock });
  const browser = new Browser(server);
  try {
    await login(server, browser, ANNA);
    const codes = codeMailCount(server, ANNA);

    // Y: Website erneut öffnen
    const page = await browser.get('/');
    assert.equal(page.status, 200);
    assert.equal((await browser.get('/api/me')).status, 200);

    // Z: Browser schließen und wieder öffnen
    browser.closeBrowser();
    assert.equal(browser.cookie(SESSION), undefined);
    clock.advance(2 * HOUR);
    const reopened = await browser.get('/api/me');
    assert.equal(reopened.status, 200);
    assert.equal(reopened.json.restored, true);

    // AA: normale Session läuft ab (12 h) → Gerät stellt neue Session her
    clock.advance(13 * HOUR);
    const renewed = await browser.get('/api/me');
    assert.equal(renewed.status, 200);
    assert.equal(renewed.json.restored, true);

    // AB: PC-/Geräteneustart + Server-Neustart – persistenter Cookie bleibt gültig
    browser.closeBrowser();
    await server.stop();
    server = await startServer({ dataDir, clock });
    browser.server = server;
    clock.advance(24 * HOUR);
    const afterRestart = await browser.get('/api/me');
    assert.equal(afterRestart.status, 200);

    assert.equal(codeMailCount(server, ANNA), codes, 'kein neuer Code');
    assert.equal(allDevices(server, ANNA).length, 1, 'kein neues Gerät');
  } finally {
    await server.stop();
  }
});

test('AC/AD/AE + E-Mail-Links A–D, G: Status-, Fertig-, Ideen- und Support-Mails → kein Code, kein neues Gerät', () =>
  withServer(async (server) => {
    const clock = server.clock;
    const anna = new Browser(server);
    await login(server, anna, ANNA);
    const admin = new Browser(server);
    await login(server, admin, ADMIN_EMAIL);
    await elevate(admin);

    const order = await createOrder(anna, { name: 'Anna Halter', link: 'https://makerworld.com/de/models/1-halter' });
    const idea = await createOrder(anna, { type: 'idea', name: 'Anna Idee', link: '' });
    const codesBefore = codeMailCount(server, ANNA);

    // Status-Mail (A)
    assert.equal((await admin.patch(`/api/orders/${order.id}`, { status: 'fail' })).status, 200);
    // Fertigstellungs-Mail (B)
    assert.equal((await admin.patch(`/api/orders/${order.id}`, { status: 'ready' })).status, 200);
    // Idee angenommen (D: beliebiger Druckplatte-Link)
    assert.equal((await admin.post(`/api/orders/${idea.id}/accept`)).status, 200);
    // Support-Mail (C)
    assert.equal((await anna.post('/api/support', { message: 'Bitte Modell löschen', orderId: order.id })).status, 200);
    const supportId = (await admin.get('/api/support')).json.messages[0].id;
    assert.equal((await admin.post(`/api/support/${supportId}/resolve`, {})).status, 200);

    const kinds = ['order_status', 'order_finished', 'idea_accepted', 'support_resolved'];
    const deviceIdBefore = activeDevices(server, ANNA)[0].id;
    for (const kind of kinds) {
      const mail = latestMail(server, { to: ANNA, kind });
      assert.ok(mail, `Mail ${kind} fehlt`);
      const [link] = mailLinks(mail);
      assert.ok(link.startsWith('https://druckplatte.test/'), link);
      // Tag 5, 14, 25 …: Browser war zwischendurch geschlossen
      clock.advance(3 * DAY);
      anna.closeBrowser();
      const { page, me } = await anna.openMailLink(link);
      assert.equal(page.status, 200, `${kind}: Zielseite`);
      assert.equal(me.status, 200, `${kind}: kein Code erforderlich`);
      assert.equal(me.json.user.email, ANNA);
      assert.equal(me.json.device.id, deviceIdBefore, `${kind}: dasselbe Gerät`);
    }
    // G: E-Mail-Links erzeugen niemals ein neues Gerät
    assert.equal(allDevices(server, ANNA).length, 1);
    assert.equal(codeMailCount(server, ANNA), codesBefore);
  }));

test('E-Mail-Link F: neues Gerät + derselbe Link → Code erforderlich', () =>
  withServer(async (server) => {
    const anna = new Browser(server);
    await login(server, anna, ANNA);
    const admin = new Browser(server);
    await login(server, admin, ADMIN_EMAIL);
    await elevate(admin);
    const order = await createOrder(anna, { name: 'X', link: 'https://makerworld.com/de/models/2' });
    await admin.patch(`/api/orders/${order.id}`, { status: 'ready' });
    const [link] = mailLinks(latestMail(server, { to: ANNA, kind: 'order_finished' }));

    const otherDevice = new Browser(server, { userAgent: UA.safariIphone });
    const { page, me } = await otherDevice.openMailLink(link);
    assert.equal(page.status, 200); // statische Seite zeigt die Anmeldung
    assert.equal(me.status, 401);
    assert.equal(allDevices(server, ANNA).length, 1, 'Mail-Link registriert kein Gerät');
  }));

test('AF/AG/E: 29 Tage gültig, ab exakt 30 Tagen Code erforderlich', () =>
  withServer(async (server) => {
    const clock = server.clock;
    const browser = new Browser(server);
    await login(server, browser, ANNA);
    const device = activeDevices(server, ANNA)[0];

    clock.set(START + 29 * DAY);
    browser.closeBrowser();
    assert.equal((await browser.get('/api/me')).status, 200, '29 Tage: gültig');

    clock.set(START + 30 * DAY - 1);
    browser.closeBrowser();
    assert.equal((await browser.get('/api/me')).status, 200, 'eine Millisekunde vor Ablauf: gültig');

    clock.set(START + 30 * DAY);
    const expired = await browser.get('/api/me');
    assert.equal(expired.status, 401, 'nach exakt 30 Tagen: Code erforderlich');
    assert.equal(server.state.devices.find((d) => d.id === device.id).expiresAt, START + 30 * DAY);
  }));

test('AH: tägliche Nutzung verlängert expiresAt NICHT (keine Sliding Expiration)', () =>
  withServer(async (server) => {
    const clock = server.clock;
    const browser = new Browser(server);
    await login(server, browser, ANNA);
    const { id, expiresAt } = activeDevices(server, ANNA)[0];
    for (let day = 1; day <= 29; day += 1) {
      clock.set(START + day * DAY);
      browser.closeBrowser();
      assert.equal((await browser.get('/api/me')).status, 200, `Tag ${day}`);
      await browser.get('/api/live');
    }
    const device = server.state.devices.find((d) => d.id === id);
    assert.equal(device.expiresAt, expiresAt);
    assert.equal(device.lastUsedAt, START + 29 * DAY, 'lastUsedAt wird aktualisiert');
    assert.equal(allDevices(server, ANNA).length, 1);
  }));

test('AI/AP: nach Ablauf → Code → neuer Token, neue 30 Tage; alter Token bleibt ungültig', () =>
  withServer(async (server) => {
    const clock = server.clock;
    const browser = new Browser(server);
    await login(server, browser, ANNA);
    const oldToken = browser.cookie(DEVICE);

    clock.set(START + 31 * DAY);
    // AP: Client schickt den abgelaufenen Token trotzdem → abgewiesen
    browser.setCookie(DEVICE, oldToken);
    const rejected = await browser.get('/api/me');
    assert.equal(rejected.status, 401);
    assert.ok(rejected.setCookies.some((c) => c.startsWith(`${DEVICE}=;`)), 'ungültiger Cookie wird gelöscht');

    await login(server, browser, ANNA);
    const newToken = browser.cookie(DEVICE);
    assert.notEqual(newToken, oldToken);
    const active = activeDevices(server, ANNA);
    assert.equal(active.length, 1);
    assert.equal(active[0].createdAt, START + 31 * DAY);
    assert.equal(active[0].expiresAt, START + 61 * DAY);

    const replay = new Browser(server);
    replay.setCookie(DEVICE, oldToken);
    assert.equal((await replay.get('/api/me')).status, 401, 'alter Token wird nie wiederverwendet');
  }));

test('AJ/AK/AM: neues Smartphone und anderer Browser brauchen Code; mehrere Geräte pro Benutzer', () =>
  withServer(async (server) => {
    const desktop = new Browser(server, { userAgent: UA.chromeWindows });
    await login(server, desktop, ANNA);

    const phone = new Browser(server, { userAgent: UA.safariIphone });
    assert.equal((await phone.get('/api/me')).status, 401, 'AJ: neues Smartphone');
    await login(server, phone, ANNA);

    const firefox = new Browser(server, { userAgent: UA.firefoxLinux });
    assert.equal((await firefox.get('/api/me')).status, 401, 'AK: anderer Browser ohne Cookie');

    const list = await desktop.get('/api/devices');
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.devices.map((d) => d.label).sort(), ['Chrome · Windows', 'Safari · iPhone']);
    const devices = allDevices(server, ANNA);
    assert.equal(devices.length, 2);
    assert.notEqual(devices[0].tokenHash, devices[1].tokenHash);

    // AM: Widerruf des Smartphones lässt den Desktop gültig
    const phoneId = list.json.devices.find((d) => d.label === 'Safari · iPhone').id;
    assert.equal((await desktop.post(`/api/devices/${phoneId}/revoke`)).status, 200);
    phone.closeBrowser();
    assert.equal((await phone.get('/api/me')).status, 401, 'AL: widerrufenes Gerät braucht Code');
    desktop.closeBrowser();
    assert.equal((await desktop.get('/api/me')).status, 200, 'AM: zweites Gerät bleibt gültig');
  }));

test('AL/AQ: widerrufenes Gerät → sofort ungültig, auch mit offener Session', () =>
  withServer(async (server) => {
    const browser = new Browser(server);
    await login(server, browser, ANNA);
    const token = browser.cookie(DEVICE);
    const deviceId = activeDevices(server, ANNA)[0].id;
    const res = await browser.post(`/api/devices/${deviceId}/revoke`);
    assert.equal(res.json.loggedOut, true);

    const replay = new Browser(server);
    replay.setCookie(DEVICE, token);
    assert.equal((await replay.get('/api/me')).status, 401, 'AQ: widerrufener Token');
    assert.equal((await browser.get('/api/me')).status, 401);
  }));

test('AN: alle Geräte abmelden → jedes Gerät braucht neuen Code', () =>
  withServer(async (server) => {
    const desktop = new Browser(server);
    await login(server, desktop, ANNA);
    const phone = new Browser(server, { userAgent: UA.safariIphone });
    await login(server, phone, ANNA);
    const tablet = new Browser(server, { userAgent: UA.firefoxLinux });
    await login(server, tablet, ANNA);

    const others = await desktop.post('/api/devices/revoke-others');
    assert.equal(others.json.revoked, 2);
    assert.equal((await phone.get('/api/me')).status, 401);
    assert.equal((await tablet.get('/api/me')).status, 401);
    assert.equal((await desktop.get('/api/me')).status, 200, 'aktuelles Gerät bleibt bei „alle anderen“');

    assert.equal((await desktop.post('/api/auth/logout')).status, 200);
    desktop.closeBrowser();
    assert.equal((await desktop.get('/api/me')).status, 401);
    assert.equal(activeDevices(server, ANNA).length, 0);
  }));

test('AO: manipulierter Token → kein Zugriff, Cookie wird gelöscht', () =>
  withServer(async (server) => {
    const browser = new Browser(server);
    await login(server, browser, ANNA);
    const token = browser.cookie(DEVICE);
    const tampered = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
    const attacker = new Browser(server);
    attacker.setCookie(DEVICE, tampered);
    const res = await attacker.get('/api/me');
    assert.equal(res.status, 401);
    assert.equal(attacker.cookie(DEVICE), undefined);

    attacker.setCookie(DEVICE, 'x'.repeat(5000));
    assert.equal((await attacker.get('/api/me')).status, 401);
  }));

test('AR: Token von Benutzer A funktioniert niemals als Benutzer B', () =>
  withServer(async (server) => {
    const anna = new Browser(server);
    await login(server, anna, ANNA);
    const ben = new Browser(server);
    await login(server, ben, BEN);
    const benOrder = await createOrder(ben, { name: 'Bens Modell', link: 'https://makerworld.com/de/models/3' });

    // Bens Session + Annas Geräte-Token: Session ist an Bens Gerät gebunden → wird abgewiesen.
    const mixed = new Browser(server);
    mixed.setCookie('__Host-dp_session', ben.cookie(SESSION));
    mixed.setCookie(DEVICE, anna.cookie(DEVICE));
    const me = await mixed.get('/api/me');
    assert.notEqual(me.json && me.json.user && me.json.user.email, BEN, 'darf nie Ben sein');
    assert.equal(me.json.user.email, ANNA, 'Annas Gerät bleibt Annas Gerät');
    assert.equal(me.json.restored, true, 'Bens Session wurde verworfen (Session ist an ihr Gerät gebunden)');

    // Annas Gerät überspringt nicht Bens Code
    const annaDevice = new Browser(server);
    annaDevice.setCookie(DEVICE, anna.cookie(DEVICE));
    const wrongCode = await annaDevice.post('/api/auth/verify-code', { email: BEN, code: '000000' });
    assert.equal(wrongCode.status, 400);
    const asAnna = await annaDevice.get('/api/me');
    assert.equal(asAnna.json.user.email, ANNA);

    // Mit Annas Token keine Rechte an Bens Auftrag
    assert.equal((await annaDevice.patch(`/api/orders/${benOrder.id}`, { isPublic: true })).status, 404);
    assert.equal(server.state.orders.find((o) => o.id === benOrder.id).isPublic, false);
  }));

test('AS: gesperrter Benutzer mit gültigem Gerät → kein Zugriff (auch bei Codeanmeldung)', () =>
  withServer(async (server) => {
    const anna = new Browser(server);
    await login(server, anna, ANNA);
    const admin = new Browser(server);
    await login(server, admin, ADMIN_EMAIL);
    await elevate(admin);
    const annaId = server.state.users.find((u) => u.email === ANNA).id;

    assert.equal((await admin.post(`/api/admin/users/${annaId}/block`)).status, 200);
    assert.equal((await anna.get('/api/me')).status, 401);
    anna.closeBrowser();
    assert.equal((await anna.get('/api/me')).status, 401);

    // Selbst ein erfolgreicher Code gewährt keinen Zugriff
    await anna.post('/api/auth/request-code', { email: ANNA });
    const code = /(\d{6})/.exec(latestMail(server, { to: ANNA, kind: 'login_code' }).text)[1];
    const verify = await anna.post('/api/auth/verify-code', { email: ANNA, code });
    assert.equal(verify.status, 403);
    assert.equal(verify.json.error, 'account_blocked');
    assert.equal(activeDevices(server, ANNA).length, 0);

    // Defense in depth: Status wird bei JEDEM Restore geprüft (auch ohne Widerruf)
    await admin.post(`/api/admin/users/${annaId}/unblock`);
    await login(server, anna, ANNA);
    server.app.store.transaction((draft) => {
      draft.users.find((u) => u.id === annaId).status = 'blocked';
    });
    anna.closeBrowser();
    assert.equal((await anna.get('/api/me')).status, 401);
  }));

test('AT: gelöschter Benutzer + altes Gerät → kein Zugriff', () =>
  withServer(async (server) => {
    const anna = new Browser(server);
    await login(server, anna, ANNA);
    const oldToken = anna.cookie(DEVICE);
    const admin = new Browser(server);
    await login(server, admin, ADMIN_EMAIL);
    await elevate(admin);
    const annaId = server.state.users.find((u) => u.email === ANNA).id;
    assert.equal((await admin.del(`/api/admin/users/${annaId}`)).status, 200);
    assert.equal(server.state.devices.filter((d) => d.userId === annaId).length, 0);

    const replay = new Browser(server);
    replay.setCookie(DEVICE, oldToken);
    assert.equal((await replay.get('/api/me')).status, 401);
  }));

test('AU: Admin-Gerät ersetzt nie das Admin-Passwort', () =>
  withServer(async (server) => {
    const admin = new Browser(server);
    await login(server, admin, ADMIN_EMAIL);
    const me = await admin.get('/api/me');
    assert.equal(me.json.user.role, 'admin');
    assert.equal(me.json.isAdmin, false, 'Code-Anmeldung allein ergibt keine Admin-Rechte');
    assert.equal((await admin.get('/api/admin/users')).status, 403);

    assert.equal((await admin.post('/api/admin/elevate', { password: 'falsch' })).status, 403);
    await elevate(admin);
    assert.equal((await admin.get('/api/admin/users')).status, 200);

    // Browser schließen: Gerät stellt Session wieder her – aber OHNE Admin-Rechte
    admin.closeBrowser();
    const restored = await admin.get('/api/me');
    assert.equal(restored.status, 200);
    assert.equal(restored.json.isAdmin, false);
    assert.equal((await admin.get('/api/admin/users')).status, 403);
    await elevate(admin);
    assert.equal((await admin.get('/api/admin/users')).status, 200);

    // Normale Benutzer können sich nicht hochstufen
    const anna = new Browser(server);
    await login(server, anna, ANNA);
    const attempt = await anna.post('/api/admin/elevate', { password: 'test-admin-passwort-2026' });
    assert.equal(attempt.status, 403);
    assert.equal((await anna.get('/api/admin/users')).status, 403);
  }));

test('AV: Geräte-/Session-Token erscheinen nicht in HTML, JSON, URLs, Mails oder Logs', () =>
  withServer(async (server) => {
    const anna = new Browser(server);
    await login(server, anna, ANNA);
    const admin = new Browser(server);
    await login(server, admin, ADMIN_EMAIL);
    await elevate(admin);
    const order = await createOrder(anna, { name: 'Token-Test', link: 'https://makerworld.com/de/models/4' });
    await admin.patch(`/api/orders/${order.id}`, { status: 'ready' });
    anna.closeBrowser();
    for (const p of ['/', '/api/me', '/api/live', '/api/devices', '/api/orders', `/auftrag/${order.dpRef}`]) await anna.get(p);

    const secrets = [anna.cookie(DEVICE), anna.cookie(SESSION), admin.cookie(DEVICE), admin.cookie(SESSION)];
    const bodies = [...anna.responses, ...admin.responses].map((r) => r.text).join('\n');
    const mails = JSON.stringify(server.outbox());
    const logs = server.logs.join('\n');
    for (const secret of secrets) {
      assert.ok(secret);
      assert.ok(!bodies.includes(secret), 'Token im HTML/JSON');
      assert.ok(!mails.includes(secret), 'Token in einer Mail');
      assert.ok(!logs.includes(secret), 'Token im Log');
    }
    for (const mail of server.outbox()) {
      for (const link of mailLinks(mail)) assert.equal(new URL(link).search, '', 'Mail-Links ohne Query-Parameter');
    }
    // Login-Codes landen ebenfalls nicht im Log
    const codes = server.outbox().filter((m) => m.kind === 'login_code').map((m) => /(\d{6})/.exec(m.text)[1]);
    for (const code of codes) assert.ok(!logs.includes(code), 'Code im Log');
  }));

test('E-Mail-Code: nur Hash gespeichert, 10 Minuten gültig, max. 5 Versuche, einmalig', () =>
  withServer(async (server) => {
    const clock = server.clock;
    const browser = new Browser(server);
    await browser.post('/api/auth/request-code', { email: ANNA });
    const code = /(\d{6})/.exec(latestMail(server, { to: ANNA, kind: 'login_code' }).text)[1];
    const file = fs.readFileSync(path.join(server.dataDir, 'druckplatte.json'), 'utf8');
    assert.ok(!file.includes(`"${code}"`), 'Code nicht im Klartext gespeichert');

    clock.advance(11 * 60 * 1000);
    assert.equal((await browser.post('/api/auth/verify-code', { email: ANNA, code })).status, 400, 'abgelaufen');

    await browser.post('/api/auth/request-code', { email: ANNA });
    const code2 = /(\d{6})/.exec(latestMail(server, { to: ANNA, kind: 'login_code' }).text)[1];
    const wrong = code2 === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await browser.post('/api/auth/verify-code', { email: ANNA, code: wrong })).status, 400);
    }
    assert.equal((await browser.post('/api/auth/verify-code', { email: ANNA, code: code2 })).status, 400, 'nach 5 Fehlversuchen gesperrt');

    await browser.post('/api/auth/request-code', { email: ANNA });
    const code3 = /(\d{6})/.exec(latestMail(server, { to: ANNA, kind: 'login_code' }).text)[1];
    assert.equal((await browser.post('/api/auth/verify-code', { email: ANNA, code: code3 })).status, 200);
    const again = new Browser(server);
    assert.equal((await again.post('/api/auth/verify-code', { email: ANNA, code: code3 })).status, 400, 'Code nur einmal gültig');
  }));

test('Anfrage-Code verrät nicht, ob eine Adresse existiert; Allowlist wird beachtet', () =>
  withServer(
    async (server) => {
      const browser = new Browser(server);
      const allowed = await browser.post('/api/auth/request-code', { email: ANNA });
      const unknown = await browser.post('/api/auth/request-code', { email: 'fremd@example.test' });
      assert.equal(allowed.status, 200);
      assert.equal(unknown.status, 200);
      assert.equal(allowed.text, unknown.text);
      assert.equal(server.outbox().filter((m) => m.to === 'fremd@example.test').length, 0);
    },
    { env: { LOGIN_ALLOWLIST: ANNA } },
  ));

test('Session ist nicht gleich Gerät: Session endet nach 12 h, Gerät bleibt 30 Tage', () =>
  withServer(async (server) => {
    const browser = new Browser(server);
    await login(server, browser, ANNA);
    const firstSession = browser.cookie(SESSION);
    server.clock.advance(12 * HOUR);
    const res = await browser.get('/api/me');
    assert.equal(res.status, 200);
    assert.equal(res.json.restored, true);
    assert.notEqual(browser.cookie(SESSION), firstSession, 'neue Session, gleicher Geräte-Token');
    assert.equal(allDevices(server, ANNA).length, 1);
  }));

test('CSRF-Schutz: fremde Origin wird bei ändernden Anfragen abgewiesen', () =>
  withServer(async (server) => {
    const browser = new Browser(server);
    await login(server, browser, ANNA);
    const res = await browser.post('/api/support', { message: 'x' }, { headers: { origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'bad_origin');
    assert.equal(server.state.support.length, 0);
  }));

test('Bereinigung: abgelaufene/widerrufene Geräte werden nach 30 Tagen Karenz gelöscht', () =>
  withServer(async (server) => {
    const clock = server.clock;
    const a = new Browser(server);
    await login(server, a, ANNA);
    const b = new Browser(server, { userAgent: UA.safariIphone });
    await login(server, b, ANNA);
    const bId = activeDevices(server, ANNA).find((d) => d.deviceLabel === 'Safari · iPhone').id;
    await a.post(`/api/devices/${bId}/revoke`);

    clock.advance(20 * DAY);
    server.app.runMaintenance();
    assert.equal(allDevices(server, ANNA).length, 2, 'noch innerhalb der Karenzzeit');

    clock.advance(11 * DAY); // widerrufen vor 31 Tagen, Gerät A seit 1 Tag abgelaufen
    const removed = server.app.runMaintenance();
    assert.equal(removed.devices, 1);
    assert.deepEqual(allDevices(server, ANNA).map((d) => d.deviceLabel), ['Chrome · Windows']);

    clock.advance(30 * DAY);
    server.app.runMaintenance();
    assert.equal(allDevices(server, ANNA).length, 0);
    assert.equal(server.state.sessions.length, 0);
  }));
