'use strict';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// DP-Auftragsnummern tragen das Jahr der Einreichung in deutscher Zeit.
const berlinYearFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', year: 'numeric' });

function berlinYear(ts) {
  return Number(berlinYearFormat.format(new Date(ts)));
}

const systemClock = { now: () => Date.now() };

module.exports = { MINUTE_MS, HOUR_MS, DAY_MS, berlinYear, systemClock };
