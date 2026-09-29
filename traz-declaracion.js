/**
 * EPIMELEIA TRAZABILIDAD · traz-declaracion.js  (módulo puro)
 * ═════════════════════════════════════════════════════════════
 * El PRIMER eslabón de la trazabilidad por saldo: la DECLARACIÓN.
 *
 * QUÉ ES:
 *   Un titular declara, para un origen y un año, cuánto produjo ese
 *   origen (toneladas). El sistema NO fija el rinde ni discute la cifra:
 *   solo comprueba que la producción declarada sea HUMANAMENTE POSIBLE
 *   sobre la base admisible, contra una referencia pública consultada al
 *   momento del pedido. Si es posible, ACEPTA, y esa producción se vuelve
 *   la CAPACIDAD del origen: el techo que las ventas no van a poder pasar.
 *
 * LA REGLA DEL SÍ (tres responsables, cada uno responde por lo suyo):
 *   · La LEY define qué base es admisible (ej. EUDR: hectáreas sin
 *     deforestación post-2020). Acá llega ya resuelta, en `baseHa`.
 *   · El DECLARANTE define la cifra: `produccionDeclarada`, con su nombre
 *     (huella) sellado. Su responsabilidad, no la nuestra.
 *   · EPIMELEIA solo dice sí/no: rinde declarado = producción / baseHa;
 *     si cae dentro de `referencia.rinde × margen`, ACEPTADA. Generoso
 *     con el inflado (el margen lo cubre), inflexible con la tierra
 *     (baseHa=0 → nada es posible).
 *
 * POR QUÉ ES PURO (igual que paquete-evidencia.js):
 *   No toca Polygon ni Supabase ni la red. Recibe todo ya resuelto
 *   —incluida la referencia pública, que la consulta otro módulo
 *   (traz-rendimiento.js) al momento del pedido— arma el paquete, lo
 *   evalúa y devuelve { paquete, canonical, hash }. El sellado on-chain
 *   y el guardado los hace la puerta. Así es testeable byte a byte.
 *
 * VERIFICACIÓN (misma máquina que los activos):
 *   Reusa sellarPaquete() de paquete-evidencia.js → el hash se computa
 *   con la MISMA canonicalización que un activo. Se publica `canonical`
 *   tal cual; un tercero le aplica keccak256 y compara con Polygon. No
 *   se re-serializa nada: "hasheá estos bytes y compará".
 *
 * PRIVACIDAD:
 *   El paquete es público. No lleva el email del titular, lleva
 *   `titularHash` (huella keccak256 del email normalizado), igual que
 *   el paquete de evidencia de los activos.
 *
 * LOS DOS ENCHUFES (este módulo no sabe cuál se usó, solo lo anota):
 *   · A EPIMELEIA:   la puerta lee el activo sellado, calcula A_limpia
 *                    y la pasa como baseHa con fuenteBase='epimeleia-satelite'.
 *   · Solo trazabilidad: el titular trae su propia base, con
 *                    fuenteBase='declarada-titular' o 'certificado-externo'.
 *   El que verifica ve en `fuenteBase` qué tan fuerte es el piso.
 * ═════════════════════════════════════════════════════════════
 */

const { ethers } = require('ethers');
// Se REUSA la máquina de sellado de los activos: misma canonicalización,
// mismo keccak256. No se duplica para que nunca puedan divergir.
const { sellarPaquete } = require('./paquete-evidencia');

// Versión del formato de la declaración. Si cambia la forma de armarla,
// se sube a v2 y las viejas se siguen verificando con v1.
const TRAZ_DECL_VERSION = 'traz-decl-v1';

// Margen de tolerancia por defecto: hasta cuántas veces la referencia
// pública del ámbito seguimos diciendo que sí. 3× cubre al productor
// intensivo con margen de inflado y deja afuera solo lo absurdo.
// Es el ÚNICO parámetro nuestro; va sellado dentro del paquete.
const MARGEN_DEFAULT = 3;

// Veredictos posibles.
const VEREDICTO = {
  ACEPTADA:     'ACEPTADA',      // la producción declarada es posible → es la capacidad
  NO_ACEPTADA:  'NO_ACEPTADA',   // supera el techo humanamente posible → capacidad 0
  PENDIENTE:    'PENDIENTE',     // falta la referencia pública → no se juzga (no sellar sin decisión)
};

// ─── Helpers de normalización ───────────────────────────────────

// Redondea a 6 decimales y evita el -0. Devuelve Number. (igual que en
// paquete-evidencia.js: misma precisión para que todo sea reproducible)
function _red6(n) {
  if (n == null || !isFinite(Number(n))) return null;
  const x = Math.round(Number(n) * 1e6) / 1e6;
  return x === 0 ? 0 : x;
}

// Number seguro o null.
function _num(n) {
  return (n == null || !isFinite(Number(n))) ? null : Number(n);
}

// Huella del titular: keccak256 del email normalizado. Nunca el email.
function _titularHash(email) {
  if (!email || typeof email !== 'string') return null;
  return ethers.keccak256(ethers.toUtf8Bytes(email.toLowerCase().trim()));
}

// Normaliza el origen a una forma estable, sin inventar campos.
// `tipo` dice de dónde viene; `ref` es el activo on-chain (número) o
// una referencia externa (string). El módulo no interpreta la ref.
function _normalizarOrigen(origen) {
  if (!origen || typeof origen !== 'object') return null;
  let ref = origen.ref;
  if (ref != null && isFinite(Number(ref))) ref = Number(ref);   // activo on-chain → número
  else if (ref != null) ref = String(ref);                       // externo → string
  else ref = null;
  return {
    tipo: origen.tipo ? String(origen.tipo) : null,   // 'epimeleia' | 'externo'
    ref,
  };
}

// Normaliza la referencia pública consultada (la trae traz-rendimiento.js).
// Sin rinde válido no hay contra qué juzgar → la declaración queda PENDIENTE.
function _normalizarReferencia(ref) {
  if (!ref || typeof ref !== 'object') return null;
  const rinde = _red6(ref.rinde);
  if (rinde == null || rinde <= 0) return null;
  return {
    rinde,                                             // t/ha/año de referencia
    unidad:       ref.unidad || 't/ha',
    fuente:       ref.fuente || null,                  // ej. 'FAOSTAT'
    ambito:       ref.ambito || null,                  // 'pais' | 'regional' | 'mundial'
    codigoAmbito: ref.codigoAmbito || null,            // ej. 'GHA' o la región usada
    anioDato:     _num(ref.anioDato),                  // año del dato público
    fechaConsulta: ref.fechaConsulta || null,          // cuándo se consultó la fuente
  };
}

// ─── Evaluación: el sí/no ───────────────────────────────────────
/**
 * Calcula el veredicto a partir de la base, la producción declarada y la
 * referencia pública. Devuelve los números que después van al paquete.
 *   { rindeDeclarado, techo, veredicto, capacidadAnual, motivo }
 */
function evaluarDeclaracion({ baseHa, produccionDeclarada, referencia, margen }) {
  const base = _red6(baseHa);
  const prod = _red6(produccionDeclarada);
  const m    = _num(margen) && Number(margen) > 0 ? Number(margen) : MARGEN_DEFAULT;
  const ref  = _normalizarReferencia(referencia);

  // Sin referencia pública válida: no se juzga. Queda pendiente.
  if (!ref) {
    return {
      rindeDeclarado: null, techo: null,
      veredicto: VEREDICTO.PENDIENTE, capacidadAnual: 0,
      motivo: 'Sin referencia pública para el cultivo/ámbito al momento del pedido.',
    };
  }

  // Tierra inflexible: sin base admisible, nada es posible.
  if (base == null || base <= 0) {
    return {
      rindeDeclarado: null, techo: _red6(ref.rinde * m),
      veredicto: VEREDICTO.NO_ACEPTADA, capacidadAnual: 0,
      motivo: 'La base admisible es cero: sobre tierra no admitida no hay capacidad.',
    };
  }

  // Producción inválida.
  if (prod == null || prod < 0) {
    return {
      rindeDeclarado: null, techo: _red6(ref.rinde * m),
      veredicto: VEREDICTO.NO_ACEPTADA, capacidadAnual: 0,
      motivo: 'Producción declarada inválida.',
    };
  }

  const rindeDeclarado = _red6(prod / base);
  const techo          = _red6(ref.rinde * m);
  const posible        = rindeDeclarado <= techo;

  return {
    rindeDeclarado,
    techo,
    veredicto:      posible ? VEREDICTO.ACEPTADA : VEREDICTO.NO_ACEPTADA,
    capacidadAnual: posible ? prod : 0,   // ACEPTADA → la propia declaración es el techo
    motivo:         posible
      ? null
      : `Rinde declarado ${rindeDeclarado} supera el techo ${techo} (${m}× la referencia ${ref.rinde}).`,
  };
}

// ─── Construcción del paquete de declaración ────────────────────
/**
 * Arma el paquete que se va a sellar y publicar. Recibe todo ya resuelto
 * por la puerta (base admisible, cifra del titular, referencia pública) y
 * devuelve un objeto limpio, normalizado y sin datos personales.
 */
function construirDeclaracion(datos) {
  const {
    origen, cultivo, pais, anio,
    baseHa, fuenteBase,
    produccionDeclarada, referencia, margen,
    titularEmail,
  } = datos;

  const m   = _num(margen) && Number(margen) > 0 ? Number(margen) : MARGEN_DEFAULT;
  const ref = _normalizarReferencia(referencia);
  const ev  = evaluarDeclaracion({ baseHa, produccionDeclarada, referencia, margen: m });

  return {
    version:  TRAZ_DECL_VERSION,
    tipo:     'declaracion',

    origen:   _normalizarOrigen(origen),
    cultivo:  cultivo ? String(cultivo).toLowerCase().trim() : null,
    pais:     pais ? String(pais).toUpperCase().trim() : null,
    anio:     _num(anio),

    // La base y de dónde sale (el piso). fuenteBase es lo que el
    // verificador mira para saber qué tan fuerte es el origen.
    baseHa:     _red6(baseHa),
    fuenteBase: fuenteBase ? String(fuenteBase) : null,

    // La cifra del declarante y contra qué se la juzgó.
    produccionDeclarada: _red6(produccionDeclarada),
    referencia:          ref,        // rinde público + fuente + ámbito + fecha de consulta
    margen:              m,          // el único parámetro nuestro, sellado

    // El veredicto y su fundamento, todo dentro del hash.
    rindeDeclarado:  ev.rindeDeclarado,
    techo:           ev.techo,
    veredicto:       ev.veredicto,
    capacidadAnual:  ev.capacidadAnual,
    motivo:          ev.motivo,

    // Raíz de la cadena de saldo: la declaración es el eslabón cero.
    // Las atribuciones se van a encadenar contra el hash de este paquete.
    hashAnterior: null,

    titularHash: _titularHash(titularEmail),
  };
}

// ─── Sellado (solo el hash; on-chain lo hace la puerta) ─────────
/**
 * Construye Y sella en un paso. Devuelve { paquete, canonical, hash }.
 * `canonical` es lo que se publica; `hash` es lo que la puerta manda a Polygon.
 * Reusa sellarPaquete() → mismo keccak256 canónico que los activos.
 */
function sellarDeclaracion(datos) {
  const paquete = construirDeclaracion(datos);
  const { canonical, hash } = sellarPaquete(paquete);
  return { paquete, canonical, hash };
}

module.exports = {
  TRAZ_DECL_VERSION,
  MARGEN_DEFAULT,
  VEREDICTO,
  evaluarDeclaracion,
  construirDeclaracion,
  sellarDeclaracion,
};
