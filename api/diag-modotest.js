// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA — DIAGNÓSTICO TEMPORAL v2 · ¿el contrato Billing está en modoTest?
// ────────────────────────────────────────────────────────────────────────────
// URL:  https://www.epimeleia.world/api/diag-modotest
//
// ⚠️ DESCARTABLE. Solo LEE la blockchain. No cambia nada, no gasta gas.
//
// v2: compatible con ethers v5 Y v6 (detecta la versión), y captura todo para
//     mostrar el error en vez de crashear.
// ────────────────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Todo dentro de try para no crashear nunca: si algo falla, se muestra.
  try {
    const ethers = require("ethers");

    // ── Detectar versión de ethers y crear el provider como corresponda ──
    // v6:  ethers.JsonRpcProvider
    // v5:  ethers.providers.JsonRpcProvider
    const esV6 = typeof ethers.JsonRpcProvider === "function";
    const esV5 = !esV6 && ethers.providers && typeof ethers.providers.JsonRpcProvider === "function";

    const versionEthers = esV6 ? "v6" : (esV5 ? "v5" : "desconocida");

    const CANDIDATOS_FUNCION = [
      "modoTest", "testMode", "esModoTest", "isTestMode", "modoPrueba",
      "testeo", "modo_test", "MODO_TEST",
    ];
    const CANDIDATOS_ENV_DIR = [
      "BILLING_ADDRESS", "BILLING_CONTRACT", "CONTRACT_BILLING",
      "BILLING_CONTRACT_ADDRESS", "EPIMELEIA_BILLING", "ADDRESS_BILLING",
      "CORE_ADDRESS", "CONTRACT_CORE",
    ];
    const CANDIDATOS_ENV_RPC = [
      "POLYGON_RPC_URL", "RPC_URL", "ALCHEMY_URL", "ALCHEMY_RPC",
      "POLYGON_RPC", "RPC_POLYGON", "PROVIDER_URL", "ALCHEMY_API_URL",
    ];

    const primeraVar = (lista) => {
      for (const n of lista) if (process.env[n]) return { nombre: n, valor: process.env[n] };
      return null;
    };

    const rpc = primeraVar(CANDIDATOS_ENV_RPC);
    const dir = primeraVar(CANDIDATOS_ENV_DIR);

    // Listar TODAS las variables de entorno que parezcan relevantes, para
    // diagnóstico (sin mostrar valores sensibles completos).
    const envRelevantes = Object.keys(process.env)
      .filter(k => /RPC|ALCHEMY|BILLING|CONTRACT|CORE|POLYGON|PROVIDER|ADDRESS/i.test(k))
      .sort();

    if (!rpc || !dir) {
      return res.status(200).json({
        ok: false,
        error: "No encontré el RPC o la dirección del contrato en las variables de entorno.",
        versionEthers,
        rpcEncontrado: rpc ? rpc.nombre : null,
        direccionEncontrada: dir ? dir.nombre : null,
        variablesRelevantesQueExisten: envRelevantes,
        pista: "Mirá la lista 'variablesRelevantesQueExisten' y decime cuál es el RPC y cuál la dirección del Billing.",
      });
    }

    const provider = esV6
      ? new ethers.JsonRpcProvider(rpc.valor)
      : new ethers.providers.JsonRpcProvider(rpc.valor);

    const resultados = {};
    let encontrada = null;

    for (const fn of CANDIDATOS_FUNCION) {
      try {
        const abi = [`function ${fn}() view returns (bool)`];
        const contrato = new ethers.Contract(dir.valor, abi, provider);
        const valor = await contrato[fn]();
        resultados[fn] = valor;
        if (encontrada === null) encontrada = { fn, valor };
      } catch {
        /* no existe con esa firma */
      }
    }

    if (encontrada === null) {
      return res.status(200).json({
        ok: false,
        resumen: "El contrato respondió pero ninguno de los nombres de función probados existe.",
        versionEthers,
        contrato: dir.valor,
        rpcUsado: rpc.nombre,
        probados: CANDIDATOS_FUNCION,
      });
    }

    const enProduccion = encontrada.valor === false;

    return res.status(200).json({
      ok: true,
      resumen: enProduccion
        ? `✅ El contrato está en PRODUCCIÓN (${encontrada.fn} = false). Todo bien.`
        : `⚠️ El contrato está en MODO PRUEBA (${encontrada.fn} = true). Hay que ponerlo en false antes de un cliente real.`,
      versionEthers,
      funcionEncontrada: encontrada.fn,
      valor: encontrada.valor,
      enProduccion,
      contrato: dir.valor,
      rpcUsado: rpc.nombre,
      todosLosResultados: resultados,
    });

  } catch (error) {
    // Nunca crashear: mostrar el error.
    return res.status(200).json({
      ok: false,
      error: "El diagnóstico falló, pero acá está el motivo (no crasheó).",
      detalle: String(error && error.message ? error.message : error),
      stack: error && error.stack ? String(error.stack).split("\n").slice(0, 4) : null,
    });
  }
};
