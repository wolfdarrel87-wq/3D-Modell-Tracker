'use strict';

// Pflichttests aus dem Review-Auftrag (Branch-Korrekturen): CF, LOCK, DELETE, PUBLIC, ORIGIN, IMAGE
// sowie die Cloudflare-Anmeldung ohne zweiten Code und zusätzlich gefundene Probleme.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const {
  ADMIN_EMAIL,
  TINY_PNG,
  START,
  DAY,
  UA,
  tempDir,
  startServer,
  Browser,
  login,
  elevate,
  createOrder,
  activeDevices,
  allDevices,
  accessFixture,
} = require('./helpers');
const { loadConfig } = require('../server/config');
const { Store } = require('../server/store');
const { PUBLIC_MODEL_FIELDS } = require('../server/domain/privacy');

const ROOT = path.join(__dirname, '..');
const DEVICE = '__Host-dp_device';
const ANNA = 'anna@example.test';
const BEN = 'ben@example.test';
const DORA = 'dora@example.test';
const PROD = { DRUCKPLATTE_ENV: 'production', PUBLIC_BASE_URL: 'https://druckplatte.test' };

async function withServer(fn, opts) {
  const server = await startServer(opts);
  try {
    await fn(server);
  } finally {
    await server.stop();
  }
}

// ====================================================================== CF (Konfiguration)

test('CF1: Produktion ohne CF_ACCESS_TEAM_DOMAIN → Start verweigert', () => {
  assert.throws(() => loadConfig({ ...PROD, CF_ACCESS_AUD: 'aud' }), /CF_ACCESS_TEAM_DOMAIN und CF_ACCESS_AUD/);
  assert.throws(() => loadConfig({ ...PROD }), /Produktion ohne Cloudflare Access verweigert/);
});

test('CF2: Produktion ohne CF_ACCESS_AUD → Start verweigert', () => {
  assert.throws(() => loadConfig({ ...PROD, CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com' }), /CF_ACCESS_TEAM_DOMAIN und CF_ACCESS_AUD/);
});

test('CF1/CF2 real: server/index.js startet in Produktion ohne Access nicht', () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, ...PROD, DATA_DIR: tempDir(), PORT: '0' },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Produktion ohne Cloudflare Access verweigert/);
});

test('CF3: Preview/Test ohne Cloudflare → erlaubt, Anmeldung per E-Mail-Code', () => {
  const cfg = loadConfig({ DRUCKPLATTE_ENV: 'test' });
  assert.equal(cfg.cfAccess, null);
  assert.equal(cfg.authMode, 'email-code');
});

test('CF4: Override nur ausdrücklich; mit Access automatisch ohne zweiten Code', () => {
  const override = loadConfig({ ...PROD, ALLOW_WITHOUT_CF_ACCESS: 'true' });
  assert.equal(override.cfAccess, null);
  assert.throws(() => loadConfig({ ...PROD, ALLOW_WITHOUT_CF_ACCESS: 'false' }), /verweigert/);
  const withAccess = loadConfig({ ...PROD, CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud' });
  assert.equal(withAccess.authMode, 'cloudflare-access');
  assert.throws(
    () => loadConfig({ DRUCKPLATTE_ENV: 'test', CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud', AUTH_MODE: 'email-code' }),
    /zwei E-Mail-Codes/,
  );
  assert.throws(() => loadConfig({ DRUCKPLATTE_ENV: 'test', AUTH_MODE: 'cloudflare-access' }), /braucht CF_ACCESS/);
});

test('ORIGIN: in Produktion nur https-Origins; Origins nie mit Platzhaltern', () => {
  const access = { CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUD: 'aud' };
  assert.throws(() => loadConfig({ ...PROD, ...access, ALLOWED_ORIGINS: 'http://druckplatte.test' }), /ALLOWED_ORIGINS muss in Produktion https/);
  assert.throws(() => loadConfig({ ...PROD, ...access, ALLOWED_ORIGINS: '*' }), /ALLOWED_ORIGINS enthält keine gültige URL/);
  const cfg = loadConfig({ ...PROD, ...access, ALLOWED_ORIGINS: 'https://www.druckplatte.test/pfad' });
  assert.deepEqual(cfg.allowedOrigins, ['https://druckplatte.test', 'https://www.druckplatte.test']);
});

// ====================================================================== Cloudflare-Anmeldung ohne zweiten Code

function accessServer(fixture, extraEnv = {}) {
  return startServer({ env: { CF_ACCESS_TEAM_DOMAIN: fixture.teamDomain, CF_ACCESS_AUD: fixture.aud, ...extraEnv }, fetchImpl: fixture.fetchImpl });
}

test('Cloudflare-Modus: neues Gerät → Access bestätigt → Gerät registriert, KEIN Druckplatte-Code', async () => {
  const access = accessFixture();
  const server = await accessServer(access);
  try {
    const jwt = (email, opts) => ({ headers: { 'cf-access-jwt-assertion': access.token(email, opts) } });
    const iat = () => Math.floor(server.clock.now() / 1000);
    const browser = new Browser(server);

    // Kein zweiter Code: die Code-Endpunkte gibt es in diesem Modus nicht
    assert.equal((await browser.post('/api/auth/request-code', { email: ANNA }, jwt(ANNA))).status, 404);
    assert.equal((await browser.post('/api/auth/verify-code', { email: ANNA, code: '123456' }, jwt(ANNA))).status, 404);

    const first = await browser.post('/api/auth/access-session', {}, jwt(ANNA, { iat: iat() }));
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.registered, true);
    assert.ok(browser.cookie(DEVICE));
    assert.equal(server.outbox().length, 0, 'keine einzige Mail von Druckplatte');
    assert.equal(activeDevices(server, ANNA).length, 1);

    // Mail-Link / Browser-Neustart innerhalb der 30 Tage: vorhandenes Gerät, kein neues
    server.clock.advance(5 * DAY);
    browser.closeBrowser();
    const oldJwt = jwt(ANNA, { iat: Math.floor(START / 1000), exp: iat() + 3600 });
    assert.equal((await browser.get('/api/me', oldJwt)).status, 200, 'Gerät erkannt');
    const again = await browser.post('/api/auth/access-session', {}, oldJwt);
    assert.equal(again.status, 200);
    assert.equal(again.json.restored, true);
    assert.equal(allDevices(server, ANNA).length, 1, 'kein neues Gerät');
  } finally {
    await server.stop();
  }
});

test('Cloudflare-Modus: neues Gerät nur mit FRISCHER Access-Anmeldung; nach 30 Tagen neu anmelden', async () => {
  const access = accessFixture();
  const server = await accessServer(access);
  try {
    const nowS = () => Math.floor(server.clock.now() / 1000);
    const jwt = (email, opts) => ({ headers: { 'cf-access-jwt-assertion': access.token(email, opts) } });
    const browser = new Browser(server);

    const stale = await browser.post('/api/auth/access-session', {}, jwt(ANNA, { iat: nowS() - 3600, exp: nowS() + 3600 }));
    assert.equal(stale.status, 401);
    assert.equal(stale.json.error, 'access_reauth_required');
    assert.equal(stale.json.logoutUrl, '/cdn-cgi/access/logout');
    assert.equal(allDevices(server, ANNA).length, 0, 'kein Gerät ohne frische Anmeldung');

    assert.equal((await browser.post('/api/auth/access-session', {}, jwt(ANNA, { iat: nowS() }))).status, 200);
    const oldToken = browser.cookie(DEVICE);

    // Nach 30 Tagen: altes Access-Token reicht nicht, erst eine neue Access-Anmeldung
    server.clock.set(START + 30 * DAY);
    const expiredJwt = jwt(ANNA, { iat: nowS() - 7200, exp: nowS() + 3600 });
    assert.equal((await browser.get('/api/me', expiredJwt)).status, 401);
    const reauth = await browser.post('/api/auth/access-session', {}, expiredJwt);
    assert.equal(reauth.json.error, 'access_reauth_required');
    const renewed = await browser.post('/api/auth/access-session', {}, jwt(ANNA, { iat: nowS() }));
    assert.equal(renewed.status, 200);
    assert.notEqual(browser.cookie(DEVICE), oldToken, 'neuer Token');
    const active = activeDevices(server, ANNA);
    assert.equal(active.length, 1);
    assert.equal(active[0].expiresAt, START + 60 * DAY, 'neue 30 Tage');
  } finally {
    await server.stop();
  }
});

test('Cloudflare-Modus: Sperre, fremde Identität und Admin-Grenze bleiben wirksam', async () => {
  const access = accessFixture();
  const server = await accessServer(access);
  try {
    const nowS = () => Math.floor(server.clock.now() / 1000);
    const jwt = (email) => ({ headers: { 'cf-access-jwt-assertion': access.token(email, { iat: nowS() }) } });

    const admin = new Browser(server);
    assert.equal((await admin.post('/api/auth/access-session', {}, jwt(ADMIN_EMAIL))).status, 200);
    assert.equal((await admin.get('/api/me', jwt(ADMIN_EMAIL))).json.isAdmin, false, 'Access allein ergibt keine Admin-Rechte');
    assert.equal((await admin.get('/api/admin/users', jwt(ADMIN_EMAIL))).status, 403);
    assert.equal((await admin.post('/api/admin/elevate', { password: 'test-admin-passwort-2026' }, jwt(ADMIN_EMAIL))).status, 200);

    const anna = new Browser(server);
    assert.equal((await anna.post('/api/auth/access-session', {}, jwt(ANNA))).status, 200);
    const annaId = server.state.users.find((u) => u.email === ANNA).id;
    assert.equal((await admin.post(`/api/admin/users/${annaId}/block`, {}, jwt(ADMIN_EMAIL))).status, 200);
    assert.equal((await anna.get('/api/me', jwt(ANNA))).status, 401);
    const blocked = await anna.post('/api/auth/access-session', {}, jwt(ANNA));
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error, 'account_blocked');

    // Ben meldet sich im Browser an, der Annas Gerät trägt → Annas Gerät wird ersetzt, nie „geteilt“
    const shared = new Browser(server);
    await admin.post(`/api/admin/users/${annaId}/unblock`, {}, jwt(ADMIN_EMAIL));
    assert.equal((await shared.post('/api/auth/access-session', {}, jwt(ANNA))).status, 200);
    const annaToken = shared.cookie(DEVICE);
    assert.equal((await shared.get('/api/me', jwt(BEN))).status, 401, 'Annas Gerät gilt nicht für Ben');
    assert.equal((await shared.post('/api/auth/access-session', {}, jwt(BEN))).status, 200);
    assert.equal((await shared.get('/api/me', jwt(BEN))).json.user.email, BEN);
    const replay = new Browser(server);
    replay.setCookie(DEVICE, annaToken);
    assert.equal((await replay.get('/api/me', jwt(ANNA))).status, 401, 'Annas alter Token ist widerrufen');
  } finally {
    await server.stop();
  }
});

test('Cloudflare-Modus: nach Abmelden/Sicherheitsreset registriert erst eine NEUE Access-Anmeldung ein Gerät', async () => {
  const access = accessFixture();
  const server = await accessServer(access);
  try {
    const nowS = () => Math.floor(server.clock.now() / 1000);
    const header = (token) => ({ headers: { 'cf-access-jwt-assertion': token } });
    const browser = new Browser(server);

    // Access-Anmeldung um 12:00, Gerät registriert, Abmelden 2 Minuten später
    const loginJwt = access.token(ANNA, { iat: nowS() });
    assert.equal((await browser.post('/api/auth/access-session', {}, header(loginJwt))).status, 200);
    server.clock.advance(2 * 60 * 1000);
    assert.equal((await browser.post('/api/auth/logout', {}, header(loginJwt))).status, 200);
    assert.equal(activeDevices(server, ANNA).length, 0);

    // Dasselbe (noch „frische“) Access-Token darf das Abmelden nicht still rückgängig machen
    const replay = await browser.post('/api/auth/access-session', {}, header(loginJwt));
    assert.equal(replay.status, 401);
    assert.equal(replay.json.error, 'access_reauth_required');
    assert.equal(activeDevices(server, ANNA).length, 0, 'kein neues Gerät nach Abmelden');

    // Auch ein Token aus derselben Sekunde wie das Abmelden gilt im Zweifel als „vorher“
    const sameSecond = await browser.post('/api/auth/access-session', {}, header(access.token(ANNA, { iat: nowS() })));
    assert.equal(sameSecond.json.error, 'access_reauth_required');

    // Neue Access-Anmeldung danach → wieder genau ein Gerät
    server.clock.advance(60 * 1000);
    const relogin = await browser.post('/api/auth/access-session', {}, header(access.token(ANNA, { iat: nowS() })));
    assert.equal(relogin.status, 200, relogin.text);
    assert.equal(activeDevices(server, ANNA).length, 1);

    // Sicherheitsreset durch den Admin wirkt genauso
    const admin = new Browser(server);
    const adminJwt = () => header(access.token(ADMIN_EMAIL, { iat: nowS() }));
    await admin.post('/api/auth/access-session', {}, adminJwt());
    await admin.post('/api/admin/elevate', { password: 'test-admin-passwort-2026' }, adminJwt());
    const annaId = server.state.users.find((u) => u.email === ANNA).id;
    const annaJwtBeforeReset = access.token(ANNA, { iat: nowS() });
    server.clock.advance(1000);
    assert.equal((await admin.post(`/api/admin/users/${annaId}/reset-devices`, {}, adminJwt())).status, 200);
    const other = new Browser(server);
    assert.equal((await other.post('/api/auth/access-session', {}, header(annaJwtBeforeReset))).json.error, 'access_reauth_required');
    server.clock.advance(1000);
    assert.equal((await other.post('/api/auth/access-session', {}, header(access.token(ANNA, { iat: nowS() })))).status, 200);

    // Skript ohne Cookies kann nicht beliebig viele Geräte anlegen (3 Registrierungen bisher, Grenze 10 / 15 Min.)
    const statuses = [];
    for (let i = 0; i < 8; i += 1) {
      statuses.push((await new Browser(server).post('/api/auth/access-session', {}, header(access.token(ANNA, { iat: nowS() })))).status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 429]);
  } finally {
    await server.stop();
  }
});

// ====================================================================== LOCK

const DEAD_PID = 999999999;

test('LOCK1: normaler Lock – genau ein Besitzer, nur eigener Lock wird freigegeben', () => {
  const dataDir = tempDir();
  const a = new Store({ dataDir }).open();
  assert.throws(() => new Store({ dataDir }).open(), /store\.lock/);
  const content = fs.readFileSync(path.join(dataDir, 'store.lock'), 'utf8');
  assert.match(content, new RegExp(`^${process.pid}:[0-9a-f]{16}$`));
  a.close();
  assert.equal(fs.existsSync(path.join(dataDir, 'store.lock')), false);
});

test('LOCK2: lebender Lock eines anderen Prozesses → zweiter Prozess abgewiesen', () => {
  const dataDir = tempDir();
  fs.writeFileSync(path.join(dataDir, 'store.lock'), `${process.ppid}:abc`);
  assert.throws(() => new Store({ dataDir }).open(), new RegExp(`Prozess ${process.ppid}`));
  assert.equal(fs.readFileSync(path.join(dataDir, 'store.lock'), 'utf8'), `${process.ppid}:abc`, 'fremder Lock unangetastet');
});

test('LOCK3: verwaister Lock → saubere Übernahme, Wiederherstellungs-Lock wird aufgeräumt', () => {
  const dataDir = tempDir();
  fs.writeFileSync(path.join(dataDir, 'store.lock'), String(DEAD_PID));
  const store = new Store({ dataDir }).open();
  assert.match(fs.readFileSync(path.join(dataDir, 'store.lock'), 'utf8'), new RegExp(`^${process.pid}:`));
  assert.equal(fs.existsSync(path.join(dataDir, 'store.lock.recover')), false);
  store.close();
});

test('LOCK4a: zwei Übernahmen desselben verwaisten Locks, exakt verschachtelt → genau EIN Besitzer', () => {
  const dataDir = tempDir();
  fs.writeFileSync(path.join(dataDir, 'store.lock'), String(DEAD_PID));
  const alive = (pid) => pid !== DEAD_PID;
  const b = new Store({ dataDir, lockOwnerId: 900002, isOwnerAlive: alive });
  let bOpened = false;
  // A erkennt den verwaisten Lock; genau in diesem Moment übernimmt B vollständig.
  const a = new Store({
    dataDir,
    lockOwnerId: 900001,
    isOwnerAlive: alive,
    onStaleLock: () => {
      b.open();
      bOpened = true;
    },
  });
  assert.throws(() => a.open(), /inzwischen von einem anderen Prozess gesperrt/);
  assert.equal(bOpened, true);
  assert.equal(fs.readFileSync(path.join(dataDir, 'store.lock'), 'utf8'), b._lockToken, 'B ist alleiniger Besitzer');
  a.close();
  assert.equal(fs.readFileSync(path.join(dataDir, 'store.lock'), 'utf8'), b._lockToken, 'A löscht keinen fremden Lock');
  b.close();
});

test('LOCK4a: laufende Wiederherstellung eines anderen Prozesses → sauberer Abbruch', () => {
  const dataDir = tempDir();
  fs.writeFileSync(path.join(dataDir, 'store.lock'), String(DEAD_PID));
  fs.writeFileSync(path.join(dataDir, 'store.lock.recover'), '900003:xyz');
  assert.throws(() => new Store({ dataDir }).open(), /übernimmt gerade den verwaisten Lock/);
  assert.equal(fs.readFileSync(path.join(dataDir, 'store.lock'), 'utf8'), String(DEAD_PID));
});

const CONTENDER = `
const { Store } = require(${JSON.stringify(path.join(ROOT, 'server', 'store.js'))});
const [dataDir, startAt] = process.argv.slice(1);
while (Date.now() < Number(startAt)) { /* synchroner Start aller Prozesse */ }
try {
  const store = new Store({ dataDir }).open();
  process.stdout.write('OK ' + process.pid + '\\n');
  setTimeout(() => { store.close(); process.exit(0); }, 1500);
} catch (err) {
  process.stdout.write('FAIL ' + err.message + '\\n');
  process.exit(0);
}`;

function runContender(dataDir, startAt) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', CONTENDER, dataDir, String(startAt)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('exit', () => resolve({ out: out.trim(), err: err.trim() }));
  });
}

test('LOCK4b: mehrere echte Prozesse gleichzeitig auf verwaistem Lock → pro Runde genau EIN Besitzer', { timeout: 120000 }, async () => {
  for (let round = 0; round < 5; round += 1) {
    const dataDir = tempDir();
    fs.writeFileSync(path.join(dataDir, 'store.lock'), String(DEAD_PID));
    const startAt = Date.now() + 2500;
    const results = await Promise.all(Array.from({ length: 6 }, () => runContender(dataDir, startAt)));
    const winners = results.filter((r) => r.out.startsWith('OK'));
    assert.equal(winners.length, 1, `Runde ${round}: ${JSON.stringify(results)}`);
    for (const r of results.filter((x) => !x.out.startsWith('OK'))) assert.match(r.out, /^FAIL /, JSON.stringify(r));
    assert.equal(fs.existsSync(path.join(dataDir, 'store.lock.recover')), false);
  }
});

// ====================================================================== DELETE

test('DELETE1–5: gelöschtes Konto – Aufträge bleiben für Admin, werden privat, Geräte ungültig', () =>
  withServer(async (server) => {
    const anna = new Browser(server);
    await login(server, anna, ANNA);
    const dora = new Browser(server);
    await login(server, dora, DORA);
    const admin = new Browser(server);
    await login(server, admin, ADMIN_EMAIL);
    await elevate(admin);

    const priv = await createOrder(anna, { name: 'ANNA-PRIVAT', link: 'https://makerworld.com/de/models/7001' });
    const pub = await createOrder(anna, { name: 'ANNA-OEFFENTLICH', link: 'https://makerworld.com/de/models/7002', image: TINY_PNG, isPublic: true });
    const queued = await createOrder(anna, { name: 'ANNA-OEFFENTLICH-WARTEND', link: 'https://makerworld.com/de/models/7003', isPublic: true });
    await admin.post('/api/admin/queue', { orderId: queued.id });
    await admin.post('/api/admin/printer/current', { orderId: pub.id });
    assert.ok((await dora.get('/api/live')).text.includes('ANNA-OEFFENTLICH'), 'vorher öffentlich sichtbar');
    const annaToken = anna.cookie(DEVICE);
    const annaId = server.state.users.find((u) => u.email === ANNA).id;

    assert.equal((await admin.del(`/api/admin/users/${annaId}`)).status, 200);

    // DELETE1/2: für Admin erhalten (inkl. DP), aber privat und ohne Besitzer
    const adminOrders = (await admin.get('/api/orders')).json.orders;
    for (const o of [priv, pub, queued]) {
      const view = adminOrders.find((x) => x.id === o.id);
      assert.ok(view, `${o.name} bleibt erhalten`);
      assert.equal(view.dpRef, o.dpRef);
      assert.equal(view.ownerId, null);
      assert.equal(view.isPublic, false);
      assert.equal(server.state.orders.find((x) => x.id === o.id).isPublic, false);
    }

    // DELETE3: für andere nicht mehr öffentlich – weder Liste noch Warteschlange noch aktueller Druck
    const live = await dora.get('/api/live');
    assert.ok(!live.text.includes('ANNA-'), live.text);
    assert.equal(live.json.publicModels.length, 0);
    assert.deepEqual(live.json.queue.entries, [{ kind: 'private_queue_slot', position: 1 }]);
    assert.equal(live.json.currentPrint.kind, 'foreign_private');
    const imageKey = server.state.orders.find((x) => x.id === pub.id).image.key;
    assert.equal((await dora.get(`/api/images/${imageKey}`)).status, 404);

    // DELETE4/5: Geräte entfernt, alter Cookie wertlos
    assert.equal(server.state.devices.filter((d) => d.userId === annaId).length, 0);
    const replay = new Browser(server);
    replay.setCookie(DEVICE, annaToken);
    assert.equal((await replay.get('/api/me')).status, 401);
  }));

// ====================================================================== PUBLIC

test('PUBLIC1–3: eigene öffentliche Modelle stehen in „Öffentliche Modelle“ – nur als Allowlist', () =>
  withServer(async (server) => {
    const anna = new Browser(server);
    await login(server, anna, ANNA);
    const ben = new Browser(server);
    await login(server, ben, BEN);
    const admin = new Browser(server);
    await login(server, admin, ADMIN_EMAIL);
    await elevate(admin);
    const a = await createOrder(anna, { name: 'MODELL-A-OEFFENTLICH', link: 'https://makerworld.com/de/models/8001', image: TINY_PNG, isPublic: true, note: 'NOTIZ-A' });
    const b = await createOrder(anna, { name: 'MODELL-B-PRIVAT', link: 'https://makerworld.com/de/models/8002', note: 'NOTIZ-B' });

    // PUBLIC1: Besitzerin sieht A in den öffentlichen Modellen, B nicht
    const own = (await anna.get('/api/orders')).json;
    assert.deepEqual(own.publicModels.map((m) => m.name), ['MODELL-A-OEFFENTLICH']);
    assert.deepEqual(Object.keys(own.publicModels[0]).sort(), [...PUBLIC_MODEL_FIELDS].sort());
    assert.ok(!JSON.stringify(own.publicModels).includes(a.dpRef), 'auch die eigene Public-Ansicht ohne DP-Nummer');
    assert.equal(own.orders.find((o) => o.id === a.id).dpRef, a.dpRef, 'private Eigentümer-Ansicht separat mit DP');

    // PUBLIC2: Ben sieht A, nicht B
    const foreign = await ben.get('/api/orders');
    assert.deepEqual(foreign.json.publicModels.map((m) => m.name), ['MODELL-A-OEFFENTLICH']);

    // PUBLIC3: private Daten nur für Eigentümerin/Admin
    for (const secret of ['MODELL-B-PRIVAT', 'NOTIZ-B', 'NOTIZ-A', b.dpRef, a.dpRef, b.id, a.id, ANNA]) {
      assert.ok(!foreign.text.includes(secret), `Ben sieht „${secret}“`);
    }
    const adminView = (await admin.get('/api/orders')).json;
    assert.ok(adminView.orders.some((o) => o.id === a.id) && adminView.orders.some((o) => o.id === b.id), 'Admin: alles');
    assert.deepEqual(adminView.publicModels.map((m) => m.name), ['MODELL-A-OEFFENTLICH']);
  }));

// ====================================================================== ORIGIN

function rawRequest(server, { method, path: p, headers }) {
  const { port } = new URL(server.baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null }));
    });
    req.on('error', reject);
    req.end('{"message":"x"}');
  });
}

test('ORIGIN1–5: Origin-Pflicht bei Mutationen, nur konfigurierte Origins, Host-Header zählt nicht', () =>
  withServer(
    async (server) => {
      const anna = new Browser(server);
      await login(server, anna, ANNA);
      const order = await createOrder(anna, { name: 'Origin-Test', link: 'https://makerworld.com/de/models/9101' });

      // ORIGIN1: richtige Origin (PUBLIC_BASE_URL) und zusätzlich konfigurierte Origin
      assert.equal((await anna.post('/api/support', { message: 'ok' }, { headers: { origin: 'https://druckplatte.test' } })).status, 200);
      assert.equal((await anna.post('/api/support', { message: 'ok' }, { headers: { origin: 'https://www.druckplatte.test' } })).status, 200);

      // ORIGIN2: fremde Origin
      const evil = await anna.post('/api/support', { message: 'x' }, { headers: { origin: 'https://evil.example' } });
      assert.equal(evil.status, 403);
      assert.equal(evil.json.error, 'bad_origin');
      assert.equal((await anna.post('/api/support', { message: 'x' }, { headers: { origin: 'null' } })).status, 403);

      // ORIGIN3: Origin fehlt – POST, PATCH, DELETE
      for (const [method, p] of [['POST', '/api/support'], ['PATCH', `/api/orders/${order.id}`], ['DELETE', `/api/orders/${order.id}`], ['POST', '/api/auth/request-code']]) {
        const res = await anna.request(method, p, method === 'DELETE' ? undefined : { isPublic: true, message: 'x', email: ANNA }, { headers: { origin: null } });
        assert.equal(res.status, 403, `${method} ${p}`);
        assert.equal(res.json.error, 'origin_required');
      }
      assert.equal(server.state.orders.find((o) => o.id === order.id).isPublic, false);

      // ORIGIN4: manipulierter Host-Header erzeugt keine neue erlaubte Origin
      const spoofed = await rawRequest(server, {
        method: 'POST',
        path: '/api/support',
        headers: { host: 'evil.test', origin: 'http://evil.test', cookie: anna.cookieHeader(), 'content-type': 'application/json', 'content-length': 15 },
      });
      assert.equal(spoofed.status, 403);
      assert.equal(spoofed.json.error, 'bad_origin');

      // ORIGIN5: GET ohne Origin weiterhin möglich
      assert.equal((await anna.get('/api/live', { headers: { origin: null } })).status, 200);
      assert.equal(server.state.support.length, 2);
    },
    { env: { ALLOWED_ORIGINS: 'https://www.druckplatte.test' } },
  ));

// ====================================================================== IMAGE

const REJECTED_IMAGE_URLS = {
  IMAGE2: 'https://attacker.example/image.png',
  IMAGE3: 'https://127.0.0.1/image.png',
  IMAGE4: 'https://192.168.1.1/image.png',
  IMAGE5: 'https://10.0.0.1/image.png',
  IMAGE6: 'https://172.16.0.1/image.png',
  IMAGE7a: 'https://[::1]/image.png',
  IMAGE7b: 'https://[fd00::1]/image.png',
  IMAGE7c: 'https://[fe80::1]/image.png',
  metadata: 'https://169.254.169.254/latest/meta-data',
  localhost: 'https://localhost/image.png',
  intern: 'https://nas/image.png',
  dezimal: 'https://2130706433/image.png',
};

test('IMAGE1–7: nur eigene Uploads; externe, lokale und private Ziele werden abgelehnt', () =>
  withServer(async (server) => {
    const anna = new Browser(server);
    await login(server, anna, ANNA);
    const upload = await createOrder(anna, { type: 'idea', name: 'Upload', link: '', image: TINY_PNG });
    assert.match(upload.imageUrl, /^\/api\/images\/[A-Za-z0-9_-]+$/, 'IMAGE1: lokaler Upload');
    assert.equal((await anna.get(upload.imageUrl)).status, 200);
    for (const [label, url] of Object.entries(REJECTED_IMAGE_URLS)) {
      const res = await anna.post('/api/orders', { type: 'idea', name: label, link: '', color: 'Weiß', filament: 'PLA', image: url });
      assert.equal(res.status, 400, `${label}: ${url}`);
      assert.equal(res.json.error, 'invalid_image');
    }
    assert.equal(server.state.orders.length, 1);
    const me = (await anna.get('/api/me')).json;
    assert.deepEqual(me.imageUrlHosts, [], 'Oberfläche bietet kein URL-Feld an');
  }));

test('IMAGE: Allowlist – nur https auf exakt freigegebenen Hosts, private Ziele bleiben gesperrt', () =>
  withServer(
    async (server) => {
      const anna = new Browser(server);
      await login(server, anna, ANNA);
      const ok = await createOrder(anna, { type: 'idea', name: 'Erlaubt', link: '', image: 'https://cdn.example.test/bild.png' });
      assert.equal(ok.imageUrl, 'https://cdn.example.test/bild.png');
      for (const url of ['http://cdn.example.test/bild.png', 'https://cdn.example.test.evil.example/b.png', 'https://sub.cdn.example.test/b.png', 'https://cdn.example.test:8443/b.png', ...Object.values(REJECTED_IMAGE_URLS)]) {
        const res = await anna.post('/api/orders', { type: 'idea', name: 'x', link: '', color: 'Weiß', filament: 'PLA', image: url });
        assert.equal(res.status, 400, url);
      }
      assert.throws(() => loadConfig({ IMAGE_HOST_ALLOWLIST: '192.168.1.10' }), /IMAGE_HOST_ALLOWLIST/);
      assert.throws(() => loadConfig({ IMAGE_HOST_ALLOWLIST: 'localhost' }), /IMAGE_HOST_ALLOWLIST/);
      for (const internal of ['nas.local', 'drucker.lan', 'build.internal', 'router.home.arpa', 'x.localhost']) {
        assert.throws(() => loadConfig({ IMAGE_HOST_ALLOWLIST: internal }), /IMAGE_HOST_ALLOWLIST/, internal);
      }
      const csp = (await anna.get('/')).headers.get('content-security-policy');
      assert.match(csp, /img-src 'self' data: https:\/\/cdn\.example\.test(;|$)/);
    },
    { env: { IMAGE_HOST_ALLOWLIST: 'cdn.example.test' } },
  ));

test('IMAGE: Altdaten mit beliebiger externer Bild-URL erreichen keinen Browser mehr', () =>
  withServer(async (server) => {
    const anna = new Browser(server);
    await login(server, anna, ANNA);
    const dora = new Browser(server);
    await login(server, dora, DORA);
    const admin = new Browser(server);
    await login(server, admin, ADMIN_EMAIL);
    await elevate(admin);
    const order = await createOrder(anna, { name: 'Legacy-Bild', link: 'https://makerworld.com/de/models/9201', isPublic: true });
    server.app.store.transaction((draft) => {
      draft.orders.find((o) => o.id === order.id).image = { kind: 'url', url: 'https://tracker.attacker.example/pixel.png' };
    });
    for (const browser of [anna, dora, admin]) {
      const res = await browser.get('/api/live');
      assert.ok(!res.text.includes('attacker.example'), 'Tracking-URL wird nicht ausgeliefert');
    }
  }));

test('CSP: keine externen Skripte, Schriften oder Bildhosts; Schriften kommen lokal', () =>
  withServer(async (server) => {
    const browser = new Browser(server);
    const page = await browser.get('/');
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /img-src 'self' data:(;|$)/);
    assert.match(csp, /font-src 'self'/);
    assert.ok(!/https:(?!\/\/)|googleapis|gstatic/.test(csp), csp);
    assert.ok(!/fonts\.googleapis|fonts\.gstatic/.test(page.text), 'keine Google-Fonts-Links im HTML');
    const font = await browser.get('/fonts/inter-latin.woff2');
    assert.equal(font.status, 200);
    assert.equal(font.headers.get('content-type'), 'font/woff2');
    for (const p of ['/fonts/LICENSE-inter-OFL.txt', '/fonts/../package.json', '/fonts/unbekannt.woff2']) assert.equal((await browser.get(p)).status, 404, p);
  }));

// ====================================================================== Zusätzlich gefundene Probleme

test('Zusatz: kaputte URL-Kodierung ergibt 400 statt 500', () =>
  withServer(async (server) => {
    const anna = new Browser(server);
    await login(server, anna, ANNA);
    const res = await anna.get('/api/images/%E0%A4%A');
    assert.equal(res.status, 400);
    assert.ok(!server.logs.some((l) => l.includes('Unerwarteter Fehler')));
  }));

test('Zusatz: öffentliche Ansicht zeigt nur MakerWorld-Links, keine beliebigen Websites', () =>
  withServer(async (server) => {
    const anna = new Browser(server);
    await login(server, anna, ANNA);
    const ben = new Browser(server);
    await login(server, ben, BEN);
    const admin = new Browser(server);
    await login(server, admin, ADMIN_EMAIL);
    await elevate(admin);
    const idea = await createOrder(anna, { type: 'idea', name: 'Idee mit Link', link: 'https://irgendwo.example/seite', isPublic: true });
    await admin.post(`/api/orders/${idea.id}/accept`);
    const pub = (await ben.get('/api/orders')).json.publicModels.find((m) => m.name === 'Idee mit Link');
    assert.equal(pub.link, null);
    assert.equal((await anna.get('/api/orders')).json.orders.find((o) => o.id === idea.id).link, 'https://irgendwo.example/seite', 'Eigentümerin sieht ihren Link');
  }));

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list || []) if (addr.family === 'IPv4' && !addr.internal) return addr.address;
  }
  return null;
}

test('Zusatz: Dev-Postausgang (Anmeldecodes) nur von localhost erreichbar', async (t) => {
  const lan = lanAddress();
  if (!lan) {
    t.skip('keine Nicht-Loopback-Adresse im Container vorhanden');
    return;
  }
  const { createApp } = require('../server/app');
  const { createLogger } = require('../server/util/log');
  const config = loadConfig({ DRUCKPLATTE_ENV: 'preview', DATA_DIR: tempDir(), PUBLIC_BASE_URL: 'http://localhost:1' });
  const app = createApp({ config, logger: createLogger({ log() {}, error() {} }) });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '0.0.0.0', r));
  const { port } = server.address();
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/dev/outbox`)).status, 200, 'lokal erlaubt');
    assert.equal((await fetch(`http://${lan}:${port}/dev/outbox`)).status, 404, 'aus dem Netz gesperrt');
    // Über einen Tunnel/Proxy auf demselben Rechner weitergereicht → ebenfalls gesperrt
    for (const header of ['x-forwarded-for', 'cf-connecting-ip', 'forwarded', 'x-real-ip']) {
      const res = await fetch(`http://127.0.0.1:${port}/dev/outbox`, { headers: { [header]: '203.0.113.9' } });
      assert.equal(res.status, 404, header);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    app.close();
  }
});

test('Zusatz: Test-Browser-Label unverändert erkannt (Regression Gerätebezeichnung)', () =>
  withServer(async (server) => {
    const phone = new Browser(server, { userAgent: UA.safariIphone });
    await login(server, phone, ANNA);
    assert.equal(activeDevices(server, ANNA)[0].deviceLabel, 'Safari · iPhone');
  }));
