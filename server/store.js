'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
  /**
   * @param lockOwnerId   Prozess-ID im Lock (Standard: eigene PID; in Tests überschreibbar)
   * @param isOwnerAlive  Prüft, ob der Besitzer eines Locks noch lebt (Standard: process.kill(pid, 0))
   * @param onStaleLock   Test-Hook: wird aufgerufen, nachdem ein verwaister Lock erkannt wurde
   */
  constructor({ dataDir, fileName = 'druckplatte.json', lock = true, lockOwnerId = process.pid, isOwnerAlive = processAlive, onStaleLock = null }) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, fileName);
    this.lockFile = path.join(dataDir, 'store.lock');
    this.recoverFile = path.join(dataDir, 'store.lock.recover');
    this.useLock = lock;
    this.isOwnerAlive = isOwnerAlive;
    this.onStaleLock = onStaleLock;
    // Eindeutiger Inhalt je Store-Instanz: PID + Zufall – so ist jeder Lock von jedem anderen unterscheidbar.
    this._lockToken = `${lockOwnerId}:${crypto.randomBytes(8).toString('hex')}`;
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
      // Nur den eigenen Lock entfernen – niemals einen fremden.
      if (this._readLock(this.lockFile) === this._lockToken) {
        try {
          fs.unlinkSync(this.lockFile);
        } catch {
          /* bereits entfernt */
        }
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

  _tryCreate(file) {
    try {
      fs.writeFileSync(file, this._lockToken, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      throw err;
    }
  }

  _readLock(file) {
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  _ownerOf(content) {
    const pid = Number(String(content).split(':')[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  /**
   * Lock-Erwerb ausschließlich über atomares Anlegen (flag 'wx'). Ein verwaister Lock wird nur
   * unter einem zweiten atomaren Wiederherstellungs-Lock (store.lock.recover) entfernt, und nur,
   * wenn er dort noch unverändert derselbe verwaiste Lock ist. Danach wird wieder atomar mit 'wx'
   * angelegt. Ergebnis: Auch wenn mehrere Prozesse gleichzeitig denselben verwaisten Lock sehen,
   * bekommt höchstens einer den Lock – die anderen brechen mit klarer Fehlermeldung ab.
   */
  _acquireLock() {
    if (this._tryCreate(this.lockFile)) {
      this._lockHeld = true;
      return;
    }
    const seen = this._readLock(this.lockFile);
    if (seen === null) {
      // Lock verschwand gerade – genau ein weiterer atomarer Versuch, sonst abbrechen.
      if (this._tryCreate(this.lockFile)) {
        this._lockHeld = true;
        return;
      }
      throw new Error(`Datenverzeichnis ${this.dataDir} wurde gerade von einem anderen Prozess gesperrt (store.lock).`);
    }
    const owner = this._ownerOf(seen);
    if (owner !== null && this.isOwnerAlive(owner)) {
      throw new Error(`Datenverzeichnis ${this.dataDir} wird bereits von Prozess ${owner} verwendet (store.lock).`);
    }
    if (this.onStaleLock) this.onStaleLock();
    this._recoverStaleLock(seen);
  }

  _recoverStaleLock(seen) {
    if (!this._tryCreate(this.recoverFile)) {
      throw new Error(
        `Ein anderer Prozess übernimmt gerade den verwaisten Lock in ${this.dataDir} (store.lock.recover). ` +
          'Bitte erneut starten. Bleibt die Datei nach einem Absturz liegen, manuell prüfen und entfernen.',
      );
    }
    try {
      const current = this._readLock(this.lockFile);
      if (current !== null && current !== seen) {
        throw new Error(`Datenverzeichnis ${this.dataDir} wurde inzwischen von einem anderen Prozess gesperrt (store.lock).`);
      }
      // Solange der verwaiste Lock existiert, kann niemand sonst per 'wx' einen Lock anlegen,
      // und die Wiederherstellung gehört exklusiv uns – er ist also noch genau der gesehene Lock.
      if (current !== null) fs.unlinkSync(this.lockFile);
      if (!this._tryCreate(this.lockFile)) {
        throw new Error(`Datenverzeichnis ${this.dataDir} wurde gerade von einem anderen Prozess gesperrt (store.lock).`);
      }
      this._lockHeld = true;
    } finally {
      if (this._readLock(this.recoverFile) === this._lockToken) fs.unlinkSync(this.recoverFile);
    }
  }
}

module.exports = { Store, emptyState, normalizeState, readStateFile, SCHEMA_VERSION };
