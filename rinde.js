/**
 * EPIMELEIA · rinde.js — RINDE MEDIDO POR SATÉLITE (fase 1, prueba)
 * ═══════════════════════════════════════════════════════════════════
 * Archivo NUEVO y APARTE (17/10/2026). No toca satellite.js, ni el
 * scheduler, ni ningún sello. No graba nada en Polygon ni en Supabase.
 * Solo LEE y MUESTRA. Sirve para ver, con datos reales, si el satélite
 * distingue una buena campaña de una floja.
 *
 * USO (en el servidor, dentro de ~/epimeleia-world):
 *     node rinde.js 29            → última campaña completa del campo #29
 *     node rinde.js 29 2024       → campaña que empezó en 2024
 *
 * QUÉ HACE, EN CRIOLLO
 *   1. Toma el polígono sellado del campo (de Supabase, el mismo de Verificar).
 *   2. Arma la CURVA DE LA CAMPAÑA: el vigor del cultivo (NDVI de Sentinel-2)
 *      cada 10 días, durante toda la temporada. Las nubes se descartan.
 *   3. Donde el óptico no vio por nubes, mira el RADAR (Sentinel-1), que ve
 *      a través de las nubes, y completa la curva — marcado como "radar".
 *   4. Compara esa campaña con:
 *        · la MISMA temporada de los 3 años anteriores (su historia), y
 *        · una FRANJA DE 2 KM alrededor del campo (sus vecinos).
 *   5. Resultado: "esta campaña rindió X % respecto de su historia y
 *      Y % respecto de su zona". Eso es un ÍNDICE, no toneladas.
 *
 * LO QUE NO HACE (honesto):
 *   · No da toneladas exactas. Para eso hacen falta cosechas reales con
 *     que calibrar. Muestra un "rinde orientativo" = referencia × índice,
 *     marcado como NO CALIBRADO.
 *   · La franja de vecinos incluye todo lo que hay alrededor (caminos,
 *     montes, otros cultivos). Sirve como contexto, no como verdad.
 *
 * TEMPORADA (calendario simple, por hemisferio):
 *   · soja / maíz / trigo-girasol de verano → hemisferio sur: 1 nov → 30 abr
 *                                            hemisferio norte: 1 may → 31 oct
 *   · cacao / café / palma / caucho (perennes) → 12 meses: 1 jul → 30 jun
 *
 * COSTO: unas 6 consultas a Copernicus por corrida (cuota gratuita).
 */

'use strict';

try { require('dotenv').config(); } catch (_) {}
const axios = require('axios');
let config = {};
try { ({ config } = require('./config')); } catch (_) { config = {}; }

const STATS_URL = 'https://sh.dataspace.copernicus.eu/api/v1/statistics';
const DIA = 24 * 3600 * 1000;
const BASE_NDVI = 0.2;        // por debajo de esto es suelo desnudo: no suma vigor
const CALIDAD_MIN = 50;       // % del campo que se tiene que ver para usar la pasada
const FRANJA_KM = 2;

// ─── credenciales ──────────────────────────────────────────────────
function _env(...nombres) { for (const n of nombres) if (process.env[n]) return process.env[n]; return null; }

async function tokenCopernicus() {
  const id = (config.sentinel && config.sentinel.apiUser) || _env('SENTINEL_API_USER', 'COPERNICUS_CLIENT_ID');
  const secreto = (config.sentinel && config.sentinel.apiKey) || _env('SENTINEL_API_KEY', 'COPERNICUS_CLIENT_SECRET');
  if (!id || !secreto) throw new Error('No encuentro las credenciales de Copernicus (config.sentinel).');
  const r = await axios.post(
    'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token',
    new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secreto }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 });
  return r.data.access_token;
}

async function leerCampo(idOnchain) {
  const url = _env('SUPABASE_URL');
  const key = _env('SUPABASE_SERVICE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_KEY');
  if (!url || !key) throw new Error('No encuentro SUPABASE_URL / SUPABASE_SERVICE_KEY en el .env del servidor.');
  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await sb.from('activos')
    .select('activo_id_onchain, nombre_activo, cultivo, pais, paquete_evidencia')
    .eq('activo_id_onchain', Number(idOnchain)).maybeSingle();
  if (error) throw new Error('Supabase: ' + error.message);
  if (!data) throw new Error(`No existe el campo #${idOnchain}.`);
  let paq = data.paquete_evidencia;
  if (typeof paq === 'string') { try { paq = JSON.parse(paq); } catch (_) { paq = null; } }
  const g = paq && (paq.poligono || paq.geometria);
  if (!g || g.type !== 'Polygon') throw new Error(`El campo #${idOnchain} no tiene polígono sellado (los verificables empiezan en el #18).`);
  // rinde de referencia (si declaró capacidad)
  let rindeRef = null;
  const { data: decl } = await sb.from('traz_declaraciones')
    .select('cultivo, base_ha, capacidad_anual, referencia, anio')
    .eq('origen_tipo', 'epimeleia').eq('origen_ref', String(idOnchain)).eq('veredicto', 'ACEPTADA')
    .order('anio', { ascending: false }).limit(1);
  const d = decl && decl[0];
  if (d) {
    let ref = d.referencia; if (typeof ref === 'string') { try { ref = JSON.parse(ref); } catch (_) { ref = {}; } }
    rindeRef = (ref && (ref.rinde ?? ref.rindeReferencia ?? ref.valor)) ?? (Number(d.base_ha) > 0 ? Number(d.capacidad_anual) / Number(d.base_ha) : null);
  }
  return { id: Number(idOnchain), nombre: data.nombre_activo, cultivo: String((d && d.cultivo) || data.cultivo || '').toLowerCase(), pais: data.pais, poligono: g, rindeRef: rindeRef != null ? Number(rindeRef) : null };
}

// ─── geometría ─────────────────────────────────────────────────────
function anilloDe(g) { return g.coordinates[0]; }
function centro(anillo) {
  const n = anillo.length - 1 || 1; let x = 0, y = 0;
  for (let i = 0; i < n; i++) { x += anillo[i][0]; y += anillo[i][1]; }
  return [x / n, y / n];
}
// Franja de vecinos: un cuadrado 2 km más grande que el campo, con el campo como agujero.
function franjaVecinos(g) {
  const a = anilloDe(g);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of a) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const lat = (minY + maxY) / 2;
  const dY = FRANJA_KM / 111.32, dX = FRANJA_KM / (111.32 * Math.cos(lat * Math.PI / 180));
  const ext = [[minX - dX, minY - dY], [maxX + dX, minY - dY], [maxX + dX, maxY + dY], [minX - dX, maxY + dY], [minX - dX, minY - dY]];
  return { type: 'Polygon', coordinates: [ext, a.slice().reverse()] };
}

// ─── temporada ─────────────────────────────────────────────────────
const PERENNES = ['cacao', 'cafe', 'café', 'palma', 'caucho', 'aceite de palma'];
function temporada(cultivo, lat, anioInicio) {
  const hoy = Date.now();
  const iso = (a, m, d) => new Date(Date.UTC(a, m - 1, d)).toISOString();
  let desdeMes, hastaMes, nombre;
  if (PERENNES.includes(cultivo)) { desdeMes = [7, 1]; hastaMes = [6, 30]; nombre = 'perenne · julio a junio'; }
  else if (lat < 0) { desdeMes = [11, 1]; hastaMes = [4, 30]; nombre = 'verano hemisferio sur · noviembre a abril'; }
  else { desdeMes = [5, 1]; hastaMes = [10, 31]; nombre = 'verano hemisferio norte · mayo a octubre'; }
  const cruza = desdeMes[0] > hastaMes[0];
  // Si no se pidió año: la última campaña COMPLETA.
  let a = anioInicio;
  if (!a) {
    a = new Date().getUTCFullYear();
    while (Date.parse(iso(cruza ? a + 1 : a, hastaMes[0], hastaMes[1])) + DIA > hoy) a--;
  }
  const v = (aa) => ({ desde: iso(aa, desdeMes[0], desdeMes[1]), hasta: new Date(Date.parse(iso(cruza ? aa + 1 : aa, hastaMes[0], hastaMes[1])) + DIA).toISOString(), etiqueta: cruza ? `${aa}/${String(aa + 1).slice(2)}` : String(aa) });
  return { nombre, actual: v(a), anteriores: [v(a - 1), v(a - 2), v(a - 3)] };
}

// ─── consultas ─────────────────────────────────────────────────────
const EVAL_NDVI = `//VERSION=3
function setup(){return{input:[{bands:["B04","B08","SCL","dataMask"]}],output:[{id:"data",bands:1,sampleType:"FLOAT32"},{id:"dataMask",bands:1}]};}
function evaluatePixel(s){var d=s.B08+s.B04;var v=d===0?0:(s.B08-s.B04)/d;var ok=d===0?0:1;
var nube=(s.SCL===3||s.SCL===8||s.SCL===9||s.SCL===10)?0:1;return{data:[v],dataMask:[s.dataMask*ok*nube]};}`;

const EVAL_RADAR = `//VERSION=3
function setup(){return{input:[{bands:["VH","dataMask"]}],output:[{id:"data",bands:1,sampleType:"FLOAT32"},{id:"dataMask",bands:1}]};}
function evaluatePixel(s){var ok=(s.VH>0)?1:0;return{data:[s.VH],dataMask:[s.dataMask*ok]};}`;

async function estadistica(token, geometria, ventana, dato, res) {
  const body = {
    input: { bounds: { geometry: geometria, properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' } }, data: [dato.data] },
    aggregation: { timeRange: { from: ventana.desde, to: ventana.hasta }, aggregationInterval: { of: 'P10D' }, evalscript: dato.eval, resx: res, resy: res },
  };
  const r = await axios.post(STATS_URL, body, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 60000 });
  return (r.data && r.data.data) || [];
}
function aSerie(intervalos) {
  return intervalos.map((it) => {
    const st = it && it.outputs && it.outputs.data && it.outputs.data.bands && it.outputs.data.bands.B0 && it.outputs.data.bands.B0.stats;
    const fecha = it && it.interval && it.interval.from;
    if (!st || !isFinite(st.mean)) return { fecha, valor: null, calidad: 0 };
    const tot = st.sampleCount || 0, nd = st.noDataCount || 0, med = tot - nd;
    const calidad = tot > 0 ? Math.round((med / tot) * 100) : 0;
    return { fecha, valor: med > 0 ? st.mean : null, calidad };
  });
}
const S2 = { data: { type: 'sentinel-2-l2a', dataFilter: { mosaickingOrder: 'leastCC' } }, eval: EVAL_NDVI };
const S1 = (orbita) => ({ data: { type: 'sentinel-1-grd', dataFilter: { acquisitionMode: 'IW', polarization: 'DV', orbitDirection: orbita }, processing: { backCoeff: 'SIGMA0_ELLIPSOID', orthorectify: false } }, eval: EVAL_RADAR });

// ─── cálculos ──────────────────────────────────────────────────────
function vigorDeCampana(serie, ventana) {
  // Área bajo la curva del NDVI por encima del suelo desnudo (0.2), en "NDVI·día".
  const pts = serie.filter((p) => p.valor !== null).map((p) => ({ t: Date.parse(p.fecha), v: p.valor })).sort((a, b) => a.t - b.t);
  if (pts.length < 4) return null;
  const t0 = Date.parse(ventana.desde), t1 = Date.parse(ventana.hasta);
  const todos = [{ t: t0, v: pts[0].v }, ...pts, { t: t1, v: pts[pts.length - 1].v }];
  let area = 0;
  for (let i = 1; i < todos.length; i++) {
    const a = Math.max(0, todos[i - 1].v - BASE_NDVI), b = Math.max(0, todos[i].v - BASE_NDVI);
    area += ((a + b) / 2) * ((todos[i].t - todos[i - 1].t) / DIA);
  }
  return Math.round(area * 100) / 100;
}
function regresion(pares) { // y = a + b·x
  const n = pares.length; if (n < 4) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of pares) { sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y; }
  const den = n * sxx - sx * sx; if (!den) return null;
  const b = (n * sxy - sx * sy) / den, a = (sy - b * sx) / n;
  const r = (n * sxy - sx * sy) / Math.sqrt(den * (n * syy - sy * sy) || 1);
  return { a, b, r };
}
const dB = (lin) => (lin > 0 ? 10 * Math.log10(lin) : null);
const pct = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + (Math.round(x * 1000) / 10).toString().replace('.', ',') + ' %');
const f3 = (x) => (x == null ? '   —  ' : x.toFixed(3));

// ─── principal ─────────────────────────────────────────────────────
async function medirRinde(idOnchain, anioInicio) {
  const campo = await leerCampo(idOnchain);
  const [lon, lat] = centro(anilloDe(campo.poligono));
  const temp = temporada(campo.cultivo, lat, anioInicio);
  const token = await tokenCopernicus();
  const pausa = () => new Promise((ok) => setTimeout(ok, 500));

  // 1) Curva óptica de la campaña (campo)
  const ndvi = aSerie(await estadistica(token, campo.poligono, temp.actual, S2, 0.0001))
    .map((p) => (p.calidad >= CALIDAD_MIN ? p : { ...p, valor: null }));
  await pausa();

  // 2) Radar de la campaña (campo): se prueba una órbita y, si no trae, la otra.
  let radar = [], orbita = null;
  for (const o of ['DESCENDING', 'ASCENDING']) {
    try {
      const s = aSerie(await estadistica(token, campo.poligono, temp.actual, S1(o), 0.0001));
      if (s.filter((p) => p.valor !== null).length > radar.filter((p) => p.valor !== null).length) { radar = s; orbita = o; }
    } catch (e) { console.log(`  (radar ${o}: ${e.response ? e.response.status : ''} ${e.message})`); }
    await pausa();
    if (radar.filter((p) => p.valor !== null).length >= 6) break;
  }

  // 3) Relleno con radar donde el óptico no vio (solo si radar y óptico se parecen: r ≥ 0,5)
  const vhPorFecha = Object.fromEntries(radar.map((p) => [p.fecha, p.valor !== null ? dB(p.valor) : null]));
  const pares = ndvi.filter((p) => p.valor !== null && vhPorFecha[p.fecha] != null).map((p) => [vhPorFecha[p.fecha], p.valor]);
  const reg = regresion(pares);
  const usarRadar = !!(reg && reg.r >= 0.5);
  const curva = ndvi.map((p) => {
    if (p.valor !== null) return { ...p, origen: 'óptico' };
    const vh = vhPorFecha[p.fecha];
    if (usarRadar && vh != null) return { ...p, valor: Math.max(-0.1, Math.min(1, reg.a + reg.b * vh)), origen: 'radar' };
    return { ...p, origen: 'sin dato' };
  });
  const vigor = vigorDeCampana(curva, temp.actual);

  // 4) Historia: misma temporada, 3 años antes (solo óptico)
  const historia = [];
  for (const v of temp.anteriores) {
    try {
      const s = aSerie(await estadistica(token, campo.poligono, v, S2, 0.0001)).map((p) => (p.calidad >= CALIDAD_MIN ? p : { ...p, valor: null }));
      historia.push({ campana: v.etiqueta, vigor: vigorDeCampana(s, v), pasadas: s.filter((p) => p.valor !== null).length });
    } catch (e) { historia.push({ campana: v.etiqueta, vigor: null, error: e.message }); }
    await pausa();
  }
  const hv = historia.map((h) => h.vigor).filter((x) => x != null);
  const promHist = hv.length ? hv.reduce((s, x) => s + x, 0) / hv.length : null;

  // 5) Zona: franja de 2 km alrededor, misma campaña (óptico, resolución más gruesa)
  let vigorZona = null;
  try {
    const s = aSerie(await estadistica(token, franjaVecinos(campo.poligono), temp.actual, S2, 0.0002)).map((p) => (p.calidad >= CALIDAD_MIN ? p : { ...p, valor: null }));
    vigorZona = vigorDeCampana(s, temp.actual);
  } catch (e) { console.log(`  (zona: ${e.response ? e.response.status : ''} ${e.message})`); }

  const vsHistoria = vigor != null && promHist ? vigor / promHist - 1 : null;
  const vsZona = vigor != null && vigorZona ? vigor / vigorZona - 1 : null;
  const orientativo = campo.rindeRef != null && vsHistoria != null ? Math.round(campo.rindeRef * Math.max(0.3, Math.min(2, 1 + vsHistoria)) * 100) / 100 : null;

  return {
    campo: { id: campo.id, nombre: campo.nombre, cultivo: campo.cultivo || '(sin cultivo)', pais: campo.pais },
    temporada: temp.nombre, campana: temp.actual.etiqueta, ventana: temp.actual,
    curva: curva.map((p) => ({ fecha: p.fecha && p.fecha.slice(0, 10), ndvi: p.valor != null ? Math.round(p.valor * 1000) / 1000 : null, origen: p.origen, calidad: p.calidad, radarVHdB: vhPorFecha[p.fecha] != null ? Math.round(vhPorFecha[p.fecha] * 100) / 100 : null })),
    pasadasOpticas: ndvi.filter((p) => p.valor !== null).length,
    rellenosRadar: curva.filter((p) => p.origen === 'radar').length,
    radar: { orbita, pasadas: radar.filter((p) => p.valor !== null).length, parecidoConOptico: reg ? Math.round(reg.r * 100) / 100 : null, usado: usarRadar },
    vigor, historia, promedioHistoria: promHist != null ? Math.round(promHist * 100) / 100 : null,
    vigorZona, vsHistoria, vsZona,
    rindeReferencia: campo.rindeRef, rindeOrientativo: orientativo,
    advertencia: 'Índice satelital relativo. El rinde orientativo NO está calibrado con cosechas reales.',
    calculadoEn: new Date().toISOString(),
  };
}

function imprimir(r) {
  const L = (s = '') => console.log(s);
  L(); L('══════════════════════════════════════════════════════════════');
  L(` RINDE MEDIDO · #${r.campo.id} ${r.campo.nombre || ''} · ${r.campo.cultivo}`);
  L(` Campaña ${r.campana} (${r.temporada})`);
  L('══════════════════════════════════════════════════════════════');
  L(' CURVA DE LA CAMPAÑA (cada 10 días)');
  L('   fecha        NDVI    origen      radar VH (dB)');
  for (const p of r.curva) L(`   ${p.fecha}   ${f3(p.ndvi)}   ${(p.origen + '        ').slice(0, 10)}  ${p.radarVHdB != null ? p.radarVHdB.toFixed(2) : '—'}`);
  L();
  L(` Pasadas ópticas útiles: ${r.pasadasOpticas} · completadas con radar: ${r.rellenosRadar}`);
  L(` Radar: órbita ${r.radar.orbita || '—'}, ${r.radar.pasadas} pasadas, parecido con el óptico r=${r.radar.parecidoConOptico ?? '—'} → ${r.radar.usado ? 'SE USA para rellenar' : 'NO se usa (se parecen poco o faltan datos)'}`);
  L();
  L(` VIGOR DE LA CAMPAÑA: ${r.vigor ?? 'sin datos suficientes'}`);
  for (const h of r.historia) L(`   campaña ${h.campana}: ${h.vigor ?? 'sin datos'}${h.pasadas != null ? `  (${h.pasadas} pasadas)` : ''}`);
  L(`   zona (franja de ${FRANJA_KM} km): ${r.vigorZona ?? 'sin datos'}`);
  L();
  L(` ► Respecto de su historia: ${pct(r.vsHistoria)}`);
  L(` ► Respecto de su zona:     ${pct(r.vsZona)}`);
  if (r.rindeReferencia != null) L(` ► Rinde de referencia ${r.rindeReferencia} t/ha → orientativo ${r.rindeOrientativo ?? '—'} t/ha (NO calibrado)`);
  L(); L(' ' + r.advertencia); L();
}

if (require.main === module) {
  const id = process.argv[2], anio = process.argv[3] ? Number(process.argv[3]) : null;
  if (!id) { console.log('Uso: node rinde.js <ID del campo> [año de inicio de campaña]'); process.exit(1); }
  medirRinde(id, anio)
    .then((r) => { imprimir(r); require('fs').writeFileSync(`rinde-${id}.json`, JSON.stringify(r, null, 2)); console.log(` (detalle guardado en rinde-${id}.json)`); })
    .catch((e) => { console.error('\n ✕ No se pudo medir:', e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 400)}` : e.message, '\n'); process.exit(1); });
}

module.exports = { medirRinde, imprimir, temporada, vigorDeCampana, franjaVecinos };
