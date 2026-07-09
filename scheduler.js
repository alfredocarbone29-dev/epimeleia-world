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
 * ─────────────────────────────────────────────────────────────────
 */

const cron       = require('node-cron');
const { config } = require('./config');
const { log }    = require('./logger');
const blockchain = require('./blockchain');
const satellite  = require('./satellite');
const reports    = require('./reports');
const { ethers } = require('ethers');

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

// ─── Proceso de ventana satelital ──────────────────────────────

/**
 * Procesa todos los activos activos en una ventana quincenal.
 * Por cada activo:
 *   1. Consulta Sentinel/Copernicus sobre el período medido
 *   2. Si la nubosidad lo permite → sella la evidencia de ventana
 *   3. Si es el cierre del trimestre → además ejecuta certificarQ()
 *   4. Si hay nubes → no sella nada esta quincena (ver nota de huecos arriba)
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

  let evidencias = 0, certificaciones = 0, sinVer = 0, huecos = 0, omitidos = 0, fallidos = 0;

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
    }

    // Pausa entre activos para no saturar el RPC
    await _pausa(config.pausas.entreActivos);
  }

  log('SCHEDULER', `══ VENTANA COMPLETADA ══`, {
    periodo: _etiqueta(periodo),
    evidencias, certificaciones, sinVer, huecos, omitidos, fallidos,
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
    evidencias, certificaciones, sinVer, huecos,
    totalActivos: ids.length,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Procesa un activo individual en una ventana quincenal.
 * Devuelve un pequeño resumen de lo que hizo.
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

  log('VENTANA', `Activo ${activoId} · ${_etiqueta(periodo)}`, {
    tipo: config.indicadoresPorTipo[datos.tipo]?.nombre || 'OTRO',
    lat: datos.latitud, lng: datos.longitud,
  });

  // 1) Consultar el satélite sobre el período medido
  const reporte = await satellite.consultarSentinel(datos);

  // 2) ¿Se pudo ver?
  const evaluacion = satellite.evaluarNubosidad(reporte);

  if (!evaluacion.puedeCertificar) {
    // Quincena sin ver: NO se registra hueco on-chain (ver nota de arriba).
    // La ausencia de esta evidencia es el registro: el trimestre tendrá
    // menos de 6. El hueco, si corresponde, se decide al cierre del Q.
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

    // Si además es el cierre del trimestre, el hueco sí se registra:
    // el trimestre entero se cierra sin haber podido ver.
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

  const hashEvidencia = satellite.generarHashEvidencia(reporte);

  // 3) EL PULSO — sellar la evidencia de esta quincena
  if (simular) {
    log('SIMULACRO', `Activo ${activoId}: SELLARÍA evidencia ${periodo.quincenaDelTrimestre}/6`, {
      trimestre: periodo.trimestre, hashEvidencia, satelite: reporte.satelite, nubosidad: reporte.nubosidadPct,
    });
  } else {
    await blockchain.registrarEvidenciaVentana({
      activoId,
      trimestre:    periodo.trimestre,
      hashEvidencia,
      satelite:     reporte.satelite,
      nubosidadPct: reporte.nubosidadPct,
      urlDescarga:  reporte.urlDescargaDatos,
    });

    log('EVIDENCIA', `Activo ${activoId} · evidencia ${periodo.quincenaDelTrimestre}/6 sellada`);

    await reports.notificarAdmin('EVIDENCIA_QUINCENAL_SELLADA', {
      activoId,
      trimestre:            periodo.trimestre,
      quincenaDelTrimestre: periodo.quincenaDelTrimestre,
      satelite:             reporte.satelite,
      nubosidad:            reporte.nubosidadPct,
      timestamp:            new Date().toISOString(),
    });
  }

  const resultado = { evidencia: true };

  // 4) EL BALANCE — solo al cierre del trimestre
  if (periodo.esCierreDeTrimestre) {
    const metadataURI = satellite.generarMetadataURI(reporte, periodo.trimestre);

    if (simular) {
      log('SIMULACRO', `Activo ${activoId}: CERTIFICARÍA el trimestre ${periodo.trimestre} (certificarQ)`);
      resultado.certificado = true;
      return resultado;
    }

    await blockchain.certificarEnChain({
      activoId,
      hashEvidencia,
      metadataURI,
      trimestre:      periodo.trimestre,
      satelite:       reporte.satelite,
      bandaEspectral: reporte.bandaEspectral,
      nubosidadPct:   reporte.nubosidadPct,
      urlDescarga:    reporte.urlDescargaDatos,
      uuid:           reporte.uuid,
    });

    log('CERT_Q', `Activo ${activoId} · trimestre ${periodo.trimestre} CERTIFICADO`);

    await reports.notificarAdmin('CERT_TRIMESTRAL_CONFIRMADA', {
      activoId,
      trimestre:  periodo.trimestre,
      satelite:   reporte.satelite,
      nubosidad:  reporte.nubosidadPct,
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
