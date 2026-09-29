'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { ADMIN_EMAIL, START, DAY, fakeClock, tempDir, startServer, Browser, login, elevate, createOrder } = require('./helpers');
const { Store, emptyState } = require('../server/store');
const { allocateDpRef, planIdeaMigration, applyIdeaMigration, parseDpRef } = require('../server/domain/dpRefs');

const DP_FORMAT = /^DP-\d{4}-\d{6}$/;
const MIGRATE = path.join(__dirname, '..', 'scripts', 'migrate-idea-dp.js');

async function withServer(fn, opts) {
  const server = await startServer(opts);
  try {
    await fn(server);
  } finally {
    await server.stop();
  }
}

function numberOf(ref) {
  return parseDpRef(ref).number;
}

test('J/K/L/M: normale Aufträge und Ideen bekommen DP-YYYY-XXXXXX aus demselben Zähler', () =>
  withServer(async (server) => {
    const anna = new Browser(server);
    await login(server, anna, 'anna@example.test');
    const order = await createOrder(anna, { name: 'Normaler Auftrag', link: 'https://makerworld.com/de/models/1' });
    const idea = await createOrder(anna, { type: 'idea', name: "Percival's Head", link: '', color: 'Schwarz', filament: 'PLA' });
    const order2 = await createOrder(anna, { name: 'Noch ein Auftrag', link: 'https://makerworld.com/de/models/2' });

    for (const ref of [order.dpRef, idea.dpRef, order2.dpRef]) {
      assert.match(ref, DP_FORMAT); // L
      assert.ok(!/^IDEA-|^IDEE-/i.test(ref)); // M
    }
    assert.deepEqual([order.dpRef, idea.dpRef, order2.dpRef], ['DP-2026-000001', 'DP-2026-000002', 'DP-2026-000003']);
    assert.equal(idea.type, 'idea'); // „Idee“ bleibt nur Typ/Badge
    assert.equal(idea.accepted, false);
    assert.deepEqual(server.state.counters.dp, { 2026: 3 });
  }));

test('Jahreswechsel: Jahr der DP-Nummer folgt der deutschen Zeit', () =>
  withServer(
    async (server) => {
      const anna = new Browser(server);
      await login(server, anna, 'anna@example.test');
      const late = await createOrder(anna, { name: 'Silvester', link: 'https://makerworld.com/de/models/3' });
      assert.equal(late.dpRef, 'DP-2026-000001');
      server.clock.set(Date.UTC(2026, 11, 31, 23, 30)); // 01.01.2027 00:30 in Berlin
      const early = await createOrder(anna, { type: 'idea', name: 'Neujahr', link: '' });
      assert.equal(early.dpRef, 'DP-2027-000001');
    },
    { clock: fakeClock(Date.UTC(2026, 11, 31, 22, 30)) },
  ));

test('N/O: gleichzeitige Ideen und Aufträge → eindeutige, lückenlose Nummern', () =>
  withServer(async (server) => {
    const users = [];
    for (let i = 0; i < 4; i += 1) {
      const browser = new Browser(server);
      await login(server, browser, `nutzer${i}@example.test`);
      users.push(browser);
    }
    const submissions = [];
    for (let i = 0; i < 40; i += 1) {
      const browser = users[i % users.length];
      const idea = i % 2 === 0;
      submissions.push(
        browser.post('/api/orders', idea
          ? { type: 'idea', name: `Idee ${i}`, link: '', color: 'Weiß', filament: 'PLA' }
          : { type: 'model', name: `Auftrag ${i}`, link: `https://makerworld.com/de/models/${i}`, color: 'Weiß', filament: 'PLA' }),
      );
    }
    const results = await Promise.all(submissions);
    assert.ok(results.every((r) => r.status === 200));
    const refs = results.map((r) => r.json.order.dpRef);
    assert.equal(new Set(refs).size, 40, 'keine doppelten Nummern');
    assert.deepEqual(refs.map(numberOf).sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i + 1));
    const ideaRefs = results.filter((r) => r.json.order.type === 'idea').map((r) => r.json.order.dpRef);
    assert.equal(new Set(ideaRefs).size, 20);
    assert.equal(server.state.counters.dp[2026], 40);
  }));

test('P: fehlgeschlagene Einreichung → kein Auftrag, keine verbrauchte Nummer', () =>
  withServer(async (server) => {
    const anna = new Browser(server);
    await login(server, anna, 'anna@example.test');
    await createOrder(anna, { name: 'Erster', link: 'https://makerworld.com/de/models/1' });

    const invalid = await anna.post('/api/orders', { type: 'model', name: 'Ohne MakerWorld', link: 'https://example.com/x', color: 'Weiß', filament: 'PLA' });
    assert.equal(invalid.status, 400);
    const badColor = await anna.post('/api/orders', { type: 'idea', name: 'Falsche Farbe', link: '', color: 'Lila', filament: 'PLA' });
    assert.equal(badColor.status, 400);
    const noName = await anna.post('/api/orders', { type: 'idea', name: '   ', link: '', color: 'Weiß', filament: 'PLA' });
    assert.equal(noName.status, 400);
    assert.equal(server.state.orders.length, 1);
    assert.equal(server.state.counters.dp[2026], 1);

    // Speicherfehler mitten in der Transaktion → Rollback, Zähler unverändert
    const store = server.app.store;
    const original = store._persist.bind(store);
    store._persist = () => {
      throw new Error('Datenträger voll (simuliert)');
    };
    const failed = await anna.post('/api/orders', { type: 'idea', name: 'Scheitert', link: '', color: 'Weiß', filament: 'PLA', image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' });
    store._persist = original;
    assert.equal(failed.status, 500);
    assert.equal(server.state.orders.length, 1);
    assert.equal(server.state.counters.dp[2026], 1);
    const imagesDir = path.join(server.dataDir, 'images');
    assert.equal(fs.existsSync(imagesDir) ? fs.readdirSync(imagesDir).length : 0, 0, 'verwaistes Bild wird entfernt');

    const next = await createOrder(anna, { type: 'idea', name: 'Klappt', link: '' });
    assert.equal(next.dpRef, 'DP-2026-000002', 'keine Lücke durch den Fehlschlag');
  }));

test('T/U/V: Idea-DP sichtbar für Eigentümer und Admin, nie für Fremde (auch öffentlich)', () =>
  withServer(async (server) => {
    const anna = new Browser(server);
    await login(server, anna, 'anna@example.test');
    const dora = new Browser(server);
    await login(server, dora, 'dora@example.test');
    const admin = new Browser(server);
    await login(server, admin, ADMIN_EMAIL);
    await elevate(admin);

    const idea = await createOrder(anna, { type: 'idea', name: 'Annas Idee', link: '', isPublic: true });
    assert.match(idea.dpRef, DP_FORMAT);

    // T: Eigentümer
    const own = await anna.get('/api/orders');
    assert.equal(own.json.orders[0].dpRef, idea.dpRef);

    // V: Admin (Ideen-Eingang)
    const adminView = await admin.get('/api/orders');
    assert.equal(adminView.json.orders.find((o) => o.name === 'Annas Idee').dpRef, idea.dpRef);

    // U: offene Idee ist für Fremde unsichtbar
    assert.ok(!(await dora.get('/api/live')).text.includes(idea.dpRef));

    // angenommen, öffentlich und in der Warteschlange → Allowlist, aber OHNE DP-Nummer
    await admin.post(`/api/orders/${idea.id}/accept`);
    await admin.post('/api/admin/queue', { orderId: idea.id });
    const foreign = await dora.get('/api/live');
    assert.ok(foreign.text.includes('Annas Idee'), 'öffentliche Allowlist sichtbar');
    assert.ok(!foreign.text.includes(idea.dpRef), 'DP-Nummer bleibt privat');
    assert.ok(!foreign.text.includes(idea.id));
  }));

function legacyState() {
  const state = emptyState();
  const base = { ownerId: 'usr_x', link: '', color: 'Weiß', filament: 'PLA', note: '', image: null, isPublic: false, status: null, accepted: false };
  state.users.push({ id: 'usr_x', email: 'x@example.test', status: 'active', createdAt: START });
  state.orders.push(
    { ...base, id: 'ord_model_1', type: 'model', name: 'Auftrag', dpRef: 'DP-2026-000007', createdAt: START - 20 * DAY, status: 'ready', accepted: true },
    { ...base, id: 'ord_idea_with', type: 'idea', name: 'Idee mit DP', dpRef: 'DP-2026-000008', createdAt: START - 10 * DAY },
    { ...base, id: 'ord_idea_b', type: 'idea', name: 'Idee B (gleiche Zeit, ID später)', dpRef: null, createdAt: START - 5 * DAY },
    { ...base, id: 'ord_idea_a', type: 'idea', name: 'Idee A (gleiche Zeit, ID früher)', dpRef: null, createdAt: START - 5 * DAY },
    { ...base, id: 'ord_idea_early', type: 'idea', name: 'Frühe Idee', createdAt: START - 8 * DAY, accepted: true, status: 'progress' },
    { ...base, id: 'ord_idea_2025', type: 'idea', name: 'Idee aus 2025', dpRef: null, createdAt: Date.UTC(2025, 5, 1) },
  );
  state.counters.dp = { 2026: 6 }; // absichtlich hinter dem Bestand (self-healing)
  return state;
}

test('Q/R/S: Migration bestehender Ideen – Dry-Run, deterministisch, idempotent', () => {
  const state = legacyState();
  const before = structuredClone(state);

  const plan = planIdeaMigration(state, START);
  assert.deepEqual(state, before, 'Dry-Run verändert nichts');
  assert.equal(plan.totalIdeas, 5);
  assert.equal(plan.withDp, 1);
  assert.equal(plan.withoutDp, 4);
  assert.deepEqual(plan.highestPerYear, { 2026: 8 });
  assert.deepEqual(plan.counterState, { 2026: 6 });
  assert.deepEqual(
    plan.assignments.map((a) => [a.id, a.dpRef]),
    [
      ['ord_idea_2025', 'DP-2025-000001'],
      ['ord_idea_early', 'DP-2026-000009'],
      ['ord_idea_a', 'DP-2026-000010'],
      ['ord_idea_b', 'DP-2026-000011'],
    ],
  );

  const draft = structuredClone(state);
  applyIdeaMigration(draft, START);
  for (const order of draft.orders) {
    const original = before.orders.find((o) => o.id === order.id);
    const { dpRef, ...rest } = order;
    const { dpRef: originalRef, ...originalRest } = original;
    assert.deepEqual(rest, originalRest, `${order.id}: keine anderen Felder verändert`);
    if (originalRef) assert.equal(dpRef, originalRef, `${order.id}: bestehende DP-Nummer bleibt (Q)`);
  }
  assert.equal(draft.orders.length, before.orders.length, 'keine Datensätze kopiert');
  assert.deepEqual(draft.counters.dp, { 2025: 1, 2026: 11 });

  // S: erneut ausführen → nichts zu tun
  const again = structuredClone(draft);
  const plan2 = applyIdeaMigration(again, START);
  assert.equal(plan2.assignments.length, 0);
  assert.deepEqual(again, draft);

  // Nach der Migration nutzt eine neue Einreichung denselben Zähler weiter
  assert.equal(allocateDpRef(again, START), 'DP-2026-000012');
});

test('Migrationsskript: Dry-Run ist READ-ONLY, --apply mit Backup und Lock', async () => {
  const dataDir = tempDir();
  const file = path.join(dataDir, 'druckplatte.json');
  fs.writeFileSync(file, JSON.stringify(legacyState()));
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const originalHash = hash();

  const dry = execFileSync(process.execPath, [MIGRATE, '--data-dir', dataDir], { encoding: 'utf8' });
  assert.match(dry, /DRY RUN/);
  assert.match(dry, /Ideen insgesamt: 5/);
  assert.match(dry, /Mit DP: 1/);
  assert.match(dry, /Ohne DP: 4/);
  assert.match(dry, /würde erhalten: DP-2026-000009/);
  assert.equal(hash(), originalHash, 'Dry-Run schreibt nicht');
  assert.ok(!fs.existsSync(path.join(dataDir, 'store.lock')));

  // Läuft ein Server auf dem Verzeichnis, verweigert --apply (Lock)
  const store = new Store({ dataDir }).open();
  assert.throws(() => execFileSync(process.execPath, [MIGRATE, '--data-dir', dataDir, '--apply'], { stdio: 'pipe' }));
  store.close();

  // Produktion ohne ausdrückliche Freigabe → verweigert
  assert.throws(() =>
    execFileSync(process.execPath, [MIGRATE, '--data-dir', dataDir, '--apply'], { stdio: 'pipe', env: { ...process.env, DRUCKPLATTE_ENV: 'production' } }),
  );
  assert.equal(hash(), originalHash);

  const applied = execFileSync(process.execPath, [MIGRATE, '--data-dir', dataDir, '--apply'], { encoding: 'utf8' });
  assert.match(applied, /Migration angewendet/);
  const migrated = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(migrated.orders.filter((o) => o.type === 'idea').every((o) => DP_FORMAT.test(o.dpRef)));
  const backups = fs.readdirSync(dataDir).filter((f) => f.startsWith('druckplatte.json.bak-'));
  assert.equal(backups.length, 1);

  const rerun = execFileSync(process.execPath, [MIGRATE, '--data-dir', dataDir], { encoding: 'utf8' });
  assert.match(rerun, /Ohne DP: 0/);
  assert.match(rerun, /nichts zu tun/);
});

test('Zähler heilt sich selbst und vergibt nie eine vorhandene Nummer', () => {
  const draft = emptyState();
  draft.orders.push({ id: 'a', dpRef: 'DP-2026-000041' });
  draft.counters.dp = { 2026: 3 };
  assert.equal(allocateDpRef(draft, START), 'DP-2026-000042');
  assert.equal(draft.counters.dp[2026], 42);
});

test('Server übernimmt Zählerstand nach Neustart', async () => {
  const dataDir = tempDir();
  const clock = fakeClock();
  let server = await startServer({ dataDir, clock });
  const anna = new Browser(server);
  await login(server, anna, 'anna@example.test');
  await createOrder(anna, { type: 'idea', name: 'Vorher', link: '' });
  await server.stop();
  server = await startServer({ dataDir, clock });
  anna.server = server;
  const after = await createOrder(anna, { type: 'idea', name: 'Nachher', link: '' });
  assert.equal(after.dpRef, 'DP-2026-000002');
  await server.stop();
});
