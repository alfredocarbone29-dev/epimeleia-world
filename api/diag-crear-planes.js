// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA — HERRAMIENTA TEMPORAL · crear el producto y los 4 planes
// ────────────────────────────────────────────────────────────────────────────
// URL:  https://epimeleia.world/api/diag-crear-planes?crear=si
//
// ⚠️ ARCHIVO DESCARTABLE. Se sube, se usa UNA vez, y se BORRA del repo.
//
// POR QUÉ EXISTE:
//   El diagnóstico probó que en la cuenta sandbox de este CLIENT_ID no hay
//   ni producto ni planes (0 productos, los 4 Plan IDs dan 404). Se crearon
//   en otro lado. Un plan de Live NO sirve contra sandbox: son dos mundos
//   separados. Así que para probar el pago hacen falta planes de acá.
//
// POR QUÉ POR API Y NO A MANO:
//   Porque usa EXACTAMENTE las mismas credenciales que Vercel. Es imposible
//   que los planes queden en otra cuenta. Y los Plan IDs los devuelve PayPal
//   por escrito: no hay que copiarlos de una pantalla (que es como se coló
//   el problema la primera vez).
//
// ⚠️ CANDADO: si PAYPAL_ENV = "live", este archivo se NIEGA a correr.
//    Los planes de producción no se crean con una herramienta descartable.
//
// LO QUE CREA (decisión del fundador, 20/7):
//   Producto: EPIMELEIA
//   Base        USD  180/mes   ·  1 mes gratis
//   Pro         USD  450/mes   ·  1 mes gratis
//   Corporate   USD  900/mes   ·  1 mes gratis
//   Enterprise  USD 1800/mes   ·  1 mes gratis
//   Todos: USD, mensual, ciclos ilimitados, sin impuestos configurados.
//
// SOBRE CAMBIAR PRECIOS DESPUÉS:
//   Se puede. PayPal permite actualizar el precio de un plan existente, o
//   crear un plan nuevo y migrar suscriptores. OJO: el precio vive en DOS
//   lugares — lib/precios.js (lo que se MUESTRA) y el plan de PayPal (lo que
//   se COBRA). Si cambia uno, cambia el otro. Si no, se muestra una cosa y
//   se cobra otra.
// ────────────────────────────────────────────────────────────────────────────

const PAYPAL_BASE = process.env.PAYPAL_ENV === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

// Los cuatro tiers, con el nombre de su variable de entorno.
const PLANES = [
  { tier: "base",       nombre: "EPIMELEIA Base",       precio: "180.00",  env: "PAYPAL_PLAN_BASE",
    desc: "Certificacion satelital inmutable · hasta 500 ha" },
  { tier: "pro",        nombre: "EPIMELEIA Pro",        precio: "450.00",  env: "PAYPAL_PLAN_PRO",
    desc: "Certificacion satelital inmutable · 500 a 5.000 ha" },
  { tier: "corporate",  nombre: "EPIMELEIA Corporate",  precio: "900.00",  env: "PAYPAL_PLAN_CORPORATE",
    desc: "Certificacion satelital inmutable · 5.000 a 25.000 ha" },
  { tier: "enterprise", nombre: "EPIMELEIA Enterprise", precio: "1800.00", env: "PAYPAL_PLAN_ENTERPRISE",
    desc: "Certificacion satelital inmutable · 25.000 a 62.500 ha" },
];

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  // ── CANDADO 1 · nunca en producción ─────────────────────────────
  if (process.env.PAYPAL_ENV === "live") {
    return res.status(403).json({
      ok: false,
      error: "PAYPAL_ENV esta en 'live'. Esta herramienta solo corre en sandbox.",
    });
  }

  // ── CANDADO 2 · no se dispara sola ──────────────────────────────
  const url = new URL(req.url, "https://epimeleia.world");
  if (url.searchParams.get("crear") !== "si") {
    return res.status(200).json({
      ok: false,
      aviso: "Esta herramienta CREA cosas en PayPal sandbox. Para ejecutarla, agrega ?crear=si al final de la URL.",
      creara: PLANES.map(p => `${p.nombre} · USD ${p.precio}/mes · 1 mes gratis`),
    });
  }

  const clientId     = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(500).json({ ok: false, error: "Faltan las credenciales de PayPal." });
  }

  try {
    // ── Token ─────────────────────────────────────────────────────
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
      return res.status(502).json({ ok: false, paso: "token", detalle: tokenData });
    }
    const token = tokenData.access_token;

    // ── 1 · El producto ───────────────────────────────────────────
    const prodResp = await fetch(`${PAYPAL_BASE}/v1/catalogs/products`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": `epi-prod-${Date.now()}`,
      },
      body: JSON.stringify({
        name: "EPIMELEIA",
        description: "Notario ambiental digital. Certificacion satelital sellada en blockchain.",
        type: "SERVICE",
        category: "SOFTWARE",
        home_url: "https://epimeleia.world",
      }),
    });
    const prodData = await prodResp.json();
    if (!prodResp.ok) {
      return res.status(502).json({ ok: false, paso: "crear producto", detalle: prodData });
    }
    const productId = prodData.id;

    // ── 2 · Los cuatro planes ─────────────────────────────────────
    const creados = [];
    const fallados = [];

    for (const p of PLANES) {
      const planResp = await fetch(`${PAYPAL_BASE}/v1/billing/plans`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "PayPal-Request-Id": `epi-plan-${p.tier}-${Date.now()}`,
        },
        body: JSON.stringify({
          product_id: productId,
          name: p.nombre,
          description: p.desc,
          status: "ACTIVE",
          billing_cycles: [
            {
              // El mes gratis. Un solo ciclo, precio cero.
              frequency: { interval_unit: "MONTH", interval_count: 1 },
              tenure_type: "TRIAL",
              sequence: 1,
              total_cycles: 1,
              pricing_scheme: { fixed_price: { value: "0", currency_code: "USD" } },
            },
            {
              // El cobro real, para siempre (total_cycles 0 = sin limite).
              frequency: { interval_unit: "MONTH", interval_count: 1 },
              tenure_type: "REGULAR",
              sequence: 2,
              total_cycles: 0,
              pricing_scheme: { fixed_price: { value: p.precio, currency_code: "USD" } },
            },
          ],
          payment_preferences: {
            auto_bill_outstanding: true,
            setup_fee: { value: "0", currency_code: "USD" },
            setup_fee_failure_action: "CONTINUE",
            payment_failure_threshold: 3,
          },
        }),
      });

      const planData = await planResp.json();

      if (planResp.ok) {
        creados.push({
          tier: p.tier,
          nombre: p.nombre,
          planId: planData.id,
          estado: planData.status,
          precioMensualUSD: p.precio,
          variableDeEntorno: p.env,
        });
      } else {
        fallados.push({ tier: p.tier, detalle: planData });
      }
    }

    // ── 3 · Lo que hay que pegar en Vercel ────────────────────────
    const paraVercel = {};
    for (const c of creados) paraVercel[c.variableDeEntorno] = c.planId;

    return res.status(200).json({
      ok: fallados.length === 0,
      entorno: PAYPAL_BASE,
      productoCreado: { id: productId, nombre: prodData.name },
      creados,
      fallados,
      paraVercel,
      siguientePaso: "Copiar 'paraVercel' a las variables de entorno de Vercel, hacer Redeploy, y recien ahi probar el pago. Despues, BORRAR este archivo del repo.",
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "Error inesperado.",
      detalle: String(error?.message || error),
    });
  }
};
