// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA V3.4 — Webhook de PayPal (SUSCRIPCIONES)
// ────────────────────────────────────────────────────────────────────────────
// URL pública: https://www.epimeleia.world/api/webhook-paypal
// Configurado en: developer.paypal.com → EPIMELEIA → Webhooks
//
// QUÉ HACE:
//   Escucha lo que PayPal avisa sobre una suscripción y marca en Supabase
//   HASTA CUÁNDO ese activo está pago. Y cuando un activo se activa por
//   primera vez, le manda al cliente el mail de bienvenida (Estación 4).
//
//   PayPal confirma un cobro  →  activos.cobertura_hasta = fecha + 1 mes
//   Activo activado (1ra vez) →  mail de bienvenida al titular
//
//   Después, el scheduler del VPS lee esa fecha para decidir si certifica.
//
// ════════════════════════════════════════════════════════════════════════════
// AJUSTE 38 (24/7/2026) — EL WEBHOOK ACTIVA EL ACTIVO
//   (ver historial completo en el repo — sin cambios en esta parte)
//   1 · custom_id "activoId|email|tier"  2 · escribe directo a Supabase
//   3 · sin firma asumida  4 · duplicados contra la tabla `pagos`
//
// ════════════════════════════════════════════════════════════════════════════
// AJUSTE 40 (27/7/2026) — EL MAIL DE BIENVENIDA (Estación 4)
// ════════════════════════════════════════════════════════════════════════════
//
//   Cuando un activo se activa por primera vez (ACTIVATED), se le manda al
//   titular el mail de bienvenida. El mail NOMBRA su recurso (nombre + tipo),
//   con el tono acordado: amigable, serio y cómplice. Remitente y contacto:
//   info@epimeleia.world.
//
//   REGLAS DE ORO DE ESTE AGREGADO:
//   · El mail NUNCA frena la activación. Si SendGrid falla o no está
//     configurado, se anota el error y se sigue: el pago y la cobertura son lo
//     que importa; el mail es un extra. (Se envía envuelto en try/catch propio.)
//   · Solo se manda en la PRIMERA activación (ACTIVATED), no en cada cobro
//     mensual (SALE.COMPLETED). Nadie quiere un "bienvenido" todos los meses.
//   · El nombre del cliente se busca en `clientes`. Si no está, el mail arranca
//     con "Hola," a secas — no se rompe ni se inventa un nombre.
//   · El tipo del activo se traduce de código (HIDRICO, FORESTAL...) a una
//     palabra amable. Si es un código desconocido, se omite el tipo.
//
//   ⚠️ PENDIENTE ANTES DE UN CLIENTE REAL: el mail promete "en la próxima
//      ventana recibís tu primera certificación". Eso hoy no ocurre solo (alta
//      on-chain = Fase 7). Confirmar que la primera certificación pase, o
//      suavizar esa frase, antes de abrir a un cliente de verdad.
//
// VARIABLES DE ENTORNO
//   PAYPAL_CLIENT_ID · PAYPAL_CLIENT_SECRET · PAYPAL_WEBHOOK_ID
//   SUPABASE_URL · SUPABASE_SERVICE_KEY
//   SENDGRID_API_KEY   (ya la usa el scheduler/procesador — no es nueva)
// ────────────────────────────────────────────────────────────────────────────

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const PAYPAL_BASE = process.env.PAYPAL_ENV === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

// Remitente y contacto del mail de bienvenida (decisión del fundador).
const EMAIL_FROM = "info@epimeleia.world";

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
function unMesDespues(fechaISO) {
  const d = new Date(fechaISO);
  if (isNaN(d.getTime())) return null;
  const r = new Date(d);
  r.setMonth(r.getMonth() + 1);
  return r.toISOString();
}

// ─── ¿Este evento ya se procesó? ─────────────────────────────────────────────
async function yaProcesado(idExterno) {
  const { data, error } = await supabase
    .from("pagos")
    .select("id")
    .eq("hash_pago", idExterno)
    .maybeSingle();

  if (error) {
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
// AJUSTE 40 · EL MAIL DE BIENVENIDA
// ════════════════════════════════════════════════════════════════════════════

// Traduce el tipo (código) a una palabra amable para el cliente. Si no
// reconoce el código, devuelve null y el mail omite el tipo (no inventa).
function tipoLegible(tipo) {
  if (tipo === null || tipo === undefined) return null;
  const t = String(tipo).toUpperCase().trim();
  const mapa = {
    MINERIA:     "zona minera",
    FORESTAL:    "recurso forestal",
    NAVAL:       "recurso naval",
    INDUSTRIAL:  "zona industrial",
    DATA_CENTER: "centro de datos",
    RESIDUOS:    "zona de residuos",
    HIDROVIA:    "hidrovía",
    HIDRICO:     "recurso hídrico",
    GLACIAR:     "glaciar",
    AGRICOLA:    "campo agrícola",
    OTRO:        null,
  };
  return mapa[t] ?? null;
}

// Busca el nombre del cliente en la tabla `clientes`. Si no está, devuelve null
// (el mail arranca con "Hola," a secas). Nunca frena por esto.
async function nombreDelCliente(email) {
  if (!email) return null;
  try {
    const { data } = await supabase
      .from("clientes")
      .select("nombre")
      .eq("email", email)
      .maybeSingle();
    return data?.nombre || null;
  } catch {
    return null;
  }
}

// Arma el texto del mail de bienvenida, con los datos del recurso.
function textoBienvenida({ nombre, nombreActivo, tipo }) {
  const saludo = nombre ? `Hola ${nombre},` : "Hola,";

  // La línea que nombra el recurso: "—Mar de Aral, recurso hídrico—" o, si no
  // hay tipo reconocible, solo "—Mar de Aral—".
  const legible = tipoLegible(tipo);
  const recurso = legible
    ? `${nombreActivo}, ${legible}`
    : `${nombreActivo}`;

  return (
`${saludo}

Listo. Ya estás adentro.

Te confirmamos que tu recurso —${recurso}— ya fue incorporado al protocolo EPIMELEIA y está siendo observado. Serás vos el que sabrá qué hacer con toda la info que te vamos a dar.

Desde ahora tenés una herramienta que no todos tienen: un satélite observando el recurso que expusiste, y cada observación queda sellada de una forma que nadie —ni vos, ni nosotros— puede cambiar después. No te damos un dato suelto; te damos la prueba de que ese dato es real y de que nadie lo tocó.

¿Para qué te sirve, en concreto? Para estar un paso adelante. Lo que pase con tu recurso lo vas a saber vos, con prueba en la mano, en lugar de enterarte tarde o por otros. Sirve para mostrarle a un banco, a un organismo o a quien sea que hacés las cosas bien, y sirve para tener tu propio registro, tuyo, que no depende de que nadie más lo confirme.

Cómo sigue esto:

· ${nombreActivo} ya está en la agenda del satélite. En la próxima ventana de observación empieza a medirse, y vas a recibir tu primera certificación.
· Cada certificación te llega a este mismo correo, con su sello y su prueba.
· Todo lo que quede registrado es tuyo. Nosotros somos el puente; el protagonista sos vos.

Y algo importante: si algo no te cierra, si tenés una duda que las explicaciones o EPI no te terminan de resolver, escribinos a info@epimeleia.world. Del otro lado hay gente de verdad que te contesta. No estás solo con una pantalla.

Gracias por confiar en nosotros. Nos alegra tenerte.

El equipo de EPIMELEIA
info@epimeleia.world`
  );
}

// Envía el mail de bienvenida por SendGrid. Envuelto para que NUNCA frene la
// activación: si algo falla, se anota y se sigue.
async function enviarBienvenida({ email, nombreActivo, tipo }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    console.warn("[webhook-paypal] SENDGRID_API_KEY no configurado — no se envía bienvenida");
    return;
  }
  if (!email) {
    console.warn("[webhook-paypal] Sin email del titular — no se envía bienvenida");
    return;
  }

  try {
    const nombre = await nombreDelCliente(email);
    const cuerpo = textoBienvenida({ nombre, nombreActivo, tipo });

    const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email }] }],
        from: { email: EMAIL_FROM, name: "EPIMELEIA" },
        reply_to: { email: EMAIL_FROM, name: "EPIMELEIA" },
        subject: `${nombreActivo} ya fue incorporado al protocolo EPIMELEIA`,
        content: [{ type: "text/plain", value: cuerpo }],
      }),
    });

    if (resp.status === 202) {
      console.log(`[webhook-paypal] Bienvenida enviada a ${email} (${nombreActivo})`);
    } else {
      const detalle = await resp.text().catch(() => "");
      console.error(`[webhook-paypal] SendGrid devolvió ${resp.status} al enviar bienvenida: ${detalle}`);
    }
  } catch (error) {
    // Nunca frena la activación.
    console.error("[webhook-paypal] Error enviando bienvenida (no frena la activación):", error.message);
  }
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

  const coberturaHasta = unMesDespues(fechaInicio);

  // Se traen también nombre_activo y tipo para el mail de bienvenida.
  const { data: actualizado, error: errUpd } = await supabase
    .from("activos")
    .update({
      suscripcion_id:  suscripcionId,
      cobertura_hasta: coberturaHasta,
    })
    .eq("id", firma.activoId)
    .select("id, nombre_activo, tipo")
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
    monto: 0,
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

  // ── AJUSTE 40 · el mail de bienvenida ─────────────────────────
  // Va DESPUÉS de todo lo importante (activación + registro del pago), y
  // envuelto para no frenar nada si falla. El email destino es el del titular
  // (el del custom_id; si no, el de PayPal).
  await enviarBienvenida({
    email: firma.email || emailPayPal,
    nombreActivo: actualizado.nombre_activo || "tu recurso",
    tipo: actualizado.tipo,
  });

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

  // Nota: acá NO se manda bienvenida. El "bienvenido" es solo de la primera
  // activación; en los cobros mensuales el cliente ya está adentro.

  return {
    status: "ok",
    accion: "COBRO_REGISTRADO",
    activo_id: activo.id,
    sale_id: saleId,
    cobertura_hasta: coberturaHasta,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// BILLING.SUBSCRIPTION.CANCELLED / EXPIRED / SUSPENDED
// ════════════════════════════════════════════════════════════════════════════
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

  // NOTA: acá irá, más adelante, el mail de DESPEDIDA (su gemelo). Se deja
  // marcado para cuando se redacte. Mismo criterio: envuelto, nunca frena.

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
    const firma = await verificarEventoPayPal(req);
    if (!firma.valida) {
      console.warn(`[webhook-paypal] Firma inválida: ${firma.motivo}`);
      return res.status(200).json({ status: "ignored", reason: "invalid_signature" });
    }

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
