// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA — DIAGNÓSTICO TEMPORAL · probar crear-suscripcion-mp sin frontend
// ────────────────────────────────────────────────────────────────────────────
// URL:  https://www.epimeleia.world/api/diag-suscripcion-mp
//
// ⚠️ ARCHIVO DESCARTABLE. Se sube, se mira, se BORRA. Solo LEE Supabase y le
//    pide a Mercado Pago que cree una suscripción de prueba. No escribe nada
//    en Supabase (no toca el activo). Es una prueba pura del flujo de pago.
//
// QUÉ HACE:
//   1. Busca en Supabase el primer activo que tenga el deslinde FIRMADO
//      (hash_firma con valor) y una superficie válida.
//   2. Calcula su tier con lib/precios.js.
//   3. Elige el plan de Mercado Pago (MP_PLAN_*) de ese tier.
//   4. Crea la suscripción en Mercado Pago (POST /preapproval).
//   5. Muestra el init_point (la URL donde el cliente pondría la tarjeta).
//
//   Si vuelve un init_point, el flujo de Mercado Pago funciona de punta a
//   punta. Faltaría solo la bifurcación por país en el frontend.
//
// VARIABLES: las mismas que crear-suscripcion-mp.js
//   MP_ACCESS_TOKEN_TEST · MP_PLAN_BASE/PRO/CORPORATE/ENTERPRISE
//   SUPABASE_URL · SUPABASE_SERVICE_KEY
// ────────────────────────────────────────────────────────────────────────────

const { createClient } = require("@supabase/supabase-js");
const { calcularPrecio } = require("../lib/precios");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MP_API = "https://api.mercadopago.com";
const BASE_URL = process.env.EPIMELEIA_BASE_URL || "https://www.epimeleia.world";

function planIdDeMercadoPago(tierId) {
  const mapa = {
    base: "MP_PLAN_BASE", pro: "MP_PLAN_PRO",
    corporate: "MP_PLAN_CORPORATE", enterprise: "MP_PLAN_ENTERPRISE",
  };
  const envName = mapa[tierId];
  if (!envName) return { ok: false, motivo: `No existe el tier "${tierId}".` };
  const planId = process.env[envName];
  if (!planId) return { ok: false, motivo: `Falta ${envName}.`, envPlan: envName };
  return { ok: true, planId, envPlan: envName };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const token = process.env.MP_ACCESS_TOKEN_TEST;
  if (!token) {
    return res.status(500).json({ ok: false, error: "Falta MP_ACCESS_TOKEN_TEST." });
  }

  try {
    // ── 1 · Buscar un activo firmado ──────────────────────────────
    const { data: activos, error: errBusq } = await supabase
      .from("activos")
      .select("id, nombre_activo, hash_firma, superficie_ha, cliente_id")
      .not("hash_firma", "is", null)
      .not("superficie_ha", "is", null)
      .limit(5);

    if (errBusq) {
      return res.status(500).json({ ok: false, paso: "buscar activo", detalle: errBusq.message });
    }
    if (!activos || activos.length === 0) {
      return res.status(200).json({
        ok: false,
        error: "No hay ningún activo firmado con superficie en Supabase para probar.",
      });
    }

    // El primero que tenga superficie > 0.
    const activo = activos.find(a => Number(a.superficie_ha) > 0) || activos[0];
    const superficieHa = Number(activo.superficie_ha);

    // Un email de prueba. En la prueba real, sería el del titular.
    const email = "test_comprador@testuser.com";

    // ── 2 · Tier ──────────────────────────────────────────────────
    const precio = calcularPrecio(superficieHa, "AR");
    if (!precio.ok) {
      return res.status(200).json({
        ok: false, paso: "calcular precio", detalle: precio.motivo,
        activo: { id: activo.id, superficieHa },
      });
    }

    // ── 3 · Plan de Mercado Pago ──────────────────────────────────
    const plan = planIdDeMercadoPago(precio.tier.id);
    if (!plan.ok) {
      return res.status(200).json({ ok: false, paso: "plan", detalle: plan.motivo });
    }

    // ── 4 · Crear la suscripción ──────────────────────────────────
    const externalReference = `${activo.id}|${email}|${precio.tier.id}`;

    const cuerpo = {
      preapproval_plan_id: plan.planId,
      reason: `EPIMELEIA ${precio.tier.nombre}`,
      external_reference: externalReference,
      payer_email: email,
      back_url: `${BASE_URL}/protocolo.html?suscripcion=ok&activo=${activo.id}`,
    };

    const subResp = await fetch(`${MP_API}/preapproval`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo),
    });

    const subData = await subResp.json();

    if (!subResp.ok) {
      return res.status(200).json({
        ok: false,
        paso: "crear suscripción en Mercado Pago",
        status: subResp.status,
        detalle: subData,
        contexto: {
          activo: activo.id,
          superficieHa,
          tier: precio.tier.nombre,
          plan: plan.planId,
        },
      });
    }

    const initPoint = subData.init_point || subData.sandbox_init_point || null;

    // ── 5 · Resultado ─────────────────────────────────────────────
    return res.status(200).json({
      ok: !!initPoint,
      resumen: initPoint
        ? "✅ Mercado Pago creó la suscripción y devolvió la ventana de pago."
        : "⚠️ Se creó la suscripción pero sin init_point.",
      activoProbado: {
        id: activo.id,
        nombre: activo.nombre_activo,
        superficieHa,
        tier: precio.tier.nombre,
      },
      subscriptionId: subData.id,
      estado: subData.status,
      initPoint,
      comoProbar: initPoint
        ? "Abrir initPoint en una ventana de incógnito, iniciar sesión con la CUENTA COMPRADORA de prueba, y pagar con una tarjeta de prueba de Mercado Pago."
        : null,
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: "Error inesperado.",
      detalle: String(error && error.message ? error.message : error),
    });
  }
};
