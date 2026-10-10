/**
 * EPIMELEIA TRAZABILIDAD · traz-superposicion.js  (módulo puro)
 * ═════════════════════════════════════════════════════════════
 * Controla que la MISMA TIERRA no se declare dos veces bajo IDs distintos.
 *
 * EL HUECO QUE CIERRA:
 *   traz-servidor.js ya impide que UNA parcela declare dos veces el mismo
 *   cultivo y año. Pero si alguien registra el mismo campo como dos parcelas
 *   (#21 y #22 con el mismo polígono, o uno casi igual), cada una tendría su
 *   propio saldo y de una tierra que da 18 t podrían salir 36. Este módulo
 *   compara polígonos y avisa si se pisan.
 *
 * LA REGLA:
 *   Dos parcelas "se pisan" si la parte compartida supera el UMBRAL (2 %)
 *   de cualquiera de las dos. Se toma la mayor de las dos fracciones, así
 *   también se detecta una parcela chica metida dentro de una grande.
 *   El 2 % de tolerancia es para bordes dibujados a mano entre vecinos.
 *
 * CÓMO MIDE (sin librerías, para no instalar nada en el VPS):
 *   Pone una grilla de puntos sobre cada polígono y cuenta cuántos caen
 *   también dentro del otro. Es una medición por muestreo: precisa de sobra
 *   para decidir "se pisa / no se pisa", que es lo único que se necesita.
 *   Como compara fracciones, no hace falta convertir grados a metros.
 *
 * POR QUÉ ES PURO:
 *   No toca Supabase ni la red. Recibe polígonos y devuelve números.
 *   La puerta (traz-servidor.js) busca los polígonos y decide.
 * ═════════════════════════════════════════════════════════════
 */

const UMBRAL_DEFAULT = 0.02;   // 2 % de la superficie de cualquiera de las dos
const GRILLA = 80;             // 80 × 80 puntos de muestreo por polígono

// ─── Lectura del polígono (acepta los formatos habituales) ──────

// Un vértice: [a, b] o { lat, lng }. Devuelve [x, y] o null.
function _par(p) {
  if (Array.isArray(p) && p.length >= 2) {
    const a = Number(p[0]), b = Number(p[1]);
    if (isFinite(a) && isFinite(b)) return [a, b];
    return null;
  }
  if (p && typeof p === 'object') {
    const lat = p.lat ?? p.latitude ?? p.latitud;
    const lng = p.lng ?? p.lon ?? p.long ?? p.longitude ?? p.longitud;
    if (lat == null || lng == null) return null;
    const x = Number(lng), y = Number(lat);
    if (isFinite(x) && isFinite(y)) return [x, y];
  }
  return null;
}

/**
 * Devuelve el anillo exterior como [[x, y], ...] o null si no se puede leer.
 * Acepta: GeoJSON (Polygon, MultiPolygon, Feature, FeatureCollection),
 * arrays de pares, arrays de { lat, lng }, objetos { vertices | puntos },
 * y todo eso también como texto JSON.
 */
function leerAnillo(poligono) {
  let g = poligono;
  if (typeof g === 'string') { try { g = JSON.parse(g); } catch { return null; } }
  if (!g) return null;

  if (g.type === 'FeatureCollection' && Array.isArray(g.features) && g.features[0]) g = g.features[0];
  if (g && g.type === 'Feature') g = g.geometry;
  if (!g) return null;

  if (g.type === 'Polygon') g = Array.isArray(g.coordinates) ? g.coordinates[0] : null;
  else if (g.type === 'MultiPolygon') g = (g.coordinates && g.coordinates[0]) ? g.coordinates[0][0] : null;
  else if (!Array.isArray(g)) g = g.coordinates || g.vertices || g.puntos || g.coordenadas || null;

  if (!Array.isArray(g)) return null;
  // Anidado sin "type": [[[x,y],...]] → tomar el anillo exterior.
  if (g.length >= 1 && Array.isArray(g[0]) && Array.isArray(g[0][0])) g = g[0];

  const pts = g.map(_par).filter(Boolean);
  return pts.length >= 3 ? pts : null;
}

// ─── Geometría básica ───────────────────────────────────────────

function _bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

function _bboxSeTocan(a, b) {
  return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
}

// Punto dentro de polígono (ray casting). Sirve para polígonos cóncavos.
function _dentro(x, y, pts) {
  let adentro = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) adentro = !adentro;
  }
  return adentro;
}

/**
 * Qué fracción de A queda dentro de B (0 a 1), por muestreo en grilla.
 */
function fraccionDeAEnB(A, B) {
  const ba = _bbox(A), bb = _bbox(B);
  if (!_bboxSeTocan(ba, bb)) return 0;
  const dx = (ba.x1 - ba.x0) / GRILLA, dy = (ba.y1 - ba.y0) / GRILLA;
  if (!(dx > 0) || !(dy > 0)) return 0;
  let enA = 0, enAmbos = 0;
  for (let i = 0; i < GRILLA; i++) {
    const x = ba.x0 + (i + 0.5) * dx;
    for (let j = 0; j < GRILLA; j++) {
      const y = ba.y0 + (j + 0.5) * dy;
      if (!_dentro(x, y, A)) continue;
      enA++;
      if (x >= bb.x0 && x <= bb.x1 && y >= bb.y0 && y <= bb.y1 && _dentro(x, y, B)) enAmbos++;
    }
  }
  return enA ? enAmbos / enA : 0;
}

/**
 * Superposición entre dos parcelas: la MAYOR de las dos fracciones.
 * Así una parcela chica metida adentro de una grande también cuenta.
 */
function superposicion(A, B) {
  return Math.max(fraccionDeAEnB(A, B), fraccionDeAEnB(B, A));
}

/**
 * Compara un polígono nuevo contra las parcelas ya declaradas.
 *   nuevo:      anillo ya leído ([[x,y],...])
 *   existentes: [{ ref, nombre, poligono }]  (poligono en formato crudo)
 * Devuelve { comparadas, ilegibles, conflicto: { ref, nombre, fraccion } | null }.
 * El conflicto es el de MAYOR superposición que pase el umbral.
 */
function buscarSuperposicion({ nuevo, existentes, umbral }) {
  const u = Number(umbral) > 0 ? Number(umbral) : UMBRAL_DEFAULT;
  let comparadas = 0, ilegibles = 0, peor = null;
  for (const e of existentes || []) {
    const otro = leerAnillo(e.poligono);
    if (!otro) { ilegibles++; continue; }
    comparadas++;
    const f = superposicion(nuevo, otro);
    if (f > u && (!peor || f > peor.fraccion)) {
      peor = { ref: e.ref, nombre: e.nombre || null, fraccion: Math.round(f * 1000) / 1000 };
    }
  }
  return { comparadas, ilegibles, conflicto: peor };
}

module.exports = {
  UMBRAL_DEFAULT,
  leerAnillo,
  fraccionDeAEnB,
  superposicion,
  buscarSuperposicion,
};
