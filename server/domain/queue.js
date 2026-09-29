'use strict';

const { HttpError } = require('../util/http');
const { findOrder } = require('./orders');

// Reine Anzeige-/Planungsdaten. Dieser Code sendet NIE Befehle oder Dateien an einen Drucker.

function idlePrinter() {
  return { currentOrderId: null, startedAt: null, progress: 0, remainingMinutes: null, updatedAt: null };
}

function enqueue(draft, orderId) {
  const order = findOrder(draft, orderId);
  if (!order.accepted) throw new HttpError(409, 'not_accepted', 'Offene Ideen können nicht eingereiht werden');
  if (draft.queue.includes(orderId)) throw new HttpError(409, 'already_queued', 'Auftrag ist bereits in der Warteschlange');
  if (draft.printer.currentOrderId === orderId) throw new HttpError(409, 'is_current', 'Auftrag ist der aktuelle Druck');
  draft.queue.push(orderId);
}

function dequeue(draft, orderId) {
  if (!draft.queue.includes(orderId)) throw new HttpError(404, 'not_queued', 'Auftrag ist nicht in der Warteschlange');
  draft.queue = draft.queue.filter((id) => id !== orderId);
}

function move(draft, orderId, direction) {
  const index = draft.queue.indexOf(orderId);
  if (index < 0) throw new HttpError(404, 'not_queued', 'Auftrag ist nicht in der Warteschlange');
  const target = direction === 'up' ? index - 1 : direction === 'down' ? index + 1 : -1;
  if (direction !== 'up' && direction !== 'down') throw new HttpError(400, 'invalid_input', 'Richtung ist ungültig');
  if (target < 0 || target >= draft.queue.length) return;
  [draft.queue[index], draft.queue[target]] = [draft.queue[target], draft.queue[index]];
}

function setCurrent(draft, orderId, now) {
  const order = findOrder(draft, orderId);
  if (!order.accepted) throw new HttpError(409, 'not_accepted', 'Offene Ideen können nicht gedruckt werden');
  draft.queue = draft.queue.filter((id) => id !== orderId);
  draft.printer = { currentOrderId: orderId, startedAt: now, progress: 0, remainingMinutes: null, updatedAt: now };
  const previousStatus = order.status;
  if (order.status !== 'progress') {
    order.status = 'progress';
    order.updatedAt = now;
  }
  return { order, previousStatus };
}

function setProgress(draft, { progress, remainingMinutes }, now) {
  if (!draft.printer.currentOrderId) throw new HttpError(409, 'idle', 'Es läuft kein Druck');
  const p = Number(progress);
  if (!Number.isFinite(p) || p < 0 || p > 100) throw new HttpError(400, 'invalid_input', 'Fortschritt muss zwischen 0 und 100 liegen');
  let remaining = null;
  if (remainingMinutes !== null && remainingMinutes !== undefined && remainingMinutes !== '') {
    remaining = Number(remainingMinutes);
    if (!Number.isFinite(remaining) || remaining < 0 || remaining > 60 * 24 * 14) throw new HttpError(400, 'invalid_input', 'Restzeit ist ungültig');
    remaining = Math.round(remaining);
  }
  draft.printer.progress = Math.round(p);
  draft.printer.remainingMinutes = remaining;
  draft.printer.updatedAt = now;
}

function finishCurrent(draft, now) {
  const orderId = draft.printer.currentOrderId;
  if (!orderId) throw new HttpError(409, 'idle', 'Es läuft kein Druck');
  const order = draft.orders.find((o) => o.id === orderId);
  draft.printer = idlePrinter();
  if (!order) return null;
  const previousStatus = order.status;
  order.status = 'ready';
  order.updatedAt = now;
  return { order, previousStatus };
}

function clearCurrent(draft) {
  draft.printer = idlePrinter();
}

module.exports = { enqueue, dequeue, move, setCurrent, setProgress, finishCurrent, clearCurrent, idlePrinter };
