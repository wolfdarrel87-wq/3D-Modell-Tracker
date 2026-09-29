#!/usr/bin/env node
'use strict';

/**
 * Vergibt fehlende DP-Auftragsnummern an bestehende Ideen.
 *
 *   node scripts/migrate-idea-dp.js --data-dir data/preview            → Dry-Run (READ-ONLY, Standard)
 *   node scripts/migrate-idea-dp.js --data-dir data/preview --apply    → Preview-Migration
 *
 * Deterministisch (Erstellungszeitpunkt, dann stabile ID), idempotent (bereits nummerierte
 * Ideen bleiben unverändert), nutzt den gemeinsamen DP-Zähler, legt vor dem Schreiben ein
 * Backup an. In Produktion (DRUCKPLATTE_ENV=production) verweigert --apply ohne
 * ausdrückliches --allow-production.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Store, readStateFile } = require('../server/store');
const { planIdeaMigration, applyIdeaMigration, formatDpRef } = require('../server/domain/dpRefs');

function parseArgs(argv) {
  const args = { apply: false, json: false, allowProduction: false, dataDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--allow-production') args.allowProduction = true;
    else if (arg === '--data-dir') args.dataDir = argv[++i];
    else throw new Error(`Unbekanntes Argument: ${arg}`);
  }
  if (!args.dataDir) throw new Error('--data-dir ist erforderlich');
  return args;
}

function formatTime(ts) {
  return ts === null ? 'unbekannt (Jahr der Migration wird verwendet)' : new Date(ts).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
}

function report(plan, { applied }) {
  const lines = [];
  lines.push(applied ? '=== Migration angewendet ===' : '=== DRY RUN (keine Änderungen) ===');
  lines.push(`Ideen insgesamt: ${plan.totalIdeas}`);
  lines.push(`Mit DP: ${plan.withDp}`);
  lines.push(`Ohne DP: ${plan.withoutDp}`);
  if (plan.invalidDp.length) lines.push(`Ungültige DP-Werte (werden NICHT verändert): ${plan.invalidDp.map((x) => `${x.id}=${x.dpRef}`).join(', ')}`);
  const years = Object.keys(plan.highestPerYear);
  lines.push(`Höchste DP-Nummer pro Jahr: ${years.length ? years.map((y) => `${y} → ${plan.highestPerYear[y] ? formatDpRef(Number(y), plan.highestPerYear[y]) : '—'}`).join(', ') : '—'}`);
  const counterYears = Object.keys(plan.counterState);
  lines.push(`Zählerstand: ${counterYears.length ? counterYears.map((y) => `${y} → ${plan.counterState[y]}`).join(', ') : '—'}`);
  for (const a of plan.assignments) {
    lines.push('');
    lines.push(`Datensatz ${a.id} „${a.name}“`);
    lines.push(`  Erstellt: ${formatTime(a.createdAt)}`);
    lines.push(`  ${applied ? 'erhielt' : 'würde erhalten'}: ${a.dpRef}`);
  }
  if (!plan.assignments.length) lines.push('\nAlle Ideen haben bereits eine DP-Auftragsnummer – nichts zu tun.');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = path.resolve(args.dataDir);
  const file = path.join(dataDir, 'druckplatte.json');
  if (!fs.existsSync(file)) throw new Error(`Keine Datendatei gefunden: ${file}`);
  const now = Date.now();

  if (!args.apply) {
    // READ-ONLY: Datei nur lesen, keine Lock-Datei, kein Schreiben.
    const plan = planIdeaMigration(readStateFile(file), now);
    console.log(args.json ? JSON.stringify(plan, null, 2) : report(plan, { applied: false }));
    return;
  }

  if (process.env.DRUCKPLATTE_ENV === 'production' && !args.allowProduction) {
    throw new Error('Produktionsmigration verweigert. Erst nach ausdrücklicher Freigabe mit --allow-production ausführen.');
  }

  const store = new Store({ dataDir }).open(); // Lock: bricht ab, wenn der Server läuft
  try {
    const backup = `${file}.bak-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    const plan = store.transaction((draft) => applyIdeaMigration(draft, now));
    const after = planIdeaMigration(store.state, now);
    console.log(args.json ? JSON.stringify({ ...plan, after: { withDp: after.withDp, withoutDp: after.withoutDp } }, null, 2) : report(plan, { applied: true }));
    if (!args.json) console.log(`\nNach der Migration: ${after.withDp} von ${after.totalIdeas} Ideen mit DP-Nummer, ${after.withoutDp} ohne.`);
    console.log(`\nBackup: ${backup}`);
  } finally {
    store.close();
  }
}

try {
  main();
} catch (err) {
  console.error(`Fehler: ${err.message}`);
  process.exit(1);
}
