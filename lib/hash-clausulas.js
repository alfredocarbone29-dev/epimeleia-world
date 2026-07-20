// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA V3.4 — Cláusulas del deslinde y su hash
// ────────────────────────────────────────────────────────────────────────────
// Este archivo es la FUENTE ÚNICA DE VERDAD del deslinde legal.
// Define:
//   · el texto de cada versión de las cláusulas,
//   · cuál es la versión VIGENTE,
//   · y la función que calcula el hash de una aceptación.
//
// LA REGLA DE ORO (igual que la regla de lectura del satélite):
//   ⛔ Una versión publicada NO se edita nunca. Ni una coma.
//   ✅ Si hay que cambiar el texto, se AGREGA una versión nueva.
//
//   Por qué: el hash de aceptación de un cliente se calcula con el texto de
//   SU versión. Si alguien edita el texto de una versión ya usada, todas las
//   firmas viejas dejan de poder verificarse: dicen "v2.0.0", pero la v2.0.0
//   que existe ya no es la que firmaron. El sello queda intacto y la prueba
//   se rompe igual. Es el mismo error que el viejo `return 50`.
//
// ────────────────────────────────────────────────────────────────────────────
// HISTORIAL DE VERSIONES
//   v1.0.0 — histórica. Hablaba de "firmar con clave privada", un método que
//            se descartó (el cliente nunca firma con clave privada). NO usar.
//   v2.0.0 — histórica. En inglés. Correcta en su alcance, pero el recorrido
//            del cliente es todo en español, así que mostrarla en inglés no
//            era coherente. Se reemplazó por la v3.0.0.
//   v3.0.0 — VIGENTE. Misma sustancia que la v2.0.0, en español. Es la que se
//            muestra y se sella. (19/7/2026)
// ────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");

// ════════════════════════════════════════════════════════════════════════════
//  LAS VERSIONES DE LAS CLÁUSULAS
//  Cada una es el TEXTO EXACTO que el cliente lee y acepta. El hash de la
//  versión se calcula desde este texto (más abajo), así que el texto y su
//  hash siempre coinciden: no se puede mostrar uno y sellar otro.
// ════════════════════════════════════════════════════════════════════════════

const CLAUSULAS = {

  // ── v1.0.0 · HISTÓRICA — NO USAR ──────────────────────────────────────────
  "v1.0.0":
`EPIMELEIA — Environmental Notary Protocol — Terms of Acceptance (v1.0.0)

By registering an asset, the Client accepts that EPIMELEIA records satellite
observations on the Polygon blockchain as immutable proof. By signing with their
private key, the Client agrees to these terms.`,

  // ── v2.0.0 · HISTÓRICA (inglés) — reemplazada por la v3.0.0 ────────────────
  "v2.0.0":
`EPIMELEIA — Environmental Notary Protocol — Terms of Acceptance (v2.0.0)

1. EPIMELEIA acts solely as a technical notary. It observes, through Sentinel-2
   satellite imagery provided by the European Space Agency (Copernicus), the
   environmental state of the geographic area (the "Asset") defined by the
   Client, and records that observation on the Polygon blockchain as immutable
   evidence.

2. The satellite images and the measurements derived from them reflect what the
   satellite observed on a given date. Their interpretation and any decision
   based on them are the sole responsibility of the Client. EPIMELEIA does not
   guarantee any particular environmental outcome, nor does it audit, endorse or
   certify the Client's conduct regarding the Asset.

3. The Client acknowledges and accepts the on-chain record as the definitive
   source of truth. Once sealed, a record cannot be altered by anyone, including
   EPIMELEIA and the Client.

4. The Client declares to have the right to request the observation of the
   Asset, and is solely responsible for the geographic boundaries (the polygon)
   they define.

5. EPIMELEIA reserves the right to incorporate improvements and new satellite
   sources into the protocol, without altering records already sealed.`,

  // ── v3.0.0 · VIGENTE (español) ────────────────────────────────────────────
  // Misma sustancia que la v2.0.0, en español, porque todo el recorrido del
  // cliente es en español. Es la que se muestra en el modal y la que se sella.
  "v3.0.0":
`EPIMELEIA — Protocolo de Notaría Ambiental — Términos de Aceptación (v3.0.0)

1. EPIMELEIA actúa exclusivamente como notario técnico. Observa, a través de
   imágenes satelitales Sentinel-2 provistas por la Agencia Espacial Europea
   (Copernicus), el estado ambiental del área geográfica (el "Activo") definida
   por el Cliente, y registra esa observación en la blockchain de Polygon como
   evidencia inmutable.

2. Las imágenes satelitales y las mediciones derivadas de ellas reflejan lo que
   el satélite observó en una fecha determinada. Su interpretación y cualquier
   decisión basada en ellas son responsabilidad exclusiva del Cliente.
   EPIMELEIA no garantiza ningún resultado ambiental en particular, ni audita,
   avala ni certifica la conducta del Cliente respecto del Activo.

3. El Cliente reconoce y acepta el registro on-chain como la fuente de verdad
   definitiva. Una vez sellado, un registro no puede ser alterado por nadie,
   incluidos EPIMELEIA y el propio Cliente.

4. El Cliente declara tener el derecho de solicitar la observación del Activo, y
   es el único responsable de los límites geográficos (el polígono) que define.

5. EPIMELEIA se reserva el derecho de incorporar mejoras y nuevas fuentes
   satelitales al protocolo, sin alterar los registros ya sellados.`,

};

// ════════════════════════════════════════════════════════════════════════════
//  VERSIÓN VIGENTE
//  La que se muestra al cliente y la que se sella. Cambiar esto es lo único
//  que hace falta para "publicar" una versión nueva.
// ════════════════════════════════════════════════════════════════════════════

const VERSION_VIGENTE = "v3.0.0";

// ════════════════════════════════════════════════════════════════════════════
//  EL HASH DE CADA VERSIÓN DEL TEXTO
//  Se calcula desde el TEXTO de la cláusula. Si alguien editara el texto de una
//  versión, su hash cambiaría y no coincidiría con las firmas viejas — que es
//  exactamente por qué las versiones no se editan.
// ════════════════════════════════════════════════════════════════════════════

function hashDeClausulas(version) {
  const texto = CLAUSULAS[version];
  if (!texto) throw new Error(`EPIMELEIA: no existe la versión de cláusulas "${version}"`);
  return "0x" + crypto.createHash("sha256").update(texto, "utf8").digest("hex");
}

// El hash de la versión vigente, listo para usar en webhooks y registro.
const HASH_CLAUSULAS_VIGENTE = hashDeClausulas(VERSION_VIGENTE);

// Se mantiene el nombre viejo por compatibilidad con código que lo importaba.
// Apunta SIEMPRE a la vigente (antes era la v1; ahora la vigente es la v3).
const HASH_CLAUSULAS_V1 = HASH_CLAUSULAS_VIGENTE;

// ════════════════════════════════════════════════════════════════════════════
//  EL HASH DE UNA ACEPTACIÓN
//  Es la "firma" del cliente: prueba que ESTE email aceptó ESTA versión en ESTE
//  momento. Cubre email + fecha + versión + el hash del texto de esa versión.
//
//  ⚠️ Esta función es la ÚNICA que calcula el hash de una aceptación en todo el
//  sistema. La usan los webhooks y registrar-activo.js. Por eso el hash sale
//  siempre igual: hay un solo lugar que lo define.
// ════════════════════════════════════════════════════════════════════════════

function calcularHashAceptacion(email, timestamp, version = VERSION_VIGENTE) {
  const emailNorm = String(email || "").toLowerCase().trim();
  const hashTexto = hashDeClausulas(version);
  const material  = `${emailNorm}|${timestamp}|${version}|${hashTexto}`;
  return "0x" + crypto.createHash("sha256").update(material, "utf8").digest("hex");
}

// ── Devuelve el texto de una versión (para mostrarlo en el modal) ────────────
function textoDeClausulas(version = VERSION_VIGENTE) {
  const texto = CLAUSULAS[version];
  if (!texto) throw new Error(`EPIMELEIA: no existe la versión de cláusulas "${version}"`);
  return texto;
}

module.exports = {
  CLAUSULAS,
  VERSION_VIGENTE,
  HASH_CLAUSULAS_VIGENTE,
  HASH_CLAUSULAS_V1,        // compat: apunta a la vigente
  hashDeClausulas,
  calcularHashAceptacion,
  textoDeClausulas,
};

// ── Mostrar por consola:  node lib/hash-clausulas.js ────────────────────────
if (require.main === module) {
  console.log("");
  console.log("EPIMELEIA · Cláusulas del deslinde");
  console.log("─".repeat(60));
  console.log("Versión vigente:", VERSION_VIGENTE);
  console.log("Hash vigente:   ", HASH_CLAUSULAS_VIGENTE);
  console.log("");
  console.log("Hash de cada versión:");
  for (const v of Object.keys(CLAUSULAS)) {
    console.log(`  ${v}  →  ${hashDeClausulas(v)}`);
  }
  console.log("");
  console.log("Texto vigente (lo que ve el cliente):");
  console.log("─".repeat(60));
  console.log(textoDeClausulas());
  console.log("");
}
