'use strict';

/**
 * Serverseitige Datenschutz-Projektionen.
 *
 * Für jeden Auftrag wird relativ zum authentifizierten Betrachter entschieden:
 *   admin           → vollständige Admin-Ansicht (nur mit bestätigtem Admin-Passwort)
 *   own             → eigene erlaubte Daten inkl. DP-Auftragsnummer
 *   foreign_public  → AUSSCHLIESSLICH die Public-Allowlist (ohne DP-Nummer, IDs, Besitzer, Notiz)
 *   foreign_private → anonymisierte Minimalantwort
 *
 * Fremde private Daten werden gar nicht erst in die Antwort geschrieben – der Browser
 * erhält sie nie (kein Ausblenden per CSS/DOM).
 */

const { isHttpUrl, isAllowedImageUrl } = require('./images');
const { isMakerWorldUrl } = require('./orders');

/** Public-Allowlist – exakt diese Felder dürfen fremde Benutzer bei öffentlichen Modellen sehen. */
const PUBLIC_MODEL_FIELDS = Object.freeze(['kind', 'name', 'color', 'filament', 'link', 'imageUrl']);

/**
 * Erzeugt die Projektionen für eine Bild-Richtlinie (`imageHostAllowlist`, Standard: keine
 * externen Bilder). Alle Funktionen sind rein: gleicher Zustand + Betrachter → gleiche Antwort.
 */
function createPrivacy({ imageHostAllowlist = [] } = {}) {
  /** Standard ist PRIVAT. Öffentlich nur bei exakt `true` und angenommenem Auftrag. */
  function isExplicitlyPublic(order) {
    return Boolean(order) && order.isPublic === true && order.accepted === true;
  }

  function relation(order, viewer) {
    if (viewer && viewer.isAdmin) return 'admin';
    if (viewer && order.ownerId && order.ownerId === viewer.userId) return 'own';
    if (isExplicitlyPublic(order)) return 'foreign_public';
    return 'foreign_private';
  }

  // Externe Bild-URLs werden bei JEDER Ausgabe erneut gegen die aktuelle Richtlinie geprüft –
  // auch Altdaten mit beliebigen Hosts erreichen so keinen Browser mehr.
  function imageUrlFor(order) {
    const image = order.image;
    if (!image) return null;
    if (image.kind === 'file') return `/api/images/${image.key}`;
    if (image.kind === 'url' && isAllowedImageUrl(image.url, imageHostAllowlist)) return image.url;
    return null;
  }

  function safeLink(link) {
    return link && isHttpUrl(link) ? link : null;
  }

  /** In der öffentlichen Ansicht nur MakerWorld-Links – keine beliebigen Websites. */
  function publicLink(link) {
    return link && isMakerWorldUrl(link) ? link : null;
  }


  function toPublicModel(order) {
    return {
      kind: 'public_model',
      name: order.name,
      color: order.color,
      filament: order.filament,
      link: publicLink(order.link),
      imageUrl: imageUrlFor(order),
    };
  }

  function toOwnOrder(order) {
    return {
      kind: 'own',
      id: order.id,
      dpRef: order.dpRef || null,
      type: order.type,
      name: order.name,
      link: safeLink(order.link),
      color: order.color,
      filament: order.filament,
      note: order.note || '',
      imageUrl: imageUrlFor(order),
      isPublic: order.isPublic === true,
      status: order.status,
      accepted: order.accepted === true,
      createdAt: order.createdAt,
    };
  }

  function toAdminOrder(order, usersById) {
    const owner = order.ownerId ? usersById.get(order.ownerId) : null;
    return {
      ...toOwnOrder(order),
      kind: 'admin',
      ownerId: order.ownerId || null,
      ownerEmail: owner ? owner.email : null,
      updatedAt: order.updatedAt,
    };
  }

  function usersIndex(state) {
    return new Map(state.users.map((u) => [u.id, u]));
  }

  function byNewest(a, b) {
    return (b.createdAt || 0) - (a.createdAt || 0);
  }

  function clampProgress(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
  }

  /** Allgemeiner Fortschritt für Fremde: auf 10-%-Schritte abgerundet. */
  function progressBucket(value) {
    return Math.floor(clampProgress(value) / 10) * 10;
  }

  /** Ungefähre Restzeit für Fremde: auf 15 Minuten aufgerundet. */
  function approxMinutes(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return null;
    if (value <= 0) return 0;
    return Math.ceil(value / 15) * 15;
  }

  function remainingNow(printer, now) {
    if (printer.remainingMinutes === null || printer.remainingMinutes === undefined) return null;
    const elapsed = printer.updatedAt ? (now - printer.updatedAt) / 60000 : 0;
    return Math.max(0, Math.round(printer.remainingMinutes - elapsed));
  }

  function buildCurrentPrintView(state, viewer, now) {
    const printer = state.printer || {};
    const order = printer.currentOrderId ? state.orders.find((o) => o.id === printer.currentOrderId) : null;
    if (!order) return { kind: 'idle' };

    const remaining = remainingNow(printer, now);
    switch (relation(order, viewer)) {
      case 'admin':
      case 'own': {
        const isAdmin = viewer && viewer.isAdmin;
        return {
          kind: isAdmin ? 'admin' : 'own',
          state: 'printing',
          order: isAdmin ? toAdminOrder(order, usersIndex(state)) : toOwnOrder(order),
          progress: clampProgress(printer.progress),
          startedAt: printer.startedAt,
          remainingMinutes: remaining,
          etaAt: remaining === null ? null : now + remaining * 60000,
        };
      }
      case 'foreign_public':
        return {
          kind: 'foreign_public',
          state: 'printing',
          model: toPublicModel(order),
          progressBucket: progressBucket(printer.progress),
          remainingApproxMinutes: approxMinutes(remaining),
        };
      default:
        return {
          kind: 'foreign_private',
          state: 'printing',
          progressBucket: progressBucket(printer.progress),
          remainingApproxMinutes: approxMinutes(remaining),
        };
    }
  }

  function buildQueueView(state, viewer) {
    const ordersById = new Map(state.orders.map((o) => [o.id, o]));
    const usersById = usersIndex(state);
    const ids = state.queue.filter((id) => ordersById.has(id));

    const entries = ids.map((id, index) => {
      const order = ordersById.get(id);
      const position = index + 1;
      switch (relation(order, viewer)) {
        case 'admin':
          return { kind: 'admin', position, order: toAdminOrder(order, usersById) };
        case 'own':
          return { kind: 'own', position, order: toOwnOrder(order) };
        case 'foreign_public':
          return { kind: 'public_model', position, model: toPublicModel(order) };
        default:
          return { kind: 'private_queue_slot', position };
      }
    });

    const ownPositions = entries.filter((e) => e.kind === 'own').map((e) => e.position);
    const mine = ownPositions.length ? { positions: ownPositions, position: ownPositions[0], aheadCount: ownPositions[0] - 1 } : null;
    return { total: entries.length, entries, mine };
  }

  /**
   * „Öffentliche Modelle“: ALLE ausdrücklich öffentlichen Modelle – auch die eigenen –,
   * aber immer nur als Public-Allowlist. Die volle eigene Ansicht steht separat in `orders`.
   */
  function publicModelsOf(state) {
    return state.orders.filter(isExplicitlyPublic).sort(byNewest).map(toPublicModel);
  }

  function buildOrdersView(state, viewer) {
    if (viewer.isAdmin) {
      const usersById = usersIndex(state);
      return { orders: [...state.orders].sort(byNewest).map((o) => toAdminOrder(o, usersById)), publicModels: publicModelsOf(state) };
    }
    const own = state.orders.filter((o) => o.ownerId && o.ownerId === viewer.userId).sort(byNewest).map(toOwnOrder);
    return { orders: own, publicModels: publicModelsOf(state) };
  }

  function buildLiveView(state, viewer, now) {
    return {
      serverTime: now,
      isAdmin: Boolean(viewer.isAdmin),
      currentPrint: buildCurrentPrintView(state, viewer, now),
      queue: buildQueueView(state, viewer),
      ...buildOrdersView(state, viewer),
    };
  }

  /** Antwort nach einer Änderung – immer über dieselben Projektionen. */
  function orderForViewer(state, order, viewer) {
    switch (relation(order, viewer)) {
      case 'admin':
        return toAdminOrder(order, usersIndex(state));
      case 'own':
        return toOwnOrder(order);
      case 'foreign_public':
        return toPublicModel(order);
      default:
        return null;
    }
  }

  /** Bildzugriff spiegelt exakt dieselben Regeln wie die Projektionen. */
  function canViewImage(order, viewer) {
    return relation(order, viewer) !== 'foreign_private';
  }

  return {
    isExplicitlyPublic,
    relation,
    toPublicModel,
    toOwnOrder,
    toAdminOrder,
    progressBucket,
    approxMinutes,
    buildCurrentPrintView,
    buildQueueView,
    buildOrdersView,
    buildLiveView,
    orderForViewer,
    canViewImage,
  };
}

module.exports = { PUBLIC_MODEL_FIELDS, createPrivacy, ...createPrivacy() };
