// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA — DIAGNÓSTICO TEMPORAL v2 · ¿dónde están los planes?
// ────────────────────────────────────────────────────────────────────────────
// URL pública:  https://epimeleia.world/api/diag-planes
//
// ⚠️ ARCHIVO DESCARTABLE. Se sube, se mira, se BORRA. No escribe nada.
//
// NOVEDAD DE LA v2:
//   La v1 pidió la LISTA de planes y volvió vacía. Eso no alcanza para saber
//   si los planes no existen o si el listado no los muestra. Así que ahora:
//
//     1 · pide el token
//     2 · pregunta por CADA plan por su ID, uno por uno (consulta directa)
//     3 · pregunta por el PRODUCTO PROD-38B84030UB484541M
//     4 · pide la lista de productos de la cuenta
//
//   Si el producto tampoco existe → todo se creó en otra cuenta.
//   Si el producto existe pero los planes no → los planes son el problema.
// ────────────────────────────────────────────────────────────────────────────

const PAYPAL_BASE = process.env.PAYPAL_ENV === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

const PRODUCTO_ESPERADO = "PROD-38B84030UB484541M";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const clientId     = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  const configurados = {
    base:       process.env.PAYPAL_PLAN_BASE       || null,
    pro:        process.env.PAYPAL_PLAN_PRO        || null,
    corporate:  process.env.PAYPAL_PLAN_CORPORATE  || null,
    enterprise: process.env.PAYPAL_PLAN_ENTERPRISE || null,
  };

  const entorno = {
    PAYPAL_ENV: process.env.PAYPAL_ENV || "(no definida → sandbox)",
    apuntaA: PAYPAL_BASE,
    clientId: clientId ? `${clientId.slice(0, 8)}…${clientId.slice(-6)}` : "(FALTA)",
  };

  if (!clientId || !clientSecret) {
    return res.status(500).json({ ok: false, error: "Faltan credenciales.", entorno });
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
      return res.status(502).json({ ok: false, paso: "token", detalle: tokenData, entorno });
    }
    const token = tokenData.access_token;
    const auth = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };

    // ── 2 · Cada plan, preguntado DIRECTO por su ID ──────────────
    const planesUnoPorUno = {};
    for (const [tier, id] of Object.entries(configurados)) {
      if (!id) { planesUnoPorUno[tier] = "❌ variable de entorno vacía"; continue; }

      const r = await fetch(`${PAYPAL_BASE}/v1/billing/plans/${id}`, { headers: auth });
      const d = await r.json().catch(() => ({}));

      planesUnoPorUno[tier] = r.ok
        ? `✅ EXISTE · estado: ${d.status} · producto: ${d.product_id} · id consultado: ${id}`
        : `❌ ${r.status} · ${d?.name || ""} · ${d?.message || ""} · id consultado: ${id}`;
    }

    // ── 3 · El producto del brief ────────────────────────────────
    const prodResp = await fetch(`${PAYPAL_BASE}/v1/catalogs/products/${PRODUCTO_ESPERADO}`, { headers: auth });
    const prodData = await prodResp.json().catch(() => ({}));
    const productoEsperado = prodResp.ok
      ? `✅ EXISTE · nombre: ${prodData.name} · id: ${PRODUCTO_ESPERADO}`
      : `❌ ${prodResp.status} · ${prodData?.message || "no encontrado"} · id: ${PRODUCTO_ESPERADO}`;

    // ── 4 · Todos los productos de esta cuenta ───────────────────
    const listaResp = await fetch(`${PAYPAL_BASE}/v1/catalogs/products?page_size=20&total_required=true`, { headers: auth });
    const listaData = await listaResp.json().catch(() => ({}));
    const productosDeLaCuenta = (listaData.products || []).map(p => ({
      id: p.id, nombre: p.name,
    }));

    return res.status(200).json({
      ok: true,
      entorno,
      planesUnoPorUno,
      productoEsperado,
      totalProductosEnLaCuenta: listaData.total_items ?? productosDeLaCuenta.length,
      productosDeLaCuenta,
      leeme: "Si el producto tampoco existe y la cuenta no tiene productos, todo se creo en OTRA cuenta. Si el producto existe, el problema esta solo en los Plan IDs.",
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "Error inesperado.",
      detalle: String(error?.message || error),
      entorno,
    });
  }
};
