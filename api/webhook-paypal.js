// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA V3.4 — Webhook de PayPal (SUSCRIPCIONES)
// ────────────────────────────────────────────────────────────────────────────
// URL pública: https://epimeleia.world/api/webhook-paypal
// Configurado en: developer.paypal.com → EPIMELEIA → Webhooks
//
// EVENTOS QUE MANEJA:
//   BILLING.SUBSCRIPTION.ACTIVATED  → alta on-chain + certificar + minuta
//   PAYMENT.SALE.COMPLETED          → cobro mensual real (post mes gratis)
//   BILLING.SUBSCRIPTION.CANCELLED  → baja del cliente
//   (cualquier otro evento)         → logueado, no procesado
//
// CLICKWRAP:
//   La firma REAL del cliente viene en el campo custom_id de la suscripción
//   PayPal. Ese campo lo completa la Pieza 3 (crear-suscripcion.js) cuando
//   el cliente tilda el casillero en el frontend. Formato esperado:
//   "email|fechaISO|versionClausulas"
//   Ejemplo: "empresa@dominio.com|2026-06-27T14:32:00.000Z|v1.0.0"
//
// VARIABLES DE ENTORNO NECESARIAS (en .env del VPS y en Vercel):
//   PAYPAL_CLIENT_ID
//   PAYPAL_CLIENT_SECRET
//   PAYPAL_WEBHOOK_ID
//   (las mismas que ya estaban — no se agregan nuevas)
// ────────────────────────────────────────────────────────────────────────────

const { encolarPago, pagoYaExiste, guardarAceptacionClausulas } = require("../lib/cola-pagos");
const { HASH_CLAUSULAS_V1, calcularHashAceptacion } = require("../lib/hash-clausulas");

// ─── URL base de PayPal según entorno ────────────────────────────────────────
// Cuando pases a producción: cambiar "sandbox" por "api-m.paypal.com"
const PAYPAL_BASE = process.env.PAYPAL_ENV === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

// ─── Obtener access token de PayPal ──────────────────────────────────────────
async function obtenerToken() {
  const clientId     = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("PAYPAL_CLIENT_ID o PAYPAL_CLIENT_SECRET no configurados");
  }

  const resp = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  if (!resp.ok) {
    throw new Error(`Error obteniendo token PayPal: ${resp.status}`);
  }

  const data = await resp.json();
  return data.access_token;
}

// ─── Verificación del evento con PayPal API ──────────────────────────────────
// PayPal ofrece verificación oficial vía su API. Usamos eso en lugar de HMAC
// manual, porque es más robusto y es lo que ellos recomiendan para webhooks.
async function verificarEventoPayPal(req) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;

  if (!webhookId) {
    console.warn("[webhook-paypal] PAYPAL_WEBHOOK_ID no configurado — saltando verificación");
    return { valida: false, motivo: "PAYPAL_WEBHOOK_ID no configurado" };
  }

  try {
    const token = await obtenerToken();

    const verifyResp = await fetch(`${PAYPAL_BASE}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        auth_algo:         req.headers["paypal-auth-algo"]         || "",
        cert_url:          req.headers["paypal-cert-url"]          || "",
        transmission_id:   req.headers["paypal-transmission-id"]   || "",
        transmission_sig:  req.headers["paypal-transmission-sig"]  || "",
        transmission_time: req.headers["paypal-transmission-time"] || "",
        webhook_id:        webhookId,
        webhook_event:     req.body
      })
    });

    if (!verifyResp.ok) {
      return { valida: false, motivo: `Error verificando: ${verifyResp.status}` };
    }

    const verifyData = await verifyResp.json();
    const valida = verifyData.verification_status === "SUCCESS";
    return { valida, motivo: valida ? "OK" : "Verificación fallida por PayPal" };

  } catch (error) {
    return { valida: false, motivo: `Excepción: ${error.message}` };
  }
}

// ─── Parsear el custom_id que viene de la suscripción ───────────────────────
// La Pieza 3 (crear-suscripcion.js) va a guardar en custom_id:
// "email|fechaAceptacion|versionClausulas"
// Esta función lo desempaqueta y valida.
function parsearCustomId(customId) {
  if (!customId || typeof customId !== "string") {
    return { valido: false, motivo: "custom_id ausente o no es string" };
  }

  const partes = customId.split("|");
  if (partes.length !== 3) {
    return { valido: false, motivo: `custom_id mal formado: ${customId}` };
  }

  const [email, fechaAceptacion, versionClausulas] = partes;

  if (!email || !email.includes("@")) {
    return { valido: false, motivo: "Email inválido en custom_id" };
  }
  if (!fechaAceptacion) {
    return { valido: false, motivo: "Fecha de aceptación ausente en custom_id" };
  }
  if (!versionClausulas) {
    return { valido: false, motivo: "Versión de cláusulas ausente en custom_id" };
  }

  return {
    valido: true,
    email: email.toLowerCase().trim(),
    fechaAceptacion,
    versionClausulas
  };
}

// ─── MANEJADOR: BILLING.SUBSCRIPTION.ACTIVATED ──────────────────────────────
// Se dispara cuando el cliente dejó la tarjeta y arranca el mes de cortesía.
// ACCIÓN: alta on-chain + primera certificación + minuta.
async function manejarSuscripcionActivada(resource) {
  const subscriptionId = resource.id;
  const planId         = resource.plan_id;
  const customId       = resource.custom_id;
  const fechaActivacion = resource.start_time || new Date().toISOString();

  console.log(`[webhook-paypal] ACTIVATED — subscription_id=${subscriptionId}`);

  // Anti-duplicados: usamos el subscription_id como idExterno
  const yaExiste = await pagoYaExiste("paypal-sub", subscriptionId);
  if (yaExiste) {
    console.log(`[webhook-paypal] Suscripción ${subscriptionId} ya procesada — duplicado`);
    return { status: "duplicate", subscription_id: subscriptionId };
  }

  // Parsear firma real del cliente (viene del frontend via Pieza 3)
  const firmaParsed = parsearCustomId(customId);
  if (!firmaParsed.valido) {
    console.error(`[webhook-paypal] custom_id inválido: ${firmaParsed.motivo}`);
    // Logueamos el error pero NO frenamos: la suscripción existe,
    // hay que procesarla igual. La firma queda marcada como "asumida".
    firmaParsed.email            = resource.subscriber?.email_address || null;
    firmaParsed.fechaAceptacion  = fechaActivacion;
    firmaParsed.versionClausulas = "v1.0.0";
    firmaParsed.firmaAsumida     = true;
  }

  const { email, fechaAceptacion, versionClausulas } = firmaParsed;

  if (!email) {
    console.error(`[webhook-paypal] ACTIVATED sin email — subscription_id=${subscriptionId}`);
    return { status: "error", reason: "no_email" };
  }

  // Calcular y guardar hash de aceptación (firma criptográfica del clickwrap)
  const hashAceptacion = calcularHashAceptacion(email, fechaAceptacion, versionClausulas);
  await guardarAceptacionClausulas(email, hashAceptacion, versionClausulas, fechaAceptacion);

  // Encolar para que el VPS haga el alta on-chain + certificación + minuta
  await encolarPago({
    proveedor:          "paypal-suscripcion",
    idExterno:          subscriptionId,
    email,
    monto:              0,           // mes de cortesía: sin cobro
    moneda:             "USD",
    externalReference:  planId,
    fechaAprobacion:    fechaActivacion,
    hashAceptacion,
    hashClausulasV1:    HASH_CLAUSULAS_V1,
    versionClausulas,
    firmaAsumida:       firmaParsed.firmaAsumida || false,
    accion:             "ALTA_ONCHAIN",  // <-- el VPS lee este campo para saber qué hacer
    rawPayPal: {
      subscription_id: subscriptionId,
      plan_id:         planId,
      status:          resource.status,
      start_time:      resource.start_time,
      subscriber_email: resource.subscriber?.email_address
    }
  });

  console.log(`[webhook-paypal] ALTA encolada — ${email} | sub=${subscriptionId}`);
  return { status: "queued", accion: "ALTA_ONCHAIN", subscription_id: subscriptionId, email };
}

// ─── MANEJADOR: PAYMENT.SALE.COMPLETED ──────────────────────────────────────
// Se dispara cuando termina el mes gratis y PayPal cobra el primer mes real.
// También se dispara en cobros subsiguientes.
// ACCIÓN: registrar el cobro, renovar el período activo en el sistema.
async function manejarCobroMensual(resource) {
  const saleId        = resource.id;
  const subscriptionId = resource.billing_agreement_id; // ID de la suscripción padre
  const monto         = parseFloat(resource.amount?.total || "0");
  const moneda        = resource.amount?.currency || "USD";
  const fechaCobro    = resource.create_time || new Date().toISOString();

  console.log(`[webhook-paypal] SALE.COMPLETED — sale_id=${saleId} sub=${subscriptionId}`);

  const yaExiste = await pagoYaExiste("paypal-sale", saleId);
  if (yaExiste) {
    console.log(`[webhook-paypal] Sale ${saleId} ya procesado — duplicado`);
    return { status: "duplicate", sale_id: saleId };
  }

  // En el cobro mensual no hay firma nueva — la firma original ya quedó
  // guardada cuando se activó la suscripción. Solo registramos el cobro.
  await encolarPago({
    proveedor:          "paypal-suscripcion",
    idExterno:          saleId,
    email:              null,       // el VPS lo busca por subscription_id en su BD
    monto,
    moneda,
    externalReference:  subscriptionId,
    fechaAprobacion:    fechaCobro,
    hashAceptacion:     null,       // ya fue guardada al activarse
    hashClausulasV1:    HASH_CLAUSULAS_V1,
    versionClausulas:   "v1.0.0",
    accion:             "COBRO_MENSUAL", // <-- el VPS renueva el período activo
    rawPayPal: {
      sale_id:         saleId,
      subscription_id: subscriptionId,
      amount:          resource.amount,
      state:           resource.state
    }
  });

  console.log(`[webhook-paypal] COBRO encolado — sale=${saleId} sub=${subscriptionId} ${moneda} ${monto}`);
  return { status: "queued", accion: "COBRO_MENSUAL", sale_id: saleId, subscription_id: subscriptionId };
}

// ─── MANEJADOR: BILLING.SUBSCRIPTION.CANCELLED ──────────────────────────────
// Se dispara cuando el cliente cancela (o PayPal cancela por falta de pago).
// ACCIÓN: dar de baja al cliente en el sistema.
async function manejarSuscripcionCancelada(resource) {
  const subscriptionId = resource.id;
  const fechaCancelacion = resource.status_update_time || new Date().toISOString();

  console.log(`[webhook-paypal] CANCELLED — subscription_id=${subscriptionId}`);

  // No chequeamos duplicados aquí: una cancelación siempre se procesa.
  await encolarPago({
    proveedor:          "paypal-suscripcion",
    idExterno:          `cancel-${subscriptionId}`,
    email:              null,       // el VPS lo busca por subscription_id
    monto:              0,
    moneda:             "USD",
    externalReference:  subscriptionId,
    fechaAprobacion:    fechaCancelacion,
    hashAceptacion:     null,
    hashClausulasV1:    HASH_CLAUSULAS_V1,
    versionClausulas:   "v1.0.0",
    accion:             "BAJA_CLIENTE", // <-- el VPS desactiva al cliente
    rawPayPal: {
      subscription_id: subscriptionId,
      status:          resource.status,
      status_update_time: resource.status_update_time,
      subscriber_email:   resource.subscriber?.email_address
    }
  });

  console.log(`[webhook-paypal] BAJA encolada — sub=${subscriptionId}`);
  return { status: "queued", accion: "BAJA_CLIENTE", subscription_id: subscriptionId };
}

// ─── Handler principal ───────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const eventType = req.body?.event_type || "unknown";
  console.log(`[webhook-paypal] Notificación recibida — event_type=${eventType}`);

  try {
    // PASO 1: Verificar que el evento viene realmente de PayPal
    const firma = await verificarEventoPayPal(req);
    if (!firma.valida) {
      console.warn(`[webhook-paypal] Firma inválida: ${firma.motivo}`);
      // Devolvemos 200 para que PayPal no reintente. Internamente no procesamos.
      return res.status(200).json({ status: "ignored", reason: "invalid_signature" });
    }

    // PASO 2: Derivar al manejador correcto según el tipo de evento
    const resource = req.body?.resource || {};
    let resultado;

    switch (eventType) {

      case "BILLING.SUBSCRIPTION.ACTIVATED":
        // El cliente dejó la tarjeta — arranca el mes de cortesía
        // ACCIÓN: alta on-chain + primera certificación + minuta
        resultado = await manejarSuscripcionActivada(resource);
        break;

      case "PAYMENT.SALE.COMPLETED":
        // PayPal cobró un mes (post período de cortesía)
        // ACCIÓN: registrar cobro, renovar período activo
        resultado = await manejarCobroMensual(resource);
        break;

      case "BILLING.SUBSCRIPTION.CANCELLED":
        // El cliente canceló (o PayPal canceló por falta de pago)
        // ACCIÓN: dar de baja al cliente en el sistema
        resultado = await manejarSuscripcionCancelada(resource);
        break;

      default:
        // Evento que no manejamos — lo logueamos y respondemos 200
        console.log(`[webhook-paypal] Evento '${eventType}' no manejado en esta versión`);
        resultado = { status: "logged", event_type: eventType };
        break;
    }

    return res.status(200).json(resultado);

  } catch (error) {
    console.error("[webhook-paypal] Error no capturado:", error);
    // Siempre 200 para que PayPal no reintente indefinidamente.
    // El error queda en los logs de Vercel para depurar.
    return res.status(200).json({ status: "error", message: "Internal error — logged" });
  }
};
