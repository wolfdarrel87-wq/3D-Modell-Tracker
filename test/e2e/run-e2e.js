'use strict';

/**
 * Browser-Ende-zu-Ende-Tests mit Playwright/Chromium gegen eine isolierte Preview-Instanz.
 *   npm run test:e2e
 * Screenshots: test-results/screenshots (oder E2E_SCREENSHOT_DIR).
 * Es werden keine echten E-Mails versendet und keine Drucker angesprochen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const { loadConfig } = require('../../server/config');
const { createApp } = require('../../server/app');
const { createLogger } = require('../../server/util/log');
const { hashPassword } = require('../../server/util/crypto');
const { Store } = require('../../server/store');
const { applyIdeaMigration } = require('../../server/domain/dpRefs');
const { seedPreview } = require('../../scripts/seed-preview');
const { Browser: ApiClient, login: apiLogin, elevate, accessFixture, ADMIN_EMAIL, ADMIN_PASSWORD } = require('../helpers');

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(path.join(globalRoot, 'playwright'));
  }
}
const { chromium, devices } = loadPlaywright();

const WIDTHS = [360, 390, 430, 768, 1280, 1920];
const SHOT_DIR = process.env.E2E_SCREENSHOT_DIR || path.join(__dirname, '..', '..', 'test-results', 'screenshots');
const ANNA = 'anna@example.test';
const DORA = 'dora@example.test';
const CLARA = 'clara@example.test';
const PRIVATE_FOREIGN = ['Geburtstagsgeschenk', 'Prototyp Gehäuse', 'Ersatzteil Staubsauger', 'ben@example.test', 'clara@example.test', 'DP-2026-000002', 'DP-2026-000004', 'DP-2026-000005', 'DP-2026-000006', 'Nicht verraten', 'Interne Maße'];

async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

async function startDruckplatte(dataDir, port, { env = {}, fetchImpl } = {}) {
  const config = loadConfig({
    DRUCKPLATTE_ENV: 'preview',
    DATA_DIR: dataDir,
    PORT: String(port),
    PUBLIC_BASE_URL: `http://localhost:${port}`,
    ADMIN_EMAILS: ADMIN_EMAIL,
    ADMIN_PASSWORD_HASH: await hashPassword(ADMIN_PASSWORD),
    ...env,
  });
  const logs = [];
  const app = createApp({ config, fetchImpl, logger: createLogger({ log: (l) => logs.push(l), error: (l) => logs.push(l) }) });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    app,
    logs,
    baseUrl: `http://localhost:${port}`,
    clock: { now: () => Date.now() },
    get state() {
      return app.store.state;
    },
    outbox: () => app.mail.list(),
    async stop() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      app.close();
    },
  };
}

function latestCode(dp, email) {
  const mails = dp.outbox().filter((m) => m.to === email && m.kind === 'login_code');
  return /(\d{6})/.exec(mails[mails.length - 1].text)[1];
}
function codeMails(dp, email) {
  return dp.outbox().filter((m) => m.to === email && m.kind === 'login_code').length;
}
function activeDevices(dp, email) {
  const user = dp.state.users.find((u) => u.email === email);
  return dp.state.devices.filter((d) => d.userId === user.id && !d.revokedAt && Date.now() < d.expiresAt);
}

async function persistentState(context) {
  const st = await context.storageState();
  return { cookies: st.cookies.filter((c) => c.expires !== -1), origins: [] };
}

async function waitForApp(page) {
  await page.waitForSelector('#loginGate', { state: 'hidden' });
  // Aktueller Druck + Warteschlange liegen im Pop-up „Druckstatus“ (Chip in der Kopfzeile)
  await page.waitForSelector('#statusChip');
  await page.waitForSelector('#queueView .queue-summary', { state: 'attached' });
}

async function uiLogin(dp, page, email) {
  await page.waitForSelector('#loginGate', { state: 'visible' });
  await page.fill('#g-email', email);
  await page.click('#g-send');
  await page.waitForSelector('#codeForm', { state: 'visible' });
  await page.fill('#g-code', latestCode(dp, email));
  await page.click('#g-verify');
  await waitForApp(page);
}

async function layoutProblems(page) {
  return page.evaluate(() => {
    const problems = [];
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > vw + 1) problems.push(`horizontaler Überlauf: ${document.documentElement.scrollWidth}px > ${vw}px`);
    for (const el of document.querySelectorAll('button, a.btn, a.mw-link, .chip, .vis-btn, .icon-btn, .link-btn')) {
      if (el.closest('[hidden]')) continue;
      const ov = el.closest('.overlay');
      if (ov && !ov.classList.contains('open')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.left < -1 || r.right > vw + 1) problems.push(`abgeschnitten: „${el.textContent.trim().slice(0, 30)}“ (${Math.round(r.left)}–${Math.round(r.right)} von ${vw})`);
    }
    return problems;
  });
}

async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`), fullPage: true });
}

test('Druckplatte im Browser (Chromium)', { timeout: 600000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'druckplatte-e2e-preview-'));
  seedPreview({ dataDir });
  const migrationStore = new Store({ dataDir }).open();
  migrationStore.transaction((draft) => applyIdeaMigration(draft, Date.now()));
  migrationStore.close();

  const port = await freePort();
  let dp = await startDruckplatte(dataDir, port);
  const apiServer = {
    get baseUrl() {
      return `http://127.0.0.1:${port}`;
    },
    origin: `http://localhost:${port}`,
    clock: { now: () => Date.now() },
    outbox: () => dp.outbox(),
    get state() {
      return dp.state;
    },
  };

  // „Mailprogramm“ auf einer ANDEREN Site (127.0.0.1 statt localhost) → echte Cross-Site-Navigation wie aus Gmail.
  const mailServer = http.createServer((req, res) => {
    const mails = dp.outbox().filter((m) => m.kind !== 'login_code');
    const items = mails
      .map((m, i) => {
        const link = (m.text.match(/https?:\/\/\S+/) || [''])[0];
        return `<li><a id="mail-${i}" data-kind="${m.kind}" data-to="${m.to}" href="${link}">${m.subject}</a></li>`;
      })
      .join('');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Postfach</title><ul>${items}</ul>`);
  });
  const mailPort = await freePort();
  await new Promise((r) => mailServer.listen(mailPort, '127.0.0.1', r));
  const mailUrl = `http://127.0.0.1:${mailPort}/`;

  let browser = await chromium.launch();
  const pageErrors = [];
  const httpErrors = [];
  const externalRequests = [];
  // Erwartete HTTP-Fehler: 401 = (noch) nicht angemeldet, 403 = absichtlich falsches Admin-Passwort im Test.
  const expectedHttp = (status, pathname) =>
    (status === 401 && pathname.startsWith('/api/')) || (status === 403 && pathname === '/api/admin/elevate');
  const watch = (page, label) => {
    page.on('pageerror', (e) => pageErrors.push(`${label}: ${e.message}`));
    page.on('console', (m) => {
      // Netzwerkfehler meldet Chromium als „Failed to load resource“ – die werden separat über die Antworten geprüft.
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) pageErrors.push(`${label}: ${m.text()}`);
    });
    // Lokale Assets: die Seite darf keine fremden Hosts ansprechen (früher: Google Fonts)
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (!['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol !== 'data:') externalRequests.push(`${label}: ${req.url()}`);
    });
    page.on('response', (res) => {
      const url = new URL(res.url());
      if (!url.host.startsWith('localhost') && !url.host.startsWith('127.0.0.1')) return;
      if (res.status() >= 400 && !expectedHttp(res.status(), url.pathname)) httpErrors.push(`${label}: ${res.status()} ${url.pathname}`);
    });
    page.on('dialog', (d) => d.accept());
  };
  const newContext = (opts = {}) => browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true, ...opts });

  const clara = new ApiClient(apiServer);
  const admin = new ApiClient(apiServer);

  let annaContext;
  let annaPage;
  try {
    await t.test('E1: einmal mit Code anmelden → Gerät registriert, sicherer Cookie', async () => {
      annaContext = await newContext();
      annaPage = await annaContext.newPage();
      watch(annaPage, 'anna');
      await annaPage.goto(`${dp.baseUrl}/`);
      await shot(annaPage, 'gate-1280');
      await uiLogin(dp, annaPage, ANNA);
      const cookies = await annaContext.cookies();
      const device = cookies.find((c) => c.name === '__Host-dp_device');
      assert.ok(device, 'Geräte-Cookie gesetzt');
      assert.equal(device.httpOnly, true);
      assert.equal(device.secure, true);
      assert.equal(device.sameSite, 'Lax');
      assert.equal(device.path, '/');
      const lifetime = device.expires * 1000 - Date.now();
      assert.ok(lifetime <= 30 * 86400000 && lifetime > 30 * 86400000 - 120000, 'Laufzeit 30 Tage');
      assert.equal(activeDevices(dp, ANNA).length, 1);
      const cookieInJs = await annaPage.evaluate(() => document.cookie);
      assert.ok(!cookieInJs.includes('dp_device') && !cookieInJs.includes('dp_session'), 'Tokens nicht per JavaScript lesbar (HttpOnly)');
      const storage = await annaPage.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
      assert.ok(!storage.includes(device.value), 'Token nicht in localStorage/sessionStorage');
      assert.ok(!(await annaPage.content()).includes(device.value), 'Token nicht im HTML');
    });

    await t.test('E2/E3: Seite neu laden, Browser komplett neu starten → kein Code, kein neues Gerät', async () => {
      const codes = codeMails(dp, ANNA);
      await annaPage.reload();
      await waitForApp(annaPage);
      const persisted = await persistentState(annaContext);
      assert.ok(persisted.cookies.some((c) => c.name === '__Host-dp_device'));
      assert.ok(!persisted.cookies.some((c) => c.name === '__Host-dp_session'), 'Session-Cookie überlebt den Browser nicht');
      await annaContext.close();
      await browser.close();
      browser = await chromium.launch(); // kompletter Browser-/Geräteneustart
      annaContext = await newContext({ storageState: persisted });
      annaPage = await annaContext.newPage();
      watch(annaPage, 'anna');
      await annaPage.goto(`${dp.baseUrl}/`);
      await waitForApp(annaPage);
      assert.equal(codeMails(dp, ANNA), codes, 'kein neuer Code');
      assert.equal(activeDevices(dp, ANNA).length, 1, 'kein neues Gerät');
    });

    await t.test('E4: Server-Neustart → Gerät bleibt gültig', async () => {
      await dp.stop();
      dp = await startDruckplatte(dataDir, port);
      await annaPage.reload();
      await waitForApp(annaPage);
      assert.equal(activeDevices(dp, ANNA).length, 1);
    });

    await t.test('E5: Status-, Fertigstellungs- und Support-Mail-Links (Cross-Site) → kein Code, dasselbe Gerät', async () => {
      await apiLogin(apiServer, admin, ADMIN_EMAIL);
      await elevate(admin);
      assert.equal((await admin.patch('/api/orders/ord_preview_annaClips', { status: 'progress' })).status, 200);
      assert.equal((await admin.patch('/api/orders/ord_preview_annaClips', { status: 'ready' })).status, 200);
      assert.equal((await admin.post('/api/support/sup_preview_1/resolve', {})).status, 200);
      const codes = codeMails(dp, ANNA);
      const deviceId = activeDevices(dp, ANNA)[0].id;

      for (const kind of ['order_status', 'order_finished', 'support_resolved']) {
        // Browser zwischendurch schließen – wie beim späteren Öffnen einer Mail
        const persisted = await persistentState(annaContext);
        await annaContext.close();
        annaContext = await newContext({ storageState: persisted });
        annaPage = await annaContext.newPage();
        watch(annaPage, 'anna');
        await annaPage.goto(mailUrl);
        const link = annaPage.locator(`a[data-kind="${kind}"][data-to="${ANNA}"]`).last();
        const href = await link.getAttribute('href');
        assert.ok(href.startsWith(`${dp.baseUrl}/`), href);
        assert.ok(!/[?#]/.test(href), 'keine Tokens/Parameter im Link');
        await link.click();
        await annaPage.waitForURL(`${dp.baseUrl}/**`, { waitUntil: 'domcontentloaded' });
        await waitForApp(annaPage);
        if (kind === 'support_resolved') {
          await annaPage.waitForSelector('#supportOverlay.open');
          await shot(annaPage, 'mail-link-support');
          await annaPage.keyboard.press('Escape');
        } else {
          await annaPage.waitForSelector('[data-dp="DP-2026-000007"].highlight');
          await shot(annaPage, `mail-link-${kind}`);
        }
        assert.equal(codeMails(dp, ANNA), codes, `${kind}: kein Code`);
        const active = activeDevices(dp, ANNA);
        assert.equal(active.length, 1, `${kind}: kein neues Gerät`);
        assert.equal(active[0].id, deviceId, `${kind}: dasselbe Gerät`);
      }
    });

    await t.test('E6: neues Gerät + derselbe Mail-Link → Code erforderlich', async () => {
      const fresh = await newContext({ ...devices['iPhone 13'], ignoreHTTPSErrors: true });
      const page = await fresh.newPage();
      watch(page, 'neues-geraet');
      await page.goto(mailUrl);
      await page.locator(`a[data-kind="order_finished"][data-to="${ANNA}"]`).last().click();
      await page.waitForSelector('#loginGate', { state: 'visible' });
      assert.equal(activeDevices(dp, ANNA).length, 1);
      await fresh.close();
    });

    await t.test('E7: Datenschutz – fremde private Daten stehen weder im DOM noch in Netzwerkantworten', async () => {
      const bodies = [];
      annaPage.on('response', async (res) => {
        if (res.url().includes('/api/')) bodies.push(await res.text().catch(() => ''));
      });
      await annaPage.reload();
      await waitForApp(annaPage);
      await annaPage.waitForTimeout(6000); // mindestens ein Live-Update
      const html = await annaPage.content();
      assert.match(await annaPage.textContent('#queueView'), /Dein Platz: 3/);
      assert.match(await annaPage.textContent('#queueView'), /Noch 2 Drucke vor dir/);
      assert.match(await annaPage.textContent('#currentPrint'), /Aktuell wird ein anderer Druck bearbeitet/);
      assert.match(html, /DP-2026-000009/);
      assert.ok(bodies.length >= 2, 'Live-Antworten mitgeschnitten');
      for (const secret of PRIVATE_FOREIGN) {
        assert.ok(!html.includes(secret), `DOM enthält „${secret}“`);
        for (const body of bodies) assert.ok(!body.includes(secret), `Netzwerkantwort enthält „${secret}“`);
      }
    });

    let doraPage;
    await t.test('E8: Live-Sync – öffentlich → privat verschwindet ohne Neuladen aus dem DOM', async () => {
      const doraContext = await newContext();
      doraPage = await doraContext.newPage();
      watch(doraPage, 'dora');
      await doraPage.goto(`${dp.baseUrl}/`);
      await uiLogin(dp, doraPage, DORA);
      assert.match(await doraPage.textContent('#queueView'), /Aktuell befinden sich 4 Drucke in der Warteschlange/);
      assert.ok((await doraPage.content()).includes('Benchy'));
      assert.equal(await doraPage.isVisible('#publicSection'), true);

      await apiLogin(apiServer, clara, CLARA);
      assert.equal((await clara.patch('/api/orders/ord_preview_claraBenchy', { isPublic: false })).status, 200);
      await doraPage.waitForFunction(() => !document.documentElement.innerHTML.includes('Benchy'), null, { timeout: 15000 });
      assert.equal(await doraPage.isVisible('#publicSection'), false);
      assert.equal(await doraPage.locator('#queueView .q-item.private').count() >= 1, true);

      assert.equal((await clara.patch('/api/orders/ord_preview_claraBenchy', { isPublic: true })).status, 200);
      await doraPage.waitForFunction(() => document.documentElement.innerHTML.includes('Benchy'), null, { timeout: 15000 });
    });

    let adminPage;
    await t.test('E9: Admin – Admin-Passwort im Browser, danach vollständige Ansicht', async () => {
      const adminContext = await newContext();
      adminPage = await adminContext.newPage();
      watch(adminPage, 'admin');
      await adminPage.goto(`${dp.baseUrl}/`);
      await uiLogin(dp, adminPage, ADMIN_EMAIL);
      assert.equal(await adminPage.isVisible('#roleSwitch'), true);
      assert.ok(!(await adminPage.content()).includes('Geburtstagsgeschenk'), 'ohne Admin-Passwort keine fremden Daten');
      await adminPage.click('#adminBtn');
      await adminPage.fill('#a-password', 'falsch');
      await adminPage.click('#adminSubmit');
      await adminPage.waitForFunction(() => document.querySelector('#a-error').textContent.includes('Falsches'));
      await adminPage.fill('#a-password', ADMIN_PASSWORD);
      await adminPage.click('#adminSubmit');
      await adminPage.waitForSelector('#modeBanner.admin');
      // Benutzerverwaltung: Pop-up über den Chip „👥 Benutzer“ (Hauptseite bleibt im Original-Layout)
      await adminPage.click('#usersChip');
      await adminPage.waitForSelector('#usersOverlay.open .user-row');
      await shot(adminPage, 'admin-benutzer-popup');
      await adminPage.keyboard.press('Escape');
      await adminPage.waitForSelector('#usersOverlay:not(.open)', { state: 'attached' });
      const text = await adminPage.textContent('body');
      for (const expected of ['Admin-Modus', 'Geburtstagsgeschenk', 'ben@example.test', 'DP-2026-000004', 'Ersatzteil Staubsauger-Düse']) {
        assert.ok(text.includes(expected), `Admin sieht „${expected}“`);
      }
    });

    await t.test('E10: Profil – Geräte anzeigen und „Alle anderen Geräte abmelden“', async () => {
      const phoneContext = await newContext({ ...devices['iPhone 13'], ignoreHTTPSErrors: true });
      const phone = await phoneContext.newPage();
      watch(phone, 'anna-iphone');
      await phone.goto(`${dp.baseUrl}/`);
      await uiLogin(dp, phone, ANNA);
      await shot(phone, 'anna-iphone');
      assert.equal(activeDevices(dp, ANNA).length, 2);

      await annaPage.click('#profileBtn');
      await annaPage.waitForSelector('#profileOverlay.open .device-item');
      assert.equal(await annaPage.locator('#deviceList .device-item').count(), 2);
      const listText = await annaPage.textContent('#deviceList');
      assert.match(listText, /dieses Gerät/);
      assert.match(listText, /Gültig bis/);
      assert.match(listText, /Safari · iPhone/);
      await shot(annaPage, 'profil-geraete-1280');
      await annaPage.click('#revokeOthersBtn');
      await annaPage.waitForFunction(() => document.querySelectorAll('#deviceList .device-item').length === 1);
      assert.equal(activeDevices(dp, ANNA).length, 1);
      await annaPage.keyboard.press('Escape');

      await phone.reload();
      await phone.waitForSelector('#loginGate', { state: 'visible' });
      await phoneContext.close();
    });

    await t.test('E11: Responsive 360–1920 px – kein Überlauf, keine abgeschnittenen Buttons', async () => {
      const problems = [];
      for (const width of WIDTHS) {
        for (const [label, page] of [['anna', annaPage], ['dora', doraPage], ['admin', adminPage]]) {
          await page.setViewportSize({ width, height: width < 768 ? 820 : 1000 });
          await page.waitForTimeout(150);
          for (const p of await layoutProblems(page)) problems.push(`${label} @${width}: ${p}`);
          await shot(page, `${label}-${width}`);
        }
        await annaPage.click('#profileBtn');
        await annaPage.waitForSelector('#profileOverlay.open .device-item');
        for (const p of await layoutProblems(annaPage)) problems.push(`profil @${width}: ${p}`);
        if (width === 360 || width === 1280) await shot(annaPage, `profil-${width}`);
        await annaPage.keyboard.press('Escape');
      }
      const gateContext = await newContext({ viewport: { width: 360, height: 780 } });
      const gatePage = await gateContext.newPage();
      await gatePage.goto(`${dp.baseUrl}/`);
      await gatePage.waitForSelector('#loginGate', { state: 'visible' });
      for (const p of await layoutProblems(gatePage)) problems.push(`gate @360: ${p}`);
      await shot(gatePage, 'gate-360');
      await gateContext.close();
      assert.deepEqual(problems, []);
    });

    await t.test('E12: Pop-ups „Druckstatus“ und „Sichtbarkeit“ im Stil der Seite', async () => {
      await annaPage.setViewportSize({ width: 1280, height: 900 });
      // Druckstatus: Chip zeigt den eigenen Platz, Pop-up zeigt aktuellen Druck + Warteschlange
      assert.match(await annaPage.textContent('#statusChip'), /Dein Platz\s*3/);
      await annaPage.click('#statusChip');
      await annaPage.waitForSelector('#statusOverlay.open #queueView .queue-summary');
      assert.match(await annaPage.innerText('#statusOverlay'), /Dein Platz: 3/);
      assert.match(await annaPage.innerText('#statusOverlay'), /Aktuell wird ein anderer Druck bearbeitet/);
      await shot(annaPage, 'druckstatus-popup-1280');
      for (const p of await layoutProblems(annaPage)) assert.fail(`Druckstatus-Pop-up: ${p}`);
      await annaPage.keyboard.press('Escape');
      await annaPage.waitForSelector('#statusOverlay:not(.open)', { state: 'attached' });

      // Sichtbarkeit: eigener Auftrag öffentlich schalten und zurück – über das Pop-up.
      // Doras Ansicht wird vorher geschlossen: Lädt sie in der kurzen öffentlichen Phase das Bild und ist
      // der Auftrag danach schon wieder privat, antwortet der Server korrekt mit 404 – das ist gewolltes
      // Datenschutzverhalten, würde hier aber die strenge „keine HTTP-Fehler“-Prüfung zufällig auslösen.
      await doraPage.context().close();
      const card = annaPage.locator('#grid .card[data-dp="DP-2026-000007"]');
      await card.locator('[data-visibility]').click();
      await annaPage.waitForSelector('#visibilityOverlay.open');
      await shot(annaPage, 'sichtbarkeit-popup-1280');
      await annaPage.click('#visSwitch [data-vis="public"]');
      await annaPage.click('#visSave');
      await annaPage.waitForSelector('#visibilityOverlay:not(.open)', { state: 'attached' });
      await annaPage.waitForFunction(() => document.querySelector('#grid .card[data-dp="DP-2026-000007"] .tag.public-flag'));
      await card.locator('[data-visibility]').click();
      await annaPage.click('#visSwitch [data-vis="private"]');
      await annaPage.click('#visSave');
      await annaPage.waitForFunction(() => !document.querySelector('#grid .card[data-dp="DP-2026-000007"] .tag.public-flag'));

      // Handy: Druckstatus-Pop-up ohne Überlauf
      await annaPage.setViewportSize({ width: 360, height: 780 });
      await annaPage.click('#statusChip');
      await annaPage.waitForSelector('#statusOverlay.open');
      const problems = await layoutProblems(annaPage);
      await shot(annaPage, 'druckstatus-popup-360');
      await annaPage.keyboard.press('Escape');
      assert.deepEqual(problems, []);
    });

    await t.test('Keine JavaScript-Fehler, keine unerwarteten HTTP-Fehler, keine externen Anfragen', () => {
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(httpErrors, []);
      assert.deepEqual(externalRequests, [], 'Schriften/Assets kommen lokal');
    });

    await t.test('Keine Tokens in Serverlogs', async () => {
      const cookies = await annaContext.cookies();
      const logs = dp.logs.join('\n');
      for (const c of cookies.filter((x) => x.name.startsWith('__Host-dp_'))) assert.ok(!logs.includes(c.value));
    });
  } finally {
    await browser.close();
    await new Promise((r) => mailServer.close(r));
    await dp.stop();
  }
});

/**
 * Produktionsmodell: Cloudflare Access sitzt vor Druckplatte und hat die E-Mail bereits per Code
 * bestätigt. Die Access-Edge wird hier nachgestellt, indem Chromium den signierten
 * Cf-Access-Jwt-Assertion-Header mitsendet (selbst signiert, kein Netzwerkzugriff).
 */
test('Cloudflare-Access-Modus im Browser (Chromium): kein zweiter Code', { timeout: 300000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'druckplatte-e2e-cf-preview-'));
  seedPreview({ dataDir });
  const access = accessFixture();
  const port = await freePort();
  const dp = await startDruckplatte(dataDir, port, {
    env: { CF_ACCESS_TEAM_DOMAIN: access.teamDomain, CF_ACCESS_AUD: access.aud },
    fetchImpl: access.fetchImpl,
  });
  const nowS = () => Math.floor(Date.now() / 1000);
  const jwtHeaders = (email, opts) => ({ 'cf-access-jwt-assertion': access.token(email, opts) });
  const browser = await chromium.launch();
  const pageErrors = [];
  const httpErrors = [];
  const newPage = async (context, label) => {
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(`${label}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) pageErrors.push(`${label}: ${m.text()}`);
    });
    page.on('response', (res) => {
      const url = new URL(res.url());
      // 401 unter /api/ = (noch) keine Druckplatte-Sitzung bzw. neue Access-Anmeldung nötig – erwartet
      if (res.status() >= 400 && !(res.status() === 401 && url.pathname.startsWith('/api/'))) httpErrors.push(`${label}: ${res.status()} ${url.pathname}`);
    });
    page.on('dialog', (d) => d.accept());
    return page;
  };
  const newContext = (headers, opts = {}) =>
    browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: headers, ...opts });

  try {
    let persisted;
    let annaPage;
    await t.test('CF-E1: frische Access-Anmeldung → App startet ohne Code-Formular, genau ein Gerät, keine Mail', async () => {
      const context = await newContext(jwtHeaders(ANNA, { iat: nowS() }));
      annaPage = await newPage(context, 'anna-cf');
      await annaPage.goto(`${dp.baseUrl}/`);
      await waitForApp(annaPage);
      assert.equal(await annaPage.isVisible('#emailForm'), false);
      assert.equal(await annaPage.isVisible('#codeForm'), false);
      assert.equal(dp.outbox().length, 0, 'Druckplatte hat keinen Code verschickt');
      assert.equal(activeDevices(dp, ANNA).length, 1);
      const device = (await context.cookies()).find((c) => c.name === '__Host-dp_device');
      assert.ok(device && device.httpOnly && device.secure, 'sicherer Geräte-Cookie');
      persisted = await persistentState(context);
      await shot(annaPage, 'cf-app-1280');
    });

    await t.test('CF-E2: Browser-Neustart mit ALTER Access-Anmeldung → vorhandenes Gerät, kein neues', async () => {
      const context = await newContext(jwtHeaders(ANNA, { iat: nowS() - 2 * 3600, exp: nowS() + 3600 }), { storageState: persisted });
      const page = await newPage(context, 'anna-cf-restart');
      await page.goto(`${dp.baseUrl}/`);
      await waitForApp(page);
      assert.equal(activeDevices(dp, ANNA).length, 1);
      assert.equal(dp.state.devices.filter((d) => d.userId === dp.state.users.find((u) => u.email === ANNA).id).length, 1);
      await context.close();
    });

    await t.test('CF-E3: neues Gerät ohne frische Access-Anmeldung → Hinweis „Neu anmelden“, kein Gerät', async () => {
      const context = await newContext(jwtHeaders(DORA, { iat: nowS() - 2 * 3600, exp: nowS() + 3600 }), { viewport: { width: 360, height: 780 } });
      const page = await newPage(context, 'dora-cf-stale');
      await page.goto(`${dp.baseUrl}/`);
      await page.waitForSelector('#accessGate:not([hidden])');
      await page.waitForFunction(() => document.querySelector('#accessTitle').textContent.includes('Neue Anmeldung'));
      assert.equal(await page.isVisible('#accessRelogin'), true);
      assert.equal(await page.getAttribute('#accessRelogin', 'href'), '/cdn-cgi/access/logout');
      assert.equal(await page.isVisible('#emailForm'), false, 'kein Druckplatte-Code-Formular');
      assert.deepEqual(await layoutProblems(page), []);
      await shot(page, 'cf-gate-reauth-360');
      assert.equal(dp.state.users.some((u) => u.email === DORA && dp.state.devices.some((d) => d.userId === u.id && !d.revokedAt)), false);
      await context.close();
    });

    await t.test('CF-E4: Abmelden → Gerät vergessen, KEINE stille Neuregistrierung, Hinweis auf Access-Anmeldung', async () => {
      await annaPage.click('#profileBtn');
      await annaPage.waitForSelector('#profileOverlay.open');
      await annaPage.click('#logoutBtn');
      await annaPage.waitForSelector('#accessGate:not([hidden])');
      await annaPage.waitForFunction(() => document.querySelector('#accessTitle').textContent === 'Abgemeldet');
      assert.equal(await annaPage.isVisible('#accessRelogin'), true);
      await annaPage.reload(); // auch ein Neuladen mit demselben Access-Token registriert nichts
      await annaPage.waitForSelector('#accessGate:not([hidden])');
      await annaPage.waitForFunction(() => document.querySelector('#accessTitle').textContent.includes('Neue Anmeldung'));
      assert.equal(activeDevices(dp, ANNA).length, 0, 'kein neues Gerät nach Abmelden');
      assert.ok(!(await annaPage.content()).includes('Dein Platz'), 'keine Daten mehr im DOM');
      await shot(annaPage, 'cf-logged-out-1280');
    });

    await t.test('CF: keine JavaScript-Fehler und keine unerwarteten HTTP-Fehler', () => {
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(httpErrors, []);
    });
  } finally {
    await browser.close();
    await dp.stop();
  }
});
