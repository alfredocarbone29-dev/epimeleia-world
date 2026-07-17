/**
 * EPIMELEIA V3.4 — Oracle Node · satellite.js
 * ─────────────────────────────────────────────
 * Toda la lógica de consulta a Sentinel/Copernicus (PV-L1).
 * Ajuste 21: OAuth client_credentials (nuevo método Copernicus 2026).
 * Ajuste 22: medirIndicadores() — mide el NÚMERO REAL de cada índice
 *            sobre el polígono del cliente vía Statistical API.
 *
 * ════════════════════════════════════════════════════════════════
 * AJUSTE 27 (10/7/2026) — LA NUBOSIDAD DEJA DE SER INVENTADA
 * ════════════════════════════════════════════════════════════════
 *
 * Se repararon tres cosas. Las tres violaban el manifiesto:
 * "solo se certifica lo que el satélite mide de verdad".
 *
 *  A) El filtro de Copernicus estaba mal escrito.
 *     Decía:  Name eq 'SENTINEL-2'
 *     Debe:   Collection/Name eq 'SENTINEL-2'
 *     `Name` es el nombre del ARCHIVO del producto (S2A_MSIL2A_...SAFE).
 *     Ningún producto se llama "SENTINEL-2". La consulta devolvía
 *     SIEMPRE cero resultados. De ahí salieron todos los
 *     "SATELLITE_LOSS" grabados en Polygon.
 *
 *  B) _extraerNubosidad devolvía 50 cuando no encontraba el dato.
 *     Un número inventado que: (1) pasaba el umbral de 70, así que
 *     siempre certificaba; (2) entraba al hash de evidencia; (3) se
 *     grababa en la cadena como si fuera medido.
 *     Ahora devuelve null. Si no se sabe, no se inventa.
 *     Además leía producto.Attributes.value — con $expand, Copernicus
 *     devuelve Attributes como lista directa. Ahora se aceptan ambas formas.
 *
 *  C) La nubosidad que va a la cadena ya no viene de la ESCENA.
 *     `cloudCover` mide la nube sobre los ~100x100 km del producto
 *     entero, no sobre el activo. Un campo despejado dentro de una
 *     escena nublada daba cloudCover 80 y calidad 98.
 *     Ahora: nubosidadPct = 100 − calidadPct, donde calidadPct es el
 *     % de píxeles DEL POLÍGONO que quedaron limpios tras la máscara
 *     de nubes. Medido sobre el activo, no heredado de la escena.
 *
 * Y se expone lo que antes se tiraba:
 *  · fechaPasada         — la fecha real de la pasada usada
 *  · fechasDistintas     — true si los índices vienen de días distintos
 *  · calidadPct          — % de píxeles limpios del polígono
 *  · nubosidadPct        — 100 − calidadPct, o null si no hay dato
 *
 * ════════════════════════════════════════════════════════════════
 * AJUSTE 28 (10/7/2026) — LA CALIDAD SE CALCULABA MAL + VENTANA
 * ════════════════════════════════════════════════════════════════
 *
 * Comprobado en pantalla, contra Copernicus, el mismo 10/7:
 *
 *  D) La fórmula de calidad estaba rota (función _ultimaMedicionValida).
 *     sampleCount YA es el total de píxeles del rectángulo; noDataCount
 *     son los excluidos. Los medidos son sampleCount − noDataCount.
 *     La fórmula vieja hacía sampleCount / (sampleCount + noDataCount):
 *       · inflaba la calidad (real 47% → daba 65%);
 *       · y cuando NO se medía nada, daba 50% en vez de 0%.
 *     Ese 50% era el gemelo del viejo `return 50` de la nubosidad.
 *     La cuenta correcta es medidos / sampleCount. Ya corregida.
 *
 *  E) La ventana pasó de 30 a 45 días. En 30 días, Pergamino en invierno
 *     a veces vuelve sin ninguna pasada limpia por nubes. En 45 casi
 *     siempre hay una. Se sigue tomando la más reciente que esté limpia.
 *
 *  F) medirIndicadores ahora devuelve `sinDato: true` cuando no hubo
 *     ninguna pasada limpia. Es un hueco honesto, no un error. El que
 *     llama decide qué hacer, pero el sistema ya no inventa para tapar.
 *
 * ════════════════════════════════════════════════════════════════
 * AJUSTE 30 (17/7/2026) — LA REGLA DE LECTURA SALE DE ACÁ
 * ════════════════════════════════════════════════════════════════
 *
 * DECISIÓN DEL FUNDADOR (17/7): regla VERSIONADA, no congelada.
 *
 * El problema que resuelve, con el certificado real del 10/7 delante:
 *
 *     NDVI 0.347  →  "vegetación moderada"   (el corte está en 0.3)
 *
 * Ese número está a 0.047 del borde. Si algún día se decide que el
 * corte correcto para la pampa es 0.35, ese MISMO 0.347 pasaría a
 * decir "vegetación escasa o estresada". Dos certificados sellados,
 * los dos válidos, contradiciéndose. El hash de cada uno perfecto,
 * y la serie rota.
 *
 * Por eso: cada medición ahora declara CON QUÉ REGLA leyó, y esa
 * versión (y la huella de la regla) entran después en el hash.
 *
 * QUÉ CAMBIÓ, exactamente y nada más:
 *
 *   1. Se importa ./reglas-lectura  (archivo nuevo, ya probado: 23/23).
 *   2. Se BORRÓ la función _interpretar() local. Su contenido, tal cual,
 *      es ahora la regla v1 de ese archivo. No se movió ni un umbral.
 *   3. Donde se traducía, ahora se llama a reglas.interpretar().
 *   4. medirIndicadores() devuelve dos campos nuevos:
 *          reglaLectura   'v1'
 *          hashRegla      0x196ec7110533897c2c0fd3d7cd089ab93a801e79...
 *      Eso es lo que va a entrar al hash del certificado.
 *
 * QUÉ **NO** CAMBIÓ:
 *   · Ni un umbral. Ni una frase. Ni una coma.
 *   · Comprobado con 23 casos, incluidos el 0.347 y el -0.07 del
 *     certificado real, y los bordes exactos de cada corte.
 *   · El resto del archivo (ajustes 27 y 28) está intacto.
 *
 * ⚠️ DEUDA ABIERTA, DECLARADA — NO SE TOCÓ A PROPÓSITO:
 *
 *   Hay DOS frases distintas para "no hay dato", y solo una está
 *   en la regla sellada:
 *       · la regla dice ............ "sin dato"
 *       · este archivo dice ........ "sin dato satelital en la ventana"
 *   La segunda la escribe medirIndicadores() por su cuenta (ver abajo,
 *   marcado). Puede aparecer en un certificado: si un índice midió y
 *   el otro no, el PDF muestra esa frase al lado del que no midió.
 *   Sería la única línea del certificado que ninguna regla sellada cubre.
 *
 *   Se dejó EXACTAMENTE como estaba. Extraer y arreglar a la vez es
 *   cómo se cuelan los errores. Es decisión del fundador.
 *
 * ⚠️ NO SE TOCÓ generarHashEvidencia(). Sigue sin cubrir las
 *    mediciones ni el polígono ni la regla (ver Junta A del brief).
 *    Está marcado abajo.
 * ════════════════════════════════════════════════════════════════
 */

const axios    = require('axios');
const { ethers } = require('ethers');
const { config } = require('./config');
const { log }    = require('./logger');

// ── AJUSTE 30 · LA REGLA DE LECTURA ──────────────────────────────
// La traducción del número a la frase ES el servicio. Por eso vive
// en su archivo propio, versionada y con huella. Si algún día un
// umbral tiene que cambiar, se agrega una v2 allá: acá no se toca nada.
//
//   ⛔ Nadie edita la v1. Jamás. Su huella la delataría.
//
// Para ver la regla completa y su huella:  node reglas-lectura.js
const reglas = require('./reglas-lectura');

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
      // ── AJUSTE 27-A: era `Name eq 'SENTINEL-2'`. Ningún producto se
      //    llama así: Name es el nombre del archivo .SAFE. El filtro
      //    de colección es Collection/Name. Sin esto, cero resultados.
      '$filter': `Collection/Name eq 'SENTINEL-2' and OData.CSC.Intersects(area=geography'SRID=4326;POLYGON((${_bboxToWkt(bbox)}))') and ContentDate/Start gt ${_hace90dias()}`,
      '$orderby': 'ContentDate/Start desc',
      '$top': 10,
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
      log('SAT-L1', `Ningún producto con nubosidad conocida bajo el umbral`, { activoId });
      return null;
    }

    // ── AJUSTE 27-B: si no hay dato de nubosidad, no hay número.
    const nubosidad = _extraerNubosidad(producto);
    if (nubosidad === null) {
      log('SAT-L1', `Producto sin dato de nubosidad — no se certifica`, { activoId });
      return null;
    }

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
      fuenteNubosidad: 'ESCENA',   // ← ojo: es la nube de los ~100x100 km, no la del activo
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

/**
 * Decide si un reporte permite certificar.
 *
 * AJUSTE 27: ahora distingue tres casos, no dos.
 *   · No hay reporte             → hueco por pérdida de señal.
 *   · Hay reporte, sin nubosidad → hueco. NO se inventa un número.
 *   · Hay nubosidad > umbral     → hueco climático.
 */
function evaluarNubosidad(reporte) {
  if (!reporte) {
    return { puedeCertificar: false, causa: 'SATELLITE_LOSS: Sin datos satelitales disponibles.' };
  }

  if (reporte.nubosidadPct === null || reporte.nubosidadPct === undefined) {
    return {
      puedeCertificar: false,
      causa: 'SATELLITE_LOSS: Sin dato de nubosidad sobre el area. No se certifica lo que no se midio.',
      esClimatica: false,
    };
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

/**
 * ⚠️ DEUDA CONOCIDA — Junta A del brief. NO REPARADO ACÁ.
 *
 * Este hash NO incluye los valores medidos (NDVI, NDMI), ni el polígono,
 * ni el titular, ni la regla de lectura.
 * Prueba que existió una pasada con ese uuid, esa nubosidad y ese
 * timestamp. NO prueba los números que el certificado muestra.
 *
 * La reparación es:
 *   keccak256({ ...metadatos, mediciones, hashPoligono, titular,
 *               reglaLectura, hashRegla })
 *
 * AJUSTE 30: la parte de la REGLA ya está lista y disponible —
 * medirIndicadores() ahora devuelve reglaLectura y hashRegla.
 * Falta la serialización canónica del polígono y el paquete de
 * inscripción. Eso es la Junta A propiamente dicha.
 */
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

/**
 * ⚠️ DEUDA CONOCIDA — Junta A del brief.
 * Esto arma un string que PARECE un IPFS y no lo es. Está grabado en
 * Polygon apuntando a nada. O se hace real, o se saca.
 *
 * Nota (17/7): acá va la dirección del PAQUETE DE EVIDENCIA — el
 * polígono, las mediciones y la regla — para que un tercero pueda
 * recalcular el hash y comprobar. Sin eso, "verificable por
 * cualquiera" es una frase. Decisión del fundador pendiente:
 * ¿IPFS de verdad, o un endpoint público de epimeleia.world?
 */
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
      // AJUSTE 27: era `|| 0` — un cielo perfecto inventado. Ahora null.
      nubosidadPct:   resp.data?.nubosidad ?? null,
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
    // AJUSTE 27: era 0. Un 0 es "cielo perfecto", y nadie lo midió.
    nubosidadPct:   null,
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

/**
 * ⚠️ PENDIENTE DE DECISIÓN DEL FUNDADOR.
 *
 * Hoy, una medición sobre el 3% del polígono (97% tapado por nubes)
 * se acepta igual que una sobre el 98%. El certificado la muestra
 * con el chip MEDIDO y "CALIDAD 3%".
 *
 * ¿Cuál es la calidad mínima para que un número sea certificable?
 * Mientras no se decida, este umbral queda en 0: acepta todo, igual
 * que antes. NO se cambia el comportamiento a espaldas de nadie.
 * Cuando se decida, se sube acá (o se mueve a config.js).
 */
const CALIDAD_MINIMA_PCT = 0;

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
  if (g && g.type === 'Polygon' && Array.isArray(g.coordinates)) {
    return { geometria: g, esPoligonoReal: true };
  }
  if (g && g.type === 'Feature' && g.geometry?.type === 'Polygon') {
    return { geometria: g.geometry, esPoligonoReal: true };
  }

  const { latitud, longitud, radioKm } = datosActivo;
  const d = (radioKm || 1) / 111;
  return {
    geometria: {
      type: 'Polygon',
      coordinates: [[
        [longitud - d, latitud - d],
        [longitud + d, latitud - d],
        [longitud + d, latitud + d],
        [longitud - d, latitud + d],
        [longitud - d, latitud - d],
      ]],
    },
    // ← IMPORTANTE: esto NO es el activo. Es un cuadrado de respaldo.
    //   Lo que se mida acá no es lo que el cliente dibujó.
    //   Es exactamente el modelo viejo: un punto con un radio. Así se
    //   certificaron Hidrovía, Aral y Chernóbil: real, sellado, y
    //   describiendo un cuadrado que no es el campo de nadie.
    esPoligonoReal: false,
  };
}

// De la respuesta de la Statistical API, toma la pasada VÁLIDA más reciente.
//
// ⚠️ AJUSTE 28 (10/7/2026) — LA CALIDAD SE CALCULABA MAL.
//
//   Se comprobó contra Copernicus, en pantalla, el 10/7:
//   · sampleCount = TODOS los píxeles del rectángulo (no los limpios).
//   · noDataCount = los excluidos (fuera de la figura, nube, sin dato).
//   · medidos     = sampleCount − noDataCount   ← los que de verdad se usaron.
//
//   La fórmula vieja hacía  muestras / (muestras + nodata), que es
//   sampleCount / (sampleCount + noDataCount). Eso está mal por dos vías:
//     - Infla la calidad. Ej. real 47% → daba 65%.
//     - Cuando NADA se midió (nodata == sampleCount), daba 50% en vez de 0%.
//       Ese 50% es la misma mentira que el viejo `return 50` de la nubosidad:
//       un número plausible que tapa el hecho de que no se vio el campo.
//
//   La cuenta correcta es  medidos / sampleCount.
function _ultimaMedicionValida(intervalos) {
  const validos = (intervalos || [])
    .map(it => {
      const st = it?.outputs?.data?.bands?.B0?.stats;
      if (!st || !isFinite(st.mean)) return null;
      const totales = st.sampleCount || 0;   // TODOS los píxeles del rectángulo
      const nodata  = st.noDataCount || 0;   // los excluidos
      const medidos = totales - nodata;      // los que de verdad se usaron
      if (medidos <= 0) return null;         // no se midió nada: no es una pasada válida
      const calidadPct = totales > 0 ? Math.round((medidos / totales) * 100) : 0;
      if (calidadPct < CALIDAD_MINIMA_PCT) return null;
      return {
        fecha:      it.interval?.from || null,
        mean:       st.mean,
        min:        st.min,
        max:        st.max,
        stDev:      st.stDev,
        muestras:   medidos,
        nodata,
        calidadPct,
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

  return validos.length ? validos[validos.length - 1] : null;
}

// Llama a la Statistical API por un índice y devuelve su última medición.
//
// AJUSTE 28: la ventana pasa de 30 a 45 días.
//   Sentinel-2 revisita cada ~5 días, pero las nubes tapan muchas pasadas.
//   Se comprobó el 10/7 contra Copernicus: Pergamino en invierno, en 30 días,
//   a veces devuelve 0 pasadas limpias por pura mala suerte de nubes; en 45
//   días casi siempre hay al menos una. No es trampa: se sigue tomando la
//   pasada MÁS RECIENTE que esté limpia, solo que se mira un poco más atrás
//   antes de declarar un hueco. El certificado sigue diciendo la fecha real
//   de la pasada, que puede no ser la de hoy. Eso ya es honesto y está declarado.
async function _pedirEstadistica(indice, geometria, token, dias = 45) {
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

// ── AJUSTE 30 ────────────────────────────────────────────────────
// Acá vivía _interpretar(): un switch con los umbrales escritos a mano.
// Se fue entera a reglas-lectura.js, como regla v1, sin cambiarle
// ni un decimal. Comprobado: 23/23 casos dan idéntico, incluidos el
// NDVI 0.347 y el NDMI -0.07 del certificado real del 10/7.
//
// Ya no hay traducción escondida en este archivo. La traducción es
// pública, versionada y tiene huella propia:
//     node reglas-lectura.js
// ──────────────────────────────────────────────────────────────────

/**
 * EL ENSAMBLADO. Punto de entrada único.
 * Toma un activo (con su polígono y su tipo) y devuelve los números
 * REALES medidos por Sentinel-2 sobre ese polígono, ya interpretados.
 *
 * AJUSTE 27 — ahora devuelve además, y esto es lo que va a la cadena:
 *   calidadPct        % de píxeles del POLÍGONO que quedaron limpios
 *   nubosidadPct      100 − calidadPct. Medido sobre el activo. null si no hay dato.
 *   fechaPasada       la fecha real de la pasada usada
 *   fechasDistintas   true si los índices no vienen todos del mismo día
 *   esPoligonoReal    false si se usó el cuadrado de respaldo lat/lon/radio
 *
 * AJUSTE 30 — y también:
 *   reglaLectura      con qué versión de la regla se tradujo ('v1')
 *   hashRegla         la huella de esa regla, para que un tercero
 *                     pueda comprobar que es la misma que se selló
 *
 * @returns {Object|null}
 */
async function medirIndicadores(datosActivo) {
  const { activoId, tipo } = datosActivo;
  const cfg = config.indicadoresPorTipo[tipo] || config.indicadoresPorTipo[7];
  const { geometria, esPoligonoReal } = _geometriaDeActivo(datosActivo);

  // AJUSTE 30: la versión y la huella de la regla con la que se va a leer.
  // Se calculan UNA vez acá y viajan con la medición hasta el certificado.
  const reglaLectura = reglas.VERSION_VIGENTE;
  const hashRegla    = reglas.hashDeRegla(reglaLectura);

  log('MEDIR', `Midiendo indicadores sobre el polígono`, {
    activoId, tipo: cfg.nombre, esPoligonoReal, reglaLectura
  });

  if (!esPoligonoReal) {
    log('WARN', `Sin polígono: se usa cuadrado de respaldo. NO es el activo.`, { activoId });
  }

  // Modo test: números simulados, no golpea la API real.
  if (config.modoTest) {
    const mediciones = cfg.indicadores.map(ind => {
      const info  = config.indicesDisponibles[ind.indice] || {};
      const valor = +(((Math.random() * 0.8) - 0.1).toFixed(3));
      return {
        clave: ind.clave, etiqueta: ind.etiqueta, indice: ind.indice,
        confianza: info.confianza || 'medido',
        valor, fecha: new Date().toISOString(), calidadPct: 100,
        // AJUSTE 30: era _interpretar(). Misma regla, ahora declarada.
        interpretacion: reglas.interpretar(ind.indice, valor, reglaLectura),
        simulado: true,
      };
    });
    return {
      activoId, satelite: 'Sentinel-2 (MOCK)', geometria, esPoligonoReal,
      timestamp: new Date().toISOString(),
      fechaPasada: new Date().toISOString(), fechasDistintas: false,
      calidadPct: 100, nubosidadPct: 0, simulado: true,
      reglaLectura, hashRegla,          // ← AJUSTE 30
      mediciones,
    };
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
      pixelesLimpios: m ? m.muestras : null,
      pixelesTapados: m ? m.nodata   : null,

      // ── AJUSTE 30 ────────────────────────────────────────────
      // Cuando HAY número, traduce la regla v1 (antes: _interpretar).
      //
      // ⚠️ Cuando NO hay número, sigue diciendo "sin dato satelital en
      //    la ventana" — una frase de ESTE archivo, que NO está en la
      //    regla sellada (la regla dice "sin dato"). Se dejó tal cual
      //    estaba: cambiarla ahora sería mover el comportamiento a
      //    espaldas del fundador. Está anotado en la cabecera como
      //    deuda declarada, para que él decida.
      interpretacion: m
        ? reglas.interpretar(ind.indice, m.mean, reglaLectura)
        : 'sin dato satelital en la ventana',
    };
  });

  const conDato = mediciones.filter(m => m.valor !== null);

  // ── AJUSTE 27-C: la nubosidad sale de la calidad del POLÍGONO.
  //    Se usa el índice principal (el primero que trajo dato).
  //    Si ninguno trajo dato: no hay nubosidad. Hay hueco.
  const principal   = conDato[0] || null;
  const calidadPct  = principal ? principal.calidadPct : null;
  const nubosidadPct = calidadPct === null ? null : (100 - calidadPct);
  const fechaPasada = principal ? principal.fecha : null;

  // ── Los índices se piden por separado. Cada uno se queda con SU
  //    pasada más reciente. Pueden no ser del mismo día. Si eso pasa,
  //    el certificado no puede hablar de "una" pasada. Se avisa.
  const fechasUnicas = Array.from(new Set(conDato.map(m => m.fecha)));
  const fechasDistintas = fechasUnicas.length > 1;
  if (fechasDistintas) {
    log('WARN', `Los índices vienen de pasadas distintas`, { activoId, fechas: fechasUnicas });
  }

  // ── Si NINGÚN índice trajo dato, no hubo pasada limpia en la ventana.
  //    Eso NO es un error: es un hecho del clima. Pero hay que decirlo,
  //    no taparlo. El que llama (scheduler / generar-pdf) decide si es hueco.
  const sinDato = conDato.length === 0;
  if (sinDato) {
    log('MEDIR', `Sin pasada limpia en la ventana — no se inventa nada`, { activoId });
  } else if (calidadPct !== null && calidadPct < 70) {
    // Se midió, pero se vio menos del 70% del campo. Es honesto, pero flojo.
    log('WARN', `Calidad baja: solo se vio el ${calidadPct}% del polígono`, {
      activoId, fechaPasada,
    });
  }

  log('MEDIR', `Medición terminada`, {
    activoId,
    indicadores: mediciones.length,
    conDato: conDato.length,
    calidadPct,
    nubosidadPct,
    fechasDistintas,
    sinDato,
    reglaLectura,
  });

  return {
    activoId,
    satelite:  'Sentinel-2 L2A',
    fuente:    'ESA_COPERNICUS_DATASPACE',
    bandaEspectral: cfg.bandas,
    geometria,
    esPoligonoReal,
    timestamp: new Date().toISOString(),
    fechaPasada,
    fechasDistintas,
    calidadPct,
    nubosidadPct,
    fuenteNubosidad: 'POLIGONO',   // ← medida sobre el activo, no sobre la escena
    sinDato,                        // ← true = no hubo pasada limpia. Es un hueco honesto.

    // ── AJUSTE 30 · con qué regla se leyeron estos números ──────
    // Esto es lo que después entra al hash del certificado. Sin esto,
    // "vegetación moderada" es una opinión. Con esto, es un hecho:
    // este número, leído con esta regla pública, da esta frase.
    reglaLectura,
    hashRegla,

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

/**
 * AJUSTE 27-B: los productos sin dato de nubosidad quedan FUERA.
 * Antes entraban con un 50 inventado, que siempre pasaba el umbral.
 */
function _seleccionarMejorProducto(productos) {
  const conNubosidad = productos
    .map(p => ({ ...p, _nubosidad: _extraerNubosidad(p) }))
    .filter(p => p._nubosidad !== null)
    .sort((a, b) => a._nubosidad - b._nubosidad);

  return conNubosidad.find(p => p._nubosidad <= config.sentinel.umbralNubosidad) || null;
}

/**
 * AJUSTE 27-B. Dos cambios:
 *
 *  1. Con $expand=Attributes, Copernicus devuelve `Attributes` como una
 *     LISTA directa, no como { value: [...] }. El código viejo buscaba
 *     `.value`, no lo encontraba nunca, y caía siempre al default.
 *     Ahora se aceptan las dos formas.
 *
 *  2. Ya no hay default. Si el atributo no está, se devuelve null.
 *     Un dato que no se midió no se inventa: se declara ausente.
 *     El viejo `return 50` pasaba el umbral de 70 y certificaba.
 */
function _extraerNubosidad(producto) {
  const attrs = Array.isArray(producto.Attributes)
    ? producto.Attributes
    : (producto.Attributes?.value || []);

  const attr = attrs.find(
    a => a?.Name === 'cloudCover' || a?.Name === 'cloudcoverpercentage'
  );

  if (!attr || attr.Value === undefined || attr.Value === null) return null;

  const n = parseFloat(attr.Value);
  return isFinite(n) ? Math.round(n) : null;
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
  CALIDAD_MINIMA_PCT,
};
