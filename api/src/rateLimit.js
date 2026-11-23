'use strict';
/* In-memory request limits per client IP. Each Function App instance counts on its own, so this is
   not exact, but it stops a single client from flooding the API or running up costs. */

const RULES = {
  create: { max: 10, windowMs: 60 * 60 * 1000 }, // new share links per hour
  write: { max: 60, windowMs: 60 * 1000 }, // updates, deletes and key checks per minute
  read: { max: 300, windowMs: 60 * 1000 }, // reads and live-update connections per minute
};
const MAX_TRACKED = 50000;

/* The platform front end adds the caller's address as the last X-Forwarded-For entry, so a
   client cannot dodge the limit by sending its own X-Forwarded-For values. */
function clientIp(headers) {
  const forwarded = String(headers.get('x-forwarded-for') || '').split(',').map((part) => part.trim()).filter(Boolean);
  const last = forwarded.length ? forwarded[forwarded.length - 1] : '';
  if (/^[\d.]+:\d+$/.test(last)) return last.replace(/:\d+$/, ''); // IPv4 with port
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(last); // [IPv6]:port
  return bracketed ? bracketed[1] : last || 'unknown';
}

function createRateLimiter(rules = RULES, now = () => Date.now()) {
  const hits = new Map(); // "rule|ip" -> request times inside the window
  const longest = Math.max(...Object.values(rules).map((rule) => rule.windowMs));
  let lastSweep = now();

  function sweep(time) {
    lastSweep = time;
    hits.forEach((times, key) => {
      if (!times.length || time - times[times.length - 1] >= longest) hits.delete(key);
    });
    if (hits.size > MAX_TRACKED) hits.clear();
  }

  /* Returns 0 when the request is allowed, otherwise the seconds until it would be. */
  return function check(ruleName, ip) {
    const rule = rules[ruleName];
    if (!rule) return 0;
    const time = now();
    if (time - lastSweep > 60 * 1000) sweep(time);
    const key = `${ruleName}|${ip}`;
    const times = (hits.get(key) || []).filter((t) => time - t < rule.windowMs);
    if (times.length >= rule.max) {
      hits.set(key, times);
      return Math.max(1, Math.ceil((rule.windowMs - (time - times[0])) / 1000));
    }
    times.push(time);
    hits.set(key, times);
    return 0;
  };
}

module.exports = { createRateLimiter, clientIp, RULES };
