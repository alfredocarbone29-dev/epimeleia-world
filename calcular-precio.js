// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA V3.4 — Consultar el precio de un activo (Estación 3)
// ────────────────────────────────────────────────────────────────────────────
// URL pública (Vercel):  https://epimeleia.world/api/calcular-precio
//
// QUÉ HACE:
//   Dada una superficie en hectáreas, devuelve el tier y el precio.
//   NADA MÁS. No crea suscripciones, no cobra, no toca la base de datos.
//
// POR QUÉ EXISTE (y no se usa crear-suscripcion para esto):
//   El cliente tiene que VER el precio ANTES de que lo manden a PayPal.
//   Es lo honesto: nadie debería llegar a una pasarela de pago sin saber
//   cuánto le van a cobrar.
//   Si usáramos crear-suscripcion solo para mostrar el precio, crearíamos una
//   suscripción de verdad cada vez que alguien mira. Por eso: un endpoint que
//   consulta, y otro que crea. Separados.
//
// QUÉ RECIBE (GET o POST):
//   superficieHa   (requerido) — hectáreas del activo
//   pais           (opcional)  — 'AR' o cualquier otro, para la leyenda de impuestos
//
// Ejemplo:  /api/calcular-precio?superficieHa=409&pais=AR
// ────────────────────────────────────────────────────────────────────────────

const { calcularPrecio, tablaDeTiers } = require("../lib/precios");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // Acepta los datos por query (GET) o por body (POST). Lo que venga.
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const q = req.query || {};

    const superficieHa = Number(q.superficieHa ?? body.superficieHa);
    const pais = (q.pais ?? body.pais ?? "INT");

    // Sin superficie, devolvemos la tabla completa de tiers.
    // Sirve para la "vidriera" de precios de la web.
    if (!isFinite(superficieHa) || superficieHa <= 0) {
      return res.status(200).json({
        ok: true,
        tipo: "tabla",
        ...tablaDeTiers(pais),
      });
    }

    const precio = calcularPrecio(superficieHa, pais);

    if (!precio.ok) {
      // No es un error del sistema: es que el activo supera el máximo de
      // Copernicus y hay que dividirlo. Se responde 200 con la explicación.
      return res.status(200).json({
        ok: false,
        tipo: "no_certificable",
        motivo: precio.motivo,
        superaMaximo: precio.superaMaximo || false,
        superficieHa,
      });
    }

    return res.status(200).json({
      ok: true,
      tipo: "precio",
      superficieHa: precio.superficieHa,
      tier: precio.tier,
      precioMensualUSD: precio.precioMensualUSD,
      precioAnualUSD:   precio.precioAnualUSD,
      enTolerancia:     precio.enTolerancia,
      nota:             precio.nota,
      leyendaImpuestos: precio.leyendaImpuestos,
      // El primer mes es sin cargo (el trial de PayPal). Se dice claro.
      mesGratis: true,
      notaMesGratis: "El primer mes es sin cargo. El cobro empieza en el segundo mes.",
    });

  } catch (error) {
    console.error("[calcular-precio] Error:", error);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
};
