// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA — DIAGNÓSTICO MÍNIMO · el cuerpo más pelado que funciona en MP
// ────────────────────────────────────────────────────────────────────────────
// URL:  https://www.epimeleia.world/api/diag-mp-minimo
//
// ⚠️ DESCARTABLE. No lee Supabase, no toca nada. Solo le manda a Mercado Pago
//    el cuerpo MÍNIMO de una suscripción sin plan asociado —calcado del
//    ejemplo que sabemos que funciona— para aislar qué campo rompe con 500.
//
// Prueba varias combinaciones, de la más simple a la más completa, y muestra
// cuál pasa y cuál falla. Así sabemos exactamente qué campo es el problema.
// ────────────────────────────────────────────────────────────────────────────

const MP_API = "https://api.mercadopago.com";
const BASE_URL = "https://www.epimeleia.world";

async function intentar(token, nombre, cuerpo) {
  try {
    const resp = await fetch(`${MP_API}/preapproval`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo),
    });
    const data = await resp.json();
    const initPoint = data.init_point || data.sandbox_init_point || null;
    return {
      prueba: nombre,
      status: resp.status,
      ok: resp.ok && !!initPoint,
      initPoint: initPoint ? initPoint.slice(0, 60) + "..." : null,
      mensaje: data.message || null,
      // si falla, mostrar el detalle para ver la causa
      detalle: resp.ok ? undefined : data,
    };
  } catch (e) {
    return { prueba: nombre, error: String(e.message || e) };
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const token = process.env.MP_ACCESS_TOKEN_TEST;
  if (!token) return res.status(500).json({ ok: false, error: "Falta MP_ACCESS_TOKEN_TEST." });

  const email = "test_user_123456@testuser.com";
  const resultados = [];

  // PRUEBA 1 · lo más pelado posible (calcado del ejemplo que funciona)
  resultados.push(await intentar(token, "1-minimo", {
    back_url: BASE_URL,
    reason: "EPIMELEIA prueba",
    payer_email: email,
    status: "pending",
    auto_recurring: {
      frequency: 1,
      frequency_type: "months",
      transaction_amount: 100,
      currency_id: "ARS",
    },
  }));

  // PRUEBA 2 · igual, pero con el monto real (288000)
  resultados.push(await intentar(token, "2-monto-alto", {
    back_url: BASE_URL,
    reason: "EPIMELEIA prueba",
    payer_email: email,
    status: "pending",
    auto_recurring: {
      frequency: 1,
      frequency_type: "months",
      transaction_amount: 288000,
      currency_id: "ARS",
    },
  }));

  // PRUEBA 3 · monto chico + external_reference con barras
  resultados.push(await intentar(token, "3-external-ref-barras", {
    back_url: BASE_URL,
    reason: "EPIMELEIA prueba",
    external_reference: "80f38661-4c23-4ca0-aec1-ac27e0df21b9|test@test.com|base",
    payer_email: email,
    status: "pending",
    auto_recurring: {
      frequency: 1,
      frequency_type: "months",
      transaction_amount: 100,
      currency_id: "ARS",
    },
  }));

  // PRUEBA 4 · back_url con querystring (como el real)
  resultados.push(await intentar(token, "4-backurl-query", {
    back_url: `${BASE_URL}/protocolo.html?suscripcion=ok&activo=80f38661`,
    reason: "EPIMELEIA prueba",
    payer_email: email,
    status: "pending",
    auto_recurring: {
      frequency: 1,
      frequency_type: "months",
      transaction_amount: 100,
      currency_id: "ARS",
    },
  }));

  return res.status(200).json({
    leeme: "Buscá cuál 'ok' es true y cuál es false. El primero que falle señala el campo culpable.",
    tokenEmpiezaCon: token.slice(0, 5),
    resultados,
  });
};
