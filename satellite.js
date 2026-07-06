/**
 * EPIMELEIA V3.4 — Oracle Node · satellite.js
 * ─────────────────────────────────────────────
 * Toda la lógica de consulta a Sentinel/Copernicus (PV-L1).
 * Ajuste 21: OAuth client_credentials (nuevo método Copernicus 2026).
 * Ajuste 22: medirIndicadores() — mide el NÚMERO REAL de cada índice
 *            sobre el polígono del cliente vía Statistical API.
 */

const axios    = require('axios');
const { ethers } = require('ethers');
const { config } = require('./config');
const { log }    = require('./logger');

// ─── PV-L1: Sentinel / Copernicus ──────────────────────────────

async function consultarSentinel(datosActivo) {
  const { activoId, latitud, longitud, radioKm, tipo } = datosActivo;

  log('SAT-L1', `Consultando Sentinel/Copernicus`, { activoId, latitud, longitud, radioKm });

  const delta = radioKm / 111;
  const bbox  = `${longitud - delta},${latitud - delta},${longitud + delta},${latitud + delta}`;
  const indicadores = config.indicadoresPorTipo[tipo] || config.indicadoresPorTipo[7];

  try {
    const url = 'https://catalogue.dataspace.copernicus.eu/odata/v1/Products';
    const params = {
      '$filter': `OData.CSC.Intersects(area=geography'SRID=4326;POLYGON((${_bboxToWkt(bbox)}))') and ContentDate/Start gt ${_hace90dias()} and Name eq 'SENTINEL-2'`,
      '$orderby': 'ContentDate/Start desc',
      '$top': 3,
      '$expand': 'Attributes',
    };

    const resp = await axios.get(url, {
      params,
      timeout: config.sentinel.timeout,
      headers: {
        'Authorization': `Bearer ${await _getTokenCopernicus()}`,
      }
    });

    const productos = resp.data?.value || [];

    if (productos.length === 0) {
      log('SAT-L1', `Sin productos satelitales para las coordenadas`, { activoId, bbox });
      return null;
    }

    const producto = _seleccionarMejorProducto(productos);

    if (!producto) {
      log('SAT-L1', `Todos los productos superan el umbral de nubosidad`, { activoId });
      return null;
    }

    const nubosidad = _extraerNubosidad(producto);
    const urlDescarga = _generarUrlDescarga(producto.Id);

    const reporte = {
      activoId,
      nivel:      'PV-L1',
      tipo:       'SENTINEL_COPERNICUS_TRIMESTRAL',
      tipoActividad: indicadores.nombre,
      indicadores: indicadores.indicadores,
      bandaEspectral: indicadores.bandas,
      timestamp:  new Date().toISOString(),
      satelite:   producto.Name || 'Sentinel-2',
      latitud, longitud, radioKm, bbox,
      nubosidadPct: nubosidad,
      uuid:       producto.Id,
      urlDescargaDatos: urlDescarga,
      fuente:     'ESA_COPERNICUS_DATASPACE',
      metadatos:  {
        nombre:     producto.Name,
        fecha:      producto.ContentDate?.Start,
        tamaño:     producto.ContentLength,
      }
    };

    log('SAT-L1', `Datos satelitales obtenidos`, {
      activoId,
      satelite:  reporte.satelite,
      nubosidad: reporte.nubosidadPct,
      uuid:      reporte.uuid,
    });

    return reporte;

  } catch (err) {
    log('ERROR', `Sentinel consulta fallida: ${err.message}`, { activoId });

    const esFuerzaMayor = ['ENOTFOUND','ETIMEDOUT','ECONNRESET','ECONNREFUSED']
      .some(code => err.code === code || err.message?.includes(code));

    if (esFuerzaMayor) {
      log('SUSPEND', `Fuerza mayor detectada en consulta satelital`, { error: err.message });
    }

    return null;
  }
}

function evaluarNubosidad(reporte) {
  if (!reporte) {
    return { puedeCertificar: false, causa: 'SATELLITE_LOSS: Sin datos satelitales disponibles.' };
  }

  if (reporte.nubosidadPct > config.sentinel.umbralNubosidad) {
    return {
      puedeCertificar: false,
      causa: `CLIMA: Nubosidad ${reporte.nubosidadPct}% sobre el area. Observacion satelital imposible. Umbral maximo: ${config.sentinel.umbralNubosidad}%.`,
      esClimatica: true,
    };
  }

  return { puedeCertificar: true, causa: null, esClimatica: false };
}

function generarHashEvidencia(reporte) {
  const { ethers } = require('ethers');
  const str = JSON.stringify({
    activoId:      reporte.activoId,
    satelite:      reporte.satelite,
    uuid:          reporte.uuid,
    nubosidadPct:  reporte.nubosidadPct,
    bandaEspectral:reporte.bandaEspectral,
    timestamp:     reporte.timestamp,
    fuente:        reporte.fuente,
  });
  return ethers.keccak256(ethers.toUtf8Bytes(str));
}

function generarMetadataURI(reporte, trimestre) {
  return `ipfs://QmEpimeleia_${reporte.activoId}_Q${trimestre}_${reporte.nivel}_${reporte.uuid?.slice(0,8) || 'pending'}`;
}

async function consultarSatelitalComercial(datosActivo, endpoint) {
  const { activoId } = datosActivo;
  log('SAT-L2', `Consultando satelital comercial`, { activoId, endpoint });

  try {
    const resp = await axios.get(endpoint, {
      timeout: config.sentinel.timeout,
      headers: { 'Authorization': `Bearer ${process.env.SAT_COMERCIAL_TOKEN || ''}` }
    });

    const indicadores = config.indicadoresPorTipo[datosActivo.tipo] || config.indicadoresPorTipo[7];

    const reporte = {
      activoId,
      nivel:         'PV-L2',
      tipo:          'SAT_COMERCIAL_VALIDACION_CRUZADA',
      tipoActividad:  indicadores.nombre,
      bandaEspectral: indicadores.bandas,
      timestamp:      new Date().toISOString(),
      satelite:       resp.data?.satelite || 'Satelital Comercial',
      nubosidadPct:   resp.data?.nubosidad || 0,
      uuid:           resp.data?.uuid || '',
      urlDescargaDatos: resp.data?.urlDescarga || '',
      datos:          resp.data,
      fuente:         'SATELITAL_COMERCIAL_BAJO_ACUERDO',
    };

    log('SAT-L2', `Datos L2 obtenidos`, { activoId, satelite: reporte.satelite });
    return reporte;

  } catch (err) {
    log('ERROR', `SAT-L2 fallido: ${err.message}`, { activoId });
    return null;
  }
}

async function consultarTripleFuente(datosActivo, fuentes) {
  const { activoId } = datosActivo;
  log('SAT-L3', `Consultando triple fuente independiente`, { activoId, totalFuentes: fuentes.length });

  const resultados = await Promise.allSettled(
    fuentes.map(f =>
      axios.get(f.endpoint, {
        timeout: 8000,
        headers: { 'Authorization': `Bearer ${process.env.SAT_L3_TOKEN || ''}` }
      }).then(r => ({ nombre: f.nombre, data: r.data }))
    )
  );

  const exitosas = resultados.filter(r => r.status === 'fulfilled').map(r => r.value);
  const fallidas = resultados.filter(r => r.status === 'rejected');

  log('SAT-L3', `Resultado triple fuente`, { activoId, exitosas: exitosas.length, fallidas: fallidas.length });

  if (exitosas.length === 0) return null;
  if (fallidas.length > 0) log('WARN', `${fallidas.length} fuentes sin respuesta en L3`, { activoId });

  const indicadores = config.indicadoresPorTipo[datosActivo.tipo] || config.indicadoresPorTipo[7];

  return {
    activoId,
    nivel:         'PV-L3',
    tipo:          'TRIPLE_FUENTE_TRIMESTRAL',
    tipoActividad:  indicadores.nombre,
    bandaEspectral: indicadores.bandas,
    timestamp:      new Date().toISOString(),
    satelite:       'Triple Fuente Independiente',
    nubosidadPct:   0,
    uuid:           `L3_${activoId}_${Date.now()}`,
    urlDescargaDatos: '',
    fuentesActivas: exitosas.length,
    fuentesTotal:   fuentes.length,
    datos:          exitosas,
    fuente:         'SAT_PREMIUM_IOT_SITIO_VALIDACION_CRUZADA',
  };
}

// ═══════════════════════════════════════════════════════════════
//  AJUSTE 22 · EL ENSAMBLADO — MEDICIÓN REAL SOBRE EL POLÍGONO
//  ───────────────────────────────────────────────────────────
//  Agarra el polígono que dibujó el cliente y le pide a Copernicus
//  (Sentinel Hub Statistical API) el NÚMERO medido de cada índice
//  que corresponde al tipo de recurso. No descarga la imagen:
//  Copernicus calcula la estadística de su lado y devuelve el valor.
//  Reusa el mismo login OAuth que ya usa consultarSentinel().
//  Doc oficial:
//  https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Statistical.html
// ═══════════════════════════════════════════════════════════════

const STATS_URL = 'https://sh.dataspace.copernicus.eu/api/v1/statistics';

// Todo índice acá es (num - den) / (num + den). Estas son las bandas.
const _formulaIndice = {
  NDVI: { num: 'B08', den: 'B04' }, // vegetación
  NDWI: { num: 'B03', den: 'B08' }, // agua (McFeeters)
  NDMI: { num: 'B08', den: 'B11' }, // humedad
  NDTI: { num: 'B04', den: 'B03' }, // turbidez/sedimentos (aprox.)
  NDBI: { num: 'B11', den: 'B08' }, // construido/pelado (aprox.)
};

// Construye el evalscript v3 para un índice, excluyendo nubes del cálculo.
function _evalscript(indice) {
  const f = _formulaIndice[indice];
  const bandas = Array.from(new Set([f.num, f.den, 'SCL', 'dataMask']));
  return `//VERSION=3
function setup() {
  return {
    input: [{ bands: [${bandas.map(b => `"${b}"`).join(', ')}] }],
    output: [
      { id: "data",     bands: 1, sampleType: "FLOAT32" },
      { id: "dataMask", bands: 1 }
    ]
  };
}
function evaluatePixel(s) {
  var num = s.${f.num};
  var den = s.${f.den};
  var indice = (num + den) === 0 ? 0 : (num - den) / (num + den);
  var valido = (num + den) === 0 ? 0 : 1;
  // Excluir sombra de nube (3), nube media (8), nube alta (9) y cirros (10)
  var sinNube = (s.SCL === 3 || s.SCL === 8 || s.SCL === 9 || s.SCL === 10) ? 0 : 1;
  return { data: [indice], dataMask: [s.dataMask * valido * sinNube] };
}`;
}

// Devuelve la geometría a medir: el polígono real del cliente si existe,
// o un cuadrado de respaldo desde lat/lon/radio si todavía no hay polígono.
function _geometriaDeActivo(datosActivo) {
  const g = datosActivo.geometria || datosActivo.geoJSON || datosActivo.poligono;
  if (g && g.type === 'Polygon' && Array.isArray(g.coordinates)) return g;
  if (g && g.type === 'Feature' && g.geometry?.type === 'Polygon') return g.geometry;

  const { latitud, longitud, radioKm } = datosActivo;
  const d = (radioKm || 1) / 111;
  return {
    type: 'Polygon',
    coordinates: [[
      [longitud - d, latitud - d],
      [longitud + d, latitud - d],
      [longitud + d, latitud + d],
      [longitud - d, latitud + d],
      [longitud - d, latitud - d],
    ]],
  };
}

// De la respuesta de la Statistical API, toma la pasada VÁLIDA más reciente.
function _ultimaMedicionValida(intervalos) {
  const validos = (intervalos || [])
    .map(it => {
      const st = it?.outputs?.data?.bands?.B0?.stats;
      if (!st || !isFinite(st.mean)) return null;
      const muestras = st.sampleCount || 0;
      const nodata   = st.noDataCount || 0;
      const total    = muestras + nodata;
      if (muestras <= 0) return null;
      return {
        fecha:      it.interval?.from || null,
        mean:       st.mean,
        min:        st.min,
        max:        st.max,
        stDev:      st.stDev,
        calidadPct: total > 0 ? Math.round((muestras / total) * 100) : 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

  return validos.length ? validos[validos.length - 1] : null;
}

// Llama a la Statistical API por un índice y devuelve su última medición.
async function _pedirEstadistica(indice, geometria, token, dias = 30) {
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
      evalscript: _evalscript(indice),
      // bounds en grados (EPSG:4326) → resolución en grados. ~0.0001° ≈ 11 m.
      resx: 0.0001,
      resy: 0.0001,
    },
  };

  const resp = await axios.post(STATS_URL, body, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    timeout: 20000,
  });

  return _ultimaMedicionValida(resp.data?.data || []);
}

// Traduce el número técnico a una frase entendible (orientativa).
function _interpretar(indice, valor) {
  if (valor == null) return 'sin dato';
  switch (indice) {
    case 'NDVI':
      if (valor < 0.1) return 'suelo desnudo o sin vegetación';
      if (valor < 0.3) return 'vegetación escasa o estresada';
      if (valor < 0.6) return 'vegetación moderada';
      return 'vegetación densa y sana';
    case 'NDWI':
      return valor > 0 ? 'presencia de agua abierta' : 'sin agua abierta';
    case 'NDMI':
      if (valor < -0.2) return 'muy seco';
      if (valor < 0.1)  return 'humedad baja';
      if (valor < 0.4)  return 'humedad media';
      return 'húmedo';
    case 'NDTI':
      return valor > 0 ? 'agua con carga de sedimentos' : 'agua clara';
    case 'NDBI':
      return valor > 0 ? 'superficie construida o de suelo pelado' : 'superficie natural';
    default:
      return '';
  }
}

/**
 * EL ENSAMBLADO. Punto de entrada único.
 * Toma un activo (con su polígono y su tipo) y devuelve los números
 * REALES medidos por Sentinel-2 sobre ese polígono, ya interpretados.
 *
 * @param {Object} datosActivo
 * @param {number} datosActivo.activoId
 * @param {number} datosActivo.tipo            - índice 0..7 (ver config)
 * @param {Object} [datosActivo.geometria]     - GeoJSON Polygon del mapa
 * @param {number} [datosActivo.latitud]       - respaldo si no hay polígono
 * @param {number} [datosActivo.longitud]
 * @param {number} [datosActivo.radioKm]
 * @returns {Object|null} { activoId, satelite, geometria, timestamp, mediciones[] }
 */
async function medirIndicadores(datosActivo) {
  const { activoId, tipo } = datosActivo;
  const cfg = config.indicadoresPorTipo[tipo] || config.indicadoresPorTipo[7];
  const geometria = _geometriaDeActivo(datosActivo);

  log('MEDIR', `Midiendo indicadores sobre el polígono`, { activoId, tipo: cfg.nombre });

  // Modo test: números simulados, no golpea la API real.
  if (config.modoTest) {
    const mediciones = cfg.indicadores.map(ind => {
      const info  = config.indicesDisponibles[ind.indice] || {};
      const valor = +(((Math.random() * 0.8) - 0.1).toFixed(3));
      return {
        clave: ind.clave, etiqueta: ind.etiqueta, indice: ind.indice,
        confianza: info.confianza || 'medido',
        valor, fecha: new Date().toISOString(), calidadPct: 100,
        interpretacion: _interpretar(ind.indice, valor), simulado: true,
      };
    });
    return { activoId, satelite: 'Sentinel-2 (MOCK)', geometria, timestamp: new Date().toISOString(), mediciones };
  }

  let token;
  try {
    token = await _getTokenCopernicus();
  } catch (err) {
    log('ERROR', `No se pudo autenticar contra Copernicus: ${err.message}`, { activoId });
    return null;
  }

  // Índices únicos (para no pedir dos veces el mismo).
  const indicesUnicos = Array.from(new Set(cfg.indicadores.map(i => i.indice)));
  const cacheIndice = {};

  for (const indice of indicesUnicos) {
    try {
      cacheIndice[indice] = await _pedirEstadistica(indice, geometria, token);
      await new Promise(r => setTimeout(r, 400)); // respiro entre llamadas
    } catch (err) {
      log('ERROR', `Fallo midiendo ${indice}: ${err.response?.status || ''} ${err.message}`, { activoId });
      cacheIndice[indice] = null;
    }
  }

  const mediciones = cfg.indicadores.map(ind => {
    const info = config.indicesDisponibles[ind.indice] || {};
    const m    = cacheIndice[ind.indice];
    return {
      clave:          ind.clave,
      etiqueta:       ind.etiqueta,
      indice:         ind.indice,
      confianza:      info.confianza || 'medido',
      valor:          m ? +m.mean.toFixed(3) : null,
      fecha:          m ? m.fecha : null,
      calidadPct:     m ? m.calidadPct : null,
      interpretacion: m ? _interpretar(ind.indice, m.mean) : 'sin dato satelital en la ventana',
    };
  });

  const conDato = mediciones.filter(m => m.valor !== null).length;
  log('MEDIR', `Medición terminada`, { activoId, indicadores: mediciones.length, conDato });

  return {
    activoId,
    satelite:  'Sentinel-2 L2A',
    fuente:    'ESA_COPERNICUS_DATASPACE',
    geometria,
    timestamp: new Date().toISOString(),
    mediciones,
  };
}

// ─── Helpers privados ───────────────────────────────────────────

async function _getTokenCopernicus() {
  if (config.modoTest) return 'test_token_mock';

  try {
    // AJUSTE 21: client_credentials con OAuth client creado en Sentinel Hub
    const resp = await axios.post(
      'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token',
      new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     config.sentinel.apiUser,
        client_secret: config.sentinel.apiKey,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
    );
    return resp.data.access_token;
  } catch (err) {
    log('ERROR', `Error obteniendo token Copernicus: ${err.message}`);
    throw err;
  }
}

function _bboxToWkt(bbox) {
  const [minLng, minLat, maxLng, maxLat] = bbox.split(',').map(Number);
  return `${minLng} ${minLat},${maxLng} ${minLat},${maxLng} ${maxLat},${minLng} ${maxLat},${minLng} ${minLat}`;
}

function _hace90dias() {
  const d = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  return d.toISOString().split('.')[0] + 'Z';
}

function _seleccionarMejorProducto(productos) {
  const conNubosidad = productos.map(p => ({
    ...p,
    _nubosidad: _extraerNubosidad(p)
  })).sort((a, b) => a._nubosidad - b._nubosidad);

  return conNubosidad.find(p => p._nubosidad <= config.sentinel.umbralNubosidad) || null;
}

function _extraerNubosidad(producto) {
  if (producto.Attributes?.value) {
    const attr = producto.Attributes.value.find(
      a => a.Name === 'cloudCover' || a.Name === 'cloudcoverpercentage'
    );
    if (attr) return Math.round(parseFloat(attr.Value));
  }
  return 50;
}

function _generarUrlDescarga(productId) {
  if (!productId || config.modoTest) return `https://mock.descarga.epimeleia.test/${productId}`;
  return `https://download.dataspace.copernicus.eu/odata/v1/Products(${productId})/$value`;
}

module.exports = {
  consultarSentinel,
  consultarSatelitalComercial,
  consultarTripleFuente,
  evaluarNubosidad,
  generarHashEvidencia,
  generarMetadataURI,
  medirIndicadores,
};
