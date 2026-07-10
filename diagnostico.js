/**
 * EPIMELEIA — diagnostico.js
 * ──────────────────────────
 * Script de SOLO LECTURA. No escribe nada en la cadena. No gasta gas.
 *
 * Uso:
 *    node diagnostico.js
 *    node diagnostico.js 2        (para revisar el activo 2)
 *
 * Responde tres preguntas:
 *   1. ¿La wallet del oráculo es también la del founder?
 *   2. ¿Puede leer las funciones protegidas del contrato?
 *   3. ¿Qué hay grabado hoy en Polygon para ese activo?
 */

try { require('dotenv').config(); } catch (e) { /* si no hay dotenv, seguimos */ }

const bc = require('./blockchain');

const activoId = Number(process.argv[2] || 2);

function titulo(t) {
  console.log('\n' + '─'.repeat(60));
  console.log('  ' + t);
  console.log('─'.repeat(60));
}

// Traduce 20262 → "Q2 2026"
function leerTrimestre(n) {
  const anio = Math.floor(n / 10);
  const q    = n % 10;
  return `Q${q} ${anio}`;
}

async function main() {
  bc.inicializarBlockchain();

  titulo('RED');
  const red = await bc.getInfoRed();
  console.log(red);

  titulo('¿QUIÉN ES QUIÉN?');
  const diag = await bc.diagnosticoLectura(activoId);
  console.log('Wallet del oráculo :', diag.oracleWallet);
  console.log('Founder            :', diag.founder);
  console.log('¿Son la misma?     :', diag.oracleEsFounder ? 'SÍ' : 'NO');
  console.log('');
  console.log('¿Puede leer getCertificaciones()? :',
    diag.puedeLeerGetCertificaciones ? 'SÍ' : 'NO');
  if (diag.errorGetCertificaciones) {
    console.log('   Motivo:', diag.errorGetCertificaciones);
  }

  titulo(`ACTIVO ${activoId} — LO QUE HAY GRABADO EN POLYGON`);

  const total = await bc.getTotalCertificaciones(activoId);
  console.log(`Certificaciones trimestrales: ${total}`);

  const certs = await bc.getCertificaciones(activoId);
  if (certs.length === 0) {
    console.log('   (ninguna todavía)');
  } else {
    certs.forEach(c => {
      console.log(`   [${c.indice}] ${leerTrimestre(c.trimestre)}` +
                  `  (crudo: ${c.trimestre})` +
                  `  nubosidad ${c.nubosidadPct}%` +
                  `  ${c.fecha.slice(0, 10)}`);
    });
  }

  const huecos = await bc.getHuecos(activoId);
  console.log(`\nHuecos de Opacidad: ${huecos.length}`);
  huecos.forEach(h => {
    console.log(`   [${h.indice}] ${h.fecha.slice(0, 10)}` +
                `  ${h.esCausaClimatica ? 'CLIMA' : 'SEÑAL'}` +
                `  fechas grabadas: ${h.fechasGrabadas ? 'sí' : 'NO (0,0)'}` +
                `\n        causa: ${h.causa}`);
  });

  const cont = await bc.getIndiceContinuidad(activoId);
  console.log('\nÍndice de continuidad:');
  if (cont.sinHistoria) {
    console.log('   sin historia todavía (ni certificaciones ni huecos)');
  } else {
    console.log(`   ${cont.pct}%  (${cont.certificados} certificados / ${cont.conHueco} con hueco)`);
  }

  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error('\n❌ ERROR:', e.shortMessage || e.message);
    console.error(e);
    process.exit(1);
  });
