// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA — DIAGNÓSTICO TEMPORAL · listar los planes reales de PayPal
// ────────────────────────────────────────────────────────────────────────────
// URL pública:  https://epimeleia.world/api/diag-planes
//
// ⚠️ ARCHIVO DESCARTABLE. Se sube, se mira una vez, y se BORRA del repo.
//    No forma parte del sistema. No escribe nada. Solo lee y muestra.
//
// QUÉ CONTESTA:
//   "¿Los Plan IDs que tengo en las variables de entorno existen de verdad
//    en la cuenta de PayPal dueña de estas credenciales?"
//
//   Usa EXACTAMENTE las mismas variables que crear-suscripcion.js, así que
//   lo que diga es la verdad del entorno real, no de una copia.
//
// NO MUESTRA NINGÚN SECRETO: del CLIENT_ID solo enseña los primeros y los
// últimos caracteres, lo justo para identificar de qué app se trata.
// ────────────────────────────────────────────────────────────────────────────

const PAYPAL_BASE = process.env.PAYPAL_ENV === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const clientId     = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  // Los cuatro Plan IDs que el sistema cree tener.
  const configurados = {
    base:       process.env.PAYPAL_PLAN_BASE       || null,
    pro:        process.env.PAYPAL_PLAN_PRO        || null,
    corporate:  process.env.PAYPAL_PLAN_CORPORATE  || null,
    enterprise: process.env.PAYPAL_PLAN_ENTERPRISE || null,
  };

  const entorno = {
    PAYPAL_ENV: process.env.PAYPAL_ENV || "(no definida → sandbox)",
    apuntaA: PAYPAL_BASE,
    clientId: clientId
      ? `${clientId.slice(0, 8)}…${clientId.slice(-6)}  (largo: ${clientId.length})`
      : "(FALTA)",
    clientSecret: clientSecret ? `(presente, largo: ${clientSecret.length})` : "(FALTA)",
  };

  if (!clientId || !clientSecret) {
    return res.status(500).json({
      ok: false,
      error: "Faltan las credenciales de PayPal.",
      entorno,
      configurados,
    });
  }

  try {
    // ── 1 · Token ────────────────────────────────────────────────
    const tokenResp = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        "Authorization": "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });

    const tokenData = await tokenResp.json();

    if (!tokenResp.ok) {
      return res.status(502).json({
        ok: false,
        paso: "token",
        error: "PayPal no dio token con estas credenciales.",
        detalle: tokenData,
        entorno,
        configurados,
      });
    }

    const token = tokenData.access_token;

    // ── 2 · Los planes que REALMENTE tiene esta cuenta ───────────
    const planesResp = await fetch(
      `${PAYPAL_BASE}/v1/billing/plans?page_size=20&total_required=true`,
      { headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" } }
    );

    const planesData = await planesResp.json();

    if (!planesResp.ok) {
      return res.status(502).json({
        ok: false,
        paso: "listar planes",
        detalle: planesData,
        entorno,
        configurados,
      });
    }

    const planesReales = (planesData.plans || []).map(p => ({
      id:         p.id,
      nombre:     p.name,
      estado:     p.status,
      producto:   p.product_id,
    }));

    const idsReales = planesReales.map(p => p.id);

    // ── 3 · El veredicto, tier por tier ──────────────────────────
    const veredicto = {};
    for (const [tier, id] of Object.entries(configurados)) {
      if (!id) {
        veredicto[tier] = "❌ la variable de entorno no está definida";
        continue;
      }
      const encontrado = planesReales.find(p => p.id === id);
      if (encontrado) {
        veredicto[tier] = `✅ existe · estado: ${encontrado.estado}`;
      } else {
        veredicto[tier] = "❌ NO existe en esta cuenta de PayPal";
      }
    }

    return res.status(200).json({
      ok: true,
      entorno,
      totalPlanesEnLaCuenta: planesData.total_items ?? planesReales.length,
      planesReales,
      configurados,
      veredicto,
      leeme: "Comparar 'configurados' contra 'planesReales'. Si un Plan ID no aparece en la lista, o el plan no está ACTIVE, ahí está el problema.",
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "Error inesperado en el diagnóstico.",
      detalle: String(error && error.message ? error.message : error),
      entorno,
      configurados,
    });
  }
};
