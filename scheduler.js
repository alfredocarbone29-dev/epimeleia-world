/**
 * EPIMELEIA V3.4 — Oracle Node · scheduler.js
 * ─────────────────────────────────────────────
 * Cerebro del oracle: coordina ventanas satelitales, multi-activo,
 * certificaciones trimestrales y alertas.
 *
 * ══ AJUSTE 24 — EL RELOJ DE DOS RITMOS ══════════════════════════
 *
 * EPIMELEIA tiene su propio reloj y respeta los mismos cortes para todos.
 * Late en dos tiempos, y cada uno hace algo distinto en la cadena:
 *
 *   · QUINCENAL (el pulso)  → registrarEvidenciaVentana()
 *     Cada 15 días se mide el activo y se sella esa medición.
 *     Es lo que hace que el cliente sienta cerca a EPIMELEIA.
 *     El contrato acepta 6 por trimestre: require(ev.length < 6).
 *     3 meses × 2 quincenas = 6. Estaba pensado así desde el principio.
 *
 *   · TRIMESTRAL (el balance) → certificarQ()
 *     Una sola vez por trimestre, al cierre del Q.
 *     Espejo de los cierres Q1–Q4 de las compañías que operan en bolsa.
 *     Es el sello formal, y el que hace avanzar el Sello de Excelencia
 *     (4 certificaciones consecutivas = 4 trimestres = 1 año).
 *
 * CALENDARIO (cron: '0 6 2,16 * *')
 * Cada corrida mide la quincena YA CERRADA, no la fecha en que corre:
 *
 *   emite el 16 de M   → mide del 1 al 15 de M          (quincena A)
 *   emite el  2 de M   → mide del 16 al fin de M-1      (quincena B)
 *
 *   La corrida del 2 de ENE / ABR / JUL / OCT mide la última quincena
 *   del trimestre que acaba de cerrar → esa corrida, además de sellar
 *   la evidencia, ejecuta certificarQ() del trimestre cerrado.
 *
 * POR QUÉ 2 Y 16, Y NO 1 Y 15
 * El satélite no publica al instante: Sentinel-2 L2A tarda horas.
 * Corriendo el día 15, la pasada del 15 todavía no existe para el sistema.
 * Emitiendo el 16, se garantiza incluirla.
 *
 * HUECOS: SE CUENTAN POR TRIMESTRE, NO POR QUINCENA
 * El contrato lo dice en sus propios nombres: trimestresConHueco.
 * Y _registrarHueco() hace actualizarConsecutivos(activoId, 0), o sea
 * borra la racha del Sello de Excelencia.
 * Si registráramos un hueco por cada quincena nublada, el sello sería
 * imposible de ganar (4 trimestres = 24 quincenas; que ninguna tenga
 * nubes no pasa nunca) y el índice de continuidad quedaría mal calculado.
 * Que el satélite no vea un día no es culpa del cliente.
 * Que no se lo pueda ver en tres meses, sí es un hecho relevante.
 *
 * Por eso:
 *   · quincena con nubes  → NO se sella evidencia. La ausencia es el
 *                            registro: el trimestre debía tener 6 y tiene 5.
 *   · trimestre sin ver   → certificarQ() registra el hueco. Ahí se juega
 *                            la continuidad y el sello.
 *
 * ════════════════════════════════════════════════════════════════
 * AJUSTE 33 (18/7/2026) — EL NUDO · SE MIDE EL POLÍGONO REAL
 * ════════════════════════════════════════════════════════════════
 *
 * Hasta hoy había DOS mundos que no se tocaban:
 *   · este scheduler medía con consultarSentinel() → punto + radio,
 *     nubosidad DE LA ESCENA, hash de 7 campos de metadata.
 *   · el polígono REAL del cliente vivía en Supabase, y lo medía
 *     medirIndicadores() (con la regla de lectura v1), pero NADIE
 *     llamaba a esa función desde acá.
 *
 * El NDVI real nunca fue a la cadena. Ni una vez.
 *
 * ESTE AJUSTE COSE LOS DOS MUNDOS. En _procesarActivoVentana():
 *   1. Se le pregunta a Supabase por el polígono del activo, cruzando
 *      por activo_id_onchain (activo-supabase.js).
 *   2. Si HAY polígono → se mide con medirIndicadores() sobre el
 *      polígono real. Ese es el mundo nuevo: NDVI de verdad, calidad
 *      del polígono, regla de lectura v1.
 *   3. Si NO hay polígono → NO se certifica (decisión del fundador,
 *      opción B). Se anota y se sigue. El modo viejo del cuadrado
 *      MUERE: nunca más se certifica un punto + radio.
 *
 * DECISIÓN DEL FUNDADOR (opción B):
 *   "No certificamos lo que no podemos medir bien." Mientras
 *   activo_id_onchain esté vacío (hasta la Fase 7), no se certifica
 *   nada nuevo — y eso está bien, porque los únicos activos on-chain
 *   hoy son escombro de prueba.
 *
 * QUÉ NO SE TOCÓ:
 *   · El reloj (periodoDeVentana, etc.) — idéntico.
 *   · Los cron, la escucha de eventos, el healthcheck — idénticos.
 *   · consultarSentinel() y evaluarNubosidad() siguen EXISTIENDO en
 *     satellite.js, pero este scheduler YA NO LOS LLAMA. Se dejan por
 *     si hay que volver atrás. Están marcados como camino muerto.
 *
 * ⚠️ TRAMPA CONOCIDA (documentada, se maneja acá):
 *   El contrato hace hueco automático si nubosidadPct > 70. Con
 *   medirIndicadores(), nubosidad = 100 − calidad. Y si no hubo pasada,
 *   nubosidadPct viene null → el contrato espera uint16 → la tx
 *   rompería. Por eso ANTES de sellar se normaliza (ver _nubosidadParaContrato).
 * ════════════════════════════════════════════════════════════════
 */

const cron       = require('node-cron');
const { config } = require('./config');
const { log }    = require('./logger');
const blockchain = require('./blockchain');
const satellite  = require('./satellite');
const reports    = require('./reports');
const { ethers } = require('ethers');

// ── AJUSTE 33: el puente al mundo nuevo ──────────────────────────
// Trae de Supabase el polígono real del activo, cruzando por
// activo_id_onchain. Es la pieza probada en la Fase 3.
const activoSupabase = require('./activo-supabase');

// ─── El reloj: trimestres y quincenas ───────────────────────────

/**
 * Trimestre del momento actual. Formato: año*10 + Q  (ej: 20263)
 * Se mantiene por compatibilidad (index.js lo usa para el log de arranque).
 */
function trimestreActual() {
  const ahora = new Date();
  return _trimestreDe(ahora.getUTCFullYear(), ahora.getUTCMonth());
}

/** Arma el número de trimestre a partir de año y mes (mes 0-indexado). */
function _trimestreDe(anio, mes0) {
  const q = Math.floor(mes0 / 3) + 1;
  return anio * 10 + q; // 20261, 20262, 20263, 20264
}

/**
 * Corazón del reloj. Dada la fecha de emisión, devuelve qué período se mide.
 *
 * Devuelve:
 *   desde, hasta            → los bordes del período medido (Date, UTC)
 *   trimestre               → el trimestre AL QUE PERTENECE ese período
 *   quincena                → 'A' (1–15) o 'B' (16–fin de mes)
 *   quincenaDelTrimestre    → 1..6
 *   esCierreDeTrimestre     → true si es la 6ª quincena del Q
 */
function periodoDeVentana(fechaEmision = new Date()) {
  const dia = fechaEmision.getUTCDate();

  let anio, mes0, quincena, diaDesde, diaHasta;

  if (dia >= 10) {
    // Corrida del 16: mide la primera quincena de ESTE mes.
    anio     = fechaEmision.getUTCFullYear();
    mes0     = fechaEmision.getUTCMonth();
    quincena = 'A';
    diaDesde = 1;
    diaHasta = 15;
  } else {
    // Corrida del 2: mide la segunda quincena del mes ANTERIOR.
    const anterior = new Date(Date.UTC(fechaEmision.getUTCFullYear(), fechaEmision.getUTCMonth(), 1));
    anterior.setUTCMonth(anterior.getUTCMonth() - 1);
    anio     = anterior.getUTCFullYear();
    mes0     = anterior.getUTCMonth();
    quincena = 'B';
    diaDesde = 16;
    diaHasta = new Date(Date.UTC(anio, mes0 + 1, 0)).getUTCDate(); // último día del mes
  }

  const trimestre = _trimestreDe(anio, mes0);

  // Posición dentro del trimestre: mes del Q (0,1,2) × 2 + (A=1, B=2)
  const mesDentroDelQ       = mes0 % 3;
  const quincenaDelTrimestre = mesDentroDelQ * 2 + (quincena === 'A' ? 1 : 2);

  // Cierra el trimestre la quincena B del último mes del Q (mar, jun, sep, dic)
  const esCierreDeTrimestre = (quincena === 'B' && mesDentroDelQ === 2);

  return {
    desde: new Date(Date.UTC(anio, mes0, diaDesde, 0, 0, 0)),
    hasta: new Date(Date.UTC(anio, mes0, diaHasta, 23, 59, 59)),
    trimestre,
    quincena,
    quincenaDelTrimestre,
    esCierreDeTrimestre,
  };
}

/** Etiqueta legible del período, para logs y mails. Ej: "Q3/2026 · quincena 6/6" */
function _etiqueta(p) {
  const q   = p.trimestre % 10;
  const anio = Math.floor(p.trimestre / 10);
  return `Q${q}/${anio} · quincena ${p.quincenaDelTrimestre}/6`;
}

// ─── AJUSTE 33: helpers del nudo ────────────────────────────────

/**
 * Normaliza la nubosidad que va al contrato.
 *
 * medirIndicadores() devuelve:
 *   · nubosidadPct = 100 − calidadPct  (medida sobre el polígono)
 *   · null si no hubo pasada limpia
 *
 * El contrato espera un uint16 (0..65535) y hace hueco si > 70.
 * Si le pasáramos null, la transacción rompería. Por eso:
 *   · null  → 100 (nubosidad total: no se vio nada → el contrato hace hueco)
 *   · resto → el número redondeado, acotado a 0..100
 *
 * Devolver 100 cuando no hay dato es honesto: significa "no se pudo ver".
 * El contrato lo tratará como hueco climático, que es lo correcto.
 */
function _nubosidadParaContrato(nubosidadPct) {
  if (nubosidadPct === null || nubosidadPct === undefined || !isFinite(nubosidadPct)) {
    return 100;
  }
  const n = Math.round(nubosidadPct);
  if (n < 0)   return 0;
  if (n > 100) return 100;
  return n;
}

/**
 * ¿La medición del polígono permite certificar?
 *
 * Espeja la lógica de evaluarNubosidad() del modo viejo, pero sobre la
 * medición REAL del polígono (medirIndicadores), no sobre la escena.
 *
 *   · sin pasada limpia (sinDato)        → no se puede certificar
 *   · nubosidad del polígono > umbral    → no se puede (hueco climático)
 *   · si no                              → se puede
 */
function _evaluarMedicionPoligono(medicion) {
  if (!medicion || medicion.sinDato) {
    return {
      puedeCertificar: false,
      causa: 'SATELLITE_LOSS: Sin pasada limpia sobre el poligono en la ventana.',
      esClimatica: false,
    };
  }

  const nub = medicion.nubosidadPct;
  if (nub === null || nub === undefined) {
    return {
      puedeCertificar: false,
      causa: 'SATELLITE_LOSS: Sin dato de calidad sobre el poligono. No se certifica lo que no se midio.',
      esClimatica: false,
    };
  }

  if (nub > config.sentinel.umbralNubosidad) {
    return {
      puedeCertificar: false,
      causa: `CLIMA: Calidad insuficiente sobre el poligono (nubosidad ${nub}%). Umbral maximo: ${config.sentinel.umbralNubosidad}%.`,
      esClimatica: true,
    };
  }

  return { puedeCertificar: true, causa: null, esClimatica: false };
}

// ─── Proceso de ventana satelital ──────────────────────────────

/**
 * Procesa todos los activos activos en una ventana quincenal.
 * Por cada activo:
 *   1. Trae su polígono de Supabase (AJUSTE 33)
 *   2. Si hay polígono → mide con medirIndicadores() sobre el polígono real
 *   3. Si la calidad lo permite → sella la evidencia de ventana
 *   4. Si es el cierre del trimestre → además ejecuta certificarQ()
 *   5. Si no hay polígono o hay nubes → no sella (ver notas arriba)
 */
async function procesarVentanaSatelital(opciones = {}) {
  // Compatibilidad: si alguien pasa una Date suelta, la tomamos como fecha de emisión.
  if (opciones instanceof Date) opciones = { fechaEmision: opciones };

  const fechaEmision = opciones.fechaEmision || new Date();
  const simular      = opciones.simular === true;

  const periodo = periodoDeVentana(fechaEmision);

  if (simular) {
    log('SIMULACRO', `══ MODO SIMULACRO — NO SE ESCRIBE NADA EN LA CADENA ══`);
  }

  log('SCHEDULER', `══ VENTANA SATELITAL ${_etiqueta(periodo)} ══`, {
    emite: fechaEmision.toISOString().slice(0,10),
    mide:  `${periodo.desde.toISOString().slice(0,10)} → ${periodo.hasta.toISOString().slice(0,10)}`,
    cierreDeTrimestre: periodo.esCierreDeTrimestre,
    simulacro: simular,
  });

  let ids;
  try {
    ids = await blockchain.getListaActivos();
    log('SCHEDULER', `Activos a procesar: ${ids.length}`);
  } catch (err) {
    log('ERROR', `No se pudo obtener lista de activos: ${err.message}`);
    await reports.notificarAdmin('ERROR_LISTA_ACTIVOS', { error: err.message });
    return;
  }

  let evidencias = 0, certificaciones = 0, sinVer = 0, huecos = 0, omitidos = 0, fallidos = 0, sinPoligono = 0;

  for (const activoId of ids) {
    let resultado = null;

    try {
      resultado = await _procesarActivoVentana(activoId, periodo, simular);
    } catch (err) {
      log('ERROR', `Error procesando activo ${activoId}: ${err.message}`);
      await reports.notificarAdmin('ERROR_ACTIVO', { activoId, error: err.message });

      // Reintento con backoff
      let reintentos = 0;
      while (reintentos < config.pausas.maxReintentos) {
        await _pausa(config.pausas.reintento * (reintentos + 1));
        try {
          resultado = await _procesarActivoVentana(activoId, periodo, simular);
          break;
        } catch (e) {
          reintentos++;
          log('WARN', `Reintento ${reintentos}/${config.pausas.maxReintentos} para activo ${activoId}`);
        }
      }
      if (!resultado) {
        fallidos++;
        log('ERROR', `Activo ${activoId} no procesado después de ${config.pausas.maxReintentos} reintentos`);
      }
    }

    if (resultado) {
      if (resultado.omitido)     omitidos++;
      if (resultado.evidencia)   evidencias++;
      if (resultado.certificado) certificaciones++;
      if (resultado.sinVer)      sinVer++;
      if (resultado.hueco)       huecos++;
      if (resultado.sinPoligono) sinPoligono++;
    }

    // Pausa entre activos para no saturar el RPC
    await _pausa(config.pausas.entreActivos);
  }

  log('SCHEDULER', `══ VENTANA COMPLETADA ══`, {
    periodo: _etiqueta(periodo),
    evidencias, certificaciones, sinVer, huecos, sinPoligono, omitidos, fallidos,
    totalActivos: ids.length,
  });

  if (simular) {
    log('SIMULACRO', `══ FIN DEL SIMULACRO — la cadena quedó intacta ══`);
    return;
  }

  await reports.notificarAdmin('VENTANA_SATELITAL_COMPLETADA', {
    trimestre:            periodo.trimestre,
    quincenaDelTrimestre: periodo.quincenaDelTrimestre,
    esCierreDeTrimestre:  periodo.esCierreDeTrimestre,
    mide:                 `${periodo.desde.toISOString().slice(0,10)} → ${periodo.hasta.toISOString().slice(0,10)}`,
    evidencias, certificaciones, sinVer, huecos, sinPoligono,
    totalActivos: ids.length,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Procesa un activo individual en una ventana quincenal.
 * Devuelve un pequeño resumen de lo que hizo.
 *
 * AJUSTE 33: mide el POLÍGONO REAL de Supabase, no el punto + radio.
 */
async function _procesarActivoVentana(activoId, periodo, simular = false) {
  const datos = await blockchain.getDatosActivo(activoId);
  if (!datos || !datos.activo) {
    log('INFO', `Activo ${activoId} inactivo, omitiendo`);
    return { omitido: true };
  }

  // Solo procesar L1 automáticamente (L2 y L3 requieren acuerdo previo)
  if (datos.nivel !== 0) {
    log('INFO', `Activo ${activoId} es L${datos.nivel + 1} — requiere acuerdo previo`);
    await reports.notificarAdmin('ACTIVO_BAJO_ACUERDO', {
      activoId, nivel: `L${datos.nivel + 1}`, trimestre: periodo.trimestre,
    });
    return { omitido: true };
  }

  // ── AJUSTE 33 · PASO 1: traer el polígono real de Supabase ────
  // Se cruza por activo_id_onchain = activoId (el ID de la cadena).
  let filaSupabase;
  try {
    filaSupabase = await activoSupabase.traerActivoPorOnchainId(activoId);
  } catch (err) {
    // Error REAL de Supabase (red/credenciales). No es "no encontrado".
    log('ERROR', `No se pudo leer Supabase para activo ${activoId}: ${err.message}`);
    // Se trata como fallo del activo, para reintentar. No se inventa nada.
    throw err;
  }

  // ── AJUSTE 33 · OPCIÓN B: sin polígono, NO se certifica ───────
  // El modo viejo del cuadrado (punto + radio) MUERE acá. Si no hay
  // polígono real en Supabase, no se mide ni se sella. Se anota y se sigue.
  if (!filaSupabase.encontrado || !filaSupabase.esPoligonoReal) {
    const motivo = !filaSupabase.encontrado
      ? filaSupabase.motivo
      : 'El activo existe en Supabase pero no tiene un polígono válido.';
    log('SIN_POLIGONO', `Activo ${activoId}: no se certifica — ${motivo}`);

    if (!simular) {
      await reports.notificarAdmin('ACTIVO_SIN_POLIGONO', {
        activoId,
        trimestre: periodo.trimestre,
        motivo,
      });
    }
    // Importante: NO se registra hueco on-chain por esto. "No tener el
    // polígono atado todavía" es un tema administrativo (falta la Fase 7),
    // no un hueco de opacidad del activo. No se penaliza al cliente.
    return { sinPoligono: true };
  }

  log('VENTANA', `Activo ${activoId} · ${_etiqueta(periodo)} · POLÍGONO REAL`, {
    tipo: config.indicadoresPorTipo[filaSupabase.tipo]?.nombre || 'OTRO',
    nombre: filaSupabase.nombreActivo,
    filaSupabase: filaSupabase.filaId,
  });

  // ── AJUSTE 33 · PASO 2: medir sobre el polígono real ──────────
  // Se arma el objeto que medirIndicadores() espera: el tipo (número) y
  // la geometría (GeoJSON Polygon). Ese es el mundo nuevo — NDVI real,
  // calidad del polígono, regla de lectura v1.
  const activoParaMedir = {
    activoId,
    tipo:       filaSupabase.tipo,
    geometria:  filaSupabase.geometria,
  };

  const medicion = await satellite.medirIndicadores(activoParaMedir);

  // ── PASO 3: ¿la calidad del polígono permite certificar? ──────
  const evaluacion = _evaluarMedicionPoligono(medicion);

  if (!evaluacion.puedeCertificar) {
    // Quincena sin ver: NO se registra hueco on-chain (misma lógica de
    // siempre — los huecos se cuentan por trimestre, no por quincena).
    log('SIN_VER', `Activo ${activoId}: ${evaluacion.causa} — no se sella esta quincena`);

    if (!simular) {
      await reports.notificarAdmin('QUINCENA_SIN_VER', {
        activoId,
        trimestre:            periodo.trimestre,
        quincenaDelTrimestre: periodo.quincenaDelTrimestre,
        causa:                evaluacion.causa,
        esClimatica:          evaluacion.esClimatica || false,
      });
    }

    // Si además es el cierre del trimestre, el hueco sí se registra.
    if (periodo.esCierreDeTrimestre) {
      if (simular) {
        log('SIMULACRO', `Activo ${activoId}: ESCRIBIRÍA un Hueco de Opacidad (trimestre ${periodo.trimestre}) — ${evaluacion.causa}`);
        return { sinVer: true, hueco: true };
      }
      await blockchain.registrarHueco(activoId, evaluacion.causa, evaluacion.esClimatica || false);
      log('HUECO', `Activo ${activoId}: trimestre ${periodo.trimestre} cerrado con hueco — ${evaluacion.causa}`);
      return { sinVer: true, hueco: true };
    }

    return { sinVer: true };
  }

  // ── AJUSTE 33 · PASO 4: armar el hash y la nubosidad para la cadena ──
  // ⚠️ Hoy generarHashEvidencia() sigue cubriendo solo metadata (7 campos).
  //    El hash del PAQUETE COMPLETO (polígono + mediciones + regla + titular)
  //    se conecta en la Junta A, cuando se enchufe paquete-evidencia.js.
  //    Por ahora el nudo mide bien y sella el hash que había — el salto al
  //    hash real es el paso siguiente, y está marcado.
  //
  //    Se le pasa a generarHashEvidencia un reporte con los datos que la
  //    medición sí tiene, para no romper su firma.
  const reporteParaHash = {
    activoId,
    satelite:       medicion.satelite,
    uuid:           `POLY_${activoId}_${medicion.fechaPasada || 'sinfecha'}`,
    nubosidadPct:   _nubosidadParaContrato(medicion.nubosidadPct),
    bandaEspectral: medicion.bandaEspectral,
    timestamp:      medicion.timestamp,
    fuente:         medicion.fuente,
  };
  const hashEvidencia = satellite.generarHashEvidencia(reporteParaHash);
  const nubosidadContrato = _nubosidadParaContrato(medicion.nubosidadPct);

  // ── PASO 5: EL PULSO — sellar la evidencia de esta quincena ───
  if (simular) {
    log('SIMULACRO', `Activo ${activoId}: SELLARÍA evidencia ${periodo.quincenaDelTrimestre}/6 (polígono real)`, {
      trimestre: periodo.trimestre,
      hashEvidencia,
      satelite: medicion.satelite,
      nubosidad: nubosidadContrato,
      calidad: medicion.calidadPct,
      regla: medicion.reglaLectura,
      fechaPasada: medicion.fechaPasada,
    });
  } else {
    await blockchain.registrarEvidenciaVentana({
      activoId,
      trimestre:    periodo.trimestre,
      hashEvidencia,
      satelite:     medicion.satelite,
      nubosidadPct: nubosidadContrato,
      urlDescarga:  '',   // el polígono no descarga una escena; queda vacío por ahora
    });

    log('EVIDENCIA', `Activo ${activoId} · evidencia ${periodo.quincenaDelTrimestre}/6 sellada (polígono real)`);

    await reports.notificarAdmin('EVIDENCIA_QUINCENAL_SELLADA', {
      activoId,
      trimestre:            periodo.trimestre,
      quincenaDelTrimestre: periodo.quincenaDelTrimestre,
      satelite:             medicion.satelite,
      nubosidad:            nubosidadContrato,
      calidad:              medicion.calidadPct,
      regla:                medicion.reglaLectura,
      timestamp:            new Date().toISOString(),
    });
  }

  const resultado = { evidencia: true };

  // ── PASO 6: EL BALANCE — solo al cierre del trimestre ─────────
  if (periodo.esCierreDeTrimestre) {
    const metadataURI = satellite.generarMetadataURI(reporteParaHash, periodo.trimestre);

    if (simular) {
      log('SIMULACRO', `Activo ${activoId}: CERTIFICARÍA el trimestre ${periodo.trimestre} (certificarQ, polígono real)`);
      resultado.certificado = true;
      return resultado;
    }

    await blockchain.certificarEnChain({
      activoId,
      hashEvidencia,
      metadataURI,
      trimestre:      periodo.trimestre,
      satelite:       medicion.satelite,
      bandaEspectral: medicion.bandaEspectral,
      nubosidadPct:   nubosidadContrato,
      urlDescarga:    '',
      uuid:           reporteParaHash.uuid,
    });

    log('CERT_Q', `Activo ${activoId} · trimestre ${periodo.trimestre} CERTIFICADO (polígono real)`);

    await reports.notificarAdmin('CERT_TRIMESTRAL_CONFIRMADA', {
      activoId,
      trimestre:  periodo.trimestre,
      satelite:   medicion.satelite,
      nubosidad:  nubosidadContrato,
      calidad:    medicion.calidadPct,
      regla:      medicion.reglaLectura,
      timestamp:  new Date().toISOString(),
    });

    resultado.certificado = true;
  }

  return resultado;
}

// ─── Escucha de eventos blockchain ─────────────────────────────

/**
 * Escucha ReporteTrimestralTrigger para despachar reportes por email — Ajuste 21.
 * NOTA: hoy está desactivada desde index.js (los filtros contra el RPC se rompían).
 */
function iniciarEscuchaEventos() {
  blockchain.escucharReportesTrimestrales(async ({ activoId, owner, trimestre }) => {
    try {
      log('EMAIL', `Preparando reporte trimestral`, { activoId, trimestre });

      // En producción, aquí se obtiene el email del activo desde un registro externo
      // (el email no se guarda on-chain por privacidad, solo el hash)
      const emailDestino = process.env[`EMAIL_ACTIVO_${activoId}`] || process.env.ADMIN_EMAIL || '';

      if (!emailDestino) {
        log('WARN', `Email no configurado para activo ${activoId}`);
        return;
      }

      const datos = await blockchain.getDatosActivo(activoId);
      const billing = await blockchain.getEstadoBilling(activoId);

      await reports.enviarReporteTrimestral({
        activoId,
        owner,
        trimestre,
        datosBilling:  billing,
        certs:         [],      // se obtendría del contrato cert
        huecos:        [],
        indiceCont:    0,
        emailDestino,
        nombreActivo:  datos?.nombre || `Activo ${activoId}`,
      });
    } catch (err) {
      log('ERROR', `Error enviando reporte trimestral activo ${activoId}: ${err.message}`);
    }
  });

  blockchain.escucharAlertasSaldo(async ({ activoId, owner, diasRestantes }) => {
    const emailDestino = process.env[`EMAIL_ACTIVO_${activoId}`] || process.env.ADMIN_EMAIL || '';
    if (!emailDestino) return;

    const billing = await blockchain.getEstadoBilling(activoId);
    const datos   = await blockchain.getDatosActivo(activoId);

    await reports.enviarAlertaSaldo({
      activoId, owner,
      emailDestino,
      nombreActivo:  datos?.nombre || `Activo ${activoId}`,
      saldoPOL:      billing.saldo,
      feeProximo:    billing.feeProximo,
      diasRestantes,
    });
  });

  log('SCHEDULER', `Escucha de eventos activada (reportes, alertas)`);
}

// ─── Schedulers cron ───────────────────────────────────────────

function iniciarSchedulers() {
  const schedVentana     = config.modoTest ? config.cron.testVentana     : config.cron.ventanaSatelital;
  const schedContinuidad = config.modoTest ? config.cron.testContinuidad : config.cron.continuidad;

  // Ventana satelital quincenal (días 2 y 16 en prod / cada minuto en test)
  cron.schedule(schedVentana, () => {
    const p = periodoDeVentana(new Date());
    log('CRON', `Job: Ventana satelital ${_etiqueta(p)}${p.esCierreDeTrimestre ? ' · CIERRE DE TRIMESTRE' : ''}`);
    procesarVentanaSatelital().catch(err =>
      log('ERROR', `Error en ventana: ${err.message}`)
    );
  });

  // Healthcheck cada hora
  cron.schedule(config.cron.healthcheck, async () => {
    try {
      const info = await blockchain.getInfoRed();
      log('HEALTH', `Oracle activo`, info);
    } catch (err) {
      log('ERROR', `Healthcheck fallido: ${err.message}`);
      await reports.notificarAdmin('ORACLE_HEALTH_ERROR', { error: err.message });
    }
  });

  const proximo = periodoDeVentana(new Date());
  log('SCHEDULER', `Schedulers iniciados`, {
    modoTest:    config.modoTest,
    ventana:     schedVentana,
    ritmo:       'quincenal (evidencia) + trimestral (certificación)',
    periodoActual: _etiqueta(proximo),
    healthcheck: config.cron.healthcheck,
  });
}

// ─── Helper ────────────────────────────────────────────────────

function _pausa(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  trimestreActual,
  periodoDeVentana,
  procesarVentanaSatelital,
  iniciarSchedulers,
  iniciarEscuchaEventos,
};
