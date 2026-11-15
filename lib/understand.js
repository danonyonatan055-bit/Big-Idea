// Understands short replies even with typos, missing or extra letters, no accents, slang and repeated letters.

function clean(t) {
  return String(t || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")   // quita tildes; la ñ queda como n
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/(.)\1+/g, "$1")                            // "siii" -> "si", "okk" -> "ok"
    .replace(/\s+/g, " ").trim();
}

// Number of letter changes between two words.
function dist(a, b) {
  const m = a.length, n = b.length;
  const d = [];
  for (let i = 0; i <= m; i++) { d[i] = [i]; }
  for (let j = 0; j <= n; j++) { d[0][j] = j; }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[m][n];
}

// Short words must match exactly; longer ones may have one or two letters wrong.
function near(phrase, options) {
  return options.some((o) => {
    const w = clean(o);
    const m = Math.max(phrase.length, w.length);
    // Phrases with several words allow one letter off; long single words allow two.
    const multi = phrase.includes(" ") || w.includes(" ");
    const tol = m <= 2 ? 0 : (multi || m <= 7) ? 1 : 2;
    return dist(phrase, w) <= tol;
  });
}

const YES = [
  "si", "ok", "okay", "oki", "dale", "claro", "listo", "va", "vale", "bueno", "perfecto", "yes", "yep", "sip",
  "confirmo", "confirmar", "confirma", "confirmala", "confirmalo", "reservala", "reservalo", "reserva",
  "correcto", "exacto", "de acuerdo", "esta bien", "por supuesto", "obvio", "si confirmo", "si la quiero",
  "si quiero", "quiero", "la quiero", "hazla", "hazlo", "agendala", "agendalo", "si esa", "esa esta bien"
];

// Plain "no": only means "do not book". After a confirmed booking it does not cancel anything.
const NO_WEAK = ["no", "nop", "nel", "nah", "nope", "mejor no", "no gracias", "no gracias ya", "no nada"];

// Clear cancel intent: after a confirmed booking it cancels that booking.
const NO_STRONG = [
  "cancelar", "cancela", "cancelala", "cancelalo", "cancelo", "cancelen", "anular", "anula", "anulala",
  "ya no puedo", "no puedo", "al final no puedo", "al final no", "no puedo ir", "no voy a poder", "no podre",
  "ya no quiero", "no quiero la cita", "mejor cancela", "cancelar la cita", "cancela la cita", "quiero cancelar"
];

// Filler words at the start or end that do not change the meaning.
const TRAIL = ["porfa", "por favor", "pf", "xfa", "gracias", "ya", "entonces", "bro", "mano", "jaja", "jeje"];

function strip(words) {
  const w = words.slice();
  while (w.length > 1 && TRAIL.includes(w[w.length - 1])) w.pop();
  while (w.length > 1 && TRAIL.includes(w[0])) w.shift();
  return w;
}

// Returns "yes", "cancel", "no" or null (null = not a short answer; the AI reads the message).
function choice(text) {
  const c = clean(text);
  if (!c || c.split(" ").length > 6) return null;
  const words = strip(c.split(" "));
  // try the full phrase, then the phrase without filler words
  const phrases = [c, words.join(" ")];
  for (const p of phrases) {
    if (near(p, NO_STRONG)) return "cancel";
    if (near(p, NO_WEAK)) return "no";
    if (near(p, YES)) return "yes";
  }
  // "cancelame la cita", "cancelenla": the first word is a cancel word
  if (/^(cancel|cancl|anul)/.test(words[0] || "") || /^(cancel|cancl)/.test(words[0] || "")) return "cancel";
  // "ok dale", "si claro": every word is a yes word
  if (words.length > 1 && words.every((w) => near(w, YES.filter((y) => !y.includes(" "))))) return "yes";
  return null;
}

// "borrar mis datos" with typos too.
function wantsDelete(text) {
  const c = clean(text);
  return /delete my data/.test(c) || near(c, ["borrar mis datos", "borrar datos", "borra mis datos"]);
}

module.exports = { clean, dist, choice, wantsDelete };
