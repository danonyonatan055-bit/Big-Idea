// Master API (only for the owner of the service): create and manage the businesses that use the assistant.

const store = require("../lib/store");
const admin = require("./admin");

function publicView(t) {
  return { id: t.id, name: t.name, phoneId: t.phoneId, owners: t.owners || "", active: t.active !== false, ownToken: !!t.token, provider: t.provider || "meta", panel: "/admin?n=" + t.id };
}

function slug(v) {
  return String(v || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
}

module.exports = async (req, res) => {
  try {
    if (await admin.tooManyTries(req, false)) { res.status(429).json({ error: "Demasiados intentos. Espera 10 minutos." }); return; }
    if (!admin.masterOk(req.headers["x-admin-password"])) {
      await admin.tooManyTries(req, true);
      res.status(401).json({ error: "Contraseña incorrecta." });
      return;
    }
    const list = await store.listTenants();
    if (req.method === "POST") {
      const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      const fail = (m) => { res.status(400).json({ error: m }); };
      const phoneId = String(b.phoneId || "").replace(/\D/g, "");
      const owners = String(b.owners || "").split(",").map((x) => x.replace(/\D/g, "")).filter(Boolean).join(",");

      if (b.action === "create") {
        const id = slug(b.id || b.name);
        if (id.length < 2 || id === "demo") return fail("Escribe un nombre o código válido para el negocio.");
        if (list.some((t) => t.id === id)) return fail("Ya existe un negocio con ese código.");
        if (phoneId.length < 8) return fail("Falta el ID del número de WhatsApp (Phone number ID de Meta).");
        if (list.some((t) => t.phoneId === phoneId)) return fail("Ese número de WhatsApp ya está en otro negocio.");
        if (String(b.password || "").length < 8) return fail("La contraseña del negocio debe tener al menos 8 caracteres.");
        const t = { id: id, name: String(b.name || id).slice(0, 100), phoneId: phoneId, owners: owners, active: true,
          pass: store.hashPassword(b.password), createdAt: new Date().toISOString() };
        if (b.token) t.token = store.encrypt(String(b.token).trim());
        if (b.provider === "360dialog") t.provider = "360dialog";
        list.push(t);
        await store.saveTenants(list);
        // Start the business page with its name.
        await store.run(t, async () => {
          const st = await store.getState();
          st.config.name = t.name;
          await store.saveState(st);
        });
      } else if (b.action === "update") {
        const t = list.find((x) => x.id === b.id);
        if (!t) return fail("No existe ese negocio.");
        if (b.name) t.name = String(b.name).slice(0, 100);
        if (b.phoneId !== undefined && phoneId) {
          if (list.some((x) => x !== t && x.phoneId === phoneId)) return fail("Ese número de WhatsApp ya está en otro negocio.");
          t.phoneId = phoneId;
        }
        if (b.owners !== undefined) t.owners = owners;
        if (b.password) {
          if (String(b.password).length < 8) return fail("La contraseña del negocio debe tener al menos 8 caracteres.");
          t.pass = store.hashPassword(b.password);
        }
        if (b.token) t.token = store.encrypt(String(b.token).trim());
        if (b.provider !== undefined) t.provider = b.provider === "360dialog" ? "360dialog" : "meta";
        if (b.active !== undefined) t.active = !!b.active;
        await store.saveTenants(list);
      } else {
        return fail("Acción desconocida.");
      }
    }
    const demo = store.demoTenant();
    res.status(200).json({ businesses: [publicView(demo)].concat(list.map(publicView)) });
  } catch (err) {
    console.error("Master error:", err);
    res.status(500).json({ error: String(err.message || err) });
  }
};
