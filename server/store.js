'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    users: [],
    sessions: [],
    devices: [],
    otps: [],
    orders: [],
    support: [],
    queue: [],
    printer: { currentOrderId: null, startedAt: null, progress: 0, remainingMinutes: null, updatedAt: null },
    counters: { dp: {} },
  };
}

function normalizeState(raw) {
  const base = emptyState();
  const state = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) };
  for (const key of ['users', 'sessions', 'devices', 'otps', 'orders', 'support', 'queue']) {
    if (!Array.isArray(state[key])) state[key] = [];
  }
  state.printer = { ...base.printer, ...(state.printer || {}) };
  state.counters = { ...base.counters, ...(state.counters || {}) };
  if (!state.counters.dp || typeof state.counters.dp !== 'object') state.counters.dp = {};
  return state;
}

function readStateFile(file) {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    throw new Error(`Datendatei ${file} konnte nicht gelesen werden: ${err.message}`);
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * JSON-Datenspeicher mit Copy-on-Write-Transaktionen.
 *
 * transaction(fn) arbeitet auf einer Kopie des Zustands, schreibt sie atomar (tmp + fsync + rename)
 * und übernimmt sie erst danach. Wirft fn oder scheitert das Schreiben, bleibt der alte Zustand
 * vollständig erhalten. Transaktionen sind synchron – in einem Node-Prozess laufen sie damit
 * strikt nacheinander (keine Race Conditions, z. B. beim DP-Zähler). Die Lock-Datei verhindert,
 * dass ein zweiter Prozess dasselbe Datenverzeichnis beschreibt.
 */
class Store {
  constructor({ dataDir, fileName = 'druckplatte.json', lock = true }) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, fileName);
    this.lockFile = path.join(dataDir, 'store.lock');
    this.useLock = lock;
    this._state = null;
    this._inTransaction = false;
    this._lockHeld = false;
    this.revision = 0;
  }

  open() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    if (this.useLock) this._acquireLock();
    this._state = readStateFile(this.file);
    return this;
  }

  close() {
    if (this._lockHeld) {
      try {
        fs.unlinkSync(this.lockFile);
      } catch {
        /* bereits entfernt */
      }
      this._lockHeld = false;
    }
  }

  /** Aktueller Zustand – nur lesen, niemals direkt verändern. */
  get state() {
    return this._state;
  }

  transaction(fn) {
    if (this._inTransaction) throw new Error('Verschachtelte Transaktionen sind nicht erlaubt');
    const draft = structuredClone(this._state);
    this._inTransaction = true;
    try {
      const result = fn(draft);
      if (result && typeof result.then === 'function') {
        throw new Error('Transaktionen müssen synchron sein');
      }
      this._persist(draft);
      this._state = draft;
      this.revision += 1;
      return result;
    } finally {
      this._inTransaction = false;
    }
  }

  _persist(state) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(state));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }

  _acquireLock() {
    try {
      fs.writeFileSync(this.lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
      this._lockHeld = true;
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const pid = Number(fs.readFileSync(this.lockFile, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) {
      throw new Error(`Datenverzeichnis ${this.dataDir} wird bereits von Prozess ${pid} verwendet (store.lock).`);
    }
    // Verwaiste Lock-Datei eines beendeten Prozesses übernehmen.
    fs.writeFileSync(this.lockFile, String(process.pid), { mode: 0o600 });
    this._lockHeld = true;
  }
}

module.exports = { Store, emptyState, normalizeState, readStateFile, SCHEMA_VERSION };
