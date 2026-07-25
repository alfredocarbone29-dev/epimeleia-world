// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA — HERRAMIENTA TEMPORAL · crear los 4 planes en Mercado Pago
// ────────────────────────────────────────────────────────────────────────────
// URL:  https://www.epimeleia.world/api/diag-crear-planes-mp?crear=si
//
// ⚠️ ARCHIVO DESCARTABLE. Se sube, se usa UNA vez, y se BORRA del repo.
//    Es el gemelo de diag-crear-planes.js (el que usamos para PayPal).
//
// POR QUÉ POR API Y NO A MANO:
//   Igual que con PayPal — usa EXACTAMENTE las mismas credenciales que va a
//   usar el resto del sistema (MP_ACCESS_TOKEN_TEST). Así es imposible que
//   los planes queden en una cuenta y las credenciales en otra (el lío que
//   nos costó una noche con PayPal). Y los IDs los devuelve Mercado Pago por
//   escrito: no hay que copiarlos de una pantalla.
//
// QUÉ CREA (decisión del fundador — mismos tiers, en USD):
//   Base        USD  180/mes
//   Pro         USD  450/mes
//   Corporate   USD  900/mes
//   Enterprise  USD 1800/mes
//   Todos: mensuales, moneda USD, con 1 mes gratis (free_trial de 1 mes).
//
// DIFERENCIAS CON PAYPAL (por si te las preguntás):
//   · Mercado Pago no tiene "producto" aparte: el plan lleva todo.
//   · El mes gratis se hace con "free_trial", no con un ciclo de precio cero.
//   · Cada plan necesita un back_url (a dónde vuelve el cliente). Se usa el
//     mismo protocolo.html que ya usa PayPal.
//
// ⚠️ CANDADO 1: no se dispara solo. Sin ?crear=si, solo muestra qué haría.
// ⚠️ CANDADO 2: si no está MP_ACCESS_TOKEN_TEST, se niega a correr.
//
// VARIABLE DE ENTORNO NECESARIA:
//   MP_ACCESS_TOKEN_TEST   (el Access Token de prueba, empieza con TEST-)
// ────────────────────────────────────────────────────────────────────────────

const MP_API = "https://api.mercadopago.com";

const BASE_URL = "https://www.epimeleia.world";

// Los cuatro tiers, con el nombre de la variable de entorno donde va a vivir
// cada Plan ID una vez creado (las cargás en Vercel después, con lo que
// devuelva este archivo).
const PLANES = [
  { tier: "base",       nombre: "EPIMELEIA Base",       precio: 180,  env: "MP_PLAN_BASE" },
  { tier: "pro",        nombre: "EPIMELEIA Pro",        precio: 450,  env: "MP_PLAN_PRO" },
  { tier: "corporate",  nombre: "EPIMELEIA Corporate",  precio: 900,  env: "MP_PLAN_CORPORATE" },
  { tier: "enterprise", nombre: "EPIMELEIA Enterprise", precio: 1800, env: "MP_PLAN_ENTERPRISE" },
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
      creara: PLANES.map(p => `${p.nombre} · USD ${p.precio}/mes · 1 mes gratis`),
      entorno: token.startsWith("TEST-") ? "prueba (TEST-)" : "⚠️ NO es TEST — revisá la credencial",
    });
  }

  // Aviso suave si la credencial no parece de prueba (no frena, solo avisa).
  const esPrueba = token.startsWith("TEST-");

  try {
    const creados = [];
    const fallados = [];

    for (const p of PLANES) {
      // El cuerpo del plan de suscripción (preapproval_plan) de Mercado Pago.
      const cuerpo = {
        reason: p.nombre,                          // lo que ve el cliente en el checkout
        auto_recurring: {
          frequency: 1,
          frequency_type: "months",
          transaction_amount: p.precio,
          currency_id: "USD",
          free_trial: {
            frequency: 1,
            frequency_type: "months",              // 1 mes gratis
          },
        },
        back_url: `${BASE_URL}/protocolo.html?suscripcion=ok`,
        // status ACTIVE para que el plan quede listo para usarse.
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
          precioMensualUSD: p.precio,
          variableDeEntorno: p.env,
        });
      } else {
        fallados.push({ tier: p.tier, status: resp.status, detalle: data });
      }
    }

    // Lo que hay que pegar en Vercel, listo para copiar.
    const paraVercel = {};
    for (const c of creados) paraVercel[c.variableDeEntorno] = c.planId;

    return res.status(200).json({
      ok: fallados.length === 0,
      entorno: esPrueba ? "prueba (TEST-)" : "⚠️ la credencial no empieza con TEST-",
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
