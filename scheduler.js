/**
 * EPIMELEIA V3.4 — Oracle Node · scheduler.js
 * (cabecera original — sin cambios; ver repo. AJUSTES 24,33,39,40,45.)
 * AJUSTE 46 (3/10/2026): respeta modo_certificacion — los activos "atras"
 * (solo EUDR histórico) no entran al seguimiento quincenal.
 * ─────────────────────────────────────────────
 */

const cron       = require('node-cron');
const { config } = require('./config');
const { log }    = require('./logger');
const blockchain = require('./blockchain');
const satellite  = require('./satellite');
const reports    = require('./reports');
const { ethers } = require('ethers');

const activoSupabase = require('./activo-supabase');
const cobertura = require('./cobertura');

function trimestreActual() {
  const ahora = new Date();
  return _trimestreDe(ahora.getUTCFullYear(), ahora.getUTCMonth());
}

function _trimestreDe(anio, mes0) {
  const q = Math.floor(mes0 / 3) + 1;
  return anio * 10 + q;
}

function periodoDeVentana(fechaEmision = new Date()) {
  const dia = fechaEmision.getUTCDate();

  let anio, mes0, quincena, diaDesde, diaHasta;

  if (dia >= 10) {
    anio     = fechaEmision.getUTCFullYear();
    mes0     = fechaEmision.getUTCMonth();
    quincena = 'A';
    diaDesde = 1;
    diaHasta = 15;
  } else {
    const anterior = new Date(Date.UTC(fechaEmision.getUTCFullYear(), fechaEmision.getUTCMonth(), 1));
    anterior.setUTCMonth(anterior.getUTCMonth() - 1);
    anio     = anterior.getUTCFullYear();
    mes0     = anterior.getUTCMonth();
    quincena = 'B';
    diaDesde = 16;
    diaHasta = new Date(Date.UTC(anio, mes0 + 1, 0)).getUTCDate();
  }

  const trimestre = _trimestreDe(anio, mes0);
  const mesDentroDelQ       = mes0 % 3;
  const quincenaDelTrimestre = mesDentroDelQ * 2 + (quincena === 'A' ? 1 : 2);
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

function _etiqueta(p) {
  const q   = p.trimestre % 10;
  const anio = Math.floor(p.trimestre / 10);
  return `Q${q}/${anio} · quincena ${p.quincenaDelTrimestre}/6`;
}

function _emailDestinoDe(activoId, filaSupabase = null) {
  if (filaSupabase && filaSupabase.emailTitular) {
    return filaSupabase.emailTitular;
  }
  return process.env[`EMAIL_ACTIVO_${activoId}`] || process.env.ADMIN_EMAIL || '';
}

function _nubosidadParaContrato(nubosidadPct) {
  if (nubosidadPct === null || nubosidadPct === undefined || !isFinite(nubosidadPct)) {
    return 100;
  }
  const n = Math.round(nubosidadPct);
  if (n < 0)   return 0;
  if (n > 100) return 100;
  return n;
}

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

async function procesarVentanaSatelital(opciones = {}) {
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

  let evidencias = 0, certificaciones = 0, sinVer = 0, huecos = 0, omitidos = 0, fallidos = 0, sinPoligono = 0, sinCobertura = 0;

  for (const activoId of ids) {
    let resultado = null;

    try {
      resultado = await _procesarActivoVentana(activoId, periodo, simular);
    } catch (err) {
      log('ERROR', `Error procesando activo ${activoId}: ${err.message}`);
      await reports.notificarAdmin('ERROR_ACTIVO', { activoId, error: err.message });

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
      if (resultado.omitido)      omitidos++;
      if (resultado.evidencia)    evidencias++;
      if (resultado.certificado)  certificaciones++;
      if (resultado.sinVer)       sinVer++;
      if (resultado.hueco)        huecos++;
      if (resultado.sinPoligono)  sinPoligono++;
      if (resultado.sinCobertura) sinCobertura++;
    }

    await _pausa(config.pausas.entreActivos);
  }

  log('SCHEDULER', `══ VENTANA COMPLETADA ══`, {
    periodo: _etiqueta(periodo),
    evidencias, certificaciones, sinVer, huecos, sinPoligono, sinCobertura, omitidos, fallidos,
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
    evidencias, certificaciones, sinVer, huecos, sinPoligono, sinCobertura,
    totalActivos: ids.length,
    timestamp: new Date().toISOString(),
  });
}

async function _procesarActivoVentana(activoId, periodo, simular = false) {
  const datos = await blockchain.getDatosActivo(activoId);
  if (!datos || !datos.activo) {
    log('INFO', `Activo ${activoId} inactivo, omitiendo`);
    return { omitido: true };
  }

  if (datos.nivel !== 0) {
    log('INFO', `Activo ${activoId} es L${datos.nivel + 1} — requiere acuerdo previo`);
    await reports.notificarAdmin('ACTIVO_BAJO_ACUERDO', {
      activoId, nivel: `L${datos.nivel + 1}`, trimestre: periodo.trimestre,
    });
    return { omitido: true };
  }

  let filaSupabase;
  try {
    filaSupabase = await activoSupabase.traerActivoPorOnchainId(activoId);
  } catch (err) {
    log('ERROR', `No se pudo leer Supabase para activo ${activoId}: ${err.message}`);
    throw err;
  }

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
    return { sinPoligono: true };
  }

  // ── AJUSTE 46 · MODO DE CERTIFICACIÓN ─────────────────────────
  // El seguimiento quincenal (hacia adelante) solo corre para activos
  // "adelante" o "ambos". Los "atras" (solo EUDR histórico) NO se siguen:
  // su chequeo es una foto puntual del pasado, no un monitoreo continuo.
  // Si el modo viniera vacío, activo-supabase ya lo normaliza a 'atras',
  // así ningún activo arranca seguimiento sin que se haya elegido.
  const modo = filaSupabase.modoCertificacion || 'atras';
  if (modo === 'atras') {
    log('INFO', `Activo ${activoId}: modo "atras" (solo histórico EUDR) — no entra al seguimiento quincenal`);
    return { omitido: true };
  }

  // ── COBERTURA · corte por baja (AJUSTE 46 · corregido 3/10/2026) ──
  // OJO: cobertura.js busca la fila por activo_id_onchain (columna ENTERA),
  // NO por el id de fila (UUID). Por eso se le pasa activoId (el id on-chain),
  // no filaSupabase.filaId. Pasarle el UUID rompe en Postgres con
  // "invalid input syntax for type integer". (El parámetro de cobertura.js se
  // llama 'filaId' por historia, pero internamente filtra activo_id_onchain.)
  // Se evalúa acá, después de traer la fila y chequear modo, por orden lógico:
  // solo llega un activo con polígono real y en seguimiento (adelante/ambos)
  // — a un "atras" ni se le mira la cobertura.
  try {
    const cob = await cobertura.evaluarCoberturaDeActivo(
      activoId,
      periodo.hasta,
      periodo.esCierreDeTrimestre
    );

    if (!cob.puedeCertificar) {
      log('SIN_COBERTURA', `Activo ${activoId} (fila ${filaSupabase.filaId}): ${cob.motivo}`);
      if (!simular) {
        await reports.notificarAdmin('ACTIVO_SIN_COBERTURA', {
          activoId,
          trimestre: periodo.trimestre,
          estado: cob.estado,
          coberturaHasta: cob.coberturaHasta || null,
          motivo: cob.motivo,
        });
      }
      return { omitido: true, sinCobertura: true };
    }
  } catch (err) {
    log('ERROR', `No se pudo evaluar cobertura de ${activoId} (fila ${filaSupabase.filaId}): ${err.message}`);
    throw err;
  }

  log('VENTANA', `Activo ${activoId} · ${_etiqueta(periodo)} · POLÍGONO REAL`, {
    tipo: config.indicadoresPorTipo[filaSupabase.tipo]?.nombre || 'OTRO',
    nombre: filaSupabase.nombreActivo,
    filaSupabase: filaSupabase.filaId,
    modo,
  });

  const activoParaMedir = {
    activoId,
    tipo:       filaSupabase.tipo,
    geometria:  filaSupabase.geometria,
  };

  const medicion = await satellite.medirIndicadores(activoParaMedir);

  const evaluacion = _evaluarMedicionPoligono(medicion);

  if (!evaluacion.puedeCertificar) {
    log('SIN_VER', `Activo ${activoId}: ${evaluacion.causa} — no se sella esta quincena`);

    if (!simular) {
      await reports.notificarAdmin('QUINCENA_SIN_VER', {
        activoId,
        trimestre:            periodo.trimestre,
        quincenaDelTrimestre: periodo.quincenaDelTrimestre,
        causa:                evaluacion.causa,
        esClimatica:          evaluacion.esClimatica || false,
      });

      try {
        const emailDestino = _emailDestinoDe(activoId, filaSupabase);
        if (emailDestino) {
          await reports.enviarEvidenciaQuincenal({
            activoId,
            nombreActivo:         filaSupabase.nombreActivo,
            emailDestino,
            trimestre:            periodo.trimestre,
            quincenaDelTrimestre: periodo.quincenaDelTrimestre,
            caso:                 'no_visto',
            esClimatica:          evaluacion.esClimatica || false,
          });
        } else {
          log('WARN', `Activo ${activoId}: sin email destino — no se envía aviso quincenal (no visto)`);
        }
      } catch (err) {
        log('ERROR', `No se pudo enviar el aviso quincenal (no visto) del activo ${activoId}: ${err.message}`);
      }
    }

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
    const recibo = await blockchain.registrarEvidenciaVentana({
      activoId,
      trimestre:    periodo.trimestre,
      hashEvidencia,
      satelite:     medicion.satelite,
      nubosidadPct: nubosidadContrato,
      urlDescarga:  '',
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

    // ── AVISO QUINCENAL AL CLIENTE (caso: se vio y se selló) ──────
    try {
      const emailDestino = _emailDestinoDe(activoId, filaSupabase);
      if (emailDestino) {
        await reports.enviarEvidenciaQuincenal({
          activoId,
          nombreActivo:         filaSupabase.nombreActivo,
          emailDestino,
          trimestre:            periodo.trimestre,
          quincenaDelTrimestre: periodo.quincenaDelTrimestre,
          caso:                 'sellado',
          calidadPct:           medicion.calidadPct,
          satelite:             medicion.satelite,
          fechaPasada:          medicion.fechaPasada,
          hashEvidencia,
          txHash:               recibo?.hash || null,
          bloque:               recibo?.blockNumber != null ? Number(recibo.blockNumber) : null,
          mediciones:           medicion.mediciones || null,
        });
      } else {
        log('WARN', `Activo ${activoId}: sin email destino (EMAIL_ACTIVO_${activoId} / ADMIN_EMAIL) — no se envía aviso quincenal`);
      }
    } catch (err) {
      log('ERROR', `No se pudo enviar el aviso quincenal del activo ${activoId}: ${err.message}`);
    }
  }

  const resultado = { evidencia: true };

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

    try {
      const emailDestino = _emailDestinoDe(activoId, filaSupabase);
      if (emailDestino) {
        let billing = null;
        try {
          billing = await blockchain.getEstadoBilling(activoId);
        } catch (e) {
          log('WARN', `Sin datos de billing para el reporte trimestral del activo ${activoId}: ${e.message}`);
        }

        await reports.enviarReporteTrimestral({
          activoId,
          owner:         datos?.owner || '',
          trimestre:     periodo.trimestre,
          datosBilling:  billing,
          certs:         [],
          huecos:        [],
          indiceCont:    0,
          emailDestino,
          nombreActivo:  filaSupabase.nombreActivo || datos?.nombre || `Activo ${activoId}`,
        });

        log('EMAIL', `Reporte trimestral enviado`, { activoId, trimestre: periodo.trimestre });
      } else {
        log('WARN', `Activo ${activoId}: sin email destino — no se envía reporte trimestral`);
      }
    } catch (err) {
      log('ERROR', `No se pudo enviar el reporte trimestral del activo ${activoId}: ${err.message}`);
    }

    resultado.certificado = true;
  }

  return resultado;
}

function iniciarEscuchaEventos() {
  blockchain.escucharReportesTrimestrales(async ({ activoId, owner, trimestre }) => {
    try {
      log('EMAIL', `Preparando reporte trimestral`, { activoId, trimestre });

      const emailDestino = _emailDestinoDe(activoId);

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
        certs:         [],
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
    const emailDestino = _emailDestinoDe(activoId);
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

function iniciarSchedulers() {
  const schedVentana     = config.modoTest ? config.cron.testVentana     : config.cron.ventanaSatelital;
  const schedContinuidad = config.modoTest ? config.cron.testContinuidad : config.cron.continuidad;

  cron.schedule(schedVentana, () => {
    const p = periodoDeVentana(new Date());
    log('CRON', `Job: Ventana satelital ${_etiqueta(p)}${p.esCierreDeTrimestre ? ' · CIERRE DE TRIMESTRE' : ''}`);
    procesarVentanaSatelital().catch(err =>
      log('ERROR', `Error en ventana: ${err.message}`)
    );
  });

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
