// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA V3.4 — Crear suscripción de Mercado Pago (Estación 3 · Argentina)
// ────────────────────────────────────────────────────────────────────────────
// URL pública:  https://www.epimeleia.world/api/crear-suscripcion-mp
//
// QUÉ HACE:
//   El gemelo de crear-suscripcion.js (PayPal), para clientes de Argentina.
//   Recibe un activo ya registrado y firmado (Estaciones 1 y 2), calcula qué
//   tier le corresponde según su SUPERFICIE, elige el plan de Mercado Pago de
//   ese tier, y crea la suscripción. Devuelve el init_point: la URL donde el
//   cliente pone su tarjeta.
//
//   superficie → precios.js → tier → variable MP_PLAN_* → plan → init_point
//
// ════════════════════════════════════════════════════════════════════════════
// POR QUÉ ES UN ARCHIVO SEPARADO DEL DE PAYPAL
// ════════════════════════════════════════════════════════════════════════════
//   Argentina → Mercado Pago → pesos (ARS)
//   Resto     → PayPal       → dólares (USD)
//
//   Son dos flujos con reglas distintas: Mercado Pago Argentina NO opera en
//   USD (lo rechaza). Por eso los precios de Mercado Pago están en pesos, y
//   viven en los planes ya creados en la cuenta. La bifurcación por país la
//   hace el frontend: manda a los argentinos acá, y al resto al de PayPal.
//
// ════════════════════════════════════════════════════════════════════════════
// LO QUE SE MANTIENE IGUAL QUE PAYPAL (a propósito, son hermanos)
// ════════════════════════════════════════════════════════════════════════════
//   · MISMA regla del fundador: SIN FIRMA NO HAY PAGO. Se verifica contra
//     Supabase que el activo tenga hash_firma. No se confía en el navegador.
//   · MISMO lib/precios.js para calcular el tier según superficie (con la
//     tolerancia del 5%). El tier es el mismo en los dos flujos; lo único que
//     cambia es en qué moneda y con qué plan se cobra.
//   · MISMO external_reference que el custom_id de PayPal: "activoId|email|tier".
//     Viaja con la suscripción y vuelve en el webhook, para saber QUÉ activo
//     se pagó sin adivinar.
//
// ════════════════════════════════════════════════════════════════════════════
// LO QUE MERCADO PAGO HACE DISTINTO
// ════════════════════════════════════════════════════════════════════════════
//   · No hay "sandbox URL" aparte: es la misma API. Lo que cambia es la
//     credencial (MP_ACCESS_TOKEN_TEST vs la de producción).
//   · La suscripción se crea con POST /preapproval, atada a un plan por
//     preapproval_plan_id.
//   · Necesita payer_email (el email del que paga).
//   · Devuelve init_point (equivalente exacto del approvalUrl de PayPal).
//
// VARIABLES DE ENTORNO NECESARIAS:
//   MP_ACCESS_TOKEN_TEST       Access Token de prueba (TEST-). En producción,
//                              se cambia por el de producción (ver MP_ACCESS_TOKEN_PROD).
//   MP_ACCESS_TOKEN_PROD       (opcional) Access Token de producción.
//   MP_ENV                     "live" para usar el de producción; cualquier otra
//                              cosa = prueba. (default: prueba)
//   MP_PLAN_BASE               Plan ID de Mercado Pago del tier Base
//   MP_PLAN_PRO                Plan ID del tier Pro
//   MP_PLAN_CORPORATE          Plan ID del tier Corporate
//   MP_PLAN_ENTERPRISE         Plan ID del tier Enterprise
//   EPIMELEIA_BASE_URL         (opcional) default https://www.epimeleia.world
//
// QUÉ RECIBE (POST, JSON):
//   {
//     activoId:     "<uuid de la fila en activos>",   (requerido)
//     email:        "titular@dominio.com",            (requerido)
//     superficieHa: 1234.56,                          (requerido)
//     pais:         "AR"                               (opcional, para la leyenda)
//   }
// ────────────────────────────────────────────────────────────────────────────

const { createClient } = require("@supabase/supabase-js");
const { calcularPrecio } = require("../lib/precios");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MP_API = "https://api.mercadopago.com";

const BASE_URL = process.env.EPIMELEIA_BASE_URL || "https://www.epimeleia.world";

// Prueba salvo que se diga explícitamente "live".
function obtenerToken() {
  const esLive = process.env.MP_ENV === "live";
  const token = esLive
    ? process.env.MP_ACCESS_TOKEN_PROD
    : process.env.MP_ACCESS_TOKEN_TEST;
  if (!token) {
    throw new Error(
      esLive
        ? "Falta MP_ACCESS_TOKEN_PROD (MP_ENV=live)."
        : "Falta MP_ACCESS_TOKEN_TEST."
    );
  }
  return token;
}

// El Plan ID de Mercado Pago según el tier. Lee la variable MP_PLAN_* que
// corresponde. Mismo criterio que planIdDePayPal en precios.js: si falta, lo
// DICE, no inventa. (Se lee acá y no en precios.js para no tocar ese archivo,
// que es compartido con el flujo de PayPal y es delicado.)
function planIdDeMercadoPago(tierId) {
  const mapa = {
    base:       "MP_PLAN_BASE",
    pro:        "MP_PLAN_PRO",
    corporate:  "MP_PLAN_CORPORATE",
    enterprise: "MP_PLAN_ENTERPRISE",
  };
  const envName = mapa[tierId];
  if (!envName) {
    return { ok: false, motivo: `No existe el tier "${tierId}".` };
  }
  const planId = process.env[envName];
  if (!planId) {
    return {
      ok: false,
      motivo: `Falta la variable de entorno ${envName} (Plan ID de Mercado Pago para el tier ${tierId}).`,
      envPlan: envName,
    };
  }
  return { ok: true, planId, envPlan: envName };
}

// ─── Handler ─────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const activoId     = body.activoId;
    const email        = (body.email || "").toLowerCase().trim();
    const superficieHa = Number(body.superficieHa);
    const pais         = body.pais || "AR";

    // ── Validaciones ──────────────────────────────────────────────
    if (!activoId) {
      return res.status(400).json({ ok: false, error: "Falta activoId." });
    }
    if (!email || !email.includes("@")) {
      return res.status(400).json({ ok: false, error: "Falta un email válido." });
    }
    if (!isFinite(superficieHa) || superficieHa <= 0) {
      return res.status(400).json({ ok: false, error: "Falta la superficie del activo." });
    }

    // ── SIN FIRMA NO HAY PAGO ─────────────────────────────────────
    // Igual que en PayPal: se verifica contra Supabase que el deslinde esté
    // firmado. No se confía en lo que diga el navegador.
    const { data: activo, error: errActivo } = await supabase
      .from("activos")
      .select("id, nombre_activo, hash_firma, firma_version, superficie_ha")
      .eq("id", activoId)
      .maybeSingle();

    if (errActivo) {
      console.error("[crear-suscripcion-mp] Error leyendo el activo:", errActivo.message);
      return res.status(500).json({ ok: false, error: "No se pudo verificar el activo." });
    }
    if (!activo) {
      return res.status(404).json({ ok: false, error: "Ese activo no existe." });
    }
    if (!activo.hash_firma) {
      return res.status(400).json({
        ok: false,
        error: "Este activo no tiene el deslinde firmado. Sin aceptación no hay pago.",
      });
    }

    // ── El precio, según la superficie ────────────────────────────
    // MISMO cálculo de tier que PayPal (mismo lib/precios.js). El tier es el
    // mismo; lo que cambia es la moneda y el plan con que se cobra.
    const precio = calcularPrecio(superficieHa, pais);

    if (!precio.ok) {
      return res.status(400).json({
        ok: false,
        error: precio.motivo,
        superaMaximo: precio.superaMaximo || false,
      });
    }

    // ── El plan de Mercado Pago de ese tier ───────────────────────
    const plan = planIdDeMercadoPago(precio.tier.id);
    if (!plan.ok) {
      console.error("[crear-suscripcion-mp] " + plan.motivo);
      return res.status(500).json({
        ok: false,
        error: "El plan de pago de este tier no está configurado en Mercado Pago. Avisale al equipo.",
        detalle: plan.motivo,
      });
    }

    // ── Crear la suscripción en Mercado Pago ──────────────────────
    const token = obtenerToken();

    // external_reference: el gemelo del custom_id de PayPal. Viaja con la
    // suscripción y vuelve en el webhook. Formato: "activoId|email|tier".
    const externalReference = `${activoId}|${email}|${precio.tier.id}`;

    const cuerpo = {
      preapproval_plan_id: plan.planId,
      reason: `EPIMELEIA ${precio.tier.nombre}`,
      external_reference: externalReference,
      payer_email: email,
      back_url: `${BASE_URL}/protocolo.html?suscripcion=ok&activo=${activoId}`,
    };

    const subResp = await fetch(`${MP_API}/preapproval`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(cuerpo),
    });

    const subData = await subResp.json();

    if (!subResp.ok) {
      console.error("[crear-suscripcion-mp] Mercado Pago rechazó la creación:", JSON.stringify(subData));
      return res.status(502).json({
        ok: false,
        error: "Mercado Pago no pudo crear la suscripción.",
        detalle: subData?.message || "Error desconocido de Mercado Pago",
      });
    }

    // El link donde el cliente pone su tarjeta (equivalente al approvalUrl).
    const initPoint = subData.init_point || subData.sandbox_init_point || null;

    if (!initPoint) {
      console.error("[crear-suscripcion-mp] Suscripción creada sin init_point:", JSON.stringify(subData));
      return res.status(502).json({
        ok: false,
        error: "Mercado Pago creó la suscripción pero no devolvió la ventana de pago.",
      });
    }

    // ── Guardar el tier y el precio en el activo ──────────────────
    // Igual que PayPal: constancia de qué se cobró. No frena el pago si falla.
    // Nota: precio_anual_dolar guarda el valor en USD del tier (la referencia
    // interna es siempre USD); la moneda con que se cobró queda como ARS.
    const { error: errUpd } = await supabase
      .from("activos")
      .update({
        tier:                precio.tier.nombre,
        precio_anual_dolar:  precio.precioAnualUSD,
        moneda:              "ARS",
      })
      .eq("id", activoId);

    if (errUpd) {
      console.error("[crear-suscripcion-mp] No se pudo guardar el tier en el activo:", errUpd.message);
    }

    console.log(
      `[crear-suscripcion-mp] Suscripción ${subData.id} creada · activo ${activoId} · ` +
      `${superficieHa} ha → tier ${precio.tier.nombre} · plan ${plan.planId}`
    );

    // ── Respuesta al frontend ─────────────────────────────────────
    return res.status(200).json({
      ok: true,
      subscriptionId: subData.id,
      approvalUrl: initPoint,         // ← el frontend manda al cliente acá (mismo nombre que PayPal)
      initPoint,                      // ← alias explícito de Mercado Pago
      activoId,
      email,
      superficieHa,
      tier: {
        id:     precio.tier.id,
        nombre: precio.tier.nombre,
      },
      precio: {
        mensualUSD: precio.precioMensualUSD,
        anualUSD:   precio.precioAnualUSD,
        enTolerancia: precio.enTolerancia,
        nota: precio.nota,
      },
      moneda: "ARS",
      leyendaImpuestos: precio.leyendaImpuestos,
      mensaje: "Suscripción creada. Redirigí al cliente a approvalUrl (init_point) para que confirme el pago.",
    });

  } catch (error) {
    console.error("[crear-suscripcion-mp] Error:", error);
    return res.status(500).json({
      ok: false,
      error: "Error interno al crear la suscripción.",
    });
  }
};
