// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA V3.4 — Webhook de Mercado Pago
// ────────────────────────────────────────────────────────────────────────────
// URL pública: https://epimeleia.world/api/webhook-mp
// Configurado en: developers.mercadopago.com → EPIMELEIA → Webhooks
//
// FLUJO:
//   1. MP envía POST con notificación de pago/suscripción
//   2. Verificamos la firma con MP_WEBHOOK_SECRET (HMAC SHA-256)
//   3. Si es evento "payment", consultamos detalles a la API de MP
//   4. Si el pago está APROBADO, lo encolamos en Redis para el VPS
//   5. Respondemos 200 a MP rápidamente (importante: timeout 22s)
//
// EVENTOS SOPORTADOS:
//   - payment            → pago único o cuota de suscripción
//   - subscription_*     → eventos de plan de suscripción (preapproval)
// ────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");
const { encolarPago, pagoYaExiste, guardarAceptacionClausulas } = require("../lib/cola-pagos");
const { HASH_CLAUSULAS_V1, calcularHashAceptacion } = require("../lib/hash-clausulas");

// ─── Verificación de firma HMAC ──────────────────────────────────────────────
// MP envía un header "x-signature" con formato: "ts=NNN,v1=HASH"
// El hash se calcula sobre el "manifest": id={dataId};request-id={reqId};ts={ts};
function verificarFirmaMP(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("[webhook-mp] MP_WEBHOOK_SECRET no configurado — saltando verificación");
    return { valida: false, motivo: "Secret no configurado" };
  }

  const xSignature = req.headers["x-signature"] || "";
  const xRequestId = req.headers["x-request-id"] || "";

  if (!xSignature || !xRequestId) {
    return { valida: false, motivo: "Headers faltantes" };
  }

  // Parsear ts=... y v1=... del header x-signature
  const partes = xSignature.split(",").reduce((acc, p) => {
    const [k, v] = p.trim().split("=");
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});

  const ts = partes.ts;
  const v1 = partes.v1;

  if (!ts || !v1) {
    return { valida: false, motivo: "Formato de firma inválido" };
  }

  // El "data.id" viene en el query string o en el body
  const dataId = req.query?.["data.id"] || req.body?.data?.id || "";
  if (!dataId) {
    return { valida: false, motivo: "data.id ausente" };
  }

  // Manifest según docs MP: "id:DATA_ID;request-id:REQUEST_ID;ts:TS;"
  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;

  const hmacCalculado = crypto
    .createHmac("sha256", secret)
    .update(manifest)
    .digest("hex");

  const valida = crypto.timingSafeEqual(
    Buffer.from(hmacCalculado, "hex"),
    Buffer.from(v1, "hex")
  );

  return { valida, motivo: valida ? "OK" : "Firma no coincide" };
}

// ─── Consulta detalles del pago a la API de MP ───────────────────────────────
async function consultarDetallesPago(paymentId) {
  const token = process.env.MP_ACCESS_TOKEN_TEST || process.env.MP_ACCESS_TOKEN_PROD;
  if (!token) throw new Error("MP_ACCESS_TOKEN no configurado");

  const url = `https://api.mercadopago.com/v1/payments/${paymentId}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!resp.ok) {
    const detalle = await resp.text();
    throw new Error(`MP API error ${resp.status}: ${detalle}`);
  }

  return await resp.json();
}

// ─── Handler principal ───────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // CORS (por si MP cambia el método o hay preflight)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-signature, x-request-id");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Log mínimo para depuración (no incluye datos sensibles)
  console.log(`[webhook-mp] Notificación recibida — type=${req.body?.type} action=${req.body?.action}`);

  try {
    // PASO 1: Verificar firma (rechaza intentos falsos)
    const firma = verificarFirmaMP(req);
    if (!firma.valida) {
      console.warn(`[webhook-mp] Firma inválida: ${firma.motivo}`);
      // IMPORTANTE: devolvemos 200 para que MP no reintente.
      // Si devolviéramos 401, MP nos seguiría martillando.
      // Pero internamente NO procesamos nada.
      return res.status(200).json({ status: "ignored", reason: "invalid_signature" });
    }

    // PASO 2: Identificar tipo de evento
    const tipo = req.body?.type;
    const dataId = req.body?.data?.id;

    if (!dataId) {
      return res.status(200).json({ status: "ignored", reason: "no_data_id" });
    }

    // Solo procesamos eventos de pago (por ahora).
    // Eventos de suscripción los logueamos pero no actuamos (se manejarán
    // cuando armemos el flujo de cobro recurrente).
    if (tipo !== "payment") {
      console.log(`[webhook-mp] Evento '${tipo}' recibido — no procesado en esta versión`);
      return res.status(200).json({ status: "logged", type: tipo });
    }

    // PASO 3: Anti-duplicados — MP a veces reenvía la misma notificación
    const yaExiste = await pagoYaExiste("mp", dataId);
    if (yaExiste) {
      console.log(`[webhook-mp] Pago ${dataId} ya procesado — duplicado ignorado`);
      return res.status(200).json({ status: "duplicate", payment_id: dataId });
    }

    // PASO 4: Consultar detalles del pago a MP
    const detalles = await consultarDetallesPago(dataId);

    // Solo procesamos pagos APROBADOS
    if (detalles.status !== "approved") {
      console.log(`[webhook-mp] Pago ${dataId} con status '${detalles.status}' — no procesado`);
      return res.status(200).json({
        status: "not_approved",
        payment_id: dataId,
        mp_status: detalles.status
      });
    }

    // PASO 5: Extraer datos relevantes del pago
    const email = detalles.payer?.email?.toLowerCase().trim();
    const monto = detalles.transaction_amount;
    const moneda = detalles.currency_id;
    const externalReference = detalles.external_reference || null;
    const fechaAprobacion = detalles.date_approved || new Date().toISOString();

    if (!email) {
      console.error(`[webhook-mp] Pago ${dataId} aprobado pero sin email del pagador`);
      return res.status(200).json({ status: "error", reason: "no_email" });
    }

    // PASO 6: Calcular hash de aceptación de cláusulas
    // ASUNCIÓN: el cliente aceptó cláusulas v1.0.0 antes de pagar (clickwrap
    // en el frontend). Si en el futuro las cláusulas se actualizan, la versión
    // vigente al momento del pago se determinaría aquí.
    const versionClausulas = "v1.0.0";
    const hashAceptacion = calcularHashAceptacion(email, fechaAprobacion, versionClausulas);

    // PASO 7: Guardar aceptación en Redis (evidencia jurídica)
    await guardarAceptacionClausulas(email, hashAceptacion, versionClausulas, fechaAprobacion);

    // PASO 8: Encolar el pago para que el VPS lo procese
    await encolarPago({
      proveedor: "mp",
      idExterno: String(dataId),
      email,
      monto,
      moneda,
      externalReference,
      fechaAprobacion,
      hashAceptacion,
      hashClausulasV1: HASH_CLAUSULAS_V1,
      versionClausulas,
      rawMP: {
        payment_id: detalles.id,
        payment_type: detalles.payment_type_id,
        payment_method: detalles.payment_method_id,
        status: detalles.status,
        status_detail: detalles.status_detail
      }
    });

    console.log(`[webhook-mp] Pago ${dataId} encolado para ${email} — USD ${monto} ${moneda}`);

    return res.status(200).json({
      status: "queued",
      payment_id: dataId,
      email: email,
      next_step: "VPS will process registration in the next polling cycle"
    });

  } catch (error) {
    console.error("[webhook-mp] Error procesando notificación:", error);
    // Devolvemos 200 para que MP no reintente indefinidamente.
    // El error queda en logs de Vercel para depurar.
    return res.status(200).json({
      status: "error",
      message: "Internal error — logged"
    });
  }
};
