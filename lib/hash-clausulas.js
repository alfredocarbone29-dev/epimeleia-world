// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA V3.4 — Cláusulas de Aceptación (Liability Disclaimer)
// ────────────────────────────────────────────────────────────────────────────
// Este archivo contiene el TEXTO EXACTO de las tres cláusulas que el cliente
// acepta antes de pagar (clickwrap). El hash de este texto se ancla on-chain
// junto al activo registrado.
//
// REGLA DE ORO: si se cambia una sola letra del texto, cambia el hash, y se
// rompe la trazabilidad de aceptaciones anteriores. Por eso NO se modifica una
// versión ya publicada. Se crea una nueva versión y la vigente pasa a ser esa.
// Las aceptaciones viejas siguen apuntando a su versión original, que queda
// intacta acá para que siempre se puedan verificar.
//
// ── HISTORIAL DE VERSIONES ──────────────────────────────────────────────────
// v1.0.0 (2026-06-12) — versión original. La cláusula 3 mencionaba "by signing
//   with their private key", un resto de cuando la aceptación se pensaba con
//   MetaMask. Ese método se descartó: hoy la aceptación es clickwrap, sin
//   billetera. Se conserva intacta por la regla de oro (no se reescribe el
//   pasado), pero ya NO es la vigente.
// v2.0.0 (2026-06-22) — versión vigente. Cláusula 3 corregida: refleja la
//   aceptación real (clickwrap, sin clave privada) y queda idéntica al texto
//   que EPI presenta en la conversación. Cláusulas 1 y 2 sin cambios respecto
//   a v1.
// ────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");

// ── v1.0.0 — HISTÓRICA. NO MODIFICAR (regla de oro). ────────────────────────
const CLAUSULAS_V1 = {
  version: "v1.0.0",
  fechaPublicacion: "2026-06-12",
  idioma: "en",

  clausula1: "Clause 1 — IRREVERSIBLE TECHNOLOGICAL INVOLUTION: The client declares full understanding of the smart contract mechanics and accepts that the Opacity state is a technical, mathematical, and automatic consequence of the protocol. This state is irreversible by human action. The client irrevocably waives any claim for lost profits, consequential damages, or reputational harm arising from the public disclosure of said state on the Polygon blockchain.",

  clausula2: "Clause 2 — THIRD-PARTY TECHNOLOGICAL FACT: Epimeleia acts solely as a conduit for data from independent third parties — the European Union Copernicus Space Programme (ESA). The client accepts that Epimeleia does not control, audit, or guarantee the technical availability or accuracy of these global satellite systems. If the satellite reports erroneous or unavailable data, the protocol executes based on received input. Epimeleia bears no liability for satellite availability or data quality.",

  clausula3: "Clause 3 — CRYPTOGRAPHIC JURISDICTION: Execution of code on the Polygon network constitutes the sole valid jurisdiction for determining protocol consistency. The client accepts the smart contract verdict as consensus-as-a-service. By signing with their private key, the client irrevocably waives jurisdiction of their national courts for matters arising from automated code execution."
};

// ── v2.0.0 — VIGENTE. Cláusula 3 corregida (clickwrap, sin clave privada). ──
// Cláusulas 1 y 2 son idénticas a v1 a propósito; solo cambia la 3.
const CLAUSULAS_V2 = {
  version: "v2.0.0",
  fechaPublicacion: "2026-06-22",
  idioma: "en",

  clausula1: "Clause 1 — IRREVERSIBLE TECHNOLOGICAL INVOLUTION: The client declares full understanding of the smart contract mechanics and accepts that the Opacity state is a technical, mathematical, and automatic consequence of the protocol. This state is irreversible by human action. The client irrevocably waives any claim for lost profits, consequential damages, or reputational harm arising from the public disclosure of said state on the Polygon blockchain.",

  clausula2: "Clause 2 — THIRD-PARTY TECHNOLOGICAL FACT: Epimeleia acts solely as a conduit for data from independent third parties — the European Union Copernicus Space Programme (ESA). The client accepts that Epimeleia does not control, audit, or guarantee the technical availability or accuracy of these global satellite systems. If the satellite reports erroneous or unavailable data, the protocol executes based on received input. Epimeleia bears no liability for satellite availability or data quality.",

  clausula3: "Clause 3 — CRYPTOGRAPHIC JURISDICTION: Execution of code on the Polygon network constitutes the sole valid jurisdiction for determining protocol consistency. The client accepts the smart contract verdict as consensus-as-a-service. For matters arising from automated code execution, the client accepts the on-chain record as the definitive source of truth."
};

// ── Registro de versiones ───────────────────────────────────────────────────
// Para agregar una v3 en el futuro: se define CLAUSULAS_V3, se la suma acá, y
// se actualiza VERSION_VIGENTE. Nada más. Las versiones viejas quedan vivas.
const VERSIONES = {
  "v1.0.0": CLAUSULAS_V1,
  "v2.0.0": CLAUSULAS_V2
};

// Versión que se usa para toda aceptación NUEVA.
const VERSION_VIGENTE = "v2.0.0";
const CLAUSULAS_VIGENTE = VERSIONES[VERSION_VIGENTE];

// ── Hash del texto canónico de un set de cláusulas ──────────────────────────
// Formato canónico: version + clausula1 + clausula2 + clausula3
// (concatenadas con "\n---\n" como separador inambiguo).
function calcularHashClausulas(clausulas = CLAUSULAS_VIGENTE) {
  const textoCanonico = [
    clausulas.version,
    clausulas.clausula1,
    clausulas.clausula2,
    clausulas.clausula3
  ].join("\n---\n");

  return crypto.createHash("sha256").update(textoCanonico, "utf8").digest("hex");
}

// Hashes precalculados de cada versión (se calculan una vez al cargar).
const HASH_CLAUSULAS_V1 = calcularHashClausulas(CLAUSULAS_V1);
const HASH_CLAUSULAS_V2 = calcularHashClausulas(CLAUSULAS_V2);
const HASH_CLAUSULAS_VIGENTE = HASH_CLAUSULAS_V2;

// Mapa versión → hash, para resolver cualquier versión por su nombre.
const HASH_POR_VERSION = {
  "v1.0.0": HASH_CLAUSULAS_V1,
  "v2.0.0": HASH_CLAUSULAS_V2
};

// ── Hash de aceptación de un cliente específico ─────────────────────────────
// Combina: email + versión de cláusulas + hash de esas cláusulas + timestamp.
// Este es el hash que se guarda en Redis y se ancla on-chain.
// Por defecto usa la versión VIGENTE; se puede pasar otra para verificar
// aceptaciones históricas.
function calcularHashAceptacion(email, timestampISO, versionClausulas = VERSION_VIGENTE) {
  const hashClausulas = HASH_POR_VERSION[versionClausulas];
  if (!hashClausulas) throw new Error(`Versión de cláusulas desconocida: ${versionClausulas}`);

  const payloadCanonico = JSON.stringify({
    email: email.toLowerCase().trim(),
    version_clausulas: versionClausulas,
    hash_clausulas: hashClausulas,
    timestamp: timestampISO
  });

  return crypto.createHash("sha256").update(payloadCanonico, "utf8").digest("hex");
}

module.exports = {
  // Versiones (texto)
  CLAUSULAS_V1,
  CLAUSULAS_V2,
  VERSIONES,
  VERSION_VIGENTE,
  CLAUSULAS_VIGENTE,
  // Hashes
  HASH_CLAUSULAS_V1,
  HASH_CLAUSULAS_V2,
  HASH_CLAUSULAS_VIGENTE,
  HASH_POR_VERSION,
  // Funciones
  calcularHashClausulas,
  calcularHashAceptacion
};
