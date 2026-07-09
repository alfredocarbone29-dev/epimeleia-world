/**
 * EPIMELEIA V3.4 — Oracle Node · index.js
 * ─────────────────────────────────────────
 * Punto de entrada. Inicia todo el sistema y lo deja corriendo.
 *
 * Uso:
 *   node index.js
 *       → modo normal. El cron dispara las ventanas los días 2 y 16.
 *
 *   node index.js --test-cert
 *       → SIMULACRO. Corre una ventana completa: mide el satélite de verdad
 *         y muestra exactamente qué haría, pero NO ESCRIBE NADA en la cadena.
 *         Es el modo seguro para probar.
 *
 *   node index.js --test-cert --fecha=2026-04-02
 *       → Simulacro fingiendo otra fecha de emisión. Sirve para ver cómo se
 *         comportaría el reloj en un cierre de trimestre, sin esperar a abril.
 *
 *   node index.js --test-cert --en-serio
 *       → CORRIDA REAL fuera de horario. ESCRIBE EN POLYGON Y ES INALTERABLE.
 *         Pide confirmación tipeada antes de hacer nada.
 *
 * ══ AJUSTE 25 — El flag de prueba ya no toca la cadena ══════════
 * Antes, `--test-cert` ejecutaba una ventana real. El 9/7/2026 eso grabó
 * Huecos de Opacidad verdaderos en Polygon (activos de prueba, por suerte),
 * porque ese día caía en un cierre de trimestre. Lo escrito en la cadena no
 * se borra. Desde ahora, probar es gratis: hay que pedir explícitamente
 * escribir.
 *
 * Requiere:
 *   npm install ethers axios dotenv node-cron
 */

const readline                  = require('readline');
const { config, validarConfig } = require('./config');
const { log }                   = require('./logger');
const blockchain                = require('./blockchain');
const scheduler                 = require('./scheduler');
const reports                   = require('./reports');

// ── Lectura de flags ────────────────────────────────────────────

const ARGS = process.argv.slice(2);

function _tieneFlag(nombre) {
  return ARGS.includes(nombre);
}

/** Lee --fecha=YYYY-MM-DD. Devuelve Date (UTC) o null. */
function _fechaSimulada() {
  const arg = ARGS.find(a => a.startsWith('--fecha='));
  if (!arg) return null;
  const valor = arg.split('=')[1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    log('ERROR', `Fecha inválida: "${valor}". Usá el formato --fecha=2026-04-02`);
    process.exit(1);
  }
  const [a, m, d] = valor.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d, 6, 0, 0));
}

/** Pide confirmación tipeada antes de escribir en la cadena a mano. */
function _confirmar(pregunta) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(pregunta, r => { rl.close(); resolve(r.trim()); }));
}

// ── Ventana manual (con o sin escritura) ────────────────────────

async function _ventanaManual() {
  const fechaEmision = _fechaSimulada() || new Date();
  const enSerio      = _tieneFlag('--en-serio');
  const periodo      = scheduler.periodoDeVentana(fechaEmision);

  console.log('');
  console.log('  Fecha de emisión : ' + fechaEmision.toISOString().slice(0, 10) +
              (_fechaSimulada() ? '  (simulada)' : ''));
  console.log('  Período que mide : ' + periodo.desde.toISOString().slice(0, 10) +
              ' → ' + periodo.hasta.toISOString().slice(0, 10));
  console.log('  Trimestre        : ' + periodo.trimestre +
              '  ·  quincena ' + periodo.quincenaDelTrimestre + '/6');
  console.log('  Cierre de Q      : ' + (periodo.esCierreDeTrimestre ? 'SÍ' : 'no'));
  console.log('');

  if (!enSerio) {
    log('SYSTEM', 'Ventana de prueba en MODO SIMULACRO. La cadena no se toca.');
    log('SYSTEM', 'Si necesitás escribir de verdad, agregá --en-serio (con cuidado).');
    await scheduler.procesarVentanaSatelital({ fechaEmision, simular: true });
    return;
  }

  // ── Corrida real pedida a mano: doble confirmación ────────────
  console.log('  ⚠  ATENCIÓN: esto ESCRIBE EN POLYGON MAINNET.');
  console.log('     Lo que se graba es INALTERABLE. No se puede deshacer.');
  if (periodo.esCierreDeTrimestre) {
    console.log('     Además es CIERRE DE TRIMESTRE: se ejecuta certificarQ()');
    console.log('     y, si un activo no se pudo ver, se graba un Hueco de Opacidad.');
  }
  console.log('');

  const r = await _confirmar('  Escribí exactamente ESCRIBIR EN CADENA para continuar: ');
  if (r !== 'ESCRIBIR EN CADENA') {
    log('SYSTEM', 'Confirmación no coincide. No se escribió nada. Salgo.');
    process.exit(0);
  }

  log('SYSTEM', 'Confirmado. Ejecutando ventana REAL...');
  await scheduler.procesarVentanaSatelital({ fechaEmision, simular: false });
}

// ── Arranque ────────────────────────────────────────────────────

async function iniciar() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║           EPIMELEIA V3.4 — Oracle Node                       ║');
  console.log('║     Notario Digital de Conducta Ambiental Corporativa        ║');
  console.log('║     Primera certificación: Hidrovía Paraná-Paraguay          ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log('');

  // ── Validar configuración ────────────────────────────────────
  const erroresConfig = validarConfig();
  if (erroresConfig.length > 0) {
    erroresConfig.forEach(e => log('ERROR', `Config: ${e}`));
    log('FATAL', 'Configuración incompleta. Revisá el archivo .env');
    process.exit(1);
  }

  log('SYSTEM', `Modo: ${config.modoTest ? 'TEST (valores simbólicos)' : 'PRODUCCIÓN'}`);

  // ── Inicializar conexión blockchain ──────────────────────────
  try {
    blockchain.inicializarBlockchain();
    const info = await blockchain.getInfoRed();

    log('SYSTEM', `Red: ${info.nombre} (chainId: ${info.chainId})`);
    log('SYSTEM', `Oracle wallet: ${info.oracleAddress}`);
    log('SYSTEM', `Balance POL: ${info.balancePOL}`);
    log('SYSTEM', `Activos registrados: ${info.totalActivos}`);
    log('SYSTEM', `Trimestre actual: Q${scheduler.trimestreActual() % 10}/${Math.floor(scheduler.trimestreActual() / 10)}`);

    if (parseFloat(info.balancePOL) < 0.01 && !config.modoTest) {
      log('WARN', `Balance bajo en oracle wallet. Recargá POL para gas.`);
    }

  } catch (err) {
    log('FATAL', `Error conectando a Polygon: ${err.message}`);
    process.exit(1);
  }

  // ── Escucha de eventos en vivo: DESACTIVADA ──────────────────
  // La escucha en vivo (blockchain.escucharReportesTrimestrales / escucharAlertasSaldo)
  // mantenía filtros abiertos contra el RPC con eth_getFilterChanges. Con el correr
  // del tiempo el rango de bloques consultado superaba el límite del proveedor y
  // devolvía "invalid block range params" en bucle (miles de requests inválidas por
  // hora en Alchemy), sin aportar valor: los emails reales a clientes (recordatorios
  // de vencimiento) los maneja api/scheduler.js en Vercel leyendo Supabase, no esta
  // escucha (que apuntaba a EMAIL_ACTIVO_X / ADMIN_EMAIL, normalmente sin configurar).
  //
  // Por eso se desactiva. El oráculo conserva intactas sus funciones centrales:
  // la ventana satelital (certificación / huecos) y el healthcheck horario.
  //
  // Si en el futuro se quiere reactivar la escucha en vivo, primero hay que acotar
  // el rango de bloques de los filtros en blockchain.js para no superar el límite
  // del RPC. Mientras tanto, queda desactivada.
  //
  // scheduler.iniciarEscuchaEventos();

  // ── Ventana manual (--test-cert): simulacro salvo --en-serio ──
  if (_tieneFlag('--test-cert')) {
    log('SYSTEM', `Flag --test-cert detectado.`);
    await _ventanaManual();
    log('SYSTEM', 'Ventana manual terminada. Salgo sin dejar el oracle corriendo.');
    process.exit(0);
  }

  // ── Iniciar schedulers cron ──────────────────────────────────
  scheduler.iniciarSchedulers();

  // ── Notificar arranque al admin ──────────────────────────────
  await reports.notificarAdmin('ORACLE_INICIADO', {
    version:    '3.4',
    modoTest:   config.modoTest,
    timestamp:  new Date().toISOString(),
  });

  log('SYSTEM', `══ ORACLE EPIMELEIA V3.4 ACTIVO ══`);
  log('SYSTEM', `Ventanas quincenales (días 2 y 16) · Certificación al cierre de cada trimestre`);
  log('SYSTEM', `Healthcheck horario`);
  console.log('');
}

// ── Manejo de errores no capturados ─────────────────────────────
process.on('uncaughtException', async (err) => {
  log('FATAL', `Error no capturado: ${err.message}`);
  await reports.notificarAdmin('ORACLE_CRASH', { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  log('ERROR', `Promise rechazada: ${reason}`);
  await reports.notificarAdmin('ORACLE_REJECTION', { reason: String(reason) });
});

process.on('SIGTERM', () => {
  log('SYSTEM', 'SIGTERM recibido. Cerrando oracle ordenadamente...');
  process.exit(0);
});

// ── Arrancar ────────────────────────────────────────────────────
iniciar().catch(err => {
  log('FATAL', `Error crítico en arranque: ${err.message}`);
  process.exit(1);
});

// ── Exports para testing ────────────────────────────────────────
module.exports = { scheduler, blockchain, reports };
