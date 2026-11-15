// Sends the alert emails to the business through Resend.

// The new key was saved in Vercel under the name "AI", so that one is tried first.
function keys() {
  return [process.env.AI, process.env.RESEND_API_KEY]
    .map((k) => String(k || "").trim()).filter((k) => k.startsWith("re_"));
}

// Returns { ok: true } or { ok: false, error: "reason in Spanish" }.
async function send(to, subject, text) {
  let error = "Falta la clave de correo (Resend) en Vercel.";
  for (const key of keys()) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM || "Recepcionista <onboarding@resend.dev>",
          to: [to], subject: subject, text: text
        })
      });
      if (r.ok) { console.log("Email alert sent"); return { ok: true }; }
      const raw = await r.text();
      console.error("Email alert failed", r.status, raw);
      if (/only send testing emails to your own email/i.test(raw)) {
        error = "Resend solo permite enviar a tu propio correo (el de tu cuenta de Resend) hasta que verifiques un dominio. Pon ese correo aquí, o verifica un dominio en resend.com/domains.";
        break;
      }
      error = /API key is invalid/i.test(raw) ? "La clave de Resend no es válida." : "Resend rechazó el correo (" + r.status + "): " + raw.slice(0, 200);
    } catch (err) {
      console.error("Email alert threw", err);
      error = "No se pudo conectar con Resend.";
    }
  }
  return { ok: false, error: error };
}

module.exports = { keys, send };
