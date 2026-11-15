// Health check: reports whether each connection works. Never returns keys or tokens.

const store = require("../lib/store");
const GRAPH = process.env.GRAPH_VERSION || "v25.0";

module.exports = async (req, res) => {
  const out = { database: false, whatsapp: false, whatsappDetail: "", claudeKey: !!process.env.ANTHROPIC_API_KEY, emailKey: !!process.env.RESEND_API_KEY };
  try {
    await store.redis(["PING"]);
    out.database = true;
  } catch (e) { out.database = false; }
  try {
    const r = await fetch("https://graph.facebook.com/" + GRAPH + "/" + process.env.WHATSAPP_PHONE_NUMBER_ID + "?fields=display_phone_number,status", {
      headers: { Authorization: "Bearer " + process.env.WHATSAPP_TOKEN }
    });
    const j = await r.json();
    out.whatsapp = r.ok;
    out.whatsappDetail = r.ok ? (j.display_phone_number + " " + (j.status || "")) : ((j.error && j.error.message) || ("HTTP " + r.status));
  } catch (e) { out.whatsappDetail = String(e.message || e); }
  // Email key check. Reports only whether Resend accepts each key, never the key itself.
  out.email = {};
  for (const name of ["RESEND_API_KEY", "AI"]) {
    const k = process.env[name];
    if (!k) { out.email[name] = "not set"; continue; }
    const shape = (k !== k.trim() ? "has spaces around it, " : "") + (k.trim().startsWith("re_") ? "" : "does not start with re_, ") + k.length + " chars";
    try {
      const r = await fetch("https://api.resend.com/domains", { headers: { Authorization: "Bearer " + k.trim() } });
      const j = await r.json().catch(() => ({}));
      out.email[name] = (r.ok ? "accepted" : "HTTP " + r.status + " " + (j.name || "") + ": " + (j.message || "")) + " (" + shape + ")";
    } catch (e) { out.email[name] = "check failed (" + shape + ")"; }
  }
  res.status(200).json(out);
};
