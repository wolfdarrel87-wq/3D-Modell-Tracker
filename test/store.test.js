'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { tempDir } = require('./helpers');
const { Store } = require('../server/store');

test('Transaktion: Fehler im Callback → nichts gespeichert, Zustand unverändert', () => {
  const store = new Store({ dataDir: tempDir() }).open();
  try {
    store.transaction((d) => d.orders.push({ id: 'a' }));
    assert.throws(() =>
      store.transaction((d) => {
        d.orders.push({ id: 'b' });
        throw new Error('Abbruch');
      }),
    );
    assert.deepEqual(store.state.orders.map((o) => o.id), ['a']);
    const onDisk = JSON.parse(fs.readFileSync(path.join(store.dataDir, 'druckplatte.json'), 'utf8'));
    assert.deepEqual(onDisk.orders.map((o) => o.id), ['a']);
  } finally {
    store.close();
  }
});

test('Transaktion: Schreibfehler → Rollback im Speicher', () => {
  const store = new Store({ dataDir: tempDir() }).open();
  try {
    store._persist = () => {
      throw new Error('EIO');
    };
    assert.throws(() => store.transaction((d) => d.orders.push({ id: 'x' })), /EIO/);
    assert.equal(store.state.orders.length, 0);
  } finally {
    store.close();
  }
});

test('Transaktion: asynchrone Callbacks und Verschachtelung werden abgelehnt', () => {
  const store = new Store({ dataDir: tempDir() }).open();
  try {
    assert.throws(() => store.transaction(async () => {}), /synchron/);
    assert.throws(() => store.transaction(() => store.transaction(() => {})), /Verschachtelte/);
    assert.equal(store.revision, 0);
  } finally {
    store.close();
  }
});

test('Lock-Datei: zweiter Prozess/Instanz auf demselben Datenverzeichnis wird abgewiesen', () => {
  const dataDir = tempDir();
  const first = new Store({ dataDir }).open();
  assert.throws(() => new Store({ dataDir }).open(), /store\.lock/);
  first.close();
  const second = new Store({ dataDir }).open();
  second.close();

  // verwaiste Lock-Datei eines beendeten Prozesses wird übernommen
  fs.writeFileSync(path.join(dataDir, 'store.lock'), '999999999');
  const third = new Store({ dataDir }).open();
  third.close();
});

test('Dateirechte: Datendatei nur für den Besitzer lesbar', () => {
  const store = new Store({ dataDir: tempDir() }).open();
  try {
    store.transaction((d) => d.orders.push({ id: 'a' }));
    const mode = fs.statSync(path.join(store.dataDir, 'druckplatte.json')).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    store.close();
  }
});
