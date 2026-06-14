// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA V3.4 — Webhook de PayPal
// ────────────────────────────────────────────────────────────────────────────
// URL pública: https://epimeleia.world/api/webhook-paypal
// Configurado en: developer.paypal.com → EPIMELEIA → Webhooks
//
// FLUJO:
//   1. PayPal envía POST con notificación de pago
//   2. Verificamos el evento con la API de PayPal
//   3. Si es PAYMENT.CAPTURE.COMPLETED, consultamos detalles
//   4. Si el pago está aprobado, lo encolamos en Redis para el VPS
//   5. Respondemos 200 a PayPal rápidamente
// ────────────────────────────────────────────────────────────────────────────

const { encolarPago, pagoYaExiste, guardarAceptacionClausulas } = require("../lib/cola-pagos");
const { HASH_CLAUSULAS_V1, calcularHashAceptacion } = require("../lib/hash-clausulas");

// ─── Verificación del evento con PayPal API ──────────────────────────────────
async function verificarEventoPayPal(req) {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;

  if (!clientId || !clientSecret || !webhookId) {
    console.warn("[webhook-paypal] Credenciales PayPal no configuradas — saltando verificación");
    return { valida: false, motivo: "Credenciales no configuradas" };
  }

  try {
    // Obtener access token de PayPal
    const authResp = await fetch("https://api-m.paypal.com/v1/oauth2/token", {
      method: "POST",
      headers: {
        "Authorization": "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    });

    if (!authResp.ok) {
      return { valida: false, motivo: `Error obteniendo token: ${authResp.status}` };
    }

    const authData = await authResp.json();
    const accessToken = authData.access_token;

    // Verificar el webhook event con PayPal
    const verifyResp = await fetch("https://api-m.paypal.com/v1/notifications/verify-webhook-signature", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        auth_algo: req.headers["paypal-auth-algo"] || "",
        cert_url: req.headers["paypal-cert-url"] || "",
        transmission_id: req.headers["paypal-transmission-id"] || "",
        transmission_sig: req.headers["paypal-transmission-sig"] || "",
        transmission_time: req.headers["paypal-transmission-time"] || "",
        webhook_id: webhookId,
        webhook_event: req.body
      })
    });

    if (!verifyResp.ok) {
      return { valida: false, motivo: `Error verificando: ${verifyResp.status}` };
    }

    const verifyData = await verifyResp.json();
    const valida = verifyData.verification_status === "SUCCESS";
    return { valida, motivo: valida ? "OK" : "Verificación fallida" };

  } catch (error) {
    return { valida: false, motivo: `Error: ${error.message}` };
  }
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
    // PASO 1: Verificar firma
    const firma = await verificarEventoPayPal(req);
    if (!firma.valida) {
      console.warn(`[webhook-paypal] Firma inválida: ${firma.motivo}`);
      return res.status(200).json({ status: "ignored", reason: "invalid_signature" });
    }

    // PASO 2: Solo procesamos pagos completados
    if (eventType !== "PAYMENT.CAPTURE.COMPLETED") {
      console.log(`[webhook-paypal] Evento '${eventType}' — no procesado`);
      return res.status(200).json({ status: "logged", event_type: eventType });
    }

    // PASO 3: Extraer datos del pago
    const resource = req.body?.resource || {};
    const paymentId = resource.id;

    if (!paymentId) {
      return res.status(200).json({ status: "ignored", reason: "no_payment_id" });
    }

    // Anti-duplicados
    const yaExiste = await pagoYaExiste("paypal", paymentId);
    if (yaExiste) {
      console.log(`[webhook-paypal] Pago ${paymentId} ya procesado — duplicado`);
      return res.status(200).json({ status: "duplicate", payment_id: paymentId });
    }

    // PASO 4: Extraer datos del pagador
    const monto = parseFloat(resource.amount?.value || "0");
    const moneda = resource.amount?.currency_code || "USD";
    const email = resource.payer?.email_address ||
                  req.body?.resource?.payer?.email_address ||
                  null;
    const fechaAprobacion = resource.create_time || new Date().toISOString();

    if (!email) {
      console.error(`[webhook-paypal] Pago ${paymentId} sin email del pagador`);
      return res.status(200).json({ status: "error", reason: "no_email" });
    }

    // PASO 5: Hash de aceptación de cláusulas (clickwrap)
    const versionClausulas = "v1.0.0";
    const hashAceptacion = calcularHashAceptacion(email, fechaAprobacion, versionClausulas);
    await guardarAceptacionClausulas(email, hashAceptacion, versionClausulas, fechaAprobacion);

    // PASO 6: Encolar para el VPS
    await encolarPago({
      proveedor: "paypal",
      idExterno: String(paymentId),
      email: email.toLowerCase().trim(),
      monto,
      moneda,
      externalReference: resource.invoice_id || null,
      fechaAprobacion,
      hashAceptacion,
      hashClausulasV1: HASH_CLAUSULAS_V1,
      versionClausulas,
      rawPayPal: {
        payment_id: paymentId,
        status: resource.status,
        payer_id: resource.payer?.payer_id
      }
    });

    console.log(`[webhook-paypal] Pago ${paymentId} encolado para ${email} — ${moneda} ${monto}`);

    return res.status(200).json({
      status: "queued",
      payment_id: paymentId,
      email: email,
      next_step: "VPS will process registration in the next polling cycle"
    });

  } catch (error) {
    console.error("[webhook-paypal] Error:", error);
    return res.status(200).json({ status: "error", message: "Internal error — logged" });
  }
};
