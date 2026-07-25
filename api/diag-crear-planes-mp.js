// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA — HERRAMIENTA TEMPORAL · crear los 4 planes en Mercado Pago
// ────────────────────────────────────────────────────────────────────────────
// URL:  https://www.epimeleia.world/api/diag-crear-planes-mp?crear=si
//
// ⚠️ ARCHIVO DESCARTABLE. Se sube, se usa UNA vez, y se BORRA del repo.
//    Es el gemelo de diag-crear-planes.js (el que usamos para PayPal).
//
// ════════════════════════════════════════════════════════════════════════════
// MONEDA: PESOS ARGENTINOS (ARS)
// ════════════════════════════════════════════════════════════════════════════
//   Mercado Pago Argentina (MLA) NO opera en USD — lo rechaza con
//   "Cannot operate with currency id USD in MLA". Por eso los planes de
//   Mercado Pago van en ARS.
//
//   El valor en pesos es el precio en USD × un tipo de cambio. Para la PRUEBA
//   se usa un cambio SIMBÓLICO de 1600. El valor REAL (contemplando las
//   comisiones de Mercado Pago) lo define el fundador antes de producción, y
//   se cambia acá, en un solo lugar.
//
//   ⚠️ RECORDATORIO: el precio en pesos NO se actualiza solo. Con la
//   inflación hay que revisarlo. Además vive en DOS lugares: el plan de
//   Mercado Pago (lo que se cobra) y lib/precios.js si algún día se muestra
//   el precio en pesos en el frontend (lo que se ve). Si cambia uno, cambia
//   el otro.
//
//   PayPal (resto del mundo) sigue en USD. Son dos flujos separados:
//     Argentina → Mercado Pago → ARS
//     Resto     → PayPal       → USD
// ════════════════════════════════════════════════════════════════════════════
//
// QUÉ CREA:
//   Base        ARS  288.000/mes   (180  × 1600)
//   Pro         ARS  720.000/mes   (450  × 1600)
//   Corporate   ARS 1.440.000/mes  (900  × 1600)
//   Enterprise  ARS 2.880.000/mes  (1800 × 1600)
//   Todos: mensuales, con 1 mes gratis (free_trial de 1 mes).
//
// ⚠️ CANDADO 1: no se dispara solo. Sin ?crear=si, solo muestra qué haría.
// ⚠️ CANDADO 2: si no está MP_ACCESS_TOKEN_TEST, se niega a correr.
//
// VARIABLE DE ENTORNO NECESARIA:
//   MP_ACCESS_TOKEN_TEST   (el Access Token de prueba, empieza con TEST-)
// ────────────────────────────────────────────────────────────────────────────

const MP_API = "https://api.mercadopago.com";

const BASE_URL = "https://www.epimeleia.world";

// El tipo de cambio simbólico para la prueba. El real lo define el fundador.
const TIPO_CAMBIO = 1600;

// Los cuatro tiers. El precio en pesos se calcula: USD × TIPO_CAMBIO.
const PLANES = [
  { tier: "base",       nombre: "EPIMELEIA Base",       usd: 180,  env: "MP_PLAN_BASE" },
  { tier: "pro",        nombre: "EPIMELEIA Pro",        usd: 450,  env: "MP_PLAN_PRO" },
  { tier: "corporate",  nombre: "EPIMELEIA Corporate",  usd: 900,  env: "MP_PLAN_CORPORATE" },
  { tier: "enterprise", nombre: "EPIMELEIA Enterprise", usd: 1800, env: "MP_PLAN_ENTERPRISE" },
];

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const token = process.env.MP_ACCESS_TOKEN_TEST;

  // ── CANDADO 2 · sin credencial, no corre ────────────────────────
  if (!token) {
    return res.status(500).json({
      ok: false,
      error: "Falta MP_ACCESS_TOKEN_TEST en Vercel. Cargala y hacé Redeploy antes de usar esto.",
    });
  }

  // ── CANDADO 1 · no se dispara sola ──────────────────────────────
  const url = new URL(req.url, BASE_URL);
  if (url.searchParams.get("crear") !== "si") {
    return res.status(200).json({
      ok: false,
      aviso: "Esta herramienta CREA planes en Mercado Pago. Para ejecutarla, agregá ?crear=si al final de la URL.",
      tipoCambio: TIPO_CAMBIO,
      creara: PLANES.map(p => `${p.nombre} · ARS ${(p.usd * TIPO_CAMBIO).toLocaleString('es-AR')}/mes (USD ${p.usd} × ${TIPO_CAMBIO}) · 1 mes gratis`),
      entorno: token.startsWith("TEST-") ? "prueba (TEST-)" : "⚠️ NO es TEST — revisá la credencial",
    });
  }

  const esPrueba = token.startsWith("TEST-");

  try {
    const creados = [];
    const fallados = [];

    for (const p of PLANES) {
      const precioARS = p.usd * TIPO_CAMBIO;

      const cuerpo = {
        reason: p.nombre,
        auto_recurring: {
          frequency: 1,
          frequency_type: "months",
          transaction_amount: precioARS,
          currency_id: "ARS",                        // ← pesos, no dólares
          free_trial: {
            frequency: 1,
            frequency_type: "months",
          },
        },
        back_url: `${BASE_URL}/protocolo.html?suscripcion=ok`,
        status: "active",
      };

      const resp = await fetch(`${MP_API}/preapproval_plan`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(cuerpo),
      });

      const data = await resp.json();

      if (resp.ok && data.id) {
        creados.push({
          tier: p.tier,
          nombre: p.nombre,
          planId: data.id,
          estado: data.status,
          precioMensualARS: precioARS,
          precioMensualUSD: p.usd,
          variableDeEntorno: p.env,
        });
      } else {
        fallados.push({ tier: p.tier, status: resp.status, detalle: data });
      }
    }

    const paraVercel = {};
    for (const c of creados) paraVercel[c.variableDeEntorno] = c.planId;

    return res.status(200).json({
      ok: fallados.length === 0,
      entorno: esPrueba ? "prueba (TEST-)" : "⚠️ la credencial no empieza con TEST-",
      tipoCambio: TIPO_CAMBIO,
      creados,
      fallados,
      paraVercel,
      siguientePaso: fallados.length === 0
        ? "Copiar 'paraVercel' a las variables de entorno de Vercel, hacer Redeploy, y después BORRAR este archivo del repo."
        : "Algún plan falló. Mirar 'fallados' para ver qué dijo Mercado Pago.",
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "Error inesperado creando los planes.",
      detalle: String(error && error.message ? error.message : error),
    });
  }
};
