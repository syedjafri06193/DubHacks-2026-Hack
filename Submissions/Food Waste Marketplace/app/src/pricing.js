// Design doc §6.2: the model proposes, the server decides.
const BANDS = [
  { over: 180, floor: 20, ceiling: 40 },
  { over: 60, floor: 30, ceiling: 50 },
  { over: 20, floor: 50, ceiling: 65 },
  { over: -Infinity, floor: 60, ceiling: 75 },
];

function band(minutesToClose) {
  return BANDS.find(b => minutesToClose > b.over);
}

// Local minutes-of-day for a timezone, and minutes until "HH:MM" closing.
function minutesToClose(closesAt, timezone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const h = +parts.find(p => p.type === 'hour').value;
  const m = +parts.find(p => p.type === 'minute').value;
  const [ch, cm] = closesAt.split(':').map(Number);
  let diff = ch * 60 + cm - (h * 60 + m);
  if (diff < 0) diff += 24 * 60; // closing is tomorrow
  return diff;
}

function localTime(timezone, now = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(now);
}

function clampDiscount(proposed, minutes) {
  const b = band(minutes);
  const p = Number.isFinite(+proposed) ? Math.round(+proposed) : Math.round((b.floor + b.ceiling) / 2);
  return Math.min(b.ceiling, Math.max(b.floor, p));
}

function priceFor(originalCents, discountPct) {
  // Never list for $0: at least 50 cents and never above original.
  const p = Math.round(originalCents * (100 - discountPct) / 100 / 10) * 10;
  return Math.min(originalCents, Math.max(50, p));
}

module.exports = { band, minutesToClose, localTime, clampDiscount, priceFor };
