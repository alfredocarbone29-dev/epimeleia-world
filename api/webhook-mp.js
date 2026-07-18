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
//
// ════════════════════════════════════════════════════════════════════════════
// AJUSTE 32 (18/7/2026) — JUNTA B · LA VERSIÓN DE CLÁUSULAS QUE SE SELLA
//                          ES LA VIGENTE, NO UNA ESCRITA A MANO
// ════════════════════════════════════════════════════════════════════════════
//
// EL PROBLEMA (decisión del fundador, opción A):
//   hash-clausulas.js dice VERSION_VIGENTE = "v2.0.0".
//   Este archivo tenía escrito a mano "v1.0.0" y HASH_CLAUSULAS_V1.
//   Resultado: EPI le muestra al cliente la v2, y acá se sellaba la v1.
//   Se mostraba una cosa y se sellaba otra — "lo que se muestra, se sella"
//   roto en la capa legal, la más delicada.
//   Y la v1 dice "By signing with their private key", un método descartado:
//   el cliente nunca firma con clave privada.
//
// EL ARREGLO (opción A, elegida por el fundador):
//   Se apunta a la ÚNICA fuente de verdad: VERSION_VIGENTE y
//   HASH_CLAUSULAS_VIGENTE, ambas de hash-clausulas.js. El día que haya
//   una v3, este archivo la sigue solo, sin tocar una línea.
//
//   Antes:  const versionClausulas = "v1.0.0";
//           ... hashClausulasV1: HASH_CLAUSULAS_V1
//   Ahora:  const versionClausulas = VERSION_VIGENTE;
//           ... hashClausulasVigente: HASH_CLAUSULAS_VIGENTE
//
// ⚠️ ESTO NO ARREGLA LA "FIRMA ASUMIDA" (Junta C):
//   Acá se sigue calculando el hashAceptacion asumiendo que el cliente
//   aceptó. Eso lo resuelve la Estación 2 del motor (deslinde firmado
//   de verdad, antes de pagar). Es otra junta. No se toca acá.
// ════════════════════════════════════════════════════════════════════════════

const crypto = require("crypto");
const { encolarPago, pagoYaExiste, guardarAceptacionClausulas } = require("../lib/cola-pagos");
// AJUSTE 32: se importan la versión vigente y su hash, en vez de la v1.
const { VERSION_VIGENTE, HASH_CLAUSULAS_VIGENTE, calcularHashAceptacion } = require("../lib/hash-clausulas");

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
    // AJUSTE 32: la versión vigente sale de hash-clausulas.js, no está escrita
    // a mano. Hoy es "v2.0.0"; el día que sea "v3.0.0", este código la sigue solo.
    //
    // ⚠️ Sigue siendo una ASUNCIÓN de que el cliente aceptó (clickwrap en el
    //    frontend). La firma REAL, antes de pagar, la resuelve la Estación 2
    //    del motor (Junta C). Esto no la reemplaza — solo asegura que, cuando
    //    haya firma, se selle la MISMA versión que se le mostró al cliente.
    const versionClausulas = VERSION_VIGENTE;
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
      // AJUSTE 32: era hashClausulasV1: HASH_CLAUSULAS_V1.
      hashClausulasVigente: HASH_CLAUSULAS_VIGENTE,
      versionClausulas,
      rawMP: {
        payment_id: detalles.id,
        payment_type: detalles.payment_type_id,
        payment_method: detalles.payment_method_id,
        status: detalles.status,
        status_detail: detalles.status_detail
      }
    });

    console.log(`[webhook-mp] Pago ${dataId} encolado para ${email} — USD ${monto} ${moneda} — cláusulas ${versionClausulas}`);

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
