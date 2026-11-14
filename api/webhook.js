// WhatsApp webhook: Meta calls this URL every time someone writes to the business number.
// It asks Claude for an answer and sends it back through WhatsApp.

const store = require("../lib/store");

const GRAPH = process.env.GRAPH_VERSION || "v25.0";
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";

function digits(s) { return String(s || "").replace(/\D/g, ""); }

function owners() {
  return String(process.env.OWNER_NUMBERS || "").split(",").map(digits).filter(Boolean);
}

async function sendWhatsApp(to, body) {
  const r = await fetch("https://graph.facebook.com/" + GRAPH + "/" + process.env.WHATSAPP_PHONE_NUMBER_ID + "/messages", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.WHATSAPP_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: to, type: "text", text: { body: body } })
  });
  if (!r.ok) console.error("WhatsApp send failed", r.status, await r.text());
  else console.log("WhatsApp reply sent to ..." + String(to).slice(-4));
  return r.ok;
}

async function callClaude(payload) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Claude error " + r.status + ": " + JSON.stringify(j));
  return j;
}

function systemPrompt(state, phone) {
  const t = store.now();
  const c = state.config;
  const free = state.slots.filter((s) => !s.taken && (s.date > t.date || (s.date === t.date && s.time > t.time)));
  const byDate = {};
  free.forEach((s) => { (byDate[s.date] = byDate[s.date] || []).push(s.time); });
  const dates = Object.keys(byDate).sort();
  const slotLines = dates.length
    ? dates.map((d) => {
        const tag = d === t.date ? "hoy" : d === store.addDays(t.date, 1) ? "mañana" : "";
        return "- " + d + " (" + (tag ? tag + ", " : "") + store.dayLabel(d) + "): " +
          byDate[d].sort().map((x) => x + " (" + store.fmt12(x) + ")").join(", ");
      }).join("\n")
    : "- No hay horas disponibles.";
  const own = state.bookings.filter((b) => b.phone === phone && b.date >= t.date);
  const mine = own.length
    ? own.map((b) => "- " + b.date + " (" + store.dayLabel(b.date) + ") a las " + b.time + " (" + store.fmt12(b.time) + "): " + b.service + ", a nombre de " + b.name).join("\n")
    : "- Ninguna.";
  return [
    "Eres la recepcionista virtual de " + c.name + ". Atiendes por WhatsApp a clientes.",
    "Responde en el idioma del cliente (español por defecto), con mensajes cortos, tono amable y sin formato markdown.",
    "Tu meta es resolver la duda del cliente. Reserva una cita cuando el cliente la pida.",
    "",
    "Fecha y hora actual: " + t.date + " " + t.time + " (" + store.dayLabel(t.date) + ").",
    "",
    "Información e instrucciones del negocio:",
    c.info || "(sin información)",
    "",
    "Servicios y precios:",
    c.services || "(sin precios cargados)",
    "",
    "Horas disponibles (solo ofrece estas):",
    slotLines,
    "",
    "Citas que ESTE cliente ya tiene reservadas:",
    mine,
    "",
    "Reglas:",
    "- Si el cliente saluda o hace una pregunta simple (horario, dirección, precios, formas de pago, qué servicios hay), responde directo y breve con los datos del negocio. No empujes una cita en cada mensaje; ofrécela solo cuando tenga sentido.",
    "- Si es charla general o un mensaje corto como 'hola' o 'gracias', responde con amabilidad en una frase y pregunta en qué puedes ayudar.",
    "- Para reservar necesitas: nombre del cliente, servicio, fecha y hora. Pide lo que falte, una cosa a la vez.",
    "- Cuando tengas todo, usa la herramienta agendar_cita con la fecha (YYYY-MM-DD) y la hora (HH:MM) de la lista. Confirma la cita solo si la herramienta responde ok.",
    "- Una hora reservada deja de aparecer en la lista de disponibles. Si la hora está en las citas de este cliente, es suya y está confirmada: nunca digas que no estaba disponible ni que el equipo debe revisarla.",
    "- Después de reservar, confirma en un mensaje corto: servicio, día, hora y nombre. No ofrezcas otras horas ni te disculpes.",
    "- Si piden una hora que no está en la lista, o no hay horas, di que el equipo le escribirá cuando abra.",
    "- Si no sabes algo, di que el equipo responderá cuando abra. No inventes precios, horas ni datos.",
    "- No des diagnósticos ni consejos médicos. En una urgencia, indica que llame al negocio."
  ].join("\n");
}

const TOOLS = [{
  name: "agendar_cita",
  description: "Reserva una cita en una hora disponible. Devuelve ok si quedó reservada.",
  input_schema: {
    type: "object",
    properties: {
      nombre: { type: "string", description: "Nombre del cliente" },
      servicio: { type: "string", description: "Servicio solicitado" },
      fecha: { type: "string", description: "Fecha en formato YYYY-MM-DD" },
      hora: { type: "string", description: "Hora en formato HH:MM" }
    },
    required: ["nombre", "servicio", "fecha", "hora"]
  }
}];

async function book(input, phone) {
  // Read the latest state right before booking so two chats cannot take the same hour.
  const state = await store.getState();
  const fecha = String(input.fecha || "").trim();
  let hora = String(input.hora || "").trim();
  if (/^\d:\d{2}$/.test(hora)) hora = "0" + hora;
  const slot = state.slots.find((s) => s.date === fecha && s.time === hora);
  if (!slot) return { ok: false, error: "Esa hora no está en la lista. Ofrece una de las disponibles." };
  if (slot.taken) return { ok: false, error: "Esa hora ya está reservada. Ofrece otra." };
  slot.taken = true;
  const booking = {
    name: String(input.nombre || "Cliente"),
    service: String(input.servicio || "Cita"),
    date: fecha, time: hora, phone: phone, at: new Date().toISOString()
  };
  state.bookings.push(booking);
  await store.saveState(state);
  return { ok: true, booking: booking };
}

async function answer(state, history, text, phone) {
  const messages = history.concat([{ role: "user", content: text }]);
  const made = [];
  for (let i = 0; i < 4; i++) {
    const resp = await callClaude({
      model: MODEL, max_tokens: 500, system: systemPrompt(state, phone), tools: TOOLS, messages: messages
    });
    if (resp.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: resp.content });
      const results = [];
      for (const block of resp.content) {
        if (block.type !== "tool_use") continue;
        const res = await book(block.input || {}, phone);
        if (res.ok) made.push(res.booking);
        results.push({
          type: "tool_result", tool_use_id: block.id,
          content: JSON.stringify(res.ok ? { ok: true } : { ok: false, error: res.error }),
          is_error: !res.ok
        });
      }
      messages.push({ role: "user", content: results });
      state = await store.getState();
      continue;
    }
    const out = (resp.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    return { text: out || "Listo.", made: made };
  }
  return { text: "El equipo te responderá cuando abra.", made: made };
}

// Owner writes "Mañana: 9, 12 y 1" or "Hoy: 3 y 4" to set the open hours.
async function ownerCommand(text, from) {
  const m = /^\s*(hoy|ma[ñn]ana)\s*[:\-]?\s*(.*\d.*)$/i.exec(text);
  if (!m) return false;
  const today = store.now().date;
  const date = m[1].toLowerCase() === "hoy" ? today : store.addDays(today, 1);
  const times = store.parseHours(m[2]);
  const state = await store.getState();
  store.pruneSlots(state);
  store.setSlotsForDate(state, date, times);
  await store.saveState(state);
  await sendWhatsApp(from, "Listo. Horas para " + store.dayLabel(date) + ": " + times.map(store.fmt12).join(", ") + ".");
  return true;
}

async function handleMessage(msg) {
  const from = msg.from;
  // Meta can deliver the same message twice. Answer each one only once.
  const first = await store.redis(["SET", "msg:" + msg.id, "1", "NX", "EX", "3600"]);
  if (first === null) { console.log("Skipped: message already handled"); return; }
  console.log("Incoming " + msg.type + " message from ..." + String(from).slice(-4));

  if (msg.type !== "text" || !msg.text || !msg.text.body) {
    await sendWhatsApp(from, "Por ahora solo puedo leer mensajes de texto. ¿Me escribes tu consulta?");
    return;
  }
  const text = msg.text.body.slice(0, 2000);

  if (owners().indexOf(digits(from)) !== -1 && (await ownerCommand(text, from))) return;

  // Privacy: anyone can ask to have their chat and bookings removed.
  if (/borrar mis datos|delete my data/i.test(text)) {
    await store.redis(["DEL", "chat:" + digits(from)]);
    const st = await store.getState();
    const mine = st.bookings.filter((b) => b.phone === digits(from));
    mine.forEach((b) => {
      const slot = st.slots.find((s) => s.date === b.date && s.time === b.time);
      if (slot) slot.taken = false;
    });
    st.bookings = st.bookings.filter((b) => b.phone !== digits(from));
    await store.saveState(st);
    await sendWhatsApp(from, "Listo. Borramos tu conversación y tus citas guardadas.");
    return;
  }

  const state = await store.getState();
  // ALWAYS_ANSWER=1 (set in Vercel) makes the AI answer at any hour, for testing.
  if (state.config.mode === "closed" && process.env.ALWAYS_ANSWER !== "1") {
    const t = store.now().time;
    if (t >= state.config.open && t < state.config.close) {
      console.log("Skipped: business is open (" + t + "), mode is closed-only");
      return; // business is open: staff answer
    }
  }

  const key = "chat:" + digits(from);
  const raw = await store.redis(["GET", key]);
  const history = raw ? JSON.parse(raw) : [];

  const res = await answer(state, history, text, digits(from));
  await sendWhatsApp(from, res.text);

  history.push({ role: "user", content: text }, { role: "assistant", content: res.text });
  await store.redis(["SET", key, JSON.stringify(history.slice(-12)), "EX", "86400"]);

  // Tell the owner about each new booking (works if the owner wrote to the number in the last 24 hours).
  for (const b of res.made) {
    for (const o of owners()) {
      await sendWhatsApp(o, "Nueva cita: " + b.name + " · " + b.service + " · " + store.dayLabel(b.date) + ", " + store.fmt12(b.time) + " · tel. " + b.phone);
    }
  }
}

module.exports = async (req, res) => {
  if (req.method === "GET") {
    // Meta checks the URL once when you save it in the dashboard.
    const q = req.query || {};
    // The verify word is VERIFY_TOKEN if set, otherwise the admin password.
    const expected = process.env.VERIFY_TOKEN || process.env.ADMIN_PASSWORD;
    if (q["hub.mode"] === "subscribe" && expected && q["hub.verify_token"] === expected) {
      res.status(200).send(String(q["hub.challenge"]));
    } else {
      res.status(403).send("Forbidden");
    }
    return;
  }
  if (req.method !== "POST") { res.status(405).send("Method not allowed"); return; }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        if (!(value.messages || []).length) {
          const st = (value.statuses || []).map((x) => x.status + (x.errors ? " " + JSON.stringify(x.errors) : "")).join(", ");
          console.log("Webhook without message: field=" + change.field + (st ? " statuses=" + st : ""));
        }
        for (const msg of value.messages || []) {
          await handleMessage(msg);
        }
      }
    }
  } catch (err) {
    console.error("Webhook error:", err);
  }
  res.status(200).send("OK"); // always 200 so Meta does not keep retrying
};
