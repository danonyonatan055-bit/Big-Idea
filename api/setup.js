// One-time helper: makes sure this Meta app is subscribed to the WhatsApp account,
// so real incoming messages are delivered to /api/webhook. It only performs that one
// fixed action and never returns the access token.

const GRAPH = process.env.GRAPH_VERSION || "v25.0";

async function call(method, path) {
  const r = await fetch("https://graph.facebook.com/" + GRAPH + "/" + path, {
    method: method,
    headers: { Authorization: "Bearer " + process.env.WHATSAPP_TOKEN }
  });
  let body;
  try { body = await r.json(); } catch (e) { body = null; }
  return { status: r.status, body: body };
}

module.exports = async (req, res) => {
  const waba = process.env.WHATSAPP_WABA_ID;
  const phone = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!waba || !process.env.WHATSAPP_TOKEN) {
    res.status(500).json({ error: "Missing WHATSAPP_WABA_ID or WHATSAPP_TOKEN" });
    return;
  }
  try {
    const before = await call("GET", waba + "/subscribed_apps");
    const subscribe = await call("POST", waba + "/subscribed_apps");
    const after = await call("GET", waba + "/subscribed_apps");
    const number = phone ? await call("GET", phone + "?fields=display_phone_number,verified_name,code_verification_status,platform_type,status") : null;
    res.status(200).json({ before: before, subscribe: subscribe, after: after, number: number });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
};
