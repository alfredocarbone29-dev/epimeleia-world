/**
 * EPIMELEIA — diag-satelite.js
 * ────────────────────────────
 * SOLO LECTURA. No escribe en la cadena. No manda mails.
 * No usa números de respaldo. No tapa errores.
 *
 * Le pregunta a Copernicus y te muestra LO QUE CONTESTA, tal cual.
 *
 * Uso:
 *    node diag-satelite.js
 */

try { require('dotenv').config(); } catch (e) {}

const axios = require('axios');
const { config } = require('./config');

const STATS_URL = 'https://sh.dataspace.copernicus.eu/api/v1/statistics';
const TOKEN_URL = 'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';

// El polígono de Pergamino, el mismo que usa generar-pdf.js
const POLIGONO_PERGAMINO = {
  type: 'Polygon',
  coordinates: [[
    [-60.60, -33.85], [-60.58, -33.85], [-60.58, -33.87],
    [-60.60, -33.87], [-60.60, -33.85]
  ]]
};

// Control: un polígono en las afueras de Varsovia, de la documentación de Copernicus.
// Si Pergamino falla y este anda, el problema es el polígono. Si fallan los dos,
// el problema es la cuenta o el pedido.
const POLIGONO_CONTROL = {
  type: 'Polygon',
  coordinates: [[
    [20.9, 52.17], [21.1, 52.17], [21.1, 52.27],
    [20.9, 52.27], [20.9, 52.17]
  ]]
};

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

function mostrarError(err) {
  console.log('\n  ✗ FALLÓ.');
  console.log('  Código HTTP : ' + (err.response?.status || '(sin respuesta HTTP)'));
  console.log('  Mensaje     : ' + err.message);
  if (err.response?.data) {
    console.log('\n  ── LO QUE CONTESTÓ COPERNICUS, TAL CUAL ──');
    console.log(JSON.stringify(err.response.data, null, 2));
  }
  if (err.code) console.log('  Código de red: ' + err.code);
}

// ── 1) El token ────────────────────────────────────────────────

async function pedirToken() {
  titulo('1) ¿ENTRAN LAS CREDENCIALES?');

  console.log('  SENTINEL_API_USER : ' +
    (config.sentinel.apiUser ? config.sentinel.apiUser : '(VACÍO)'));
  console.log('  SENTINEL_API_KEY  : ' +
    (config.sentinel.apiKey ? '(presente, ' + config.sentinel.apiKey.length + ' caracteres)' : '(VACÍO)'));

  if (!config.sentinel.apiKey) {
    console.log('\n  ✗ No hay clave. Nada más que probar.');
    process.exit(1);
  }

  try {
    const resp = await axios.post(TOKEN_URL, new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     config.sentinel.apiUser,
      client_secret: config.sentinel.apiKey,
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });

    console.log('\n  ✓ Token obtenido.');
    console.log('  Vence en    : ' + resp.data.expires_in + ' segundos');
    console.log('  Largo       : ' + (resp.data.access_token || '').length + ' caracteres');
    return resp.data.access_token;

  } catch (err) {
    mostrarError(err);
    console.log('\n  → Si dice "invalid_client": el client_id o el client_secret están mal,');
    console.log('    o el OAuth client no existe en Sentinel Hub.');
    process.exit(1);
  }
}

// ── 2) La Statistical API ──────────────────────────────────────

async function pedirEstadistica(nombre, geometria, token, dias) {
  const desde = new Date(Date.now() - dias * 24 * 3600 * 1000).toISOString();
  const hasta = new Date().toISOString();

  const body = {
    input: {
      bounds: {
        geometry: geometria,
        properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' },
      },
      data: [{
        type: 'sentinel-2-l2a',
        dataFilter: { mosaickingOrder: 'mostRecent' },
      }],
    },
    aggregation: {
      timeRange: { from: desde, to: hasta },
      aggregationInterval: { of: 'P1D' },
      evalscript: EVALSCRIPT_NDVI,
      resx: 0.0001,
      resy: 0.0001,
    },
  };

  console.log('  Polígono  : ' + nombre);
  console.log('  Ventana   : ' + desde.slice(0,10) + ' → ' + hasta.slice(0,10) + '  (' + dias + ' días)');
  console.log('  Resolución: resx/resy = 0.0001 grados');
  console.log('');

  try {
    const resp = await axios.post(STATS_URL, body, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
      timeout: 30000,
    });

    console.log('  ✓ Copernicus respondió. HTTP ' + resp.status);

    const intervalos = resp.data?.data || [];
    console.log('  Intervalos devueltos: ' + intervalos.length);

    if (intervalos.length === 0) {
      console.log('\n  ── RESPUESTA COMPLETA, TAL CUAL ──');
      console.log(JSON.stringify(resp.data, null, 2));
      console.log('\n  → Cero intervalos. O no hubo pasadas, o el pedido no las encuentra.');
      return { ok: true, conDato: 0 };
    }

    // Mostrar el primer intervalo entero, sin resumir.
    console.log('\n  ── PRIMER INTERVALO, TAL CUAL ──');
    console.log(JSON.stringify(intervalos[0], null, 2));

    // Contar cuántos traen estadística usable.
    let conDato = 0;
    console.log('\n  ── TODAS LAS PASADAS ──');
    for (const it of intervalos) {
      const st = it?.outputs?.data?.bands?.B0?.stats;
      const fecha = (it.interval?.from || '?').slice(0, 10);

      if (!st) {
        console.log(`  ${fecha}   sin bloque de estadísticas`);
        continue;
      }
      if (!isFinite(st.mean)) {
        console.log(`  ${fecha}   mean no numérico (${st.mean})   sampleCount=${st.sampleCount} noDataCount=${st.noDataCount}`);
        continue;
      }
      const muestras = st.sampleCount || 0;
      const nodata   = st.noDataCount || 0;
      const total    = muestras + nodata;
      const calidad  = total > 0 ? Math.round((muestras / total) * 100) : 0;

      if (muestras <= 0) {
        console.log(`  ${fecha}   0 píxeles limpios (todo nube o fuera de la figura)   noDataCount=${nodata}`);
        continue;
      }

      conDato++;
      console.log(`  ${fecha}   NDVI ${st.mean.toFixed(4)}   ` +
                  `limpios ${muestras} / tapados ${nodata}   calidad ${calidad}%`);
    }

    console.log('\n  Pasadas con dato usable: ' + conDato + ' de ' + intervalos.length);
    return { ok: true, conDato };

  } catch (err) {
    mostrarError(err);
    return { ok: false, conDato: 0 };
  }
}

// ── Correr todo ────────────────────────────────────────────────

async function main() {
  console.log('\n  EPIMELEIA — diagnóstico crudo del satélite');
  console.log('  Sin números de respaldo. Solo lo que Copernicus contesta.');

  const token = await pedirToken();

  titulo('2) PERGAMINO — últimos 30 días (lo que pide medirIndicadores)');
  const a = await pedirEstadistica('Pergamino', POLIGONO_PERGAMINO, token, 30);

  titulo('3) PERGAMINO — últimos 120 días (por si la ventana era corta)');
  const b = await pedirEstadistica('Pergamino', POLIGONO_PERGAMINO, token, 120);

  titulo('4) CONTROL — polígono de la documentación (Varsovia), 30 días');
  const c = await pedirEstadistica('Varsovia (control)', POLIGONO_CONTROL, token, 30);

  titulo('VEREDICTO');
  console.log('  Pergamino 30 días  : ' + (a.ok ? a.conDato + ' pasadas con dato' : 'ERROR'));
  console.log('  Pergamino 120 días : ' + (b.ok ? b.conDato + ' pasadas con dato' : 'ERROR'));
  console.log('  Varsovia (control) : ' + (c.ok ? c.conDato + ' pasadas con dato' : 'ERROR'));
  console.log('');

  if (!a.ok && !c.ok) {
    console.log('  → Fallan las dos. El problema es la cuenta o cómo se arma el pedido.');
    console.log('    Leé arriba lo que contestó Copernicus.');
  } else if (a.ok && c.ok && a.conDato === 0 && c.conDato > 0) {
    console.log('  → El control anda y Pergamino no. El problema es ese polígono:');
    console.log('    puede ser el tamaño, las coordenadas, o el orden de los vértices.');
  } else if (a.conDato === 0 && b.conDato > 0) {
    console.log('  → 30 días no alcanzan. En 120 sí hay pasadas. La ventana es corta.');
  } else if (a.conDato > 0) {
    console.log('  → Pergamino SÍ mide. Entonces lo que falla está en satellite.js,');
    console.log('    entre esta llamada y lo que medirIndicadores hace con la respuesta.');
  } else {
    console.log('  → Ninguna pasada trae dato usable. Leé el detalle de arriba:');
    console.log('    ¿sampleCount es cero? ¿el mean no es numérico? Ahí está la pista.');
  }
  console.log('');
}

main().catch(e => {
  console.error('\n  ✗ Error inesperado:', e.message);
  console.error(e);
  process.exit(1);
});
