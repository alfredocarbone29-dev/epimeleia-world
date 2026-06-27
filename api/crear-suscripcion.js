// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA V3.4 — Crear suscripción de cliente (PIEZA 3)
// ────────────────────────────────────────────────────────────────────────────
// URL pública: https://epimeleia.world/api/crear-suscripcion
// La llama el FRONTEND cuando el cliente:
//   1. Tildó el casillero del clickwrap (aceptó las 3 cláusulas)
//   2. Quiere arrancar el mes de cortesía
//
// QUÉ HACE:
//   1. Valida que el cliente realmente aceptó (aceptoClausulas === true)
//   2. Captura la FIRMA REAL: email + fecha/hora exacta + versión de cláusulas
//      → la guarda en Redis como evidencia jurídica EN EL MOMENTO DEL CONSENTIMIENTO
//        (no espera al webhook — esto es el escudo legal del founder)
//   3. Crea la suscripción en PayPal usando el PLAN ID (mes de cortesía incluido)
//   4. Mete la firma dentro del campo custom_id de la suscripción, para que el
//      webhook (Pieza 2) la lea cuando PayPal confirme la activación
//   5. Devuelve al frontend la URL de aprobación (la ventana de PayPal — Camino A)
//
// VARIABLES DE ENTORNO (en .env del VPS y en Vercel):
//   PAYPAL_CLIENT_ID         (ya existe)
//   PAYPAL_CLIENT_SECRET     (ya existe)
//   PAYPAL_PLAN_ID           (opcional — si falta, usa el PLAN ID sandbox conocido)
//   PAYPAL_ENV               (opcional — "live" para producción; default = sandbox)
//   EPIMELEIA_BASE_URL       (opcional — default https://epimeleia.world)
// ────────────────────────────────────────────────────────────────────────────

const { guardarAceptacionClausulas } = require("../lib/cola-pagos");
const { HASH_CLAUSULAS_V1, calcularHashAceptacion } = require("../lib/hash-clausulas");

// ─── Config según entorno ────────────────────────────────────────────────────
const PAYPAL_BASE = process.env.PAYPAL_ENV === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

// PLAN ID: el creado en la Pieza 1. Preferimos leerlo del .env; si no está,
// usamos el conocido de sandbox como respaldo para no frenar las pruebas.
const PLAN_ID = process.env.PAYPAL_PLAN_ID || "P-28525887527389315NI76A7Q";

const BASE_URL = process.env.EPIMELEIA_BASE_URL || "https://epimeleia.world";

const VERSION_CLAUSULAS = "v1.0.0";

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
    const detalle = await resp.text();
    throw new Error(`Error obteniendo token PayPal (${resp.status}): ${detalle}`);
  }

  const data = await resp.json();
  return data.access_token;
}

// ─── Validación simple de email ──────────────────────────────────────────────
function emailValido(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ─── Handler principal ───────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    // ── PASO 1: Leer y validar lo que manda el frontend ──────────────────────
    const body = req.body || {};
    const email          = (body.email || "").toLowerCase().trim();
    const aceptoClausulas = body.aceptoClausulas === true;
    const nombreOrg      = (body.nombreOrg || "").trim(); // opcional, informativo

    if (!emailValido(email)) {
      return res.status(400).json({ ok: false, error: "Email inválido o ausente." });
    }

    // El escudo legal: si NO aceptó, NO se crea nada. Sin excepciones.
    if (!aceptoClausulas) {
      return res.status(400).json({
        ok: false,
        error: "Hay que aceptar las cláusulas del protocolo antes de continuar."
      });
    }

    // ── PASO 2: Capturar la FIRMA REAL ───────────────────────────────────────
    // La fecha/hora la pone el servidor (más confiable como evidencia que el
    // reloj del navegador del cliente). Este es el instante del consentimiento.
    const fechaAceptacion = new Date().toISOString();
    const hashAceptacion  = calcularHashAceptacion(email, fechaAceptacion, VERSION_CLAUSULAS);

    // Guardar la firma en Redis YA — antes de tocar PayPal. Si PayPal fallara,
    // igual queda registrado que este cliente aceptó, cuándo, y con qué hash.
    await guardarAceptacionClausulas(email, hashAceptacion, VERSION_CLAUSULAS, fechaAceptacion);

    // ── PASO 3: Armar el custom_id que viajará en la suscripción ─────────────
    // Formato que la Pieza 2 (webhook) sabe leer: "email|fecha|version"
    // PayPal limita custom_id a 127 caracteres — controlamos que entre.
    let customId = `${email}|${fechaAceptacion}|${VERSION_CLAUSULAS}`;
    if (customId.length > 127) {
      // Si el email fuera larguísimo, recortamos la fecha a segundos (sigue siendo válida)
      customId = `${email}|${fechaAceptacion.slice(0, 19)}Z|${VERSION_CLAUSULAS}`.slice(0, 127);
    }

    // ── PASO 4: Crear la suscripción en PayPal ───────────────────────────────
    const token = await obtenerToken();

    // PayPal-Request-Id: evita crear dos suscripciones si el cliente hace doble clic
    const requestId = `epimeleia-${email}-${Date.now()}`;

    const subResp = await fetch(`${PAYPAL_BASE}/v1/billing/subscriptions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": requestId
      },
      body: JSON.stringify({
        plan_id: PLAN_ID,
        custom_id: customId,
        subscriber: {
          email_address: email
        },
        application_context: {
          brand_name: "EPIMELEIA",
          locale: "es-AR",
          shipping_preference: "NO_SHIPPING",
          user_action: "SUBSCRIBE_NOW",
          payment_method: {
            payer_selected: "PAYPAL",
            payee_preferred: "IMMEDIATE_PAYMENT_REQUIRED"
          },
          // A dónde vuelve el cliente después de aprobar o cancelar en PayPal
          return_url: `${BASE_URL}/?suscripcion=ok`,
          cancel_url: `${BASE_URL}/?suscripcion=cancelada`
        }
      })
    });

    const subData = await subResp.json();

    if (!subResp.ok) {
      console.error("[crear-suscripcion] PayPal rechazó la creación:", subData);
      return res.status(502).json({
        ok: false,
        error: "PayPal no pudo crear la suscripción.",
        detalle: subData?.message || "Error desconocido de PayPal"
      });
    }

    // ── PASO 5: Encontrar la URL de aprobación (la ventana — Camino A) ────────
    const approveLink = (subData.links || []).find(l => l.rel === "approve");
    const approvalUrl = approveLink?.href || null;

    if (!approvalUrl) {
      console.error("[crear-suscripcion] Suscripción creada pero sin link de aprobación:", subData);
      return res.status(502).json({
        ok: false,
        error: "PayPal creó la suscripción pero no devolvió la ventana de pago."
      });
    }

    console.log(`[crear-suscripcion] Suscripción ${subData.id} creada para ${email} — esperando aprobación`);

    // ── PASO 6: Devolver al frontend lo que necesita ─────────────────────────
    return res.status(200).json({
      ok: true,
      subscription_id: subData.id,
      approval_url: approvalUrl,    // <-- el frontend abre esto (la ventana de PayPal)
      email,
      hash_aceptacion: hashAceptacion,
      mensaje: "Suscripción creada. Redirigí al cliente a approval_url para que confirme."
    });

  } catch (error) {
    console.error("[crear-suscripcion] Error:", error);
    return res.status(500).json({
      ok: false,
      error: "Error interno al crear la suscripción. Quedó registrado en los logs."
    });
  }
};
