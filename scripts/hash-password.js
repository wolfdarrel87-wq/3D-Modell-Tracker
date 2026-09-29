#!/usr/bin/env node
'use strict';

// Erzeugt einen scrypt-Hash für ADMIN_PASSWORD_HASH. Das Passwort wird über stdin gelesen,
// damit es nicht in der Shell-Historie landet:  printf '%s' 'geheim' | npm run hash-password

const { hashPassword } = require('../server/util/crypto');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', async () => {
  const password = input.replace(/\r?\n$/, '');
  if (password.length < 10) {
    console.error('Passwort zu kurz (mindestens 10 Zeichen).');
    process.exit(1);
  }
  console.log(await hashPassword(password));
});
