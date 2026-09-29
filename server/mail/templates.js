'use strict';

const { STATUS_LABELS } = require('../domain/orders');

// Mail-Links enthalten nur normale Zielpfade – niemals Geräte-/Session-Tokens oder Codes.
// Die Wiedererkennung erfolgt über das bereits gespeicherte vertrauenswürdige Gerät.

const FOOTER = '\n\n–\nDruckplatte · Diese Nachricht wurde automatisch erstellt.';

function orderLink(baseUrl, order) {
  return `${baseUrl}/auftrag/${encodeURIComponent(order.dpRef)}`;
}

function loginCodeMail(code) {
  return {
    kind: 'login_code',
    subject: 'Dein Druckplatte-Anmeldecode',
    text:
      `Dein Anmeldecode lautet: ${code}\n\n` +
      'Er ist 10 Minuten gültig. Nach der Anmeldung bleibt dieses Gerät 30 Tage lang vertrauenswürdig.\n' +
      'Wenn du keinen Code angefordert hast, kannst du diese Nachricht ignorieren.' +
      FOOTER,
  };
}

function statusMail(baseUrl, order) {
  const finished = order.status === 'ready';
  return {
    kind: finished ? 'order_finished' : 'order_status',
    subject: finished ? `Druckplatte: ${order.dpRef} ist fertig` : `Druckplatte: Neuer Status für ${order.dpRef}`,
    text:
      `Dein Auftrag ${order.dpRef} („${order.name}“) hat einen neuen Status: ${STATUS_LABELS[order.status] || order.status}.\n\n` +
      `Auftrag ansehen: ${orderLink(baseUrl, order)}` +
      FOOTER,
  };
}

function ideaAcceptedMail(baseUrl, order) {
  return {
    kind: 'idea_accepted',
    subject: `Druckplatte: Deine Idee ${order.dpRef} wurde angenommen`,
    text: `Deine Idee „${order.name}“ (${order.dpRef}) wurde angenommen und ist jetzt in Bearbeitung.\n\nAuftrag ansehen: ${orderLink(baseUrl, order)}` + FOOTER,
  };
}

function supportResolvedMail(baseUrl, entry) {
  return {
    kind: 'support_resolved',
    subject: 'Druckplatte: Deine Support-Anfrage wurde bearbeitet',
    text:
      `Deine Support-Nachricht${entry.dpRef ? ` zu ${entry.dpRef}` : ''} wurde vom Admin bearbeitet.\n\n` +
      `Druckplatte öffnen: ${baseUrl}/support` +
      FOOTER,
  };
}

module.exports = { loginCodeMail, statusMail, ideaAcceptedMail, supportResolvedMail };
