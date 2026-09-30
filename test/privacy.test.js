'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ADMIN_EMAIL, TINY_PNG, startServer, Browser, login, elevate, createOrder } = require('./helpers');
const { PUBLIC_MODEL_FIELDS } = require('../server/domain/privacy');

const EMAILS = {
  anna: 'anna@example.test',
  ben: 'ben@example.test',
  clara: 'clara@example.test',
  dora: 'dora@example.test',
};

/**
 * Szenario:
 *   Aktueller Druck: Bens privater Auftrag
 *   Warteschlange:  1 Ben (privat) · 2 Clara (privat) · 3 Anna · 4 Clara (öffentlich)
 *   Dora hat keinen Auftrag in der Warteschlange.
 */
async function setupScenario() {
  // Anpassung (Review, Punkt 7): externe Bild-URLs sind standardmäßig verboten. Für den Leak-Test mit
  // einem URL-Bild wird dieser eine Host ausdrücklich freigegeben.
  const server = await startServer({ env: { IMAGE_HOST_ALLOWLIST: 'cdn.example.test' } });
  const b = {};
  for (const [key, email] of Object.entries(EMAILS)) {
    b[key] = new Browser(server);
    await login(server, b[key], email);
  }
  b.admin = new Browser(server);
  await login(server, b.admin, ADMIN_EMAIL);
  await elevate(b.admin);

  const o = {};
  o.benCurrent = await createOrder(b.ben, {
    name: 'GEHEIM-Ben-Aktuell',
    link: 'https://makerworld.com/de/models/9001-geheim-ben-aktuell',
    color: 'Rot',
    filament: 'PETG',
    note: 'GEHEIM-Notiz-Ben-Aktuell',
    image: TINY_PNG,
  });
  o.benQueued = await createOrder(b.ben, {
    name: 'GEHEIM-Ben-Wartend',
    link: 'https://makerworld.com/de/models/9002-geheim-ben-wartend',
    color: 'Rot',
    filament: 'PETG',
    note: 'GEHEIM-Notiz-Ben-Wartend',
    image: TINY_PNG,
  });
  o.claraPrivate = await createOrder(b.clara, {
    name: 'GEHEIM-Clara-Privat',
    link: 'https://makerworld.com/de/models/9003-geheim-clara',
    color: 'Gelb',
    filament: 'ASA',
    note: 'GEHEIM-Notiz-Clara',
    image: 'https://cdn.example.test/geheim-clara.jpg',
  });
  o.anna = await createOrder(b.anna, {
    name: 'Annas Modell',
    link: 'https://makerworld.com/de/models/9004-anna',
    color: 'Schwarz',
    filament: 'PLA',
    note: 'Annas Notiz',
    image: TINY_PNG,
  });
  o.claraPublic = await createOrder(b.clara, {
    name: 'Öffentliche Benchy',
    link: 'https://makerworld.com/de/models/9005-benchy',
    color: 'Weiß',
    filament: 'PLA',
    note: 'GEHEIM-Notiz-Clara-Oeffentlich',
    image: TINY_PNG,
    isPublic: true,
  });

  for (const order of [o.benQueued, o.claraPrivate, o.anna, o.claraPublic]) {
    const res = await b.admin.post('/api/admin/queue', { orderId: order.id });
    assert.equal(res.status, 200, res.text);
  }
  assert.equal((await b.admin.post('/api/admin/printer/current', { orderId: o.benCurrent.id })).status, 200);
  assert.equal((await b.admin.post('/api/admin/printer/progress', { progress: 47, remainingMinutes: 83 })).status, 200);

  const users = Object.fromEntries(Object.entries(EMAILS).map(([k, email]) => [k, server.state.users.find((u) => u.email === email)]));
  return { server, b, o, users };
}

/** Alle privaten Merkmale eines fremden Auftrags – nichts davon darf in fremden Antworten stehen. */
function privateMarkers(order, owner, server) {
  const stored = server.state.orders.find((x) => x.id === order.id);
  const markers = [order.name, order.link, order.note, order.dpRef, order.id, owner.email, owner.id];
  if (stored.image && stored.image.kind === 'file') markers.push(stored.image.key);
  if (stored.image && stored.image.kind === 'url') markers.push(stored.image.url);
  return markers.filter(Boolean);
}

function assertNoLeak(json, markers, label) {
  const text = JSON.stringify(json);
  for (const marker of markers) assert.ok(!text.includes(marker), `${label}: „${marker}“ darf nicht enthalten sein`);
}

test('Datenschutz Current Print & Warteschlange', async (t) => {
  const { server, b, o, users } = await setupScenario();
  try {
    await t.test('A: eigener Current Print → volle eigene Ansicht; Fremde → keine Details; Admin → vollständig', async () => {
      assert.equal((await b.admin.post('/api/admin/printer/current', { orderId: o.anna.id })).status, 200);
      await b.admin.post('/api/admin/printer/progress', { progress: 63, remainingMinutes: 41 });

      const own = (await b.anna.get('/api/current-print')).json.currentPrint;
      assert.equal(own.kind, 'own');
      assert.equal(own.order.name, 'Annas Modell');
      assert.equal(own.order.dpRef, o.anna.dpRef);
      assert.equal(own.order.color, 'Schwarz');
      assert.equal(own.order.filament, 'PLA');
      assert.ok(own.order.imageUrl);
      assert.equal(own.progress, 63);
      assert.equal(own.remainingMinutes, 41);
      assert.ok(own.etaAt > server.clock.now());
      assert.ok(own.startedAt);

      const foreign = (await b.ben.get('/api/current-print')).json.currentPrint;
      assert.deepEqual(Object.keys(foreign).sort(), ['kind', 'progressBucket', 'remainingApproxMinutes', 'state']);
      assert.equal(foreign.kind, 'foreign_private');
      assert.equal(foreign.progressBucket, 60);
      assert.equal(foreign.remainingApproxMinutes, 45);
      assertNoLeak(foreign, privateMarkers(o.anna, users.anna, server), 'Ben sieht Annas Druck');

      const admin = (await b.admin.get('/api/current-print')).json.currentPrint;
      assert.equal(admin.kind, 'admin');
      assert.equal(admin.order.ownerEmail, EMAILS.anna);
      assert.equal(admin.order.dpRef, o.anna.dpRef);
      assert.equal(admin.order.note, 'Annas Notiz');
      assert.equal(admin.progress, 63);

      // zurück zum Ausgangszustand: Anna wieder auf Platz 3
      await b.admin.post('/api/admin/printer/current', { orderId: o.benCurrent.id });
      await b.admin.post('/api/admin/printer/progress', { progress: 47, remainingMinutes: 83 });
      await b.admin.post('/api/admin/queue', { orderId: o.anna.id });
      await b.admin.post(`/api/admin/queue/${o.anna.id}/move`, { direction: 'up' });
      assert.deepEqual(server.state.queue, [o.benQueued.id, o.claraPrivate.id, o.anna.id, o.claraPublic.id]);
    });

    await t.test('B: fremder privater Current Print → keine privaten Daten', async () => {
      for (const viewer of ['anna', 'clara', 'dora']) {
        const res = await b[viewer].get('/api/current-print');
        const view = res.json.currentPrint;
        assert.equal(view.kind, 'foreign_private');
        assert.equal(view.state, 'printing');
        assert.deepEqual(Object.keys(view).sort(), ['kind', 'progressBucket', 'remainingApproxMinutes', 'state']);
        assertNoLeak(res.json, privateMarkers(o.benCurrent, users.ben, server), `${viewer} → Bens Current Print`);
        assert.ok(!res.text.includes('Rot') && !res.text.includes('PETG'), 'private Farbe/Material');
      }
    });

    await t.test('C: fremder öffentlicher Current Print → nur Public-Allowlist', async () => {
      await b.admin.post('/api/admin/printer/current', { orderId: o.claraPublic.id });
      const res = await b.dora.get('/api/current-print');
      const view = res.json.currentPrint;
      assert.equal(view.kind, 'foreign_public');
      assert.deepEqual(Object.keys(view.model).sort(), [...PUBLIC_MODEL_FIELDS].sort());
      assert.equal(view.model.name, 'Öffentliche Benchy');
      assert.equal(view.model.color, 'Weiß');
      assert.equal(view.model.filament, 'PLA');
      assert.equal(view.model.link, 'https://makerworld.com/de/models/9005-benchy');
      assert.match(view.model.imageUrl, /^\/api\/images\//);
      assertNoLeak(res.json, [o.claraPublic.dpRef, o.claraPublic.id, o.claraPublic.note, EMAILS.clara, users.clara.id], 'öffentlicher Current Print');
      // Zustand wiederherstellen
      await b.admin.post('/api/admin/printer/current', { orderId: o.benCurrent.id });
      await b.admin.post('/api/admin/queue', { orderId: o.claraPublic.id });
      assert.deepEqual(server.state.queue, [o.benQueued.id, o.claraPrivate.id, o.anna.id, o.claraPublic.id]);
    });

    await t.test('D: Anna auf Platz 3 hinter zwei privaten Aufträgen', async () => {
      const res = await b.anna.get('/api/queue');
      const q = res.json.queue;
      assert.equal(q.total, 4);
      assert.deepEqual(q.mine, { positions: [3], position: 3, aheadCount: 2 });
      assert.deepEqual(q.entries[0], { kind: 'private_queue_slot', position: 1 });
      assert.deepEqual(q.entries[1], { kind: 'private_queue_slot', position: 2 });
      assert.equal(q.entries[2].kind, 'own');
      assert.equal(q.entries[2].order.dpRef, o.anna.dpRef);
      assert.equal(q.entries[2].order.name, 'Annas Modell');
      assertNoLeak(res.json, privateMarkers(o.benQueued, users.ben, server), 'Bens Auftrag');
      assertNoLeak(res.json, privateMarkers(o.claraPrivate, users.clara, server), 'Claras privater Auftrag');
    });

    await t.test('E: öffentlicher Auftrag in der Queue → Allowlist sichtbar, private Daten entfernt', async () => {
      const res = await b.anna.get('/api/queue');
      const pub = res.json.queue.entries[3];
      assert.equal(pub.kind, 'public_model');
      assert.equal(pub.position, 4);
      assert.deepEqual(Object.keys(pub).sort(), ['kind', 'model', 'position']);
      assert.deepEqual(Object.keys(pub.model).sort(), [...PUBLIC_MODEL_FIELDS].sort());
      assert.equal(pub.model.name, 'Öffentliche Benchy');
      assertNoLeak(res.json, [o.claraPublic.dpRef, o.claraPublic.id, o.claraPublic.note, EMAILS.clara, users.clara.id], 'öffentlicher Queue-Eintrag');
    });

    await t.test('F: Admin sieht die komplette Warteschlange', async () => {
      const q = (await b.admin.get('/api/queue')).json.queue;
      assert.equal(q.total, 4);
      assert.ok(q.entries.every((e) => e.kind === 'admin'));
      assert.deepEqual(
        q.entries.map((e) => e.order.ownerEmail),
        [EMAILS.ben, EMAILS.clara, EMAILS.anna, EMAILS.clara],
      );
      assert.deepEqual(
        q.entries.map((e) => e.order.dpRef),
        [o.benQueued.dpRef, o.claraPrivate.dpRef, o.anna.dpRef, o.claraPublic.dpRef],
      );
      assert.equal(q.entries[0].order.note, 'GEHEIM-Notiz-Ben-Wartend');
    });

    await t.test('G: Benutzer ohne eigenen Queue-Auftrag sieht keine privaten Modelle', async () => {
      const res = await b.dora.get('/api/queue');
      const q = res.json.queue;
      assert.equal(q.total, 4);
      assert.equal(q.mine, null);
      assert.deepEqual(q.entries.map((e) => e.kind), ['private_queue_slot', 'private_queue_slot', 'private_queue_slot', 'public_model']);
      for (const order of [o.benQueued, o.claraPrivate, o.anna]) {
        const owner = server.state.users.find((u) => u.id === server.state.orders.find((x) => x.id === order.id).ownerId);
        assertNoLeak(res.json, privateMarkers(order, owner, server), 'Dora');
      }
    });

    await t.test('57: API-Leak-Test – JSON.stringify fremder Antworten enthält keine privaten Daten', async () => {
      const privateOrders = [
        [o.benCurrent, users.ben],
        [o.benQueued, users.ben],
        [o.claraPrivate, users.clara],
        [o.anna, users.anna],
      ];
      for (const endpoint of ['/api/live', '/api/queue', '/api/current-print', '/api/orders']) {
        const res = await b.dora.get(endpoint);
        assert.equal(res.status, 200);
        for (const [order, owner] of privateOrders) assertNoLeak(res.json, privateMarkers(order, owner, server), `Dora ${endpoint}`);
        // Private Farben/Materialien der fremden Aufträge (Dora sieht nur die öffentliche Benchy: Weiß/PLA).
        // Zufällige Bildschlüssel werden vorher entfernt, damit sie nicht zufällig ein Wort enthalten.
        const text = res.text.replace(/\/api\/images\/[A-Za-z0-9_-]+/g, '');
        for (const word of ['Rot', 'Gelb', 'Schwarz', 'PETG', 'ASA']) assert.ok(!text.includes(word), `Dora ${endpoint}: ${word}`);
        assertNoLeak(res.json, [o.claraPublic.dpRef, o.claraPublic.id, o.claraPublic.note, EMAILS.clara], `Dora ${endpoint} (öffentlich)`);
      }
      // Anna sieht ihre eigenen Daten, aber nichts Fremdes
      const annaLive = await b.anna.get('/api/live');
      assert.ok(annaLive.text.includes(o.anna.dpRef));
      for (const [order, owner] of privateOrders.filter(([x]) => x.id !== o.anna.id)) {
        assertNoLeak(annaLive.json, privateMarkers(order, owner, server), 'Anna /api/live');
      }
    });

    await t.test('Bilder: privates Bild für Fremde 404, öffentliches Bild erlaubt, Eigentümer/Admin erlaubt', async () => {
      const key = (id) => server.state.orders.find((x) => x.id === id).image.key;
      const privateUrl = `/api/images/${key(o.benQueued.id)}`;
      const publicUrl = `/api/images/${key(o.claraPublic.id)}`;
      assert.equal((await b.dora.get(privateUrl)).status, 404);
      assert.equal((await b.anna.get(privateUrl)).status, 404);
      assert.equal((await b.ben.get(privateUrl)).status, 200);
      assert.equal((await b.admin.get(privateUrl)).status, 200);
      const pub = await b.dora.get(publicUrl);
      assert.equal(pub.status, 200);
      assert.equal(pub.headers.get('content-type'), 'image/png');
      assert.equal(pub.headers.get('cache-control'), 'private, no-store');
      assert.equal((await new Browser(server).get(publicUrl)).status, 401, 'ohne Anmeldung kein Bild');
    });

    await t.test('H: Live-Sync – öffentlich → privat entfernt die Details beim nächsten Update', async () => {
      const before = await b.dora.get('/api/live');
      assert.ok(before.text.includes('Öffentliche Benchy'));
      assert.equal(before.json.publicModels.length, 1);

      const toggle = await b.clara.patch(`/api/orders/${o.claraPublic.id}`, { isPublic: false });
      assert.equal(toggle.status, 200);

      const after = await b.dora.get('/api/live');
      assert.ok(!after.text.includes('Öffentliche Benchy'));
      assert.ok(!after.text.includes('9005-benchy'));
      assert.equal(after.json.publicModels.length, 0);
      assert.deepEqual(after.json.queue.entries[3], { kind: 'private_queue_slot', position: 4 });
      const imageKey = server.state.orders.find((x) => x.id === o.claraPublic.id).image.key;
      assert.equal((await b.dora.get(`/api/images/${imageKey}`)).status, 404, 'Bild nicht mehr abrufbar');

      await b.clara.patch(`/api/orders/${o.claraPublic.id}`, { isPublic: true });
      assert.ok((await b.dora.get('/api/live')).text.includes('Öffentliche Benchy'));
    });

    await t.test('I: Legacy-/ungültige Public-Werte werden privat behandelt', async () => {
      const values = [['fehlt', undefined], ['string', 'true'], ['eins', 1], ['ja', 'yes'], ['null', null], ['objekt', {}]];
      server.app.store.transaction((draft) => {
        const legacy = draft.orders.find((x) => x.id === o.claraPrivate.id);
        for (const [label, value] of values) {
          const order = { ...legacy, id: `ord_legacy_${label}`, dpRef: null, name: `LEGACY-${label}`, isPublic: value };
          if (value === undefined) delete order.isPublic;
          draft.orders.push(order);
          draft.queue.push(order.id);
        }
      });
      const res = await b.dora.get('/api/live');
      assert.ok(!res.text.includes('LEGACY-'));
      assert.equal(res.json.publicModels.length, 1, 'nur die ausdrücklich öffentliche Benchy');
      const slots = res.json.queue.entries.slice(4);
      assert.equal(slots.length, 6);
      assert.ok(slots.every((e) => e.kind === 'private_queue_slot' && Object.keys(e).length === 2));
      server.app.store.transaction((draft) => {
        draft.orders = draft.orders.filter((x) => !x.id.startsWith('ord_legacy_'));
        draft.queue = draft.queue.filter((id) => !id.startsWith('ord_legacy_'));
      });
    });

    await t.test('Eigene Aufträge: /api/orders liefert nur eigene + öffentliche Allowlist', async () => {
      const res = await b.anna.get('/api/orders');
      assert.deepEqual(res.json.orders.map((x) => x.name), ['Annas Modell']);
      assert.deepEqual(res.json.publicModels.map((x) => x.name), ['Öffentliche Benchy']);
      assert.ok(res.json.publicModels.every((m) => Object.keys(m).sort().join() === [...PUBLIC_MODEL_FIELDS].sort().join()));
    });

    await t.test('Rechte: Fremde können fremde Aufträge weder ändern, löschen, referenzieren noch Support lesen', async () => {
      assert.equal((await b.dora.patch(`/api/orders/${o.anna.id}`, { isPublic: true })).status, 404);
      assert.equal((await b.dora.del(`/api/orders/${o.anna.id}`)).status, 403);
      assert.equal((await b.dora.post('/api/support', { message: 'x', orderId: o.anna.id })).status, 404);
      assert.equal((await b.dora.get('/api/support')).status, 403);
      assert.equal((await b.dora.post('/api/admin/queue', { orderId: o.anna.id })).status, 403);
      assert.equal((await b.anna.patch(`/api/orders/${o.anna.id}`, { name: 'Umbenannt' })).status, 403, 'Eigentümer darf nur Sichtbarkeit ändern');
      assert.equal(server.state.orders.find((x) => x.id === o.anna.id).isPublic, false);
    });

    await t.test('Admin ohne Admin-Passwort sieht wie ein normaler Benutzer', async () => {
      const admin2 = new Browser(server);
      await login(server, admin2, ADMIN_EMAIL);
      const res = await admin2.get('/api/live');
      assert.equal(res.json.isAdmin, false);
      assert.deepEqual(res.json.queue.entries.map((e) => e.kind), ['private_queue_slot', 'private_queue_slot', 'private_queue_slot', 'public_model']);
      assertNoLeak(res.json, privateMarkers(o.benQueued, users.ben, server), 'Admin ohne Passwort');
    });

    await t.test('Unangemeldet: keine Daten', async () => {
      const anon = new Browser(server);
      for (const endpoint of ['/api/live', '/api/queue', '/api/current-print', '/api/orders']) {
        const res = await anon.get(endpoint);
        assert.equal(res.status, 401);
        assert.deepEqual(Object.keys(res.json).sort(), ['error', 'message']);
      }
    });
  } finally {
    await server.stop();
  }
});
