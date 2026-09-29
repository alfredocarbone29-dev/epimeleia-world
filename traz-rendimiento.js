/**
 * EPIMELEIA TRAZABILIDAD · traz-rendimiento.js
 * ═════════════════════════════════════════════════════════════
 * La REFERENCIA PÚBLICA: cuánto rinde un cultivo, según un dato que no
 * es nuestro. Es lo que le da de comer a traz-declaracion.js.
 *
 * QUÉ DEVUELVE (justo lo que la declaración espera):
 *   { rinde, unidad, fuente, ambito, codigoAmbito, anioDato, fechaConsulta }
 *
 * DE DÓNDE SALE — dos capas, siempre etiquetadas para que el verificador
 * sepa exactamente contra qué se juzgó:
 *   1. CONSULTA VIVA a FAOSTAT (el rinde del país, al momento del pedido).
 *      fuente = 'FAOSTAT', ambito = 'pais'. Es el camino principal: el dato
 *      público, consultado ahora, no un número nuestro.
 *   2. RESPALDO mundial de referencia FAO, embebido, por si la API no
 *      responde o el país no tiene dato. fuente = 'FAO-referencia-base',
 *      ambito = 'mundial'. Así el sistema no se cae, y NUNCA miente sobre
 *      el origen del número.
 *   Si el cultivo no está soportado → devuelve null → la declaración queda
 *   PENDIENTE (no se juzga lo que no se puede juzgar).
 *
 * POR QUÉ NO FIJAMOS NOSOTROS EL RINDE:
 *   El respaldo no es "nuestra tabla de criterio": es una foto del dato
 *   público FAO, marcada como respaldo. El criterio (el margen) vive en
 *   la declaración; acá solo se trae el número de referencia.
 *
 * ── NOTA PARA EL VPS (a validar con red real) ──
 *   Los códigos de área FAOSTAT (≠ ISO ≠ M49) están como BORRADOR abajo.
 *   Si un código está mal o el país no está en el mapa, la consulta viva
 *   cae limpio al respaldo mundial y lo anota — no rompe, no inventa. Se
 *   amplían/corrigen los códigos probando contra FAOSTAT en el servidor.
 * ═════════════════════════════════════════════════════════════
 */

// FAOSTAT: dominio Crops and livestock products (QCL), elemento Yield (5419).
// El rinde llega en hg/ha (hectogramos/ha) → se pasa a t/ha dividiendo 10000.
const FAOSTAT_BASE     = 'https://faostatservices.fao.org/api/v1/en/data/QCL';
const FAOSTAT_YIELD    = '5419';       // elemento "Yield"
const FETCH_TIMEOUT_MS = 8000;

// ─── Cultivos soportados ────────────────────────────────────────
// faoItem: código de item FAOSTAT. rindeRespaldo: t/ha, referencia FAO
// mundial (valor típico, NO techo: el margen 3× de la declaración da la
// holgura). anioRespaldo: año aproximado de esa referencia.
const CULTIVOS = {
  cacao:  { faoItem: '661', unidad: 't/ha', rindeRespaldo: 0.5,  anioRespaldo: 2023, nota: 'granos de cacao' },
  cafe:   { faoItem: '656', unidad: 't/ha', rindeRespaldo: 0.9,  anioRespaldo: 2023, nota: 'café verde' },
  soja:   { faoItem: '236', unidad: 't/ha', rindeRespaldo: 2.8,  anioRespaldo: 2023, nota: 'poroto de soja' },
  palma:  { faoItem: '254', unidad: 't/ha', rindeRespaldo: 15.0, anioRespaldo: 2023, nota: 'fruto de palma aceitera (no el aceite)' },
  caucho: { faoItem: '836', unidad: 't/ha', rindeRespaldo: 1.2,  anioRespaldo: 2023, nota: 'caucho natural seco' },
  // No soportados aún (rinde en otra unidad): madera (m³/ha), ganado (kg o cabezas/ha).
};

// Alias de entrada → slug de cultivo.
const ALIAS_CULTIVO = {
  cacao: 'cacao', cocoa: 'cacao',
  cafe: 'cafe', 'café': 'cafe', coffee: 'cafe',
  soja: 'soja', soya: 'soja', soybean: 'soja', soybeans: 'soja',
  palma: 'palma', 'palma aceitera': 'palma', 'oil palm': 'palma', palm: 'palma',
  caucho: 'caucho', rubber: 'caucho', 'natural rubber': 'caucho',
};

// ─── Códigos de área FAOSTAT (BORRADOR — validar en el VPS) ──────
// Clave: ISO3. Valor: código de área FAOSTAT. Los principales productores
// para arrancar; se amplía probando contra la API. Si falta o está mal,
// se cae al respaldo mundial (no rompe).
const AREA_FAOSTAT = {
  GHA: 81,   // Ghana
  CIV: 107,  // Côte d'Ivoire
  NGA: 159,  // Nigeria
  CMR: 32,   // Camerún
  ECU: 58,   // Ecuador
  BRA: 21,   // Brasil
  COL: 44,   // Colombia
  PER: 170,  // Perú
  ARG: 9,    // Argentina
  IDN: 101,  // Indonesia
  MYS: 131,  // Malasia
  VNM: 237,  // Vietnam
};

// ─── Helpers ────────────────────────────────────────────────────

function _normalizarCultivo(c) {
  if (!c || typeof c !== 'string') return null;
  const k = c.toLowerCase().trim();
  return ALIAS_CULTIVO[k] || (CULTIVOS[k] ? k : null);
}

function _isoPais(p) {
  return (p && typeof p === 'string') ? p.toUpperCase().trim() : null;
}

function _hgHa_a_tHa(hgPorHa) {
  const v = Number(hgPorHa);
  if (!isFinite(v) || v <= 0) return null;
  return Math.round((v / 10000) * 1e6) / 1e6;   // hg/ha → t/ha, 6 decimales
}

function _hoyISO() {
  return new Date().toISOString().slice(0, 10);   // YYYY-MM-DD
}

// ─── Consulta viva a FAOSTAT ────────────────────────────────────
/**
 * Trae el rinde del país para el cultivo, del año más reciente disponible.
 * Devuelve { rinde, anioDato } o null si no hay dato / no responde / error.
 * No lanza: cualquier problema devuelve null y el que llama cae al respaldo.
 *
 * `fetchImpl` es inyectable solo para pruebas; en producción usa fetch global.
 */
async function consultarFAOSTAT(cultivoSlug, paisISO3, fetchImpl) {
  const cultivo  = CULTIVOS[cultivoSlug];
  const areaCode = AREA_FAOSTAT[paisISO3];
  if (!cultivo || areaCode == null) return null;

  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) return null;

  const url = `${FAOSTAT_BASE}?area=${areaCode}&item=${cultivo.faoItem}` +
              `&element=${FAOSTAT_YIELD}&output_type=objects&show_codes=false`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await doFetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!resp || !resp.ok) return null;
    const json = await resp.json();
    const filas = (json && Array.isArray(json.data)) ? json.data : [];
    if (filas.length === 0) return null;

    // Quedarse con el año más reciente que tenga valor.
    let mejor = null;
    for (const f of filas) {
      const anio  = Number(f.Year ?? f.year);
      const valor = Number(f.Value ?? f.value);
      if (!isFinite(anio) || !isFinite(valor) || valor <= 0) continue;
      if (!mejor || anio > mejor.anio) mejor = { anio, valor };
    }
    if (!mejor) return null;

    const rinde = _hgHa_a_tHa(mejor.valor);   // FAOSTAT da Yield en hg/ha
    if (rinde == null) return null;
    return { rinde, anioDato: mejor.anio };
  } catch (_e) {
    return null;   // timeout, red caída, JSON raro: se cae al respaldo
  } finally {
    clearTimeout(timer);
  }
}

// ─── La función que usa la puerta ───────────────────────────────
/**
 * Obtiene la referencia pública para { cultivo, pais }. Intenta FAOSTAT
 * vivo; si no hay dato, usa el respaldo mundial. Siempre devuelve el objeto
 * normalizado que traz-declaracion.js espera, o null si el cultivo no está
 * soportado (→ declaración PENDIENTE).
 *
 * `fetchImpl` es solo para pruebas.
 */
async function obtenerReferencia({ cultivo, pais }, fetchImpl) {
  const slug = _normalizarCultivo(cultivo);
  if (!slug) return null;                     // cultivo no soportado → sin referencia

  const iso = _isoPais(pais);
  const base = CULTIVOS[slug];
  const fechaConsulta = _hoyISO();

  // 1) Consulta viva (solo si hay país mapeado).
  if (iso) {
    const vivo = await consultarFAOSTAT(slug, iso, fetchImpl);
    if (vivo) {
      return {
        rinde:        vivo.rinde,
        unidad:       base.unidad,
        fuente:       'FAOSTAT',
        ambito:       'pais',
        codigoAmbito: iso,
        anioDato:     vivo.anioDato,
        fechaConsulta,
      };
    }
  }

  // 2) Respaldo mundial de referencia FAO (etiquetado como tal).
  return {
    rinde:        base.rindeRespaldo,
    unidad:       base.unidad,
    fuente:       'FAO-referencia-base',
    ambito:       'mundial',
    codigoAmbito: 'MUNDIAL',
    anioDato:     base.anioRespaldo,
    fechaConsulta,
  };
}

// Lista de cultivos soportados (para el front / validaciones).
function cultivosSoportados() {
  return Object.keys(CULTIVOS).map(slug => ({
    slug, unidad: CULTIVOS[slug].unidad, nota: CULTIVOS[slug].nota,
  }));
}

module.exports = {
  obtenerReferencia,
  consultarFAOSTAT,
  cultivosSoportados,
  CULTIVOS,
  ALIAS_CULTIVO,
  AREA_FAOSTAT,
};
