'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
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

function ipv4Parts(ip) {
  return ip.split('.').map(Number);
}

/** Loopback, private Netze, Link-Local (inkl. Metadaten-IP 169.254.169.254), CGNAT, Multicast, reserviert. */
function isPrivateOrLocalIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) {
    const [a, b] = ipv4Parts(ip);
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateOrLocalIp(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(lower)) return true; // IPv4-mapped in Hex-Form
    const first = parseInt(lower.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00;
  }
  return false;
}

/** Hosts, die nie als Bildquelle erlaubt sind: IP-Literale, localhost und interne Namen. */
function blockedHostReason(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return 'leer';
  if (net.isIP(host)) return isPrivateOrLocalIp(host) ? 'lokales oder privates Netz' : 'IP-Adresse statt Hostname';
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa|intranet|corp)$/.test(host)) return 'lokales oder privates Netz';
  if (!host.includes('.')) return 'interner Hostname';
  return null;
}

/**
 * Prüft eine externe Bild-URL. Standard (leere Allowlist): externe URLs sind nicht erlaubt,
 * Bilder kommen nur als Upload über /api/images. Mit IMAGE_HOST_ALLOWLIST sind ausschließlich
 * https-URLs auf exakt diesen Hostnamen erlaubt – nie lokale/private Ziele.
 */
function checkImageUrl(value, allowlist = []) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: 'Bild muss eine hochgeladene Datei sein' };
  }
  if (url.protocol !== 'https:') return { ok: false, message: 'Externe Bilder nur über https' };
  if (url.username || url.password) return { ok: false, message: 'Bild-URL darf keine Zugangsdaten enthalten' };
  const blocked = blockedHostReason(url.hostname);
  if (blocked) return { ok: false, message: `Bild-URL nicht erlaubt (${blocked})` };
  if (url.port) return { ok: false, message: 'Bild-URL darf keinen eigenen Port verwenden' };
  if (!allowlist.length) return { ok: false, message: 'Externe Bild-URLs sind nicht erlaubt – bitte das Bild hochladen' };
  if (!allowlist.includes(url.hostname.toLowerCase())) return { ok: false, message: 'Diese Bildquelle ist nicht freigegeben – bitte das Bild hochladen' };
  return { ok: true, url: url.href };
}

function isAllowedImageUrl(value, allowlist = []) {
  return typeof value === 'string' && value.length <= MAX_URL_LENGTH && checkImageUrl(value, allowlist).ok;
}

/**
 * Normalisiert die Bildangabe eines Formulars:
 *  '' / null → kein Bild; data:-URL → Datei (serverseitig gespeichert); https-URL → nur mit Allowlist.
 */
function parseImageInput(value, { allowlist = [] } = {}) {
  if (value === null || value === '' || value === undefined) return { kind: 'none' };
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_image', 'Ungültiges Bild');
  const match = DATA_URL_PATTERN.exec(value);
  if (match) {
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new HttpError(400, 'invalid_image', 'Bild zu groß (max. 2,5 MB)');
    if (!MAGIC[match[1]](buffer)) throw new HttpError(400, 'invalid_image', 'Bilddatei ist beschädigt');
    return { kind: 'data', mime: match[1], buffer };
  }
  if (value.length > MAX_URL_LENGTH) throw new HttpError(400, 'invalid_image', 'Bild-URL ist zu lang');
  const check = checkImageUrl(value, allowlist);
  if (!check.ok) throw new HttpError(400, 'invalid_image', check.message);
  return { kind: 'url', url: check.url };
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

module.exports = { parseImageInput, saveImageFile, readImageFile, deleteImageFile, isHttpUrl, checkImageUrl, isAllowedImageUrl, isPrivateOrLocalIp, blockedHostReason, KEY_PATTERN };
