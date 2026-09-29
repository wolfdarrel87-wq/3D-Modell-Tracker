'use strict';

const { berlinYear } = require('../util/time');

const DP_REF_PATTERN = /^DP-(\d{4})-(\d{6})$/;

function formatDpRef(year, number) {
  if (!Number.isInteger(number) || number < 1 || number > 999999) {
    throw new Error(`DP-Nummernkreis für ${year} erschöpft`);
  }
  return `DP-${year}-${String(number).padStart(6, '0')}`;
}

function parseDpRef(ref) {
  const match = DP_REF_PATTERN.exec(String(ref || ''));
  return match ? { year: Number(match[1]), number: Number(match[2]) } : null;
}

function highestIssued(orders, year) {
  let max = 0;
  for (const order of orders) {
    const parsed = parseDpRef(order.dpRef);
    if (parsed && parsed.year === year && parsed.number > max) max = parsed.number;
  }
  return max;
}

/**
 * Vergibt die nächste DP-Auftragsnummer aus dem EINEN gemeinsamen Zähler (normale Aufträge
 * und Ideen). Muss innerhalb einer Store-Transaktion aufgerufen werden – dann ist die Vergabe
 * zusammen mit dem Speichern des Auftrags atomar. Der Zähler kann nie hinter bereits
 * vergebene Nummern zurückfallen (max aus Zähler und Bestand).
 */
function allocateDpRef(draft, timestamp) {
  const year = berlinYear(timestamp);
  if (!draft.counters.dp || typeof draft.counters.dp !== 'object') draft.counters.dp = {};
  const counter = Number(draft.counters.dp[year]) || 0;
  const next = Math.max(counter, highestIssued(draft.orders, year)) + 1;
  const ref = formatDpRef(year, next);
  if (draft.orders.some((o) => o.dpRef === ref)) throw new Error(`DP-Nummer ${ref} bereits vergeben`);
  draft.counters.dp[year] = next;
  return ref;
}

function compareForMigration(a, b) {
  const aHas = Number.isFinite(a.createdAt);
  const bHas = Number.isFinite(b.createdAt);
  if (aHas !== bHas) return aHas ? -1 : 1;
  if (aHas && a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * READ-ONLY: ermittelt, welche Ideen noch keine DP-Nummer haben und welche Nummer sie
 * bekommen würden. Reihenfolge: Erstellungszeitpunkt, bei Gleichstand die stabile ID.
 */
function planIdeaMigration(state, now) {
  const ideas = state.orders.filter((o) => o.type === 'idea');
  const withDp = ideas.filter((o) => parseDpRef(o.dpRef));
  const invalidDp = ideas.filter((o) => o.dpRef && !parseDpRef(o.dpRef));
  const withoutDp = ideas.filter((o) => !o.dpRef).sort(compareForMigration);

  const simulation = {
    orders: state.orders.map((o) => ({ dpRef: o.dpRef })),
    counters: { dp: { ...(state.counters && state.counters.dp) } },
  };
  const assignments = withoutDp.map((order) => {
    const basis = Number.isFinite(order.createdAt) ? order.createdAt : now;
    const dpRef = allocateDpRef(simulation, basis);
    simulation.orders.push({ dpRef });
    return { id: order.id, name: order.name, createdAt: Number.isFinite(order.createdAt) ? order.createdAt : null, dpRef };
  });

  const years = new Set();
  for (const order of state.orders) {
    const parsed = parseDpRef(order.dpRef);
    if (parsed) years.add(parsed.year);
  }
  for (const year of Object.keys((state.counters && state.counters.dp) || {})) years.add(Number(year));
  const highestPerYear = {};
  for (const year of [...years].sort()) highestPerYear[year] = highestIssued(state.orders, year);

  return {
    totalIdeas: ideas.length,
    withDp: withDp.length,
    withoutDp: withoutDp.length,
    invalidDp: invalidDp.map((o) => ({ id: o.id, dpRef: o.dpRef })),
    highestPerYear,
    counterState: { ...((state.counters && state.counters.dp) || {}) },
    assignments,
  };
}

/**
 * Vergibt fehlende DP-Nummern an Ideen – deterministisch, idempotent, ohne andere Felder
 * anzufassen. Muss in einer Store-Transaktion laufen.
 */
function applyIdeaMigration(draft, now) {
  const plan = planIdeaMigration(draft, now);
  for (const assignment of plan.assignments) {
    const order = draft.orders.find((o) => o.id === assignment.id);
    if (!order || order.dpRef) continue;
    const dpRef = allocateDpRef(draft, Number.isFinite(order.createdAt) ? order.createdAt : now);
    if (dpRef !== assignment.dpRef) throw new Error('Migration nicht deterministisch – abgebrochen');
    order.dpRef = dpRef;
  }
  return plan;
}

module.exports = { DP_REF_PATTERN, formatDpRef, parseDpRef, highestIssued, allocateDpRef, planIdeaMigration, applyIdeaMigration };
