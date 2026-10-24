// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA V3.4 — Crear suscripción de PayPal (Estación 3 · el pago)
//
// ★ BILLETERA (24/10/2026): este archivo ahora también cobra el CHEQUEO EUDR
//   como pago único de precio fijo (modo "orden" / "capturar"). Ver el bloque
//   "BILLETERA" más abajo. La suscripción por tiers queda inerte, sin borrar.
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

// ════════════════════════════════════════════════════════════════════════════
// BILLETERA (24/10/2026) — PAGO ÚNICO DEL CHEQUEO EUDR, PRECIO FIJO POR PARCELA
// ════════════════════════════════════════════════════════════════════════════
//
// Este mismo archivo atiende dos pedidos nuevos (no ocupa una función más de
// Vercel). La suscripción vieja de arriba queda intacta e inerte.
//
//   modo "orden"     → el cliente quiere pagar su chequeo EUDR (01).
//                      1. Se verifica que el campo sea SUYO y esté firmado.
//                      2. Se le pregunta al VPS si el satélite PUEDE sellarlo
//                         hoy (simulacro). Si no puede (nubes), NO se cobra.
//                      3. Se crea la orden en PayPal por el precio FIJO
//                         (lo pone el servidor, nunca el navegador).
//                      4. Se devuelve el link de PayPal.
//
//   modo "capturar"  → el cliente volvió de PayPal con la orden aprobada.
//                      1. Se verifica que sea su campo y que la orden sea la
//                         de ese campo y por el monto correcto.
//                      2. Se cobra (captura). Recién ahí se toma la plata.
//                      3. Se registra el pago en la tabla `pagos`.
//                      4. Se sella: mismo camino que el sello del founder
//                         (VPS + SELLO_SECRET), con cultivo y país, así se
//                         declara solo el techo de producción.
//                      5. Si el sello falla después de cobrar (VPS caído o
//                         nubes de último momento), NO se pierde nada: el pago
//                         queda registrado como "pagado sin sellar" y se le
//                         avisa al founder por mail para sellarlo a mano.
//
// La plata se toma SOLO en la captura. Si el cliente cierra PayPal sin
// volver, la orden vence sola y no se cobra nada.
//
// VARIABLES DE ENTORNO (ya existen en Vercel, no hay que cargar nada nuevo):
//   PAYPAL_ENV · PAYPAL_CLIENT_ID · PAYPAL_CLIENT_SECRET
//   SELLO_SECRET · SELLO_VPS_URL · SELLO_FOUNDER_EMAIL · SENDGRID_API_KEY
// ════════════════════════════════════════════════════════════════════════════

const PRECIO_EUDR_USD = "230.00";   // ← precio fijo por parcela. Cambiar SOLO acá.
const CULTIVOS_OK = ["soja", "cafe", "cacao", "palma", "caucho"];

const SELLO_SECRET  = process.env.SELLO_SECRET  || "";
const SELLO_VPS_URL = process.env.SELLO_VPS_URL || "";
const FOUNDER_EMAIL = (process.env.SELLO_FOUNDER_EMAIL || "").toLowerCase().trim();

function limpiarCultivo(c) {
  const x = String(c || "").toLowerCase().trim();
  return CULTIVOS_OK.includes(x) ? x : null;
}
function limpiarPais(p) {
  const x = String(p || "").toUpperCase().trim();
  return /^[A-Z]{3}$/.test(x) ? x : null;
}

// ¿Quién pide? Devuelve el usuario de Supabase o null.
async function usuarioDelToken(token) {
  if (!token) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) return null;
    return data.user;
  } catch { return null; }
}

// ¿El campo es de quien pide? (misma regla que confirmar-sello.js)
async function campoEsDe(act, user) {
  if (!act || !act.cliente_id || !user) return false;
  if (String(act.cliente_id) === String(user.id)) return true;
  try {
    const { data: cli } = await supabase.from("clientes").select("email").eq("id", act.cliente_id).maybeSingle();
    const a = ((cli && cli.email) || "").toLowerCase().trim();
    const b = (user.email || "").toLowerCase().trim();
    return !!a && a === b;
  } catch { return false; }
}

async function leerCampo(activoId) {
  const { data } = await supabase.from("activos")
    .select("id, nombre_activo, cliente_id, hash_firma, activo_id_onchain, paquete_sellado_en")
    .eq("id", activoId).maybeSingle();
  return data || null;
}

// Le habla a la puerta del VPS (igual que confirmar-sello.js).
async function pedirAlVPS(cuerpo, timeoutMs) {
  if (!SELLO_SECRET || !SELLO_VPS_URL) return { ok: false, error: "El sistema de sellado no está configurado." };
  try {
    const r = await fetch(SELLO_VPS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-sello-secret": SELLO_SECRET },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: "No se pudo contactar al motor de sellado: " + e.message, tipo: "vps" };
  }
}

async function avisarFounder(asunto, texto) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey || !FOUNDER_EMAIL) return;
  try {
    await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: FOUNDER_EMAIL }] }],
        from: { email: "info@epimeleia.world", name: "EPIMELEIA" },
        subject: asunto,
        content: [{ type: "text/plain", value: texto }],
      }),
    });
  } catch (e) {
    console.error("[billetera] no se pudo avisar al founder:", e.message);
  }
}

// custom_id de la orden: "eudr|activoId|cultivo|pais" (cultivo/pais pueden ir vacíos)
function leerCustomIdOrden(s) {
  const p = String(s || "").split("|");
  if (p[0] !== "eudr" || !p[1]) return null;
  return { activoId: p[1], cultivo: p[2] || null, pais: p[3] || null };
}

// ─── modo "orden" ────────────────────────────────────────────────
async function crearOrden(body, res) {
  const user = await usuarioDelToken(body.token);
  if (!user) return res.status(401).json({ ok: false, error: "Entrá a tu cuenta para pagar." });

  const activoId = body.activoId;
  if (!activoId) return res.status(400).json({ ok: false, error: "Falta el campo a certificar." });

  const act = await leerCampo(activoId);
  if (!act) return res.status(404).json({ ok: false, error: "Ese campo no existe." });
  if (!(await campoEsDe(act, user))) return res.status(403).json({ ok: false, error: "Ese campo no está en tu cuenta." });
  if (!act.hash_firma) return res.status(400).json({ ok: false, error: "Falta firmar el deslinde. Sin aceptación no hay pago." });
  if (act.activo_id_onchain != null && act.paquete_sellado_en) {
    return res.status(400).json({ ok: false, error: "Este campo ya está certificado." });
  }

  const cultivo = limpiarCultivo(body.cultivo);
  const pais    = limpiarPais(body.pais);
  if (cultivo && !pais) return res.status(400).json({ ok: false, error: "Con cultivo hace falta el país del campo." });

  // ¿El satélite puede sellarlo hoy? Si no, no se cobra.
  const sim = await pedirAlVPS({ filaId: activoId, ejecutar: false }, 60000);
  if (!sim || !sim.ok) {
    return res.status(200).json({
      ok: false, tipo: "medicion",
      error: (sim && sim.error) || "El satélite no puede sellar tu campo en este momento.",
    });
  }

  const token = await obtenerToken();
  const nombre = (act.nombre_activo || "campo").slice(0, 60);
  const ordResp = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "PayPal-Request-Id": `eudr-${activoId}-${Date.now()}`,
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: String(activoId).slice(0, 256),
        custom_id: `eudr|${activoId}|${cultivo || ""}|${pais || ""}`.slice(0, 127),
        description: `EPIMELEIA · Chequeo EUDR sellado · ${nombre}`.slice(0, 127),
        amount: { currency_code: "USD", value: PRECIO_EUDR_USD },
      }],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "EPIMELEIA",
            locale: "es-AR",
            shipping_preference: "NO_SHIPPING",
            user_action: "PAY_NOW",
            return_url: `${BASE_URL}/protocolo.html?pago=ok&activo=${encodeURIComponent(activoId)}`,
            cancel_url: `${BASE_URL}/protocolo.html?pago=cancelado&activo=${encodeURIComponent(activoId)}`,
          },
        },
      },
    }),
  });
  const ord = await ordResp.json();
  if (!ordResp.ok) {
    console.error("[billetera] PayPal rechazó la orden:", JSON.stringify(ord));
    return res.status(502).json({ ok: false, error: "PayPal no pudo crear el pago. Probá en un momento." });
  }
  const link = (ord.links || []).find(l => l.rel === "payer-action" || l.rel === "approve");
  if (!link) return res.status(502).json({ ok: false, error: "PayPal no devolvió la ventana de pago." });

  console.log(`[billetera] orden ${ord.id} creada · activo ${activoId} · USD ${PRECIO_EUDR_USD}`);
  return res.status(200).json({ ok: true, orderId: ord.id, approvalUrl: link.href, montoUSD: PRECIO_EUDR_USD });
}

// ─── modo "capturar" ─────────────────────────────────────────────
async function capturarOrden(body, res) {
  const user = await usuarioDelToken(body.token);
  if (!user) return res.status(401).json({ ok: false, error: "Entrá a tu cuenta para confirmar el pago." });

  const orderId = String(body.orderId || "").trim();
  if (!/^[A-Z0-9]{10,40}$/.test(orderId)) return res.status(400).json({ ok: false, error: "Orden de pago inválida." });

  // ¿Ya se procesó esta orden? (recargar la página no cobra ni sella dos veces)
  const { data: previo } = await supabase.from("pagos").select("id, webhook_payload").eq("hash_pago", "orden-" + orderId).maybeSingle();
  if (previo) {
    const pl = previo.webhook_payload || {};
    return res.status(200).json({ ok: true, yaProcesado: true, pagado: true, sellado: !!pl.sellado, onchain: pl.onchain || null, txHash: pl.txHash || null });
  }

  const token = await obtenerToken();

  // Leer la orden ANTES de cobrar: que sea de este campo y por el monto correcto.
  const gResp = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}`, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  const orden = await gResp.json();
  if (!gResp.ok) return res.status(404).json({ ok: false, error: "No se encontró esa orden de pago." });

  const pu = (orden.purchase_units || [])[0] || {};
  const datos = leerCustomIdOrden(pu.custom_id);
  if (!datos) return res.status(400).json({ ok: false, error: "Esa orden no es de un chequeo EUDR." });
  if (pu.amount && (pu.amount.currency_code !== "USD" || pu.amount.value !== PRECIO_EUDR_USD)) {
    return res.status(400).json({ ok: false, error: "El monto de la orden no coincide." });
  }

  const act = await leerCampo(datos.activoId);
  if (!act || !(await campoEsDe(act, user))) return res.status(403).json({ ok: false, error: "Ese campo no está en tu cuenta." });

  // Cobrar (si ya estaba cobrada, PayPal devuelve el mismo resultado: Request-Id fijo).
  let captura = null;
  if (orden.status === "COMPLETED") {
    captura = orden;
  } else if (orden.status === "APPROVED") {
    const cResp = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": `cap-${orderId}`,
      },
    });
    captura = await cResp.json();
    if (!cResp.ok) {
      console.error("[billetera] captura rechazada:", JSON.stringify(captura));
      return res.status(402).json({ ok: false, error: "PayPal no pudo completar el cobro. No se te cobró nada." });
    }
  } else {
    return res.status(400).json({ ok: false, error: "El pago todavía no fue aprobado en PayPal." });
  }

  const cap = (((captura.purchase_units || [])[0] || {}).payments || {}).captures;
  const c0 = (cap && cap[0]) || {};
  if (captura.status !== "COMPLETED" || (c0.status && c0.status !== "COMPLETED")) {
    return res.status(402).json({ ok: false, error: "El cobro quedó pendiente en PayPal. Te avisamos cuando se acredite." });
  }

  const emailPagador = (captura.payer && captura.payer.email_address) || user.email || null;
  console.log(`[billetera] COBRADO orden ${orderId} · captura ${c0.id} · activo ${datos.activoId}`);

  // 1) El pago queda registrado ANTES de sellar: pase lo que pase con el
  //    sello, la plata cobrada nunca queda sin constancia.
  const base = {
    evento: "EUDR_PAGO_UNICO", orderId, captureId: c0.id || null, activo_id: datos.activoId,
    cultivo: datos.cultivo, pais: datos.pais,
  };
  const { error: errIns } = await supabase.from("pagos").insert({
    cliente_email:   emailPagador,
    monto_usd:       Number(PRECIO_EUDR_USD),
    metodo:          "paypal-orden",
    status:          "aprobado",
    hash_pago:       "orden-" + orderId,
    webhook_payload: Object.assign({ sellado: false, estado: "sellando" }, base),
  });
  if (errIns) console.error("[billetera] no se pudo registrar el pago:", errIns.message);

  // 2) Sellar: mismo camino que el founder, con cultivo y país (declara el techo).
  //    Si el campo ya quedó sellado (por ejemplo, un reintento), no se sella dos veces.
  const fresco = await leerCampo(datos.activoId);
  let sello;
  if (fresco && fresco.activo_id_onchain != null && fresco.paquete_sellado_en) {
    sello = { ok: true, sellado: true, onchain: fresco.activo_id_onchain, txHash: null };
  } else {
    sello = await pedirAlVPS({
      filaId: datos.activoId, ejecutar: true,
      producto: "atras", cultivo: datos.cultivo || undefined, pais: datos.pais || undefined,
    }, 150000);
  }
  const sellado = !!(sello && sello.ok && sello.sellado);

  // 3) Se anota cómo terminó.
  await supabase.from("pagos").update({
    webhook_payload: Object.assign({}, base, {
      sellado, estado: sellado ? "sellado" : "pagado_sin_sellar",
      onchain: sellado ? sello.onchain : null, txHash: sellado ? sello.txHash : null,
      motivoSinSello: sellado ? null : ((sello && sello.error) || "sin respuesta del VPS"),
    }),
  }).eq("hash_pago", "orden-" + orderId).then(({ error }) => { if (error) console.error("[billetera] no se pudo actualizar el pago:", error.message); });

  if (!sellado) {
    await avisarFounder(
      `PAGO RECIBIDO SIN SELLAR · ${act.nombre_activo || datos.activoId}`,
      `Entró un pago de USD ${PRECIO_EUDR_USD} (orden ${orderId}) pero el sello no salió.\n\n` +
      `Campo: ${act.nombre_activo || "-"}\nFila: ${datos.activoId}\nCliente: ${emailPagador}\n` +
      `Cultivo/país: ${datos.cultivo || "-"} / ${datos.pais || "-"}\n` +
      `Motivo: ${(sello && sello.error) || "sin respuesta del VPS"}\n\n` +
      `Sellalo a mano desde tu panel de fundador eligiendo 01 + ese cultivo y país.`
    );
    return res.status(200).json({
      ok: true, pagado: true, sellado: false,
      mensaje: "Pago recibido. El sello de tu campo se completa en las próximas horas y te llega el certificado por mail.",
    });
  }

  return res.status(200).json({
    ok: true, pagado: true, sellado: true,
    onchain: sello.onchain, txHash: sello.txHash, polygonscan: sello.polygonscan,
    deforestacion: sello.deforestacion || null, capacidad: sello.capacidad || null,
  });
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

    // BILLETERA: pago único del chequeo EUDR (lo nuevo).
    if (body.modo === "orden")    return await crearOrden(body, res);
    if (body.modo === "capturar") return await capturarOrden(body, res);

    // (debajo: la suscripción vieja por tiers, inerte — nadie la llama hoy)
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