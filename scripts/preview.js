#!/usr/bin/env node
'use strict';

/**
 * Startet eine isolierte Druckplatte-Preview:
 *   - eigenes Datenverzeichnis (data/preview), getrennt von jeder Produktion
 *   - MAIL_PRODUCTION_ENABLED=false → Codes/Mails nur im Dev-Postausgang (/dev/outbox)
 *   - keine Druckersteuerung (dieser Build enthält keine)
 *
 *   npm run preview              → startet (legt Testdaten an, falls leer)
 *   npm run preview -- --reset   → Testdaten neu anlegen, Migrations-Dry-Run + Preview-Migration
 */

const fs = require('node:fs');
const path = require('node:path');
const { hashPassword } = require('../server/util/crypto');
const { seedPreview } = require('./seed-preview');

const PREVIEW_ADMIN_PASSWORD = 'preview-admin-2026';

async function main() {
  const args = process.argv.slice(2);
  const port = process.env.PORT || '8080';
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data', 'preview'));
  if (!/preview/i.test(dataDir)) throw new Error('Die Preview darf nur ein Verzeichnis mit „preview“ im Pfad verwenden.');

  if (args.includes('--reset')) fs.rmSync(dataDir, { recursive: true, force: true });
  const fresh = !fs.existsSync(path.join(dataDir, 'druckplatte.json'));
  if (fresh) {
    seedPreview({ dataDir });
    console.log(`[preview] Testdaten angelegt: ${dataDir}`);
    console.log('[preview] Migrations-Dry-Run für Alt-Ideen ohne DP-Nummer:');
    const { execFileSync } = require('node:child_process');
    const migrate = path.join(__dirname, 'migrate-idea-dp.js');
    console.log(execFileSync(process.execPath, [migrate, '--data-dir', dataDir], { encoding: 'utf8' }));
    if (!args.includes('--no-migrate')) {
      console.log(execFileSync(process.execPath, [migrate, '--data-dir', dataDir, '--apply'], { encoding: 'utf8' }));
    }
  }

  Object.assign(process.env, {
    DRUCKPLATTE_ENV: 'preview',
    DATA_DIR: dataDir,
    HOST: process.env.HOST || '127.0.0.1',
    PORT: port,
    PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || `http://localhost:${port}`,
    MAIL_PRODUCTION_ENABLED: 'false',
    ADMIN_EMAILS: 'admin@druckplatte.test',
    ADMIN_PASSWORD_HASH: await hashPassword(PREVIEW_ADMIN_PASSWORD),
  });
  console.log(`[preview] Öffne http://localhost:${port} · Codes: http://localhost:${port}/dev/outbox`);
  console.log(`[preview] Testkonten: anna@, ben@, clara@, dora@example.test · Admin: admin@druckplatte.test (Admin-Passwort der Preview: ${PREVIEW_ADMIN_PASSWORD})`);
  require('../server/index.js');
}

main().catch((err) => {
  console.error(`Fehler: ${err.message}`);
  process.exit(1);
});
