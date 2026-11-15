// Private API for the company's page: read and save prices, instructions, open hours and bookings.

const crypto = require("crypto");
const store = require("../lib/store");
const mail = require("../lib/mail");

function masterOk(given) {
  const expected = process.env.ADMIN_PASSWORD || "";
  if (!expected || expected.length < 8) return false;
  const a = crypto.createHash("sha256").update(String(given || "")).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// Each business enters with its own code and password. The master password opens any business.
async function whoIs(req) {
  const given = String(req.headers["x-admin-password"] || "");
  const biz = String(req.headers["x-business"] || "").trim().toLowerCase();
  const tenant = await store.findTenant(biz || "demo");
  if (!tenant) return null;
  if (masterOk(given)) return tenant;
  if (tenant.id !== "demo" && store.checkPassword(given, tenant.pass)) return tenant;
  return null;
}

// Slow down password guessing: 10 wrong tries per 10 minutes for each visitor.
async function tooManyTries(req, failed) {
  const ip = String(req.headers["x-forwarded-for"] || "x").split(",")[0].trim();
  const k = "tries:" + ip;
  const n = Number(await store.redis(["GET", k])) || 0;
  if (failed) await store.redis(["SET", k, String(n + 1), "EX", "600"]);
  return n >= 10;
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
  let tenant = null;
  try {
    if (await tooManyTries(req, false)) { res.status(429).json({ error: "Demasiados intentos. Espera 10 minutos." }); return; }
    tenant = await whoIs(req);
    if (!tenant) { await tooManyTries(req, true); res.status(401).json({ error: "Código o contraseña incorrectos." }); return; }
  } catch (err) {
    console.error("Admin login error:", err);
    res.status(500).json({ error: "No se pudo entrar. Intenta de nuevo." });
    return;
  }
  return store.run(tenant, () => serve(req, res));
};
module.exports.masterOk = masterOk;
module.exports.tooManyTries = tooManyTries;

async function serve(req, res) {
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
      // Block hours the staff gave by phone or in person (or unblock them).
      if (body.blockDate && /^\d{4}-\d{2}-\d{2}$/.test(body.blockDate)) {
        for (const t of store.parseHours(body.blockText || "")) {
          let slot = state.slots.find((x) => x.date === body.blockDate && x.time === t);
          if (body.unblock) {
            if (!slot) continue;
            // An hour with a real booking stays taken.
            if (!state.bookings.some((b) => b.date === slot.date && b.time === slot.time)) slot.taken = false;
          } else {
            if (!slot) { slot = { date: body.blockDate, time: t, taken: false }; state.slots.push(slot); }
            slot.taken = true;
          }
        }
      }
      await store.saveState(state);
      // "Send a test email" button on the company page.
      if (body.testEmail) {
        const to = (state.config.email || "").trim();
        const out = to
          ? await mail.send(to, "Correo de prueba de tu recepcionista", "Si lees esto, los avisos de citas llegan bien a este correo.")
          : { ok: false, error: "Primero escribe el correo del negocio y guarda." };
        res.status(200).json(Object.assign(view(state), { testEmail: out }));
        return;
      }
    }
    res.status(200).json(Object.assign(view(state), { business: store.current().id }));
  } catch (err) {
    console.error("Admin error:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
}
