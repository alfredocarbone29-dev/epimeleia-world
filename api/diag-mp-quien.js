// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA — DIAGNÓSTICO · ¿de quién es esta credencial de Mercado Pago?
// ────────────────────────────────────────────────────────────────────────────
// URL:  https://www.epimeleia.world/api/diag-mp-quien
//
// ⚠️ DESCARTABLE. Solo LEE. No crea nada. Le pregunta a Mercado Pago los datos
//    de la cuenta dueña del MP_ACCESS_TOKEN_TEST, para saber si es:
//      · tu cuenta real, o
//      · una cuenta de prueba (test user), y si puede recibir suscripciones.
// ────────────────────────────────────────────────────────────────────────────

const MP_API = "https://api.mercadopago.com";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const token = process.env.MP_ACCESS_TOKEN_TEST;
  if (!token) return res.status(500).json({ ok: false, error: "Falta MP_ACCESS_TOKEN_TEST." });

  try {
    // /users/me devuelve los datos de la cuenta dueña del token.
    const resp = await fetch(`${MP_API}/users/me`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    const data = await resp.json();

    if (!resp.ok) {
      return res.status(200).json({
        ok: false,
        paso: "consultar /users/me",
        status: resp.status,
        detalle: data,
      });
    }

    return res.status(200).json({
      ok: true,
      tokenEmpiezaCon: token.slice(0, 8),
      cuenta: {
        id: data.id,
        nickname: data.nickname,
        email: data.email,
        site_id: data.site_id,               // MLA = Argentina
        tipo_usuario: data.user_type,
        // pistas de si es cuenta de prueba
        es_test_user: String(data.nickname || "").startsWith("TEST") ||
                      String(data.email || "").includes("testuser"),
        tags: data.tags,
        status: data.status,
      },
      leeme: "Si es_test_user es false, este token es de tu cuenta REAL, no de la cuenta de prueba vendedor. Para suscripciones se necesita el token del vendedor de prueba (empieza con APP_USR-).",
    });

  } catch (error) {
    return res.status(500).json({
      ok: false, error: "Error inesperado.",
      detalle: String(error && error.message ? error.message : error),
    });
  }
};
