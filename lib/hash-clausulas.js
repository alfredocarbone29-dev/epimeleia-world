// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA V3.4 — Cláusulas de Aceptación (Liability Disclaimer)
// ────────────────────────────────────────────────────────────────────────────
// Este archivo contiene el TEXTO EXACTO de las tres cláusulas que el cliente
// acepta antes de pagar (clickwrap). El hash de este texto se ancla on-chain
// junto al activo registrado.
//
// REGLA DE ORO: si se cambia una sola letra del texto, cambia el hash, y se
// rompe la trazabilidad de aceptaciones anteriores. Para versionar:
//   - NO modifiques CLAUSULAS_V1
//   - Creá CLAUSULAS_V2 con los cambios, y en el webhook usá la versión
//     vigente al momento de cada pago. Las aceptaciones viejas siguen
//     apuntando a su versión original.
// ────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");

// Texto exacto de las cláusulas — extraído de api/chat.js (system prompt).
// Cada cláusula es un string limpio, sin saltos de línea extra.
const CLAUSULAS_V1 = {
  version: "v1.0.0",
  fechaPublicacion: "2026-06-12",
  idioma: "en",

  clausula1: "Clause 1 — IRREVERSIBLE TECHNOLOGICAL INVOLUTION: The client declares full understanding of the smart contract mechanics and accepts that the Opacity state is a technical, mathematical, and automatic consequence of the protocol. This state is irreversible by human action. The client irrevocably waives any claim for lost profits, consequential damages, or reputational harm arising from the public disclosure of said state on the Polygon blockchain.",

  clausula2: "Clause 2 — THIRD-PARTY TECHNOLOGICAL FACT: Epimeleia acts solely as a conduit for data from independent third parties — the European Union Copernicus Space Programme (ESA). The client accepts that Epimeleia does not control, audit, or guarantee the technical availability or accuracy of these global satellite systems. If the satellite reports erroneous or unavailable data, the protocol executes based on received input. Epimeleia bears no liability for satellite availability or data quality.",

  clausula3: "Clause 3 — CRYPTOGRAPHIC JURISDICTION: Execution of code on the Polygon network constitutes the sole valid jurisdiction for determining protocol consistency. The client accepts the smart contract verdict as consensus-as-a-service. By signing with their private key, the client irrevocably waives jurisdiction of their national courts for matters arising from automated code execution."
};

// Calcula el hash SHA-256 del texto canónico de las tres cláusulas.
// El formato canónico es: version + clausula1 + clausula2 + clausula3
// (concatenadas con "\n---\n" como separador para que sea inambiguo)
function calcularHashClausulas(clausulas = CLAUSULAS_V1) {
  const textoCanonico = [
    clausulas.version,
    clausulas.clausula1,
    clausulas.clausula2,
    clausulas.clausula3
  ].join("\n---\n");

  return crypto.createHash("sha256").update(textoCanonico, "utf8").digest("hex");
}

// Hash de la versión actual (se calcula una vez al cargar el módulo)
const HASH_CLAUSULAS_V1 = calcularHashClausulas(CLAUSULAS_V1);

// Calcula el hash de aceptación de un cliente específico.
// Combina: email + versión de cláusulas + hash de cláusulas + timestamp ISO.
// Este es el hash que se guarda en Redis y se ancla on-chain.
function calcularHashAceptacion(email, timestampISO, versionClausulas = "v1.0.0") {
  const hashClausulas = versionClausulas === "v1.0.0" ? HASH_CLAUSULAS_V1 : null;
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
  CLAUSULAS_V1,
  HASH_CLAUSULAS_V1,
  calcularHashClausulas,
  calcularHashAceptacion
};
