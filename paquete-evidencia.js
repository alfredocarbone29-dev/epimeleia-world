/**
 * EPIMELEIA · paquete-evidencia.js  (PASO A — prueba aislada)
 * ═════════════════════════════════════════════════════════════
 * LA JUNTA A, resuelta: el hash que SÍ prueba lo que el certificado dice.
 *
 * Hoy generarHashEvidencia() (satellite.js) sella 7 campos de metadata.
 * El polígono, el veredicto de deforestación y las mediciones NO entran
 * al hash: viven en Supabase, y "confiá en mí". Este módulo cierra eso.
 *
 * QUÉ HACE:
 *   1. construirPaquete(datos)  → arma el "paquete de inscripción": todo
 *      lo que define la prueba (polígono + deforestación + mediciones +
 *      regla + activo), con las coordenadas redondeadas a 6 decimales y
 *      SIN datos personales del titular (solo su huella — ver abajo).
 *   2. canonicalizar(obj)       → produce UNA cadena JSON canónica:
 *      claves ordenadas alfabéticamente en todos los niveles, sin
 *      espacios. Misma entrada → misma cadena, siempre.
 *   3. sellarPaquete(paquete)   → devuelve { canonical, hash } donde
 *      hash = keccak256(bytes utf-8 de canonical).
 *
 * CÓMO SE VERIFICA (la clave del diseño):
 *   Se PUBLICA la cadena `canonical` tal cual (bytes exactos) en un
 *   endpoint de epimeleia.world. Un tercero baja ESA cadena, le aplica
 *   keccak256, y compara con el hash que está en Polygon. No re-serializa
 *   nada: hashea los bytes publicados. Por eso es verificable en cualquier
 *   lenguaje — es "hasheá estos bytes y compará", nada más.
 *
 * PRIVACIDAD (decisión importante):
 *   El paquete es PÚBLICO. Por eso NO lleva el email ni el nombre del
 *   titular — eso sería exponer datos personales. Lleva `titularHash`,
 *   la huella keccak256 del email normalizado. Eso prueba que el sello
 *   está atado a un titular específico, sin revelar quién es. El dueño,
 *   que sí conoce su email, puede demostrar que le corresponde.
 * ═════════════════════════════════════════════════════════════
 */

const { ethers } = require('ethers');

// La versión del formato del paquete. Si algún día cambia la forma en
// que se arma, se sube a v2 y los viejos siguen verificándose con v1.
const PAQUETE_VERSION = 'paquete-v1';

// ─── Canonicalización ───────────────────────────────────────────
// Ordena las claves de todo objeto alfabéticamente, en todos los
// niveles, y serializa sin espacios. Los arrays mantienen su orden
// (en un polígono el orden de los vértices importa). El resultado es
// una cadena estable: la misma entrada da siempre la misma cadena.
function canonicalizar(valor) {
  return JSON.stringify(_ordenar(valor));
}

function _ordenar(v) {
  if (Array.isArray(v)) {
    return v.map(_ordenar);
  }
  if (v && typeof v === 'object') {
    const salida = {};
    for (const clave of Object.keys(v).sort()) {
      salida[clave] = _ordenar(v[clave]);
    }
    return salida;
  }
  return v; // primitivo (string, number, boolean, null)
}

// ─── Helpers de normalización ───────────────────────────────────

// Redondea a 6 decimales (~0,1 m) y evita el -0. Devuelve un Number.
function _red6(n) {
  const x = Math.round(Number(n) * 1e6) / 1e6;
  return x === 0 ? 0 : x;
}

// Normaliza el anillo del polígono: [[lng,lat],...] con 6 decimales,
// cerrado (primer punto == último). Acepta Feature, Geometry o string.
function _normalizarPoligono(poligono) {
  let g = poligono;
  if (typeof g === 'string') { try { g = JSON.parse(g); } catch { return null; } }
  if (g && g.type === 'Feature') g = g.geometry;
  let ring = null;
  if (g && g.type === 'Polygon' && Array.isArray(g.coordinates)) ring = g.coordinates[0];
  else if (g && Array.isArray(g.coordinates) && Array.isArray(g.coordinates[0]) && Array.isArray(g.coordinates[0][0])) ring = g.coordinates[0];
  else if (Array.isArray(g) && Array.isArray(g[0])) ring = g;
  if (!ring || ring.length < 3) return null;

  let r = ring.map(c => [_red6(c[0]), _red6(c[1])]);
  const a = r[0], z = r[r.length - 1];
  if (a[0] !== z[0] || a[1] !== z[1]) r = r.concat([[a[0], a[1]]]);
  return { type: 'Polygon', coordinates: [r] };
}

// Huella del titular: keccak256 del email normalizado. Nunca el email.
function _titularHash(email) {
  if (!email || typeof email !== 'string') return null;
  return ethers.keccak256(ethers.toUtf8Bytes(email.toLowerCase().trim()));
}

// Normaliza el veredicto de deforestación a una forma estable.
function _normalizarDeforestacion(def) {
  if (!def || typeof def.huboDeforestacion !== 'boolean') return null;
  const detalle = Array.isArray(def.detallePorAnio)
    ? def.detallePorAnio
        .filter(d => d && d.anio != null)
        .map(d => ({ anio: Number(d.anio), hectareas: _red6(d.hectareas) }))
        .sort((a, b) => a.anio - b.anio)
    : [];
  return {
    hubo:            def.huboDeforestacion,
    totalHectareas:  def.totalHectareasPerdidas != null ? _red6(def.totalHectareasPerdidas) : null,
    detallePorAnio:  detalle,
    periodo:         def.periodoAnalizado || null,
    fuente:          def.fuente || null,
    resolucion:      def.resolucion || null,
  };
}

// Normaliza las mediciones (NDVI, humedad…) a lo esencial y estable.
function _normalizarMediciones(mediciones) {
  if (!Array.isArray(mediciones)) return [];
  return mediciones.map(m => ({
    indice:         m.indice ?? null,
    clave:          m.clave ?? null,
    etiqueta:       m.etiqueta ?? null,
    valor:          m.valor != null ? _red6(m.valor) : null,
    calidadPct:     m.calidadPct != null ? Number(m.calidadPct) : null,
    interpretacion: m.interpretacion ?? null,
    fecha:          m.fecha ?? null,
  }));
}

// ─── Construcción del paquete de inscripción ────────────────────
/**
 * Arma el paquete que se va a sellar y publicar. Recibe lo que ya
 * tienen la medición (satellite) y el activo (supabase), y devuelve
 * un objeto limpio, normalizado y sin datos personales.
 */
function construirPaquete(datos) {
  const {
    activoIdOnchain, nombreActivo, tipoTexto,
    poligono, medicion, deforestacion,
    titularEmail, trimestre,
  } = datos;

  return {
    version:        PAQUETE_VERSION,
    activoIdOnchain: activoIdOnchain != null ? Number(activoIdOnchain) : null,
    nombreActivo:   nombreActivo || null,
    tipo:           tipoTexto || null,
    trimestre:      trimestre != null ? Number(trimestre) : null,

    poligono:       _normalizarPoligono(poligono),

    satelite:       medicion?.satelite || null,
    fuente:         medicion?.fuente || null,
    fechaPasada:    medicion?.fechaPasada || null,
    calidadPct:     medicion?.calidadPct != null ? Number(medicion.calidadPct) : null,
    nubosidadPct:   medicion?.nubosidadPct != null ? Number(medicion.nubosidadPct) : null,
    reglaLectura:   medicion?.reglaLectura || null,
    hashRegla:      medicion?.hashRegla || null,
    mediciones:     _normalizarMediciones(medicion?.mediciones),

    deforestacion:  _normalizarDeforestacion(deforestacion),

    titularHash:    _titularHash(titularEmail),
  };
}

// ─── Sellado ────────────────────────────────────────────────────
/**
 * Dado un paquete ya construido, devuelve la cadena canónica y su hash.
 *   { canonical, hash }
 * `canonical` es lo que se publica; `hash` es lo que va a Polygon.
 */
function sellarPaquete(paquete) {
  const canonical = canonicalizar(paquete);
  const hash = ethers.keccak256(ethers.toUtf8Bytes(canonical));
  return { canonical, hash };
}

/**
 * Atajo: construye Y sella en un paso. Devuelve { paquete, canonical, hash }.
 */
function construirYSellar(datos) {
  const paquete = construirPaquete(datos);
  const { canonical, hash } = sellarPaquete(paquete);
  return { paquete, canonical, hash };
}

module.exports = {
  PAQUETE_VERSION,
  canonicalizar,
  construirPaquete,
  sellarPaquete,
  construirYSellar,
};
