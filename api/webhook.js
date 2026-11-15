// WhatsApp webhook: Meta calls this URL every time someone writes to the business number.
// It asks Claude for an answer and sends it back through WhatsApp.

const store = require("../lib/store");

const GRAPH = process.env.GRAPH_VERSION || "v25.0";
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";

function digits(s) { return String(s || "").replace(/\D/g, ""); }

function owners() {
  return String(process.env.OWNER_NUMBERS || "").split(",").map(digits).filter(Boolean);
}

// What the customer reads when the AI cannot answer. It never mentions an error.
const HANDOFF = "Gracias por escribirnos. Le paso tu mensaje al equipo y te responden por aquí lo antes posible.";

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function sendWhatsApp(to, body) {
  for (let i = 0; i < 2; i++) {
    try {
      if (await sendOnce(to, body)) return true;
    } catch (err) { console.error("WhatsApp send threw", err); }
    await wait(600);
  }
  return false;
}

async function sendOnce(to, body) {
  const r = await fetch("https://graph.facebook.com/" + GRAPH + "/" + process.env.WHATSAPP_PHONE_NUMBER_ID + "/messages", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.WHATSAPP_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: to, type: "text", text: { body: body } })
  });
  if (!r.ok) console.error("WhatsApp send failed", r.status, await r.text());
  else console.log("WhatsApp reply sent to ..." + String(to).slice(-4));
  return r.ok;
}

// Alert the business. Email is used when a business email and RESEND_API_KEY are set;
// otherwise the alert goes by WhatsApp to OWNER_NUMBERS.
// The email key. The new key was saved in Vercel under the name "AI", so that one is tried first.
function emailKeys() {
  return [process.env.AI, process.env.RESEND_API_KEY]
    .map((k) => String(k || "").trim()).filter((k) => k.startsWith("re_"));
}

async function sendEmail(to, subject, text) {
  for (const key of emailKeys()) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || "Recepcionista <onboarding@resend.dev>",
        to: [to], subject: subject, text: text
      })
    });
    if (r.ok) { console.log("Email alert sent"); return true; }
    console.error("Email alert failed", r.status, await r.text());
  }
  return false;
}

async function notifyBusiness(state, subject, text, skip) {
  const to = (state.config.email || process.env.OWNER_EMAIL || "").trim();
  if (to && emailKeys().length) {
    if (await sendEmail(to, subject, text)) return;
    // The alert must not get lost: send it by WhatsApp to the owner (not to the customer's own chat).
    for (const o of owners()) if (o !== skip) await sendWhatsApp(o, subject + "\n" + text);
    return;
  }
  for (const o of owners()) await sendWhatsApp(o, subject + "\n" + text);
}

// Busy or flaky moments (429, 5xx, network) are retried. Other errors are thrown.
async function callClaude(payload) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      const j = await r.json().catch(() => null);
      if (r.ok && j) return j;
      last = new Error("Claude error " + r.status + ": " + JSON.stringify(j));
      if (r.status !== 429 && r.status < 500) throw last;
    } catch (err) {
      if (err === last) throw err;
      last = err;
    }
    console.error("Claude call failed, retrying", String(last).slice(0, 200));
    await wait(700 * (i + 1));
  }
  throw last;
}

function describe(kind, b) {
  return kind + ": " + b.service + ", " + store.dayLabel(b.date) + " a las " + store.fmt12(b.time) + ", a nombre de " + b.name;
}

function systemPrompt(state, phone, acts) {
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
    "Citas que ESTE cliente tiene reservadas AHORA:",
    mine,
    "",
    "Acciones que el sistema YA ejecutó para este cliente en este chat (son hechos reales, en orden):",
    (acts && acts.length) ? acts.map((a) => "- " + a).join("\n") : "- Ninguna todavía.",
    "",
    "Reglas:",
    "- Si el cliente saluda o hace una pregunta simple (horario, dirección, precios, formas de pago, qué servicios hay), responde directo y breve con los datos del negocio. No empujes una cita en cada mensaje; ofrécela solo cuando tenga sentido.",
    "- Si es charla general o un mensaje corto como 'hola' o 'gracias', responde con amabilidad en una frase y pregunta en qué puedes ayudar.",
    "- Para reservar necesitas: servicio, fecha, hora y nombre completo. Pide lo que falte, una cosa a la vez.",
    "- Antes de reservar pide el nombre completo del cliente, a menos que ya lo haya dicho en este chat. Nunca inventes ni asumas el nombre.",
    "- NO pidas teléfono: el negocio ya tiene el número de WhatsApp del cliente.",
    "- En cuanto tengas servicio, fecha, hora y nombre, reserva de inmediato con agendar_cita. No hagas una pregunta extra de confirmación como '¿La reservo...?'.",
    "- Cuando tengas todo, usa la herramienta agendar_cita con la fecha (YYYY-MM-DD) y la hora (HH:MM) de la lista. Confirma la cita solo si la herramienta responde ok.",
    "- Una hora reservada deja de aparecer en la lista de disponibles. Si la hora está en las citas de este cliente, es suya y está confirmada: nunca digas que no estaba disponible ni que el equipo debe revisarla.",
    "- Tus mensajes anteriores sobre reservas y cancelaciones fueron correctos cuando los enviaste. NUNCA los corrijas, los contradigas ni te disculpes por ellos. Si una cita ya no aparece en la lista de AHORA, es porque se canceló, como dice la lista de acciones. Si una hora ya no aparece como disponible, es porque se reservó.",
    "- Si el cliente responde 'no', 'gracias' o algo parecido después de una reserva o cancelación, despídete con amabilidad en una frase. No agregues correcciones ni información nueva.",
    "- Después de reservar, confirma siempre en un mensaje completo, por ejemplo: 'Listo, tu cita quedó confirmada: limpieza dental, domingo 15 de noviembre a la 1:00 p. m., a nombre de Ana Pérez.' Incluye servicio, día, hora y nombre. Nunca respondas solo 'Listo'. No ofrezcas otras horas ni te disculpes.",
    "- Si el cliente quiere cancelar una de sus citas, usa la herramienta cancelar_cita. Si responde ok, confirma con amabilidad que la cita quedó cancelada. Si tiene varias citas y no dice cuál, pregunta cuál.",
    "- Si el cliente quiere cambiar la hora de su cita, primero cancela la cita actual con cancelar_cita y luego reserva la nueva con agendar_cita.",
    "- Si piden una hora que no está en la lista, o no hay horas, di que el equipo le escribirá cuando abra.",
    "- Si no sabes algo, di que el equipo responderá cuando abra. No inventes precios, horas ni datos.",
    "- Usa sentido común, como una buena recepcionista humana. Entiende mensajes con errores de escritura, abreviaturas y respuestas cortas ('si', 'ok', 'dale', 'esa', 'la primera', 'a la 1') según lo último que se habló en el chat.",
    "- Si el cliente da varios datos en un solo mensaje, úsalos todos; no vuelvas a preguntar algo que ya dijo.",
    "- Si de verdad no queda claro qué quiere, haz UNA pregunta corta y concreta con opciones (por ejemplo: '¿Prefieres a las 9:00 a. m. o a la 1:00 p. m.?'). Nunca respondas 'no te entendí'.",
    "- Nunca hables de errores, sistemas, herramientas, fallas técnicas ni de que eres un programa con problemas. El cliente solo ve una atención normal.",
    "- Siempre responde algo útil; nunca dejes un mensaje vacío.",
    "- No des diagnósticos ni consejos médicos. En una urgencia, indica que llame al negocio."
  ].join("\n");
}

const TOOLS = [{
  name: "agendar_cita",
  description: "Reserva una cita en una hora disponible. Devuelve ok si quedó reservada.",
  input_schema: {
    type: "object",
    properties: {
      nombre: { type: "string", description: "Nombre completo del cliente, dicho por el cliente" },
      servicio: { type: "string", description: "Servicio solicitado" },
      fecha: { type: "string", description: "Fecha en formato YYYY-MM-DD" },
      hora: { type: "string", description: "Hora en formato HH:MM" }
    },
    required: ["nombre", "servicio", "fecha", "hora"]
  }
}, {
  name: "cancelar_cita",
  description: "Cancela una cita que este cliente ya tiene reservada y libera esa hora. Devuelve ok si quedó cancelada.",
  input_schema: {
    type: "object",
    properties: {
      fecha: { type: "string", description: "Fecha de la cita en formato YYYY-MM-DD" },
      hora: { type: "string", description: "Hora de la cita en formato HH:MM" }
    },
    required: ["fecha", "hora"]
  }
}];

async function book(input, phone) {
  // Read the latest state right before booking so two chats cannot take the same hour.
  const nombre = String(input.nombre || "").trim();
  if (nombre.length < 2) return { ok: false, error: "Falta el nombre completo. Pídelo al cliente antes de reservar." };
  const state = await store.getState();
  const fecha = String(input.fecha || "").trim();
  let hora = String(input.hora || "").trim();
  if (/^\d:\d{2}$/.test(hora)) hora = "0" + hora;
  let slot = state.slots.find((s) => s.date === fecha && s.time === hora);
  // Common sense: "01:00" meant as 1 p. m., or the right hour with the wrong date.
  if (!slot && /^\d{2}:\d{2}$/.test(hora) && Number(hora.slice(0, 2)) < 12) {
    const pm = String(Number(hora.slice(0, 2)) + 12) + hora.slice(2);
    slot = state.slots.find((s) => s.date === fecha && s.time === pm);
  }
  if (!slot) {
    const t = store.now();
    const same = state.slots.filter((s) => s.time === hora && !s.taken && (s.date > t.date || (s.date === t.date && s.time > t.time)));
    if (same.length === 1) slot = same[0];
  }
  if (!slot) return { ok: false, error: "Esa hora no está en la lista. Ofrece una de las disponibles." };
  if (slot.taken) {
    // The same customer asking again for the hour they already have: it is theirs.
    const own = state.bookings.find((b) => b.phone === phone && b.date === slot.date && b.time === slot.time);
    if (own) return { ok: true, booking: own, already: true };
    return { ok: false, error: "Esa hora ya está reservada. Ofrece otra." };
  }
  slot.taken = true;
  const booking = {
    name: nombre,
    service: String(input.servicio || "Cita"),
    date: slot.date, time: slot.time, phone: phone, at: new Date().toISOString()
  };
  state.bookings.push(booking);
  await store.saveState(state);
  return { ok: true, booking: booking };
}

// Reply used when the AI returns no text: a full confirmation built from what actually happened.
function summary(made, cancelled) {
  const lines = [];
  cancelled.forEach((b) => lines.push("Tu cita de " + b.service + " del " + store.dayLabel(b.date) + " a las " + store.fmt12(b.time) + " quedó cancelada."));
  made.forEach((b) => lines.push("Listo, tu cita quedó confirmada: " + b.service + ", " + store.dayLabel(b.date) + " a las " + store.fmt12(b.time) +
    ", a nombre de " + b.name + "."));
  return lines.join("\n");
}

async function cancel(input, phone) {
  const state = await store.getState();
  const fecha = String(input.fecha || "").trim();
  let hora = String(input.hora || "").trim();
  if (/^\d:\d{2}$/.test(hora)) hora = "0" + hora;
  const mine = state.bookings.filter((b) => b.phone === phone);
  let booking = mine.find((b) => b.date === fecha && b.time === hora);
  if (!booking && mine.length === 1) booking = mine[0]; // only one booking: that is the one
  if (!booking) return { ok: false, error: "Este cliente no tiene una cita en esa fecha y hora." };
  state.bookings = state.bookings.filter((b) => b !== booking);
  const slot = state.slots.find((s) => s.date === booking.date && s.time === booking.time);
  if (slot) slot.taken = false;
  await store.saveState(state);
  return { ok: true, booking: booking };
}

// One try at answering. Throws if the AI fails or returns nothing usable.
async function attempt(state, history, text, phone, acts, made, cancelled, tokens) {
  const messages = history.concat([{ role: "user", content: text }]);
  // The system prompt stays the same for the whole try. The model's reasoning blocks are tied
  // to it, so changing it between tool calls makes the API reject the conversation.
  const system = systemPrompt(state, phone, acts);
  for (let i = 0; i < 5; i++) {
    const resp = await callClaude({ model: MODEL, max_tokens: tokens, system: system, tools: TOOLS, messages: messages });
    if (!resp || !Array.isArray(resp.content)) throw new Error("Claude returned an unexpected body");
    if (resp.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: resp.content });
      const results = [];
      for (const block of resp.content) {
        if (block.type !== "tool_use") continue;
        const isCancel = block.name === "cancelar_cita";
        const res = isCancel ? await cancel(block.input || {}, phone) : await book(block.input || {}, phone);
        let payload;
        if (res.ok) {
          const b = res.booking;
          if (!res.already) {
            (isCancel ? cancelled : made).push(b);
            acts.push(describe(isCancel ? "Cancelada" : "Reservada", b));
          }
          payload = {
            ok: true,
            resultado: isCancel ? "Cita cancelada. Esa hora quedó libre."
              : res.already ? "Esta cita ya estaba reservada y confirmada para este cliente." : "Cita reservada y confirmada.",
            servicio: b.service, dia: store.dayLabel(b.date), hora: store.fmt12(b.time), nombre: b.name
          };
        } else {
          payload = { ok: false, error: res.error };
        }
        results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(payload), is_error: !res.ok });
      }
      messages.push({ role: "user", content: results });
      continue;
    }
    const out = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (!out) throw new Error("Claude returned no text. stop_reason=" + resp.stop_reason);
    return out;
  }
  throw new Error("Too many tool rounds");
}

// The customer always gets a sensible reply:
// 1) the AI's answer; 2) if it fails after booking or cancelling, a confirmation built by the server;
// 3) if it fails before, one fresh try; 4) if that fails too, a polite hand-off to the team.
async function answer(state, history, text, phone, acts) {
  const made = [];
  const cancelled = [];
  for (let n = 0; n < 2; n++) {
    try {
      const st = n === 0 ? state : await store.getState();
      const out = await attempt(st, history, text, phone, acts, made, cancelled, n === 0 ? 2000 : 4000);
      return { text: out, made: made, cancelled: cancelled };
    } catch (err) {
      console.error("Answer try " + (n + 1) + " failed:", err);
      if (made.length || cancelled.length) return { text: summary(made, cancelled), made: made, cancelled: cancelled };
    }
  }
  return { text: HANDOFF, made: made, cancelled: cancelled, failed: true };
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

// Whatever goes wrong, the customer gets a polite reply and the business is told.
async function handleMessage(msg) {
  try {
    await handle(msg);
  } catch (err) {
    console.error("Message handling failed:", err);
    try {
      await sendWhatsApp(msg.from, HANDOFF);
      await unanswered(msg);
    } catch (e) { console.error("Hand-off failed:", e); }
  }
}

async function unanswered(msg) {
  const state = await store.getState();
  const said = msg.text && msg.text.body ? msg.text.body.slice(0, 500) : "(" + msg.type + ")";
  await notifyBusiness(state, "Mensaje sin responder de +" + digits(msg.from),
    "La recepcionista no pudo responder este mensaje. Por favor respóndelo:\n\n\"" + said + "\"\n\nWhatsApp del cliente: +" + digits(msg.from),
    digits(msg.from));
}

async function handle(msg) {
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
    await store.redis(["DEL", "acts:" + digits(from)]);
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

  // Handle one message at a time per customer, so two quick messages do not get mixed up.
  const lock = "lock:" + digits(from);
  for (let i = 0; i < 15; i++) {
    const got = await store.redis(["SET", lock, "1", "NX", "EX", "40"]);
    if (got !== null) break;
    await wait(1000);
  }

  const key = "chat:" + digits(from);
  let res;
  try {
    const raw = await store.redis(["GET", key]);
    const history = raw ? JSON.parse(raw) : [];
    const actsKey = "acts:" + digits(from);
    const rawActs = await store.redis(["GET", actsKey]);
    const acts = rawActs ? JSON.parse(rawActs) : [];
    const before = acts.length;

    res = await answer(state, history, text, digits(from), acts);
    await sendWhatsApp(from, res.text);
    if (acts.length !== before) await store.redis(["SET", actsKey, JSON.stringify(acts.slice(-8)), "EX", "86400"]);

    history.push({ role: "user", content: text }, { role: "assistant", content: res.text });
    await store.redis(["SET", key, JSON.stringify(history.slice(-12)), "EX", "86400"]);
  } finally {
    await store.redis(["DEL", lock]);
  }

  if (res.failed) await unanswered(msg);

  // Tell the business about each cancellation and each new booking.
  if (res.cancelled.length || res.made.length) {
    const fresh = await store.getState();
    for (const b of res.cancelled) {
      await notifyBusiness(fresh,
        "Cita cancelada: " + b.name + " · " + store.dayLabel(b.date) + ", " + store.fmt12(b.time),
        "Cliente: " + b.name + "\nServicio: " + b.service + "\nDía y hora: " + store.dayLabel(b.date) + ", " + store.fmt12(b.time) +
        "\nWhatsApp del cliente: +" + b.phone + "\n\nEsa hora quedó libre otra vez.", digits(from));
    }
    for (const b of res.made) {
      await notifyBusiness(fresh,
        "Nueva cita: " + b.name + " · " + store.dayLabel(b.date) + ", " + store.fmt12(b.time),
        "Cliente: " + b.name + "\nServicio: " + b.service + "\nDía y hora: " + store.dayLabel(b.date) + ", " + store.fmt12(b.time) +
        "\nWhatsApp del cliente: +" + b.phone + "\n\nEsa hora ya no se ofrece a otros clientes.", digits(from));
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
