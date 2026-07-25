// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA — HERRAMIENTA TEMPORAL · crear SOLO el plan Enterprise en Mercado Pago
// ────────────────────────────────────────────────────────────────────────────
// URL:  https://www.epimeleia.world/api/diag-crear-enterprise-mp?crear=si
//
// ⚠️ ARCHIVO DESCARTABLE. Se sube, se usa UNA vez, y se BORRA del repo.
//
// POR QUÉ EXISTE:
//   diag-crear-planes-mp.js creó bien Base, Pro y Corporate, pero Enterprise
//   falló: en pesos serían 2.880.000, y Mercado Pago SANDBOX tiene un techo de
//   $ 2.000.000 por transacción ("Cannot pay an amount greater than
//   $ 2000000.00"). Es un límite de la cuenta de prueba, no del diseño.
//
//   Este archivo crea SOLO Enterprise, con un precio de prueba que entra bajo
//   el techo (1.999.000 ARS). En sandbox el número exacto no importa: lo que
//   se prueba es que el flujo del tier más caro funcione. El precio REAL de
//   Enterprise se define en producción, donde ese techo de sandbox no aplica.
//
//   ⚠️ NO corras diag-crear-planes-mp.js de nuevo: crearía duplicados de los
//      tres que ya salieron bien. Este archivo toca ÚNICAMENTE Enterprise.
//
// ⚠️ CANDADO 1: no se dispara solo. Sin ?crear=si, solo muestra qué haría.
// ⚠️ CANDADO 2: si no está MP_ACCESS_TOKEN_TEST, se niega a correr.
//
// VARIABLE DE ENTORNO NECESARIA:
//   MP_ACCESS_TOKEN_TEST
// ────────────────────────────────────────────────────────────────────────────

const MP_API = "https://api.mercadopago.com";
const BASE_URL = "https://www.epimeleia.world";

// Precio de prueba para Enterprise: entra bajo el techo de sandbox (2.000.000).
// El precio real (2.880.000 con el cambio 1600, o el que definas) va en
// producción, donde el techo de sandbox no aplica.
const PRECIO_ENTERPRISE_PRUEBA = 1999000;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const token = process.env.MP_ACCESS_TOKEN_TEST;

  if (!token) {
    return res.status(500).json({
      ok: false,
      error: "Falta MP_ACCESS_TOKEN_TEST en Vercel. Cargala y hacé Redeploy antes de usar esto.",
    });
  }

  const url = new URL(req.url, BASE_URL);
  if (url.searchParams.get("crear") !== "si") {
    return res.status(200).json({
      ok: false,
      aviso: "Esta herramienta CREA el plan Enterprise en Mercado Pago. Para ejecutarla, agregá ?crear=si al final de la URL.",
      creara: `EPIMELEIA Enterprise · ARS ${PRECIO_ENTERPRISE_PRUEBA.toLocaleString('es-AR')}/mes (precio de PRUEBA, bajo el techo de sandbox) · 1 mes gratis`,
      nota: "El precio real de Enterprise se define en producción. En sandbox solo importa que el flujo funcione.",
      entorno: token.startsWith("TEST-") ? "prueba (TEST-)" : "⚠️ NO es TEST — revisá la credencial",
    });
  }

  try {
    const cuerpo = {
      reason: "EPIMELEIA Enterprise",
      auto_recurring: {
        frequency: 1,
        frequency_type: "months",
        transaction_amount: PRECIO_ENTERPRISE_PRUEBA,
        currency_id: "ARS",
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
      return res.status(200).json({
        ok: true,
        entorno: token.startsWith("TEST-") ? "prueba (TEST-)" : "⚠️ no es TEST",
        creado: {
          tier: "enterprise",
          nombre: "EPIMELEIA Enterprise",
          planId: data.id,
          estado: data.status,
          precioMensualARS: PRECIO_ENTERPRISE_PRUEBA,
          variableDeEntorno: "MP_PLAN_ENTERPRISE",
        },
        paraVercel: { MP_PLAN_ENTERPRISE: data.id },
        siguientePaso: "Sumar MP_PLAN_ENTERPRISE a Vercel junto con los otros tres, hacer Redeploy, y BORRAR los archivos de diagnóstico.",
      });
    }

    return res.status(resp.status).json({
      ok: false,
      error: "Mercado Pago rechazó la creación de Enterprise.",
      status: resp.status,
      detalle: data,
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "Error inesperado creando Enterprise.",
      detalle: String(error && error.message ? error.message : error),
    });
  }
};
