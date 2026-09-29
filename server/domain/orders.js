'use strict';

const { randomId } = require('../util/crypto');
const { HttpError } = require('../util/http');
const { allocateDpRef } = require('./dpRefs');
const { isHttpUrl } = require('./images');

const COLORS = ['Weiß', 'Schwarz', 'Grau', 'Rot', 'Blau', 'Grün', 'Gelb', 'Orange', 'Transparent', 'Silber', 'Gold', 'Sonstige'];
const FILAMENTS = ['PLA', 'PETG', 'ABS', 'TPU', 'ASA', 'Nylon', 'PLA+', 'Resin', 'Sonstige'];
const STATUSES = ['ready', 'progress', 'fail'];
const TYPES = ['model', 'idea'];
const STATUS_LABELS = { ready: 'Fertigstellung', progress: 'In Bearbeitung', fail: 'Geht nicht' };

function isMakerWorldUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    return /(^|\.)makerworld\.com(\.cn)?$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function bad(message) {
  return new HttpError(400, 'invalid_input', message);
}

function text(value, { field, max, required }) {
  if (value === undefined || value === null) {
    if (required) throw bad(`${field} fehlt`);
    return '';
  }
  if (typeof value !== 'string') throw bad(`${field} ist ungültig`);
  const trimmed = value.trim();
  if (required && !trimmed) throw bad(`${field} fehlt`);
  if (trimmed.length > max) throw bad(`${field} ist zu lang (max. ${max} Zeichen)`);
  return trimmed;
}

/**
 * Validiert Formulardaten serverseitig. `partial` = Bearbeiten (nur übergebene Felder).
 * isPublic ist nur bei exakt true öffentlich – alles andere bleibt privat.
 */
function validateOrderFields(body, { partial = false, type: fixedType } = {}) {
  const out = {};
  const type = fixedType || (body.type === undefined ? 'model' : body.type);
  if (!TYPES.includes(type)) throw bad('Typ ist ungültig');
  if (!partial) out.type = type;

  if (!partial || body.name !== undefined) out.name = text(body.name, { field: 'Name', max: 120, required: true });
  if (!partial || body.link !== undefined) {
    const link = text(body.link, { field: 'Link', max: 2048 });
    if (type === 'model' && !isMakerWorldUrl(link)) throw bad('Bitte einen gültigen MakerWorld-Link angeben');
    if (type === 'idea' && link && !isHttpUrl(link)) throw bad('Referenz-Link muss mit http(s):// beginnen');
    out.link = link;
  }
  if (!partial || body.color !== undefined) {
    const color = body.color === undefined ? COLORS[0] : body.color;
    if (!COLORS.includes(color)) throw bad('Farbe ist ungültig');
    out.color = color;
  }
  if (!partial || body.filament !== undefined) {
    const filament = body.filament === undefined ? FILAMENTS[0] : body.filament;
    if (!FILAMENTS.includes(filament)) throw bad('Filament ist ungültig');
    out.filament = filament;
  }
  if (!partial || body.note !== undefined) out.note = text(body.note, { field: 'Notiz', max: 2000 });
  if (!partial || body.isPublic !== undefined) out.isPublic = body.isPublic === true;
  if (body.status !== undefined && body.status !== null) {
    if (!STATUSES.includes(body.status)) throw bad('Status ist ungültig');
    out.status = body.status;
  }
  return out;
}

/**
 * Legt einen Auftrag an und vergibt IN DERSELBEN Transaktion die DP-Auftragsnummer –
 * für normale Aufträge und Ideen gleichermaßen.
 */
function createOrder(draft, { viewer, fields, image, now }) {
  const pendingIdea = fields.type === 'idea' && !viewer.isAdmin;
  const order = {
    id: randomId('ord'),
    dpRef: null,
    type: fields.type,
    ownerId: viewer.userId,
    name: fields.name,
    link: fields.link,
    color: fields.color,
    filament: fields.filament,
    note: fields.note,
    image: image || null,
    isPublic: fields.isPublic === true,
    status: pendingIdea ? null : (viewer.isAdmin && fields.status) || 'progress',
    accepted: !pendingIdea,
    createdAt: now,
    updatedAt: now,
  };
  order.dpRef = allocateDpRef(draft, now);
  draft.orders.push(order);
  return order;
}

function findOrder(draft, orderId) {
  const order = draft.orders.find((o) => o.id === orderId);
  if (!order) throw new HttpError(404, 'not_found', 'Auftrag nicht gefunden');
  return order;
}

/** Admin: alle Felder außer Typ/DP-Nummer. Eigentümer: nur „öffentlich anzeigen“. Fremde: 404. */
function updateOrder(draft, { orderId, viewer, body, image, now }) {
  const order = draft.orders.find((o) => o.id === orderId);
  const isOwner = order && order.ownerId && order.ownerId === viewer.userId;
  if (!order || (!viewer.isAdmin && !isOwner)) throw new HttpError(404, 'not_found', 'Auftrag nicht gefunden');

  const previousStatus = order.status;
  let replacedImage = null;
  if (viewer.isAdmin) {
    const fields = validateOrderFields(body, { partial: true, type: order.type });
    Object.assign(order, fields);
    if (fields.status && !order.accepted) order.accepted = true;
    if (image !== undefined) {
      replacedImage = order.image;
      order.image = image;
    }
  } else {
    const keys = Object.keys(body);
    if (keys.some((k) => k !== 'isPublic')) throw new HttpError(403, 'forbidden', 'Nur die Sichtbarkeit kann geändert werden');
    order.isPublic = body.isPublic === true;
  }
  order.updatedAt = now;
  return { order, previousStatus, replacedImage };
}

function removeOrderReferences(draft, orderId) {
  draft.queue = draft.queue.filter((id) => id !== orderId);
  if (draft.printer.currentOrderId === orderId) {
    draft.printer = { currentOrderId: null, startedAt: null, progress: 0, remainingMinutes: null, updatedAt: null };
  }
}

function deleteOrder(draft, orderId) {
  const order = findOrder(draft, orderId);
  draft.orders = draft.orders.filter((o) => o.id !== orderId);
  removeOrderReferences(draft, orderId);
  return order;
}

function acceptIdea(draft, orderId, now) {
  const order = findOrder(draft, orderId);
  if (order.type !== 'idea' || order.accepted) throw new HttpError(409, 'not_pending', 'Idee ist nicht mehr offen');
  order.accepted = true;
  order.status = 'progress';
  order.updatedAt = now;
  return order;
}

function rejectIdea(draft, orderId) {
  const order = findOrder(draft, orderId);
  if (order.type !== 'idea' || order.accepted) throw new HttpError(409, 'not_pending', 'Idee ist nicht mehr offen');
  return deleteOrder(draft, orderId);
}

module.exports = {
  COLORS,
  FILAMENTS,
  STATUSES,
  STATUS_LABELS,
  isMakerWorldUrl,
  validateOrderFields,
  createOrder,
  updateOrder,
  deleteOrder,
  acceptIdea,
  rejectIdea,
  findOrder,
  removeOrderReferences,
};
