/**
 * EPIMELEIA TRAZABILIDAD · traz-atribucion.js  (módulo puro)
 * ═════════════════════════════════════════════════════════════
 * El SEGUNDO eslabón: la ATRIBUCIÓN. El descuento de saldo.
 *
 * QUÉ ES:
 *   Una declaración ACEPTADA fijó una capacidad (ej. 30 t). Esa capacidad
 *   es una CUENTA DE SALDO que solo baja. Cada venta que se atribuye a ese
 *   origen descuenta toneladas. El saldo nunca puede dar negativo: cuando
 *   llega a cero, no se puede atribuir más producto a ese origen, y la
 *   mezcla se vuelve imposible POR SALDO. No hace falta seguir el saco
 *   físico: basta con que la suma atribuida no supere lo que el origen
 *   pudo dar.
 *
 * LA CADENA:
 *   declaración (eslabón 0) → atribución 1 → atribución 2 → …
 *   Cada atribución lleva `hashAnterior` = el hash del eslabón inmediato
 *   anterior, y `declaracionHash` = la raíz de la cuenta. Así la cadena
 *   es reconstruible y cada movimiento queda sellado e inmutable. Un
 *   eslabón no se puede intercalar ni reescribir sin romper la cadena.
 *
 * POR QUÉ ES PURO (igual que traz-declaracion.js):
 *   No lee ni escribe nada. La PUERTA calcula el `saldoAnterior` (suma la
 *   capacidad de la declaración menos las atribuciones ya selladas de ese
 *   origen y año) y trae el `hashAnterior`; este módulo solo decide si el
 *   descuento entra, arma el paquete y lo hashea. Testeable byte a byte.
 *
 * LA REGLA (una sola):
 *   saldoNuevo = saldoAnterior − toneladas.
 *   · saldoNuevo ≥ 0 → ATRIBUIDA. Se descuenta.
 *   · saldoNuevo < 0 → RECHAZADA. No alcanza el saldo. No se sella nada:
 *     el intento no ocurre. (la puerta le devuelve el error al receptor)
 *
 * QUIÉN PUEDE ATRIBUIR:
 *   Eso lo controla la puerta (sesión del titular del origen, por ahora).
 *   Este módulo no decide permisos, solo aritmética y sello.
 *
 * IMPORTANTE (coherencia que garantiza la puerta, no este módulo):
 *   El saldo se reinicia por año de cosecha. La puerta solo suma
 *   atribuciones del mismo `anio` y `declaracionHash` al calcular el
 *   saldoAnterior. Este módulo anota el año; no lo cruza.
 * ═════════════════════════════════════════════════════════════
 */

const { ethers } = require('ethers');
// Misma máquina de sellado que la declaración y que los activos.
const { sellarPaquete } = require('./paquete-evidencia');

const TRAZ_ATRIB_VERSION = 'traz-atrib-v1';

const VEREDICTO = {
  ATRIBUIDA: 'ATRIBUIDA',   // el descuento entró; saldoNuevo ≥ 0
  RECHAZADA: 'RECHAZADA',   // saldo insuficiente; no se sella
};

// ─── Helpers (mismos criterios que traz-declaracion.js) ─────────

function _red6(n) {
  if (n == null || !isFinite(Number(n))) return null;
  const x = Math.round(Number(n) * 1e6) / 1e6;
  return x === 0 ? 0 : x;
}

function _num(n) {
  return (n == null || !isFinite(Number(n))) ? null : Number(n);
}

// Huella pública de un identificador (email o id del receptor). Nunca el
// dato en claro: el receptor conoce el suyo y puede demostrar que le toca.
function _huella(valor) {
  if (!valor || typeof valor !== 'string') return null;
  return ethers.keccak256(ethers.toUtf8Bytes(valor.toLowerCase().trim()));
}

function _normalizarOrigen(origen) {
  if (!origen || typeof origen !== 'object') return null;
  let ref = origen.ref;
  if (ref != null && isFinite(Number(ref))) ref = Number(ref);
  else if (ref != null) ref = String(ref);
  else ref = null;
  return { tipo: origen.tipo ? String(origen.tipo) : null, ref };
}

// Hash 0x… de 32 bytes (declaración raíz o eslabón anterior).
function _hash(h) {
  if (!h || typeof h !== 'string') return null;
  const s = h.trim();
  return /^0x[0-9a-fA-F]{64}$/.test(s) ? s.toLowerCase() : null;
}

// ─── Evaluación: entra o no entra ───────────────────────────────
/**
 * Decide el descuento a partir del saldo anterior y las toneladas.
 *   { toneladas, saldoNuevo, veredicto, motivo }
 */
function evaluarAtribucion({ saldoAnterior, toneladas }) {
  const saldo = _red6(saldoAnterior);
  const t     = _red6(toneladas);

  if (saldo == null || saldo < 0) {
    return { toneladas: t, saldoNuevo: null, veredicto: VEREDICTO.RECHAZADA,
      motivo: 'Saldo anterior inválido.' };
  }
  if (t == null || t <= 0) {
    return { toneladas: t, saldoNuevo: saldo, veredicto: VEREDICTO.RECHAZADA,
      motivo: 'Toneladas a atribuir inválidas (deben ser mayores que cero).' };
  }

  const saldoNuevo = _red6(saldo - t);

  if (saldoNuevo < 0) {
    return { toneladas: t, saldoNuevo: null, veredicto: VEREDICTO.RECHAZADA,
      motivo: `Saldo insuficiente: quedan ${saldo} y se quieren atribuir ${t}.` };
  }

  return { toneladas: t, saldoNuevo, veredicto: VEREDICTO.ATRIBUIDA, motivo: null };
}

// ─── Construcción del paquete de atribución ─────────────────────
/**
 * Arma el eslabón. Recibe todo ya resuelto por la puerta (saldo anterior,
 * hash raíz, hash del eslabón anterior) y devuelve el paquete normalizado.
 */
function construirAtribucion(datos) {
  const {
    declaracionHash, hashAnterior, origen,
    cultivo, anio,
    saldoAnterior, toneladas,
    receptor, referenciaComercial, fecha,
  } = datos;

  const ev = evaluarAtribucion({ saldoAnterior, toneladas });

  return {
    version: TRAZ_ATRIB_VERSION,
    tipo:    'atribucion',

    // A qué cuenta pertenece y contra qué eslabón se encadena.
    declaracionHash: _hash(declaracionHash),
    hashAnterior:    _hash(hashAnterior),

    // El origen, repetido para que el eslabón se lea solo.
    origen:  _normalizarOrigen(origen),
    cultivo: cultivo ? String(cultivo).toLowerCase().trim() : null,
    anio:    _num(anio),

    // El movimiento: cuánto se descuenta y el saldo antes/después.
    toneladas:     ev.toneladas,
    saldoAnterior: _red6(saldoAnterior),
    saldoNuevo:    ev.saldoNuevo,
    veredicto:     ev.veredicto,
    motivo:        ev.motivo,

    // Datos del movimiento (públicos salvo la identidad del receptor).
    referenciaComercial: referenciaComercial ? String(referenciaComercial) : null,
    fecha:               fecha ? String(fecha) : null,
    receptorHash:        _huella(receptor),
  };
}

// ─── Sellado (solo el hash; on-chain lo hace la puerta) ─────────
/**
 * Construye Y sella. Devuelve { paquete, canonical, hash }.
 * Reusa sellarPaquete() → mismo keccak256 canónico que todo lo demás.
 * Nota: aunque el veredicto sea RECHAZADA se devuelve el hash, pero la
 * puerta NO debe sellar un rechazo: un intento fallido no es un eslabón.
 */
function sellarAtribucion(datos) {
  const paquete = construirAtribucion(datos);
  const { canonical, hash } = sellarPaquete(paquete);
  return { paquete, canonical, hash };
}

module.exports = {
  TRAZ_ATRIB_VERSION,
  VEREDICTO,
  evaluarAtribucion,
  construirAtribucion,
  sellarAtribucion,
};
