'use strict';

/** Einfaches In-Memory-Fensterlimit (pro Prozess, nicht persistent). */
class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
  }

  /** Zählt einen Versuch; liefert false, wenn das Limit erreicht ist. */
  hit(key, now) {
    const since = now - this.windowMs;
    const list = (this.hits.get(key) || []).filter((t) => t > since);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }

  prune(now) {
    const since = now - this.windowMs;
    for (const [key, list] of this.hits) {
      const kept = list.filter((t) => t > since);
      if (kept.length) this.hits.set(key, kept);
      else this.hits.delete(key);
    }
  }
}

module.exports = { RateLimiter };
