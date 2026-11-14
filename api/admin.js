// Private API for the company's page: read and save prices, instructions, open hours and bookings.

const crypto = require("crypto");
const store = require("../lib/store");

function allowed(req) {
  const expected = process.env.ADMIN_PASSWORD || "";
  const given = String(req.headers["x-admin-password"] || "");
  if (!expected || expected.length < 8) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function view(state) {
  const t = store.now();
  return {
    config: state.config,
    today: t.date,
    tomorrow: store.addDays(t.date, 1),
    slots: state.slots.slice().sort((x, y) => (x.date + x.time).localeCompare(y.date + y.time))
      .map((s) => ({ date: s.date, time: s.time, taken: s.taken, label: store.dayLabel(s.date) + ", " + store.fmt12(s.time) })),
    bookings: state.bookings.slice().reverse()
      .map((b) => Object.assign({}, b, { label: store.dayLabel(b.date) + ", " + store.fmt12(b.time) }))
  };
}

module.exports = async (req, res) => {
  if (!allowed(req)) { res.status(401).json({ error: "Contraseña incorrecta." }); return; }
  try {
    const state = await store.getState();
    store.pruneSlots(state);

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      if (body.config) {
        const c = body.config;
        const str = (v, max) => String(v == null ? "" : v).slice(0, max);
        state.config = {
          name: str(c.name, 100) || "Mi negocio",
          info: str(c.info, 6000),
          services: str(c.services, 4000),
          email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str(c.email, 200).trim()) ? str(c.email, 200).trim() : "",
          mode: c.mode === "closed" ? "closed" : "always",
          open: /^\d{2}:\d{2}$/.test(c.open) ? c.open : "08:00",
          close: /^\d{2}:\d{2}$/.test(c.close) ? c.close : "17:00"
        };
      }
      if (body.slotsDate && /^\d{4}-\d{2}-\d{2}$/.test(body.slotsDate)) {
        store.setSlotsForDate(state, body.slotsDate, store.parseHours(body.slotsText || ""));
      }
      await store.saveState(state);
    }
    res.status(200).json(view(state));
  } catch (err) {
    console.error("Admin error:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
};
