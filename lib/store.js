// Shared helpers: database (Upstash Redis over HTTPS), state, dates and hours.

const TZ = process.env.TIMEZONE || "America/Panama";

async function redis(cmd) {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Database is not connected (missing Redis URL or token).");
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(cmd)
  });
  const j = await r.json();
  if (j.error) throw new Error("Database error: " + j.error);
  return j.result;
}

const DEFAULT_STATE = {
  config: {
    name: "Mi negocio",
    info: "",        // free text: address, hours, how to answer ("training")
    services: "",    // one per line, e.g. "Limpieza: 45"
    mode: "always",  // "always" or "closed" (answer only when the business is closed)
    open: "08:00",
    close: "17:00"
  },
  slots: [],         // [{ date: "2026-11-15", time: "09:00", taken: false }]
  bookings: []       // [{ name, service, date, time, phone, at }]
};

async function getState() {
  const raw = await redis(["GET", "state"]);
  if (!raw) return JSON.parse(JSON.stringify(DEFAULT_STATE));
  const s = JSON.parse(raw);
  s.config = Object.assign({}, DEFAULT_STATE.config, s.config || {});
  s.slots = s.slots || [];
  s.bookings = s.bookings || [];
  return s;
}

async function saveState(state) {
  await redis(["SET", "state", JSON.stringify(state)]);
}

function pad(n) { return (n < 10 ? "0" : "") + n; }

// Current date and time in the business's time zone.
function now() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  let hour = get("hour");
  if (hour === "24") hour = "00";
  return { date: get("year") + "-" + get("month") + "-" + get("day"), time: hour + ":" + get("minute") };
}

function addDays(dateStr, n) {
  const p = dateStr.split("-").map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
}

function dayLabel(dateStr) {
  const p = dateStr.split("-").map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2], 12));
  return d.toLocaleDateString("es-PA", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });
}

function fmt12(t) {
  const p = t.split(":");
  const h = +p[0];
  const suf = h >= 12 ? "p. m." : "a. m.";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + ":" + p[1] + " " + suf;
}

// "9, 12 y 1" -> ["09:00", "12:00", "13:00"]. Hours 1 to 7 with no am/pm count as afternoon.
function parseHours(s) {
  const out = {};
  const re = /(\d{1,2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)?/gi;
  let m;
  while ((m = re.exec(String(s))) !== null) {
    let h = +m[1];
    const min = m[2] ? +m[2] : 0;
    const suf = (m[3] || "").toLowerCase().replace(/[^ap]/g, "");
    if (suf === "p" && h < 12) h += 12;
    else if (suf === "a" && h === 12) h = 0;
    else if (!suf && h >= 1 && h <= 7) h += 12;
    if (h > 23 || min > 59) continue;
    out[pad(h) + ":" + pad(min)] = true;
  }
  return Object.keys(out).sort();
}

// Replace the open hours of one day. Hours already booked that day stay booked.
function setSlotsForDate(state, date, times) {
  const booked = state.slots.filter((s) => s.date === date && s.taken);
  const others = state.slots.filter((s) => s.date !== date);
  const fresh = times
    .filter((t) => !booked.some((b) => b.time === t))
    .map((t) => ({ date: date, time: t, taken: false }));
  state.slots = others.concat(booked, fresh);
}

// Drop days that already passed.
function pruneSlots(state) {
  const today = now().date;
  state.slots = state.slots.filter((s) => s.date >= today);
}

module.exports = {
  redis, getState, saveState, now, addDays, dayLabel, fmt12, parseHours,
  setSlotsForDate, pruneSlots, DEFAULT_STATE
};
