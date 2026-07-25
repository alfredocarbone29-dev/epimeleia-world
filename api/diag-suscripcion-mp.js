// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA — DIAGNÓSTICO TEMPORAL · probar crear-suscripcion-mp (opción A)
// ────────────────────────────────────────────────────────────────────────────
// URL:  https://www.epimeleia.world/api/diag-suscripcion-mp
//
// ⚠️ DESCARTABLE. Solo LEE Supabase y crea una suscripción de PRUEBA en
//    Mercado Pago (sin plan asociado). No toca el activo.
//
// Método SIN plan asociado (opción A): el precio va en la suscripción y se
// devuelve init_point, igual que hará crear-suscripcion-mp.js.
// ────────────────────────────────────────────────────────────────────────────

const { createClient } = require("@supabase/supabase-js");
const { calcularPrecio } = require("../lib/precios");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MP_API = "https://api.mercadopago.com";
const BASE_URL = process.env.EPIMELEIA_BASE_URL || "https://www.epimeleia.world";
const TIPO_CAMBIO = 1600;
const TECHO_SANDBOX_ARS = 2000000;

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const token = process.env.MP_ACCESS_TOKEN_TEST;
  if (!token) return res.status(500).json({ ok: false, error: "Falta MP_ACCESS_TOKEN_TEST." });

  try {
    // Buscar un activo firmado con superficie.
    const { data: activos, error: errBusq } = await supabase
      .from("activos")
      .select("id, nombre_activo, hash_firma, superficie_ha")
      .not("hash_firma", "is", null)
      .not("superficie_ha", "is", null)
      .limit(10);

    if (errBusq) return res.status(500).json({ ok: false, paso: "buscar activo", detalle: errBusq.message });
    if (!activos || activos.length === 0) {
      return res.status(200).json({ ok: false, error: "No hay activos firmados con superficie para probar." });
    }

    // Preferir uno cuyo precio en pesos entre bajo el techo de sandbox.
    let elegido = null;
    for (const a of activos) {
      const ha = Number(a.superficie_ha);
      if (!(ha > 0)) continue;
      const p = calcularPrecio(ha, "AR");
      if (p.ok && p.precioMensualUSD * TIPO_CAMBIO <= TECHO_SANDBOX_ARS) { elegido = { a, p }; break; }
    }
    // Si ninguno entra, usar el primero válido igual (para ver el error real).
    if (!elegido) {
      const a = activos.find(x => Number(x.superficie_ha) > 0) || activos[0];
      elegido = { a, p: calcularPrecio(Number(a.superficie_ha), "AR") };
    }

    const activo = elegido.a;
    const precio = elegido.p;
    const superficieHa = Number(activo.superficie_ha);

    if (!precio.ok) {
      return res.status(200).json({ ok: false, paso: "calcular precio", detalle: precio.motivo });
    }

    const precioARS = precio.precioMensualUSD * TIPO_CAMBIO;
    const email = "test_comprador@testuser.com";

    const cuerpo = {
      reason: `EPIMELEIA ${precio.tier.nombre}`,
      external_reference: `${activo.id}|${email}|${precio.tier.id}`,
      payer_email: email,
      back_url: `${BASE_URL}/protocolo.html?suscripcion=ok&activo=${activo.id}`,
      status: "pending",
      auto_recurring: {
        frequency: 1,
        frequency_type: "months",
        transaction_amount: precioARS,
        currency_id: "ARS",
      },
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
        contexto: { activo: activo.id, superficieHa, tier: precio.tier.nombre, precioARS },
      });
    }

    const initPoint = subData.init_point || subData.sandbox_init_point || null;

    return res.status(200).json({
      ok: !!initPoint,
      resumen: initPoint
        ? "✅ Mercado Pago creó la suscripción y devolvió la ventana de pago."
        : "⚠️ Suscripción creada pero sin init_point.",
      activoProbado: {
        id: activo.id, nombre: activo.nombre_activo,
        superficieHa, tier: precio.tier.nombre, precioARS,
      },
      subscriptionId: subData.id,
      estado: subData.status,
      initPoint,
      comoProbar: initPoint
        ? "Abrir initPoint en ventana de incógnito, entrar con la CUENTA COMPRADORA de prueba, y pagar con una tarjeta de prueba de Mercado Pago."
        : null,
    });

  } catch (error) {
    return res.status(500).json({
      ok: false, error: "Error inesperado.",
      detalle: String(error && error.message ? error.message : error),
    });
  }
};
