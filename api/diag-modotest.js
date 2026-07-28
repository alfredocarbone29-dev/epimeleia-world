// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA — DIAGNÓSTICO TEMPORAL · ¿el contrato Billing está en modoTest?
// ────────────────────────────────────────────────────────────────────────────
// URL:  https://www.epimeleia.world/api/diag-modotest
//
// ⚠️ DESCARTABLE. Solo LEE la blockchain. No cambia nada, no gasta gas
//    (las lecturas on-chain son gratis).
//
// QUÉ HACE:
//   Le pregunta al contrato Billing en Polygon si su interruptor de modo prueba
//   está en true (prueba, tiempos comprimidos) o false (producción, tiempos
//   reales). Antes de un cliente real, debe estar en FALSE.
//
//   Como no sabemos el nombre exacto de la función, prueba varios nombres
//   habituales y te dice cuál existe y qué devuelve.
//
// VARIABLES DE ENTORNO (usa las que ya tenés; prueba varias por las dudas):
//   POLYGON_RPC_URL / RPC_URL / ALCHEMY_URL   → el proveedor RPC (Alchemy)
//   BILLING_ADDRESS / BILLING_CONTRACT / CONTRACT_BILLING → dirección del Billing
// ────────────────────────────────────────────────────────────────────────────

const { ethers } = require("ethers");

// Nombres candidatos de la función/variable de modo test en el contrato.
const CANDIDATOS_FUNCION = [
  "modoTest", "testMode", "esModoTest", "isTestMode", "modoPrueba",
  "testeo", "modo_test", "MODO_TEST",
];

// Nombres candidatos de la variable de entorno con la dirección del Billing.
const CANDIDATOS_ENV_DIR = [
  "BILLING_ADDRESS", "BILLING_CONTRACT", "CONTRACT_BILLING",
  "BILLING_CONTRACT_ADDRESS", "EPIMELEIA_BILLING", "ADDRESS_BILLING",
];

// Nombres candidatos de la variable de entorno con el RPC.
const CANDIDATOS_ENV_RPC = [
  "POLYGON_RPC_URL", "RPC_URL", "ALCHEMY_URL", "ALCHEMY_RPC",
  "POLYGON_RPC", "RPC_POLYGON", "PROVIDER_URL",
];

function primeraVar(lista) {
  for (const nombre of lista) {
    if (process.env[nombre]) return { nombre, valor: process.env[nombre] };
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  // ── Encontrar el RPC y la dirección entre las variables que existan ──
  const rpc = primeraVar(CANDIDATOS_ENV_RPC);
  const dir = primeraVar(CANDIDATOS_ENV_DIR);

  const diagnosticoEnv = {
    rpcEncontrado: rpc ? rpc.nombre : "NINGUNO de " + CANDIDATOS_ENV_RPC.join(", "),
    direccionEncontrada: dir ? `${dir.nombre} = ${dir.valor.slice(0, 10)}…` : "NINGUNA de " + CANDIDATOS_ENV_DIR.join(", "),
  };

  if (!rpc || !dir) {
    return res.status(200).json({
      ok: false,
      error: "No encontré el RPC o la dirección del Billing en las variables de entorno.",
      diagnosticoEnv,
      pista: "Decime cómo se llaman esas variables en tu Vercel y ajusto el diagnóstico.",
    });
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpc.valor);

    // Probamos cada nombre de función candidato con un ABI mínimo.
    const resultados = {};
    let encontrada = null;

    for (const fn of CANDIDATOS_FUNCION) {
      try {
        const abi = [`function ${fn}() view returns (bool)`];
        const contrato = new ethers.Contract(dir.valor, abi, provider);
        const valor = await contrato[fn]();
        resultados[fn] = valor; // si contesta, existe
        if (encontrada === null) encontrada = { fn, valor };
      } catch {
        // esa función no existe con esa firma — se ignora y se prueba la próxima
      }
    }

    if (encontrada === null) {
      return res.status(200).json({
        ok: false,
        resumen: "El contrato respondió, pero ninguno de los nombres de función probados existe.",
        contrato: dir.valor,
        probados: CANDIDATOS_FUNCION,
        pista: "El interruptor puede tener otro nombre, o ser una variable pública distinta. Decime y lo busco.",
      });
    }

    const enProduccion = encontrada.valor === false;

    return res.status(200).json({
      ok: true,
      resumen: enProduccion
        ? `✅ El contrato Billing está en PRODUCCIÓN (${encontrada.fn} = false). Todo bien.`
        : `⚠️ El contrato Billing está en MODO PRUEBA (${encontrada.fn} = true). Antes de un cliente real hay que ponerlo en false.`,
      funcionEncontrada: encontrada.fn,
      valor: encontrada.valor,
      enProduccion,
      contrato: dir.valor,
      red: rpc.nombre,
      todosLosResultados: resultados,
    });

  } catch (error) {
    return res.status(200).json({
      ok: false,
      error: "Error consultando la blockchain.",
      detalle: String(error && error.message ? error.message : error),
      diagnosticoEnv,
    });
  }
};
