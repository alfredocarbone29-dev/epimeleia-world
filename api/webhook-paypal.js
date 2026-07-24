// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA V3.4 — Webhook de PayPal (SUSCRIPCIONES)
// ────────────────────────────────────────────────────────────────────────────
// URL pública: https://epimeleia.world/api/webhook-paypal
// Configurado en: developer.paypal.com → EPIMELEIA → Webhooks
//
// QUÉ HACE:
//   Escucha lo que PayPal avisa sobre una suscripción y marca en Supabase
//   HASTA CUÁNDO ese activo está pago. Nada más que eso.
//
//   PayPal confirma un cobro  →  activos.cobertura_hasta = fecha + 1 mes
//
//   Después, el scheduler del VPS lee esa fecha para decidir si certifica.
//   El webhook escribe; el scheduler lee. Ninguno de los dos hace la otra cosa.
//
// ════════════════════════════════════════════════════════════════════════════
// AJUSTE 38 (24/7/2026) — EL WEBHOOK ACTIVA EL ACTIVO
// ════════════════════════════════════════════════════════════════════════════
//
// QUÉ CAMBIÓ Y POR QUÉ
//
// 1 · EL custom_id ESTABA DESACOPLADO — era el bug que rompía todo.
//     Este archivo esperaba  "email|fecha|versionClausulas".
//     crear-suscripcion.js manda  "activoId|email|tier".
//     Resultado: al llegar el ACTIVATED, buscaba una arroba donde venía el
//     activoId, no la encontraba, y caía al fallback. El activoId se perdía
//     — justo el dato que hace falta para saber QUÉ activo activar.
//     Ahora se lee el formato real que manda crear-suscripcion.js.
//
// 2 · SE ESCRIBE DIRECTO A SUPABASE. Antes se encolaba todo en Redis para
//     que procesador-pagos.js (VPS) creara el activo y lo diera de alta
//     on-chain. Ese diseño es de cuando EPI hacía el registro conversando.
//     Hoy el activo YA EXISTE antes de pagar: lo dibujó y lo firmó el cliente
//     en las Estaciones 1 y 2. Si el procesador actuara, insertaría una fila
//     duplicada sin polígono. Entonces el webhook no crea: ACTUALIZA.
//
//     ⚠️ procesador-pagos.js NO se toca ni se para. Queda corriendo con la
//        cola vacía, sin hacer nada, y su código de alta on-chain queda
//        intacto para la Fase 7.
//
// 3 · SE SACÓ LA FIRMA ASUMIDA. Este archivo calculaba un hash de aceptación
//     "asumiendo" que el cliente había aceptado las cláusulas (el clickwrap
//     viejo). Desde la Estación 2 hay una firma REAL, sellada en Supabase
//     (hash_firma, firma_version, firma_fecha), calculada por el servidor.
//     Inventar una firma asumida al lado de una firma real es peor que no
//     tener ninguna: son dos verdades sobre el mismo hecho.
//
// 4 · LOS DUPLICADOS SE CHEQUEAN CONTRA LA TABLA `pagos`, no contra Redis.
//     PayPal reenvía notificaciones. Si el id externo ya está registrado,
//     se ignora. Una sola fuente, la misma que guarda el historial.
//
// LO QUE SE DEJÓ INTACTO
//   La verificación de firma contra la API de PayPal. Es la parte difícil,
//   está bien hecha, y no había ninguna razón para tocarla.
//
// ════════════════════════════════════════════════════════════════════════════
// COLUMNAS NUEVAS QUE ESTE ARCHIVO NECESITA EN `activos`
// ════════════════════════════════════════════════════════════════════════════
//   suscripcion_id    text          ID de la suscripción de PayPal.
//                                   Es la llave de los cobros siguientes: el
//                                   aviso de cobro NO trae el activo, solo
//                                   trae este número.
//   cobertura_hasta   timestamptz   Hasta cuándo está pago.
//
// NO se toca la columna `estado` (hoy dice "alta" en todas las filas y no se
// sabe quién más la lee). NO se toca la tabla `clientes` — unificar la
// creación de clientes es otro tema, y mezclarlo acá sería esconderlo.
//
// ════════════════════════════════════════════════════════════════════════════
// LA TOLERANCIA NO VIVE ACÁ
// ════════════════════════════════════════════════════════════════════════════
//   cobertura_hasta guarda exactamente lo que se pagó, sin regalar un día.
//   La tolerancia (seguir certificando una ventana más después del
//   vencimiento) es una decisión del scheduler, y vive allá.
//   Acá se registra el hecho; allá se decide qué hacer con él.
//
// VARIABLES DE ENTORNO
//   PAYPAL_CLIENT_ID · PAYPAL_CLIENT_SECRET · PAYPAL_WEBHOOK_ID
//   SUPABASE_URL · SUPABASE_SERVICE_KEY
// ────────────────────────────────────────────────────────────────────────────

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const PAYPAL_BASE = process.env.PAYPAL_ENV === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

// ─── Token de PayPal ─────────────────────────────────────────────────────────
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
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!resp.ok) throw new Error(`Error obteniendo token PayPal: ${resp.status}`);
  const data = await resp.json();
  return data.access_token;
}

// ─── Verificación del evento contra la API de PayPal ─────────────────────────
// (sin cambios respecto de la versión anterior — funciona y es lo que PayPal
//  recomienda para webhooks)
async function verificarEventoPayPal(req) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;

  if (!webhookId) {
    console.warn("[webhook-paypal] PAYPAL_WEBHOOK_ID no configurado — no se procesa nada");
    return { valida: false, motivo: "PAYPAL_WEBHOOK_ID no configurado" };
  }

  try {
    const token = await obtenerToken();

    const verifyResp = await fetch(`${PAYPAL_BASE}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        auth_algo:         req.headers["paypal-auth-algo"]         || "",
        cert_url:          req.headers["paypal-cert-url"]          || "",
        transmission_id:   req.headers["paypal-transmission-id"]   || "",
        transmission_sig:  req.headers["paypal-transmission-sig"]  || "",
        transmission_time: req.headers["paypal-transmission-time"] || "",
        webhook_id:        webhookId,
        webhook_event:     req.body,
      }),
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

// ─── El custom_id que manda crear-suscripcion.js ─────────────────────────────
// Formato real: "activoId|email|tier"
// (antes este archivo esperaba "email|fecha|version" — ese era el desacople)
function parsearCustomId(customId) {
  if (!customId || typeof customId !== "string") {
    return { valido: false, motivo: "custom_id ausente" };
  }

  const partes = customId.split("|");
  if (partes.length < 2) {
    return { valido: false, motivo: `custom_id mal formado: ${customId}` };
  }

  const [activoId, email, tier] = partes;

  if (!activoId) {
    return { valido: false, motivo: "activoId ausente en custom_id" };
  }
  if (!email || !email.includes("@")) {
    return { valido: false, motivo: "email inválido en custom_id" };
  }

  return {
    valido: true,
    activoId: activoId.trim(),
    email: email.toLowerCase().trim(),
    tier: (tier || "").trim() || null,
  };
}

// ─── Un mes más, desde una fecha ─────────────────────────────────────────────
// Se usa el calendario, no 30 días fijos: si se pagó el 31 de enero, la
// cobertura va al 28 de febrero (JavaScript lo resuelve solo). Es lo mismo
// que hace PayPal para el próximo cobro.
function unMesDespues(fechaISO) {
  const d = new Date(fechaISO);
  if (isNaN(d.getTime())) return null;
  const r = new Date(d);
  r.setMonth(r.getMonth() + 1);
  return r.toISOString();
}

// ─── ¿Este evento ya se procesó? ─────────────────────────────────────────────
// PayPal reenvía notificaciones. El id externo se guarda en pagos.hash_pago.
async function yaProcesado(idExterno) {
  const { data, error } = await supabase
    .from("pagos")
    .select("id")
    .eq("hash_pago", idExterno)
    .maybeSingle();

  if (error) {
    // Si Supabase falla, se prefiere procesar de nuevo antes que perder un
    // cobro. Un duplicado en el historial es reparable; un cobro perdido no.
    console.error("[webhook-paypal] Error chequeando duplicados:", error.message);
    return false;
  }
  return !!data;
}

// ─── Registrar el hecho en la tabla `pagos` ──────────────────────────────────
async function registrarPago({ email, monto, metodo, idExterno, payload }) {
  const { error } = await supabase.from("pagos").insert({
    cliente_email:   email || null,
    monto_usd:       monto ?? null,
    metodo:          metodo,
    status:          "aprobado",
    hash_pago:       idExterno,
    webhook_payload: payload || null,
  });

  if (error) console.error("[webhook-paypal] Error registrando pago:", error.message);
}

// ─── Buscar el activo por el ID de suscripción ───────────────────────────────
// Los cobros siguientes NO traen el activo: solo traen el número de la
// suscripción. Por eso se guarda en el alta.
async function activoPorSuscripcion(suscripcionId) {
  const { data, error } = await supabase
    .from("activos")
    .select("id, nombre_activo, cliente_id, cobertura_hasta")
    .eq("suscripcion_id", suscripcionId)
    .maybeSingle();

  if (error) {
    console.error("[webhook-paypal] Error buscando activo por suscripción:", error.message);
    return null;
  }
  return data;
}

// ════════════════════════════════════════════════════════════════════════════
// BILLING.SUBSCRIPTION.ACTIVATED
// El cliente dejó la tarjeta. Arranca el mes de cortesía.
// ════════════════════════════════════════════════════════════════════════════
async function manejarSuscripcionActivada(resource) {
  const suscripcionId  = resource.id;
  const fechaInicio    = resource.start_time || new Date().toISOString();
  const emailPayPal    = resource.subscriber?.email_address || null;

  console.log(`[webhook-paypal] ACTIVATED — sub=${suscripcionId}`);

  if (await yaProcesado(suscripcionId)) {
    return { status: "duplicate", subscription_id: suscripcionId };
  }

  const firma = parsearCustomId(resource.custom_id);

  if (!firma.valido) {
    // Sin activoId no hay nada que activar. NO se inventa un activo ni se
    // adivina cuál es: se avisa y se corta. Es preferible una alta pendiente
    // y visible, a una activación silenciosa sobre el activo equivocado.
    console.error(
      `[webhook-paypal] ACTIVATED sin activoId utilizable (${firma.motivo}) — ` +
      `sub=${suscripcionId} email=${emailPayPal}`
    );
    await registrarPago({
      email: emailPayPal,
      monto: 0,
      metodo: "paypal-suscripcion",
      idExterno: suscripcionId,
      payload: { evento: "ACTIVATED", error: firma.motivo, resource },
    });
    return { status: "error", reason: "custom_id_invalido", detalle: firma.motivo };
  }

  // El mes de cortesía también es cobertura: el cliente está adentro.
  const coberturaHasta = unMesDespues(fechaInicio);

  const { data: actualizado, error: errUpd } = await supabase
    .from("activos")
    .update({
      suscripcion_id:  suscripcionId,
      cobertura_hasta: coberturaHasta,
    })
    .eq("id", firma.activoId)
    .select("id, nombre_activo")
    .maybeSingle();

  if (errUpd) {
    console.error("[webhook-paypal] Error activando el activo:", errUpd.message);
    return { status: "error", reason: "update_fallido", detalle: errUpd.message };
  }

  if (!actualizado) {
    console.error(`[webhook-paypal] El activo ${firma.activoId} no existe en Supabase`);
    return { status: "error", reason: "activo_inexistente", activo_id: firma.activoId };
  }

  await registrarPago({
    email: firma.email || emailPayPal,
    monto: 0,                       // mes de cortesía: sin cobro
    metodo: "paypal-suscripcion",
    idExterno: suscripcionId,
    payload: {
      evento: "ACTIVATED",
      subscription_id: suscripcionId,
      plan_id: resource.plan_id,
      status: resource.status,
      start_time: resource.start_time,
      tier: firma.tier,
    },
  });

  console.log(
    `[webhook-paypal] Activo ${firma.activoId} ("${actualizado.nombre_activo}") ` +
    `activado — cobertura hasta ${coberturaHasta}`
  );

  return {
    status: "ok",
    accion: "ACTIVADO",
    activo_id: firma.activoId,
    subscription_id: suscripcionId,
    cobertura_hasta: coberturaHasta,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// PAYMENT.SALE.COMPLETED
// PayPal cobró un mes de verdad (el primero real, o cualquiera posterior).
// ════════════════════════════════════════════════════════════════════════════
async function manejarCobroMensual(resource) {
  const saleId        = resource.id;
  const suscripcionId = resource.billing_agreement_id || null;
  const monto         = parseFloat(resource.amount?.total || "0");
  const moneda        = resource.amount?.currency || "USD";
  const fechaCobro    = resource.create_time || new Date().toISOString();

  console.log(`[webhook-paypal] SALE.COMPLETED — sale=${saleId} sub=${suscripcionId}`);

  if (await yaProcesado(saleId)) {
    return { status: "duplicate", sale_id: saleId };
  }

  if (!suscripcionId) {
    // Un cobro suelto, sin suscripción padre. No se puede saber a qué activo
    // corresponde. Se registra para que quede rastro y se avisa.
    console.warn(`[webhook-paypal] Cobro ${saleId} sin billing_agreement_id`);
    await registrarPago({
      email: null, monto, metodo: "paypal-suscripcion", idExterno: saleId,
      payload: { evento: "SALE.COMPLETED", error: "sin_subscription_id", resource },
    });
    return { status: "error", reason: "sin_subscription_id", sale_id: saleId };
  }

  const activo = await activoPorSuscripcion(suscripcionId);

  if (!activo) {
    console.error(`[webhook-paypal] Cobro ${saleId}: ningún activo con suscripción ${suscripcionId}`);
    await registrarPago({
      email: null, monto, metodo: "paypal-suscripcion", idExterno: saleId,
      payload: { evento: "SALE.COMPLETED", error: "activo_no_encontrado", subscription_id: suscripcionId },
    });
    return { status: "error", reason: "activo_no_encontrado", subscription_id: suscripcionId };
  }

  // Se extiende un mes desde la fecha del cobro.
  const coberturaHasta = unMesDespues(fechaCobro);

  const { error: errUpd } = await supabase
    .from("activos")
    .update({ cobertura_hasta: coberturaHasta })
    .eq("id", activo.id);

  if (errUpd) {
    console.error("[webhook-paypal] Error extendiendo la cobertura:", errUpd.message);
    return { status: "error", reason: "update_fallido", detalle: errUpd.message };
  }

  await registrarPago({
    email: null,
    monto,
    metodo: "paypal-suscripcion",
    idExterno: saleId,
    payload: {
      evento: "SALE.COMPLETED",
      sale_id: saleId,
      subscription_id: suscripcionId,
      activo_id: activo.id,
      amount: resource.amount,
      state: resource.state,
    },
  });

  console.log(
    `[webhook-paypal] Cobro ${moneda} ${monto} — activo ${activo.id} ` +
    `("${activo.nombre_activo}") cubierto hasta ${coberturaHasta}`
  );

  return {
    status: "ok",
    accion: "COBRO_REGISTRADO",
    activo_id: activo.id,
    sale_id: saleId,
    cobertura_hasta: coberturaHasta,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// BILLING.SUBSCRIPTION.CANCELLED
// El cliente canceló, o PayPal canceló por falta de pago.
// ════════════════════════════════════════════════════════════════════════════
//
// DECISIÓN DEL FUNDADOR: "el pago se respeta hasta el momento en que debía
// entrar el próximo débito". Por eso acá NO se toca cobertura_hasta: la fecha
// ya pagada sigue valiendo, y el activo se apaga solo cuando esa fecha pase.
//
// Tampoco se borra ni se cierra nada. El activo es del usuario, siempre: queda
// dormido, con todo su historial intacto. Si vuelve a pagar, retoma.
// Y no se registra ningún Hueco de Opacidad — un hueco significa que el
// satélite no pudo ver, y dejar de pagar no es opacidad.
async function manejarSuscripcionCancelada(resource) {
  const suscripcionId = resource.id;
  const fechaCancel   = resource.status_update_time || new Date().toISOString();

  console.log(`[webhook-paypal] CANCELLED — sub=${suscripcionId}`);

  const activo = await activoPorSuscripcion(suscripcionId);

  await registrarPago({
    email: resource.subscriber?.email_address || null,
    monto: 0,
    metodo: "paypal-suscripcion",
    idExterno: `cancel-${suscripcionId}`,
    payload: {
      evento: "CANCELLED",
      subscription_id: suscripcionId,
      activo_id: activo?.id || null,
      status: resource.status,
      status_update_time: resource.status_update_time,
      cobertura_vigente_al_cancelar: activo?.cobertura_hasta || null,
    },
  });

  if (activo) {
    console.log(
      `[webhook-paypal] Activo ${activo.id} cancelado — sigue cubierto hasta ` +
      `${activo.cobertura_hasta || "(sin fecha)"}, después queda dormido`
    );
  } else {
    console.warn(`[webhook-paypal] CANCELLED: ningún activo con suscripción ${suscripcionId}`);
  }

  return {
    status: "ok",
    accion: "BAJA_REGISTRADA",
    subscription_id: suscripcionId,
    activo_id: activo?.id || null,
    cobertura_hasta: activo?.cobertura_hasta || null,
  };
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
    // PASO 1 · ¿Viene realmente de PayPal?
    const firma = await verificarEventoPayPal(req);
    if (!firma.valida) {
      console.warn(`[webhook-paypal] Firma inválida: ${firma.motivo}`);
      // 200 para que PayPal no reintente al infinito. Internamente: nada.
      return res.status(200).json({ status: "ignored", reason: "invalid_signature" });
    }

    // PASO 2 · Al manejador que corresponda
    const resource = req.body?.resource || {};
    let resultado;

    switch (eventType) {
      case "BILLING.SUBSCRIPTION.ACTIVATED":
        resultado = await manejarSuscripcionActivada(resource);
        break;

      case "PAYMENT.SALE.COMPLETED":
        resultado = await manejarCobroMensual(resource);
        break;

      case "BILLING.SUBSCRIPTION.CANCELLED":
      case "BILLING.SUBSCRIPTION.EXPIRED":
      case "BILLING.SUBSCRIPTION.SUSPENDED":
        // Los tres significan lo mismo para EPIMELEIA: dejó de haber cobro.
        // La cobertura ya pagada se respeta igual.
        resultado = await manejarSuscripcionCancelada(resource);
        break;

      default:
        console.log(`[webhook-paypal] Evento '${eventType}' no manejado`);
        resultado = { status: "logged", event_type: eventType };
        break;
    }

    return res.status(200).json(resultado);

  } catch (error) {
    console.error("[webhook-paypal] Error no capturado:", error);
    return res.status(200).json({ status: "error", message: "Internal error — logged" });
  }
};
