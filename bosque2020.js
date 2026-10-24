/**
 * EPIMELEIA · bosque2020.js  (VPS, raíz del repo)
 * ═════════════════════════════════════════════════════════════
 * ¿ERA BOSQUE ESTE CAMPO EL 31/12/2020, SEGÚN EL MAPA OFICIAL DE LA UE?
 *
 * Fuente: JRC Global Forest Cover 2020 (GFC2020, versión 4), el mapa que
 * la Comisión Europea publica para la EUDR. Usa la definición de bosque de
 * la propia EUDR (FAO): más de 0,5 ha, árboles de más de 5 m, más de 10 %
 * de cobertura; excluye uso agrícola, urbano y cultivos como palma, caucho
 * y cacao. Resolución: 10 m. Valor del píxel: 1 = bosque.
 *
 * Cómo lo lee: el mapa mundial es UN archivo COG (Cloud Optimized GeoTIFF)
 * en un servidor público de la Comisión. Se lee SOLO el recuadro de la
 * parcela por internet (pedidos parciales), sin bajar los ~50 GB.
 * Gratis, sin cuentas, sin claves.
 *
 * Por qué importa: Global Forest Watch (Hansen) mide PÉRDIDA DE ÁRBOLES,
 * que no es lo mismo que DEFORESTACIÓN según la EUDR. Si el mapa oficial
 * dice que el campo NO era bosque en 2020, una pérdida de árboles después
 * no es deforestación en el sentido de la ley (y al revés: si era bosque y
 * hubo pérdida, hay que mirarlo).
 *
 * Uso como módulo:
 *   const { bosque2020 } = require('./bosque2020');
 *   const r = await bosque2020(geometriaGeoJSON);
 *
 * Uso de prueba (no toca nada, solo lee el mapa):
 *   node bosque2020.js            → prueba con dos campos de ejemplo
 *   node bosque2020.js 29         → prueba con el polígono de la parcela #29
 *
 * Requiere: npm install geotiff@2   (una sola vez)
 * Nunca rompe nada: si el mapa no responde, devuelve { ok:false, motivo }.
 * ═════════════════════════════════════════════════════════════
 */

const URL_GFC2020 = process.env.GFC2020_URL ||
  'https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/FOREST/GFC2020/LATEST/single-cog/JRC_GFC2020_V4_COG.tif';
const FUENTE = 'JRC Global Forest Cover 2020 (GFC2020 V4) · Comisión Europea';
const MAX_PIXELES = 6_000_000;   // ~60.000 ha a 10 m. Más grande: se divide la parcela.
const TIMEOUT_MS = 90_000;

let _tiff = null, _img = null;

async function abrirMapa() {
  if (_img) return _img;
  const { fromUrl, fromFile } = require('geotiff');
  _tiff = /^https?:/.test(URL_GFC2020) ? await fromUrl(URL_GFC2020, { allowFullFile: false }) : await fromFile(URL_GFC2020);
  _img = await _tiff.getImage(0);          // imagen de resolución completa
  return _img;
}

function anilloDe(geometria) {
  let g = geometria;
  if (typeof g === 'string') { try { g = JSON.parse(g); } catch { return null; } }
  if (g && g.type === 'Feature') g = g.geometry;
  if (!g || !g.coordinates) return null;
  if (g.type === 'Polygon') return g.coordinates[0];
  if (g.type === 'MultiPolygon') return g.coordinates[0][0];
  return null;
}

function dentro(lon, lat, anillo) {
  let adentro = false;
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
    const xi = anillo[i][0], yi = anillo[i][1], xj = anillo[j][0], yj = anillo[j][1];
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) adentro = !adentro;
  }
  return adentro;
}

function conTiempo(promesa, ms) {
  return Promise.race([promesa, new Promise((_, rej) => setTimeout(() => rej(new Error('el mapa tardó demasiado')), ms))]);
}

async function _bosque2020(geometria) {
  const anillo = anilloDe(geometria);
  if (!anillo || anillo.length < 4) return { ok: false, motivo: 'polígono inválido' };

  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lon, lat] of anillo) {
    if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
  }

  const img = await abrirMapa();
  const [x0img, y0img] = img.getOrigin();          // esquina superior izquierda (lon, lat)
  const [resX, resYneg] = img.getResolution();     // grados por píxel (resY negativo)
  const resY = Math.abs(resYneg);
  const ancho = img.getWidth(), alto = img.getHeight();

  const c0 = Math.max(0, Math.floor((minLon - x0img) / resX));
  const c1 = Math.min(ancho, Math.ceil((maxLon - x0img) / resX));
  const f0 = Math.max(0, Math.floor((y0img - maxLat) / resY));
  const f1 = Math.min(alto, Math.ceil((y0img - minLat) / resY));
  const w = c1 - c0, h = f1 - f0;
  if (w <= 0 || h <= 0) return { ok: false, motivo: 'la parcela queda fuera del mapa' };
  if (w * h > MAX_PIXELES) return { ok: false, motivo: 'parcela demasiado grande para una sola lectura: dividila' };

  const datos = await img.readRasters({ window: [c0, f0, c1, f1], samples: [0], interleave: true });

  let total = 0, bosque = 0;
  for (let f = 0; f < h; f++) {
    const lat = y0img - (f0 + f + 0.5) * resY;
    for (let c = 0; c < w; c++) {
      const lon = x0img + (c0 + c + 0.5) * resX;
      if (!dentro(lon, lat, anillo)) continue;
      total++;
      if (datos[f * w + c] === 1) bosque++;
    }
  }
  if (!total) return { ok: false, motivo: 'la parcela es más chica que un píxel del mapa' };

  const latMedia = (minLat + maxLat) / 2;
  const m2Pixel = (resX * 111320 * Math.cos(latMedia * Math.PI / 180)) * (resY * 110574);
  const haBosque = Math.round(bosque * m2Pixel / 100) / 100;     // m² → ha, 2 decimales
  const pct = Math.round((bosque / total) * 1000) / 10;          // 1 decimal

  return {
    ok: true,
    fuente: FUENTE,
    fechaReferencia: '2020-12-31',
    resolucionM: 10,
    pixeles: total,
    pixelesBosque: bosque,
    pctBosque2020: pct,
    haBosque2020: haBosque,
    eraBosque: bosque > 0,
    consultadoEn: new Date().toISOString(),
  };
}

async function bosque2020(geometria) {
  try {
    return await conTiempo(_bosque2020(geometria), TIMEOUT_MS);
  } catch (e) {
    return { ok: false, motivo: 'no se pudo leer el mapa del JRC: ' + e.message };
  }
}

/* Lectura conjunta con Global Forest Watch: qué significa para la EUDR.
 *   def = deforestacion_historica (Hansen), b = resultado de bosque2020 */
function lecturaEUDR(b, def) {
  if (!b || !b.ok) return null;
  const huboPerdida = !!(def && def.huboDeforestacion);
  if (!b.eraBosque) {
    return huboPerdida
      ? 'Según el mapa oficial de la UE, este campo no era bosque en 2020: la pérdida de árboles que registra Global Forest Watch no es deforestación en el sentido de la EUDR.'
      : 'Según el mapa oficial de la UE, este campo no era bosque en 2020, y Global Forest Watch no registra pérdida de árboles después.';
  }
  return huboPerdida
    ? `El ${b.pctBosque2020} % del campo era bosque en 2020 según el mapa oficial de la UE, y Global Forest Watch registra pérdida de árboles después: hay que revisarlo.`
    : `El ${b.pctBosque2020} % del campo era bosque en 2020 según el mapa oficial de la UE, y Global Forest Watch no registra pérdida de árboles después.`;
}

module.exports = { bosque2020, lecturaEUDR, URL_GFC2020, FUENTE };

/* ── Prueba por consola ─────────────────────────────────────── */
if (require.main === module) {
  (async () => {
    const arg = process.argv[2];
    const casos = [];
    if (arg) {
      require('dotenv').config();
      const { createClient } = require('@supabase/supabase-js');
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data } = await sb.from('activos').select('nombre_activo, poligono').eq('activo_id_onchain', Number(arg)).maybeSingle();
      if (!data || !data.poligono) { console.log('No encontré el polígono de la parcela #' + arg); process.exit(1); }
      casos.push({ nombre: '#' + arg + ' ' + (data.nombre_activo || ''), geo: data.poligono });
    } else {
      casos.push({ nombre: 'Campo agrícola · Marcos Juárez (debería dar ~0 % bosque)', geo: { type: 'Polygon', coordinates: [[
        [-62.0538, -32.6600], [-62.0505, -32.6600], [-62.0505, -32.6650], [-62.0538, -32.6650], [-62.0538, -32.6600]]] } });
      // Selva cerrada en el interior de Amazonas (lejos de ríos y ciudades).
      casos.push({ nombre: 'Selva amazónica · Brasil (debería dar ~100 % bosque)', geo: { type: 'Polygon', coordinates: [[
        [-64.5000, -6.5000], [-64.4950, -6.5000], [-64.4950, -6.5050], [-64.5000, -6.5050], [-64.5000, -6.5000]]] } });
    }
    console.log('\n MAPA DE BOSQUES 2020 · ' + FUENTE + '\n');
    for (const c of casos) {
      const t = Date.now();
      const r = await bosque2020(c.geo);
      console.log(' ' + c.nombre);
      if (r.ok) console.log(`   bosque 2020: ${r.pctBosque2020} % (${r.haBosque2020} ha) · ${r.pixeles} píxeles · ${((Date.now() - t) / 1000).toFixed(1)} s`);
      else console.log('   NO SE PUDO: ' + r.motivo);
      console.log();
    }
    process.exit(0);
  })();
}
