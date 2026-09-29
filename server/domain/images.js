'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomToken } = require('../util/crypto');
const { HttpError } = require('../util/http');

const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;
const MAX_URL_LENGTH = 2048;
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const DATA_URL_PATTERN = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/;

const MAGIC = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Normalisiert die Bildangabe eines Formulars:
 *  '' / null → kein Bild; data:-URL → Datei (serverseitig gespeichert); http(s)-URL → externe URL.
 */
function parseImageInput(value) {
  if (value === null || value === '' || value === undefined) return { kind: 'none' };
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_image', 'Ungültiges Bild');
  const match = DATA_URL_PATTERN.exec(value);
  if (match) {
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new HttpError(400, 'invalid_image', 'Bild zu groß (max. 2,5 MB)');
    if (!MAGIC[match[1]](buffer)) throw new HttpError(400, 'invalid_image', 'Bilddatei ist beschädigt');
    return { kind: 'data', mime: match[1], buffer };
  }
  if (value.length <= MAX_URL_LENGTH && isHttpUrl(value)) return { kind: 'url', url: value };
  throw new HttpError(400, 'invalid_image', 'Bild muss eine Datei oder eine http(s)-URL sein');
}

function imagesDir(dataDir) {
  return path.join(dataDir, 'images');
}

/** Speichert ein Bild unter einem zufälligen Schlüssel (nicht aus der Auftrags-ID ableitbar). */
function saveImageFile(dataDir, { mime, buffer }) {
  const dir = imagesDir(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = randomToken(18);
  fs.writeFileSync(path.join(dir, key), buffer, { mode: 0o600, flag: 'wx' });
  return { kind: 'file', key, mime };
}

function readImageFile(dataDir, key) {
  if (!KEY_PATTERN.test(String(key))) return null;
  try {
    return fs.readFileSync(path.join(imagesDir(dataDir), key));
  } catch {
    return null;
  }
}

function deleteImageFile(dataDir, image) {
  if (!image || image.kind !== 'file' || !KEY_PATTERN.test(String(image.key))) return;
  try {
    fs.unlinkSync(path.join(imagesDir(dataDir), image.key));
  } catch {
    /* bereits entfernt */
  }
}

module.exports = { parseImageInput, saveImageFile, readImageFile, deleteImageFile, isHttpUrl, KEY_PATTERN };
