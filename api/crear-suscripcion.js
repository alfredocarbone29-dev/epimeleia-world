// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA V3.4 — Crear suscripción de PayPal (Estación 3 · el pago)
// ────────────────────────────────────────────────────────────────────────────
// URL pública (Vercel):  https://epimeleia.world/api/crear-suscripcion
//
// QUÉ HACE:
//   Recibe un activo ya registrado y firmado (Estaciones 1 y 2), calcula qué
//   tier le corresponde según su SUPERFICIE, elige el plan de PayPal de ese
//   tier, y crea la suscripción. Devuelve el link donde el cliente pone su
//   tarjeta.
//
// ════════════════════════════════════════════════════════════════════════════
// AJUSTE 37 (22/7/2026) — LOS CUATRO TIERS
// ════════════════════════════════════════════════════════════════════════════
//
// ANTES: usaba UN plan fijo de PayPal (el de prueba, USD 550). No sabía nada
// de tiers ni de superficie.
//
// AHORA: la superficie manda. lib/precios.js calcula el tier (con la
// tolerancia del 5% incluida) y devuelve qué variable de entorno tiene el
// Plan ID de PayPal de ese tier. Este archivo lo lee y crea la suscripción
// con el plan correcto.
//
//   superficie → precios.js → tier → variable de entorno → Plan ID → PayPal
//
// LOS CUATRO PLANES (decisión del fundador, 20/7):
//   Base        hasta 500 ha        USD 180/mes
//   Pro         500 a 5.000 ha      USD 450/mes
//   Corporate   5.000 a 25.000 ha   USD 900/mes
//   Enterprise  25.000 a 62.500 ha  USD 1800/mes
//   Los cuatro con 1 mes gratis (el trial de PayPal). El cliente ya dejó la
//   tarjeta, así que desde el mes 2 se cobra solo.
//
// POR QUÉ LOS PLAN IDs VIENEN DE VARIABLES DE ENTORNO (opción B):
//   Los Plan IDs de sandbox y de producción son DISTINTOS. Teniéndolos en
//   variables, el salto sandbox → live es cambiar 4 variables y no tocar
//   código. Si estuvieran escritos acá, habría que editar el archivo cada vez.
//
// VARIABLES DE ENTORNO NECESARIAS:
//   PAYPAL_ENV                 "live" para producción; cualquier otra cosa = sandbox
//   PAYPAL_CLIENT_ID
//   PAYPAL_CLIENT_SECRET
//   PAYPAL_PLAN_BASE           Plan ID del tier Base
//   PAYPAL_PLAN_PRO            Plan ID del tier Pro
//   PAYPAL_PLAN_CORPORATE      Plan ID del tier Corporate
//   PAYPAL_PLAN_ENTERPRISE     Plan ID del tier Enterprise
//   EPIMELEIA_BASE_URL         (opcional) default https://epimeleia.world
//
// QUÉ RECIBE (POST, JSON):
//   {
//     activoId:     "<uuid de la fila en activos>",   (requerido)
//     email:        "titular@dominio.com",            (requerido)
//     superficieHa: 1234.56,                          (requerido)
//     pais:         "AR" | otro                       (opcional, para la leyenda)
//   }
//
// ⚠️ IMPORTANTE — SIN FIRMA NO HAY PAGO:
//   Este endpoint verifica en Supabase que el activo TENGA su deslinde firmado
//   (hash_firma). Si no lo tiene, no crea la suscripción. Es la regla del
//   fundador aplicada también acá: "sin aceptación no hay pago".
// ────────────────────────────────────────────────────────────────────────────

const { createClient } = require("@supabase/supabase-js");
const { calcularPrecio, planIdDePayPal } = require("../lib/precios");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Sandbox salvo que se diga explícitamente "live".
const PAYPAL_BASE = process.env.PAYPAL_ENV === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

const BASE_URL = process.env.EPIMELEIA_BASE_URL || "https://epimeleia.world";

// ─── Token de PayPal ─────────────────────────────────────────────────────────
async function obtenerToken() {
  const clientId     = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Faltan PAYPAL_CLIENT_ID o PAYPAL_CLIENT_SECRET.");
  }

  const resp = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!resp.ok) throw new Error(`PayPal no dio token (${resp.status}).`);
  const data = await resp.json();
  return data.access_token;
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
    const pais         = body.pais || "INT";

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
    // Se verifica contra Supabase que el deslinde esté firmado. No se confía
    // en lo que diga el navegador.
    const { data: activo, error: errActivo } = await supabase
      .from("activos")
      .select("id, nombre_activo, hash_firma, firma_version, superficie_ha")
      .eq("id", activoId)
      .maybeSingle();

    if (errActivo) {
      console.error("[crear-suscripcion] Error leyendo el activo:", errActivo.message);
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
    // Acá entra toda la lógica de tiers y la tolerancia del 5%.
    const precio = calcularPrecio(superficieHa, pais);

    if (!precio.ok) {
      // Puede ser que supere el máximo de Copernicus (hay que dividir el activo).
      return res.status(400).json({
        ok: false,
        error: precio.motivo,
        superaMaximo: precio.superaMaximo || false,
      });
    }

    // ── El plan de PayPal de ese tier ─────────────────────────────
    const plan = planIdDePayPal(precio.tier.id);
    if (!plan.ok) {
      console.error("[crear-suscripcion] " + plan.motivo);
      return res.status(500).json({
        ok: false,
        error: "El plan de pago de este tier no está configurado. Avisale al equipo.",
        detalle: plan.motivo,
      });
    }

    // ── Crear la suscripción en PayPal ────────────────────────────
    const token = await obtenerToken();

    // custom_id: viaja con la suscripción y vuelve en el webhook. Así el
    // webhook sabe QUÉ activo se pagó, sin tener que adivinar.
    // Formato: "activoId|email|tier". PayPal limita a 127 caracteres.
    let customId = `${activoId}|${email}|${precio.tier.id}`;
    if (customId.length > 127) customId = customId.slice(0, 127);

    const requestId = `epimeleia-${activoId}-${Date.now()}`;

    const subResp = await fetch(`${PAYPAL_BASE}/v1/billing/subscriptions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": requestId,
      },
      body: JSON.stringify({
        plan_id: plan.planId,
        custom_id: customId,
        subscriber: { email_address: email },
        application_context: {
          brand_name: "EPIMELEIA",
          locale: "es-AR",
          shipping_preference: "NO_SHIPPING",
          user_action: "SUBSCRIBE_NOW",
          payment_method: {
            payer_selected: "PAYPAL",
            payee_preferred: "IMMEDIATE_PAYMENT_REQUIRED",
          },
          return_url: `${BASE_URL}/protocolo.html?suscripcion=ok&activo=${activoId}`,
          cancel_url: `${BASE_URL}/protocolo.html?suscripcion=cancelada&activo=${activoId}`,
        },
      }),
    });

    const subData = await subResp.json();

    if (!subResp.ok) {
      console.error("[crear-suscripcion] PayPal rechazó la creación:", JSON.stringify(subData));
      return res.status(502).json({
        ok: false,
        error: "PayPal no pudo crear la suscripción.",
        detalle: subData?.message || "Error desconocido de PayPal",
      });
    }

    // El link donde el cliente pone su tarjeta.
    const approveLink = (subData.links || []).find(l => l.rel === "approve");
    const approvalUrl = approveLink?.href || null;

    if (!approvalUrl) {
      console.error("[crear-suscripcion] Suscripción creada sin link de aprobación:", JSON.stringify(subData));
      return res.status(502).json({
        ok: false,
        error: "PayPal creó la suscripción pero no devolvió la ventana de pago.",
      });
    }

    // ── Guardar el tier y el precio en el activo ──────────────────
    // Para que quede constancia de QUÉ se le cobró y por qué. No frena el
    // pago si falla: se anota el error y se sigue.
    const { error: errUpd } = await supabase
      .from("activos")
      .update({
        tier:                precio.tier.nombre,
        precio_anual_dolar:  precio.precioAnualUSD,
        moneda:              "USD",
      })
      .eq("id", activoId);

    if (errUpd) {
      console.error("[crear-suscripcion] No se pudo guardar el tier en el activo:", errUpd.message);
    }

    console.log(
      `[crear-suscripcion] Suscripción ${subData.id} creada · activo ${activoId} · ` +
      `${superficieHa} ha → tier ${precio.tier.nombre} · USD ${precio.precioMensualUSD}/mes · plan ${plan.planId}`
    );

    // ── Respuesta al frontend ─────────────────────────────────────
    return res.status(200).json({
      ok: true,
      subscriptionId: subData.id,
      approvalUrl,                    // ← el frontend manda al cliente acá
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
        // Si cayó en tolerancia, se quedó en el tier de abajo (no subió).
        nota: precio.nota,
      },
      leyendaImpuestos: precio.leyendaImpuestos,
      mensaje: "Suscripción creada. Redirigí al cliente a approvalUrl para que confirme el pago.",
    });

  } catch (error) {
    console.error("[crear-suscripcion] Error:", error);
    return res.status(500).json({
      ok: false,
      error: "Error interno al crear la suscripción.",
    });
  }
};
