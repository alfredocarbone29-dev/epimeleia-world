// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA V3.4 — Crear suscripción de Mercado Pago (Estación 3 · Argentina)
// ────────────────────────────────────────────────────────────────────────────
// URL pública:  https://www.epimeleia.world/api/crear-suscripcion-mp
//
// QUÉ HACE:
//   El gemelo de crear-suscripcion.js (PayPal), para clientes de Argentina.
//   Recibe un activo ya registrado y firmado (Estaciones 1 y 2), calcula qué
//   tier le corresponde según su SUPERFICIE, y crea la suscripción en Mercado
//   Pago. Devuelve el init_point: la URL donde el cliente pone su tarjeta.
//
// ════════════════════════════════════════════════════════════════════════════
// MÉTODO: SUSCRIPCIÓN SIN PLAN ASOCIADO (decisión del fundador, 25/7 — opción A)
// ════════════════════════════════════════════════════════════════════════════
//   Mercado Pago tiene dos formas de suscribir:
//
//   · CON plan asociado (preapproval_plan_id): exige card_token_id, es decir
//     que la tarjeta se capture en NUESTRO sitio (Checkout Bricks). Más
//     control, pero la tarjeta pasa por el frontend.
//
//   · SIN plan asociado (esta): se manda al cliente a Mercado Pago y ahí pone
//     la tarjeta, igual que PayPal. Devuelve init_point. El precio va escrito
//     en CADA suscripción (no lo toma de un plan).
//
//   Se eligió SIN plan asociado (opción A) porque es el flujo tipo PayPal que
//   ya usa EPIMELEIA: mandar al cliente a la ventana del proveedor. No obliga
//   a meter mano en el frontend de captura de tarjeta.
//
//   ⚠️ CONSECUENCIA: los 4 planes MP_PLAN_* que se crearon NO se usan en este
//   método. Quedan por si algún día se pasa al método con plan asociado. El
//   precio se arma acá, a partir del tier (USD) × tipo de cambio.
//
// ════════════════════════════════════════════════════════════════════════════
// EL PRECIO EN PESOS
// ════════════════════════════════════════════════════════════════════════════
//   lib/precios.js calcula el tier y el precio en USD (fuente única de verdad,
//   compartida con PayPal). Mercado Pago Argentina cobra en ARS. Por eso el
//   precio en pesos es: precio USD del tier × TIPO_CAMBIO.
//
//   El TIPO_CAMBIO de acá es SIMBÓLICO (1600), el mismo que se usó para crear
//   los planes. El valor real (con las comisiones de Mercado Pago) lo define
//   el fundador antes de producción, y se cambia en esta constante.
//
//   ⚠️ Debe coincidir con el TIPO_CAMBIO que se usó al crear los planes, para
//   que lo que se muestra y lo que se cobra sea lo mismo. Si cambia uno,
//   cambia el otro. (Es la misma regla de "lo que se muestra, se sella"
//   aplicada al precio.)
//
// ════════════════════════════════════════════════════════════════════════════
// LO QUE SE MANTIENE IGUAL QUE PAYPAL (son hermanos)
// ════════════════════════════════════════════════════════════════════════════
//   · SIN FIRMA NO HAY PAGO: se verifica contra Supabase que el activo tenga
//     hash_firma. No se confía en el navegador.
//   · MISMO lib/precios.js para el tier según superficie (tolerancia 5%).
//   · MISMO external_reference que el custom_id de PayPal: "activoId|email|tier".
//   · ⚠️ MES GRATIS: en el método sin plan asociado, start_date rompe con 500
//     cuando todavía no hay tarjeta asociada. Por ahora Mercado Pago cobra
//     desde el primer mes (sin mes de cortesía). Queda como diferencia con
//     PayPal, a resolver cuando se defina el flujo real de producción.
//
// VARIABLES DE ENTORNO NECESARIAS:
//   MP_ACCESS_TOKEN_TEST       Access Token de prueba (TEST-).
//   MP_ACCESS_TOKEN_PROD       (opcional) Access Token de producción.
//   MP_ENV                     "live" = usa el de producción; otra cosa = prueba.
//   EPIMELEIA_BASE_URL         (opcional) default https://www.epimeleia.world
//
// QUÉ RECIBE (POST, JSON):
//   { activoId, email, superficieHa, pais }
// ────────────────────────────────────────────────────────────────────────────

const { createClient } = require("@supabase/supabase-js");
const { calcularPrecio } = require("../lib/precios");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MP_API = "https://api.mercadopago.com";

const BASE_URL = process.env.EPIMELEIA_BASE_URL || "https://www.epimeleia.world";

// El tipo de cambio simbólico. DEBE ser el mismo con el que se crearon los
// planes (diag-crear-planes-mp.js). El valor real lo define el fundador.
const TIPO_CAMBIO = 1600;

// Techo de Mercado Pago sandbox por transacción. En producción no aplica igual;
// se deja como aviso para que la prueba no falle en silencio con Enterprise.
const TECHO_SANDBOX_ARS = 2000000;

function obtenerToken() {
  const esLive = process.env.MP_ENV === "live";
  const token = esLive
    ? process.env.MP_ACCESS_TOKEN_PROD
    : process.env.MP_ACCESS_TOKEN_TEST;
  if (!token) {
    throw new Error(
      esLive ? "Falta MP_ACCESS_TOKEN_PROD (MP_ENV=live)." : "Falta MP_ACCESS_TOKEN_TEST."
    );
  }
  return { token, esLive };
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

    // ── El precio, según la superficie (MISMO precios.js que PayPal) ──
    const precio = calcularPrecio(superficieHa, pais);
    if (!precio.ok) {
      return res.status(400).json({
        ok: false,
        error: precio.motivo,
        superaMaximo: precio.superaMaximo || false,
      });
    }

    // ── El precio en pesos ────────────────────────────────────────
    const precioARS = precio.precioMensualUSD * TIPO_CAMBIO;

    // Aviso de techo de sandbox (no frena en producción).
    const { token, esLive } = obtenerToken();
    if (!esLive && precioARS > TECHO_SANDBOX_ARS) {
      return res.status(400).json({
        ok: false,
        error: `El precio (${precioARS} ARS) supera el techo de Mercado Pago sandbox (${TECHO_SANDBOX_ARS}). ` +
               `Es un límite de la cuenta de prueba, no de producción. Probá con un tier más chico.`,
        tier: precio.tier.nombre,
      });
    }

    // external_reference: el gemelo del custom_id de PayPal.
    const externalReference = `${activoId}|${email}|${precio.tier.id}`;

    // ── Crear la suscripción SIN plan asociado ────────────────────
    const cuerpo = {
      reason: `EPIMELEIA ${precio.tier.nombre}`,
      external_reference: externalReference,
      payer_email: email,
      back_url: `${BASE_URL}/protocolo.html?suscripcion=ok&activo=${activoId}`,
      status: "pending",              // pending = devuelve init_point para que el cliente pague
      auto_recurring: {
        frequency: 1,
        frequency_type: "months",
        transaction_amount: precioARS,
        currency_id: "ARS",
      },
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

    const initPoint = subData.init_point || subData.sandbox_init_point || null;

    if (!initPoint) {
      console.error("[crear-suscripcion-mp] Suscripción creada sin init_point:", JSON.stringify(subData));
      return res.status(502).json({
        ok: false,
        error: "Mercado Pago creó la suscripción pero no devolvió la ventana de pago.",
      });
    }

    // ── Guardar el tier y el precio en el activo ──────────────────
    const { error: errUpd } = await supabase
      .from("activos")
      .update({
        tier:                precio.tier.nombre,
        precio_anual_dolar:  precio.precioAnualUSD,   // referencia interna en USD
        moneda:              "ARS",
      })
      .eq("id", activoId);

    if (errUpd) {
      console.error("[crear-suscripcion-mp] No se pudo guardar el tier en el activo:", errUpd.message);
    }

    console.log(
      `[crear-suscripcion-mp] Suscripción ${subData.id} creada · activo ${activoId} · ` +
      `${superficieHa} ha → tier ${precio.tier.nombre} · ARS ${precioARS}/mes`
    );

    // ── Respuesta al frontend ─────────────────────────────────────
    return res.status(200).json({
      ok: true,
      subscriptionId: subData.id,
      approvalUrl: initPoint,         // mismo nombre que PayPal, para el frontend
      initPoint,
      activoId,
      email,
      superficieHa,
      tier: {
        id:     precio.tier.id,
        nombre: precio.tier.nombre,
      },
      precio: {
        mensualUSD: precio.precioMensualUSD,
        mensualARS: precioARS,
        tipoCambio: TIPO_CAMBIO,
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
