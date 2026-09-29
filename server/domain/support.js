'use strict';

const { randomId } = require('../util/crypto');
const { HttpError } = require('../util/http');

function createSupportMessage(draft, { viewer, body, now }) {
  if (typeof body.message !== 'string' || !body.message.trim()) {
    throw new HttpError(400, 'invalid_input', 'Bitte eine Nachricht eingeben');
  }
  const message = body.message.trim();
  if (message.length > 2000) throw new HttpError(400, 'invalid_input', 'Nachricht ist zu lang (max. 2000 Zeichen)');

  let order = null;
  if (body.orderId) {
    order = draft.orders.find((o) => o.id === body.orderId);
    // Normale Benutzer können nur eigene Aufträge referenzieren.
    if (!order || (!viewer.isAdmin && order.ownerId !== viewer.userId)) {
      throw new HttpError(404, 'not_found', 'Auftrag nicht gefunden');
    }
  }

  const entry = {
    id: randomId('sup'),
    userId: viewer.userId,
    orderId: order ? order.id : null,
    orderName: order ? order.name : null,
    dpRef: order ? order.dpRef : null,
    message,
    createdAt: now,
  };
  draft.support.push(entry);
  return entry;
}

function adminSupportList(state) {
  const usersById = new Map(state.users.map((u) => [u.id, u]));
  return [...state.support]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((s) => ({
      id: s.id,
      userEmail: s.userId && usersById.has(s.userId) ? usersById.get(s.userId).email : null,
      orderId: s.orderId,
      orderName: s.orderName,
      dpRef: s.dpRef,
      orderExists: Boolean(s.orderId && state.orders.some((o) => o.id === s.orderId)),
      message: s.message,
      createdAt: s.createdAt,
    }));
}

function resolveSupportMessage(draft, supportId) {
  const entry = draft.support.find((s) => s.id === supportId);
  if (!entry) throw new HttpError(404, 'not_found', 'Nachricht nicht gefunden');
  draft.support = draft.support.filter((s) => s.id !== supportId);
  return entry;
}

module.exports = { createSupportMessage, adminSupportList, resolveSupportMessage };
