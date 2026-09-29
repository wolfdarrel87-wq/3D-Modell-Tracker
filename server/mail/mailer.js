'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Mail-Ausgang. In diesem Build gibt es ausschließlich den lokalen Dev-Postausgang
 * (<DATA_DIR>/outbox/*.json) – es wird keine echte E-Mail versendet. Mit
 * MAIL_PRODUCTION_ENABLED=true startet der Server gar nicht erst (siehe config.js).
 */
function createOutboxMailer({ dataDir, clock }) {
  const dir = path.join(dataDir, 'outbox');
  let sequence = 0;

  async function send({ to, subject, text, kind }) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const createdAt = clock.now();
    sequence += 1;
    const name = `${String(createdAt).padStart(15, '0')}-${String(sequence).padStart(6, '0')}-${crypto.randomBytes(4).toString('hex')}.json`;
    const mail = { to, subject, text, kind, createdAt };
    fs.writeFileSync(path.join(dir, name), JSON.stringify(mail, null, 2), { mode: 0o600 });
    return mail;
  }

  function list() {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return [];
    }
    return files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  }

  return { send, list, transport: 'outbox' };
}

module.exports = { createOutboxMailer };
