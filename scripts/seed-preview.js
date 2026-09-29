#!/usr/bin/env node
'use strict';

/**
 * Erzeugt einen isolierten Preview-Datenbestand (nur Testdaten, keine echten Personen).
 * Enthält bewusst zwei Alt-Ideen OHNE DP-Nummer, damit der Migrations-Dry-Run etwas findet.
 *
 *   node scripts/seed-preview.js --data-dir data/preview [--reset]
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Store } = require('../server/store');
const { allocateDpRef } = require('../server/domain/dpRefs');
const { saveImageFile } = require('../server/domain/images');
const { DAY_MS, HOUR_MS, MINUTE_MS } = require('../server/util/time');

const USERS = {
  admin: 'admin@druckplatte.test',
  anna: 'anna@example.test',
  ben: 'ben@example.test',
  clara: 'clara@example.test',
  dora: 'dora@example.test',
};

const COLOR_RGB = {
  Weiß: [242, 241, 237], Schwarz: [60, 58, 66], Grau: [139, 139, 147], Rot: [228, 87, 61], Blau: [62, 124, 224],
  Grün: [76, 175, 125], Gelb: [242, 199, 68], Orange: [242, 136, 75], Transparent: [201, 203, 206],
  Silber: [184, 188, 194], Gold: [212, 175, 87], Sonstige: [124, 156, 255],
};

/** Kleines PNG ohne Abhängigkeiten: beleuchtete Kugel in Filamentfarbe auf dunklem Verlauf. */
function renderPng(colorName, width = 240, height = 180) {
  const [r, g, b] = COLOR_RGB[colorName] || COLOR_RGB.Sonstige;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const cx = width / 2;
  const cy = height / 2 + 6;
  const radius = Math.min(width, height) * 0.34;
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const i = row + 1 + x * 3;
      const bg = 34 + Math.round((y / height) * 14);
      let pr = bg;
      let pg = bg - 2;
      let pb = bg + 6;
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const shadow = Math.sqrt(dx * dx + ((y - (cy + radius * 0.9)) * 3) ** 2);
      if (shadow < radius * 0.9 && d >= radius) {
        const s = 0.75;
        pr *= s;
        pg *= s;
        pb *= s;
      }
      if (d < radius) {
        const lx = x - (cx - radius * 0.35);
        const ly = y - (cy - radius * 0.4);
        const light = Math.max(0, 1 - Math.sqrt(lx * lx + ly * ly) / (radius * 1.6));
        const shade = 0.55 + 0.45 * light;
        const hi = light > 0.82 ? (light - 0.82) * 3 : 0;
        pr = Math.min(255, r * shade + 255 * hi);
        pg = Math.min(255, g * shade + 255 * hi);
        pb = Math.min(255, b * shade + 255 * hi);
      }
      raw[i] = pr;
      raw[i + 1] = pg;
      raw[i + 2] = pb;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function seedPreview({ dataDir, now = Date.now(), withLegacyIdeas = true }) {
  const store = new Store({ dataDir }).open();
  try {
    if (store.state.users.length || store.state.orders.length) throw new Error(`${dataDir} ist nicht leer – mit --reset neu anlegen`);
    const ids = {};
    store.transaction((draft) => {
      let t = now - 30 * DAY_MS;
      for (const [key, email] of Object.entries(USERS)) {
        ids[key] = `usr_preview_${key}`;
        draft.users.push({ id: ids[key], email, status: 'active', createdAt: t });
        t += HOUR_MS;
      }

      const orders = {};
      let clock = now - 21 * DAY_MS;
      const add = (key, owner, fields) => {
        clock += 17 * HOUR_MS;
        const image = fields.withImage === false ? null : saveImageFile(dataDir, { mime: 'image/png', buffer: renderPng(fields.color) });
        const order = {
          id: `ord_preview_${key}`,
          dpRef: null,
          type: fields.type || 'model',
          ownerId: ids[owner],
          name: fields.name,
          link: fields.link || '',
          color: fields.color,
          filament: fields.filament,
          note: fields.note || '',
          image,
          isPublic: fields.isPublic === true,
          status: fields.status === undefined ? 'progress' : fields.status,
          accepted: fields.accepted !== false,
          createdAt: clock,
          updatedAt: clock,
        };
        if (!fields.legacyWithoutDp) order.dpRef = allocateDpRef(draft, clock);
        draft.orders.push(order);
        orders[key] = order;
        return order;
      };

      add('annaHalter', 'anna', { name: 'Handyhalterung Schreibtisch', link: 'https://makerworld.com/de/models/100001', color: 'Grau', filament: 'PETG', status: 'ready', note: 'Bitte mit 20 % Infill' });
      add('benDuese', 'ben', { name: 'Ersatzteil Staubsauger-Düse', link: 'https://makerworld.com/de/models/100002', color: 'Schwarz', filament: 'PETG', note: 'Privat – Maße 32 mm' });
      add('doraVase', 'dora', { name: 'Spiral-Vase', link: 'https://makerworld.com/de/models/100003', color: 'Blau', filament: 'PLA', status: 'ready' });
      add('benGeschenk', 'ben', { name: 'Geburtstagsgeschenk (geheim)', link: 'https://makerworld.com/de/models/100004', color: 'Gold', filament: 'PLA+', note: 'Nicht verraten!' });
      add('claraGehaeuse', 'clara', { name: 'Prototyp Gehäuse v3', link: 'https://makerworld.com/de/models/100005', color: 'Orange', filament: 'ASA', note: 'Interne Maße vertraulich' });
      add('claraBenchy', 'clara', { name: 'Benchy – Kalibrierboot', link: 'https://makerworld.com/de/models/100006', color: 'Weiß', filament: 'PLA', isPublic: true });
      add('annaClips', 'anna', { name: 'Kabelclip-Set', link: 'https://makerworld.com/de/models/100007', color: 'Grün', filament: 'TPU', status: 'fail', note: 'TPU zu weich – neu planen' });
      add('doraUntersetzer', 'dora', { name: 'Untersetzer Hexagon', link: 'https://makerworld.com/de/models/100008', color: 'Transparent', filament: 'PETG', status: 'ready' });
      if (withLegacyIdeas) {
        add('legacyBen', 'ben', { type: 'idea', name: 'Schlüsselbrett Flur', color: 'Rot', filament: 'PLA', status: null, accepted: false, legacyWithoutDp: true, withImage: false, note: 'Alt-Idee aus Druckplatte 3.0' });
        add('legacyDora', 'dora', { type: 'idea', name: 'Deko-Mond Lampe', color: 'Gelb', filament: 'PLA', status: 'progress', accepted: true, legacyWithoutDp: true, note: 'Alt-Idee aus Druckplatte 3.0' });
      }
      add('annaPercival', 'anna', { type: 'idea', name: "Percival's Head", color: 'Schwarz', filament: 'PLA', note: 'Büste für das Regal', status: 'progress', accepted: true });
      add('annaKopfhoerer', 'anna', { type: 'idea', name: 'Wandhalter für Kopfhörer', color: 'Silber', filament: 'PETG', status: null, accepted: false, note: 'Gibt es so nicht auf MakerWorld' });

      draft.queue = [orders.benGeschenk.id, orders.claraGehaeuse.id, orders.annaPercival.id, orders.claraBenchy.id];
      draft.printer = { currentOrderId: orders.benDuese.id, startedAt: now - 78 * MINUTE_MS, progress: 42, remainingMinutes: 95, updatedAt: now };
      draft.support.push({
        id: 'sup_preview_1',
        userId: ids.anna,
        orderId: orders.annaClips.id,
        orderName: orders.annaClips.name,
        dpRef: orders.annaClips.dpRef,
        message: 'Kann der Kabelclip in PETG statt TPU gedruckt werden?',
        createdAt: now - 3 * HOUR_MS,
      });
    });
    return { users: USERS };
  } finally {
    store.close();
  }
}

function main() {
  const args = process.argv.slice(2);
  const dirIndex = args.indexOf('--data-dir');
  const dataDir = path.resolve(dirIndex >= 0 ? args[dirIndex + 1] : path.join(__dirname, '..', 'data', 'preview'));
  if (!/preview|test|tmp/i.test(dataDir) && !args.includes('--force')) {
    throw new Error(`Sicherheitsstopp: ${dataDir} sieht nicht nach einem Preview-Verzeichnis aus.`);
  }
  if (args.includes('--reset')) fs.rmSync(dataDir, { recursive: true, force: true });
  seedPreview({ dataDir });
  console.log(`Preview-Daten angelegt in ${dataDir}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`Fehler: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { seedPreview, renderPng, USERS };
