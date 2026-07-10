/**
 * EPIMELEIA — diag-poligono.js
 * ────────────────────────────
 * SOLO LECTURA. No escribe nada, no manda mails, no toca la cadena.
 *
 * Pregunta una sola cosa: ¿por qué el polígono de Pergamino no mide?
 *
 * Prueba la MISMA figura, la MISMA fecha, el MISMO evalscript,
 * cambiando solo cómo se le describe a Copernicus:
 *
 *   A) horario     — el orden actual, el que usa generar-pdf.js
 *   B) antihorario — los mismos cuatro vértices, al revés
 *   C) bbox        — sin polígono, solo el rectángulo que lo contiene
 *
 * Si B mide y A no, el problema es el orden de los vértices.
 * Si C mide y ni A ni B, el problema es la geometría en sí.
 * Si ninguna mide, el problema está en otro lado y hay que seguir buscando.
 *
 * Además imprime la CALIDAD REAL, calculada bien:
 *   medidos = sampleCount − noDataCount
 *   calidad = medidos / sampleCount
 *
 * Uso:
 *    node diag-poligono.js
 */

try { require('dotenv').config(); } catch (e) {}

const axios = require('axios');
const { config } = require('./config');

const STATS_URL = 'https://sh.dataspace.copernicus.eu/api/v1/statistics';
const TOKEN_URL = 'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';

// Los cuatro vértices de Pergamino, tal como están en generar-pdf.js.
// Recorrido: este → sur → oeste → norte.  (HORARIO)
const ANILLO_ORIGINAL = [
  [-60.60, -33.85], [-60.58, -33.85], [-60.58, -33.87],
  [-60.60, -33.87], [-60.60, -33.85]
];

// Los mismos vértices, recorridos al revés. (ANTIHORARIO)
const ANILLO_INVERTIDO = [...ANILLO_ORIGINAL].reverse();

// El rectángulo que los contiene, como polígono antihorario explícito.
const ANILLO_BBOX = [
  [-60.60, -33.87], [-60.58, -33.87], [-60.58, -33.85],
  [-60.60, -33.85], [-60.60, -33.87]
];

const EVALSCRIPT_NDVI = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B08", "B04", "SCL", "dataMask"] }],
    output: [
      { id: "data",     bands: 1, sampleType: "FLOAT32" },
      { id: "dataMask", bands: 1 }
    ]
  };
}
function evaluatePixel(s) {
  var num = s.B08;
  var den = s.B04;
  var indice = (num + den) === 0 ? 0 : (num - den) / (num + den);
  var valido = (num + den) === 0 ? 0 : 1;
  var sinNube = (s.SCL === 3 || s.SCL === 8 || s.SCL === 9 || s.SCL === 10) ? 0 : 1;
  return { data: [indice], dataMask: [s.dataMask * valido * sinNube] };
}`;

function titulo(t) {
  console.log('\n' + '═'.repeat(64));
  console.log('  ' + t);
  console.log('═'.repeat(64));
}

/** Calcula el área con signo del anillo. Positiva = antihorario. */
function areaConSigno(anillo) {
  let a = 0;
  for (let i = 0; i < anillo.length - 1; i++) {
    const [x1, y1] = anillo[i];
    const [x2, y2] = anillo[i + 1];
    a += (x1 * y2 - x2 * y1);
  }
  return a / 2;
}

function sentido(anillo) {
  const a = areaConSigno(anillo);
  return a > 0 ? 'ANTIHORARIO' : (a < 0 ? 'HORARIO' : 'DEGENERADO (área cero)');
}

async function pedirToken() {
  const resp = await axios.post(TOKEN_URL, new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     config.sentinel.apiUser,
    client_secret: config.sentinel.apiKey,
  }), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });
  return resp.data.access_token;
}

async function probar(nombre, anillo, token, dias = 60) {
  titulo(nombre);

  console.log('  Sentido del anillo : ' + sentido(anillo));
  console.log('  Área con signo     : ' + areaConSigno(anillo).toExponential(4));
  console.log('  Vértices           : ' + anillo.length + ' (el último cierra la figura)');
  console.log('');

  const desde = new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();
  const hasta = new Date().toISOString();

  const body = {
    input: {
      bounds: {
        geometry: { type: 'Polygon', coordinates: [anillo] },
        properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' },
      },
      data: [{ type: 'sentinel-2-l2a', dataFilter: { mosaickingOrder: 'mostRecent' } }],
    },
    aggregation: {
      timeRange: { from: desde, to: hasta },
      aggregationInterval: { of: 'P1D' },
      evalscript: EVALSCRIPT_NDVI,
      resx: 0.0001,
      resy: 0.0001,
    },
  };

  let resp;
  try {
    resp = await axios.post(STATS_URL, body, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
      timeout: 40000,
    });
  } catch (err) {
    console.log('  ✗ FALLÓ. HTTP ' + (err.response?.status || '?') + ' — ' + err.message);
    if (err.response?.data) console.log(JSON.stringify(err.response.data, null, 2));
    return { conDato: 0, error: true };
  }

  const intervalos = resp.data?.data || [];
  console.log('  Copernicus respondió. Pasadas encontradas: ' + intervalos.length);
  console.log('');

  let conDato = 0;
  let mejor = null;

  for (const it of intervalos) {
    const st    = it?.outputs?.data?.bands?.B0?.stats;
    const fecha = (it.interval?.from || '?').slice(0, 10);
    if (!st) continue;

    const totales = st.sampleCount || 0;     // TODOS los píxeles del rectángulo
    const tapados = st.noDataCount || 0;     // los excluidos (fuera de la figura, nube, sin dato)
    const medidos = totales - tapados;       // los que de verdad se usaron

    // ── LA CUENTA CORRECTA ──
    const calidadReal = totales > 0 ? Math.round((medidos / totales) * 100) : 0;
    // ── La cuenta que hace hoy satellite.js, para comparar ──
    const calidadVieja = (totales + tapados) > 0 ? Math.round((totales / (totales + tapados)) * 100) : 0;

    if (!isFinite(st.mean) || medidos <= 0) {
      console.log(`  ${fecha}   sin dato   ` +
                  `totales ${totales}  tapados ${tapados}  medidos ${medidos}   ` +
                  `calidad REAL ${calidadReal}%  (la fórmula vieja diría ${calidadVieja}%)`);
      continue;
    }

    conDato++;
    console.log(`  ${fecha}   NDVI ${st.mean.toFixed(4)}   ` +
                `medidos ${medidos} de ${totales}   ` +
                `calidad REAL ${calidadReal}%  (la vieja diría ${calidadVieja}%)`);

    if (!mejor || calidadReal > mejor.calidadReal) {
      mejor = { fecha, ndvi: st.mean, calidadReal, medidos, totales };
    }
  }

  console.log('');
  console.log('  → Pasadas con dato usable: ' + conDato + ' de ' + intervalos.length);
  if (mejor) {
    console.log('  → Mejor pasada: ' + mejor.fecha +
                '   NDVI ' + mejor.ndvi.toFixed(4) +
                '   calidad ' + mejor.calidadReal + '%');
  }

  return { conDato, mejor };
}

async function main() {
  console.log('\n  EPIMELEIA — ¿por qué el polígono de Pergamino no mide?');
  console.log('  Misma figura, misma fecha, mismo evalscript. Cambia solo el orden.');

  const token = await pedirToken();
  console.log('\n  ✓ Token obtenido.');

  const a = await probar('A) ANILLO ORIGINAL — el que usa generar-pdf.js', ANILLO_ORIGINAL, token);
  const b = await probar('B) ANILLO INVERTIDO — los mismos vértices, al revés', ANILLO_INVERTIDO, token);
  const c = await probar('C) BBOX — el rectángulo que lo contiene, antihorario', ANILLO_BBOX, token);

  titulo('VEREDICTO');
  console.log('  A) original   : ' + a.conDato + ' pasadas con dato');
  console.log('  B) invertido  : ' + b.conDato + ' pasadas con dato');
  console.log('  C) bbox       : ' + c.conDato + ' pasadas con dato');
  console.log('');

  if (a.conDato === 0 && b.conDato > 0) {
    console.log('  → CONFIRMADO: es el orden de los vértices.');
    console.log('    El anillo exterior tiene que ir en sentido antihorario.');
    console.log('    Al revés, Copernicus lee la figura como un agujero: sin interior,');
    console.log('    todos los píxeles quedan afuera, y el promedio es NaN.');
    console.log('');
    console.log('    Arreglo: normalizar el sentido de todo polígono antes de medirlo.');
    console.log('    Y validarlo en el registro, cuando el cliente lo dibuja.');
  } else if (a.conDato > 0) {
    console.log('  → El anillo original SÍ mide en 60 días.');
    console.log('    Entonces la ventana de 30 días de medirIndicadores era el problema,');
    console.log('    o algo cambió entre esta corrida y la anterior. Hay que mirar de nuevo.');
  } else if (a.conDato === 0 && b.conDato === 0 && c.conDato > 0) {
    console.log('  → Ni el original ni el invertido miden, pero el bbox sí.');
    console.log('    El problema no es el sentido: es la figura. Revisá las coordenadas.');
  } else {
    console.log('  → Ninguna de las tres mide. El problema no es el polígono.');
    console.log('    Mirá arriba: ¿cuántos píxeles son "totales" y cuántos "tapados"?');
    console.log('    Si tapados == totales siempre, la máscara está borrando todo.');
  }
  console.log('');
}

main().catch(e => {
  console.error('\n  ✗ Error inesperado:', e.message);
  process.exit(1);
});
