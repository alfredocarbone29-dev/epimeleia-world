/**
 * EPIMELEIA · fase0-radiografia.js
 * ─────────────────────────────────────────────────────────────
 * FASE 0.2 DEL PLAN — RADIOGRAFÍA ON-CHAIN.
 *
 * SOLO LEE. No escribe en la cadena. No gasta gas. No manda emails.
 * No toca Supabase. No puede romper nada. Se corre las veces que haga falta.
 *
 * Contesta, de una vez, lo que hoy estamos adivinando:
 *
 *   1. ¿Core.modoTest está en true o false?
 *      → si true: el billing corre cada 60 SEGUNDOS en mainnet.
 *        Un cliente real caería en gracia el mismo día. PUEDE
 *        REORDENAR TODO EL PLAN.
 *   2. ¿Cuánto cuesta el alta de un activo? (getRegistrationFee)
 *   3. ¿La wallet del oráculo está autorizada? (sin esto certificarQ revierte)
 *   4. ¿Los módulos están conectados entre sí? (conectarModulos)
 *   5. ¿Qué activos hay ya en la cadena? (el escombro)
 *
 * CÓMO CORRERLO (en el VPS, JUNTOS):
 *   cd /root/epimeleia-world
 *   node fase0-radiografia.js
 *
 * Después: copiar y pegar TODA la salida en el chat.
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { config }  = require('./config');

const ZERO = '0x0000000000000000000000000000000000000000';

// ── ABIs mínimos (solo lo que se lee acá) ──────────────────────

const ABI_CORE = [
  'function VERSION() external view returns (string)',
  'function founder() external view returns (address)',
  'function modoTest() external view returns (bool)',
  'function modeSuspension() external view returns (bool)',
  'function nextActivoId() external view returns (uint256)',
  'function contratoCert() external view returns (address)',
  'function contratoBilling() external view returns (address)',
  'function contratoOracle() external view returns (address)',
  'function getPeriodoBilling() external view returns (uint256)',
  'function getVentanaSatelital() external view returns (uint256)',
  'function getListaActivoIds() external view returns (uint256[])',
  'function getDatosOracle(uint256 activoId) external view returns (bool, uint8, uint8, int256, int256, uint256, address)',
];

const ABI_ORACLE  = ['function esOraculo(address addr) external view returns (bool)'];
const ABI_BILLING = ['function getRegistrationFee() external view returns (uint256)'];
const ABI_CERT    = [
  'function getTotalCertificaciones(uint256 activoId) external view returns (uint256)',
  'function trimestresCertificados(uint256 activoId) external view returns (uint256)',
  'function trimestresConHueco(uint256 activoId) external view returns (uint256)',
];

const TIPOS   = ['MINERIA','FORESTAL','NAVAL','INDUSTRIAL','DATA_CENTER','RESIDUOS','HIDROVIA','OTRO'];
const NIVELES = ['PV-L1','PV-L2','PV-L3'];

// ── Helpers ────────────────────────────────────────────────────

const L = (t = '') => console.log(t);
function titulo(t) { L(''); L('═'.repeat(60)); L('  ' + t); L('═'.repeat(60)); }
function mismo(a, b) { return a && b && a.toLowerCase() === b.toLowerCase(); }

async function leer(etiqueta, fn, fmt = String) {
  try {
    const v = await fn();
    L(`  ✓ ${etiqueta.padEnd(30)} ${fmt(v)}`);
    return v;
  } catch (e) {
    L(`  ✗ ${etiqueta.padEnd(30)} ERROR: ${e.shortMessage || e.message}`);
    return undefined;
  }
}

function periodoLegible(s) {
  const n = Number(s);
  if (n < 120) return `${n} segundos   ⚠ ¡ESTO ES MODO TEST!`;
  return `${n} segundos (${Math.round(n / 86400)} días)`;
}

// ── Diagnóstico ────────────────────────────────────────────────

(async () => {
  L('');
  L('╔════════════════════════════════════════════════════════════╗');
  L('║   EPIMELEIA · FASE 0.2 — RADIOGRAFÍA ON-CHAIN (solo lee)   ║');
  L('╚════════════════════════════════════════════════════════════╝');

  // ── Chequeos previos ────────────────────────────────────────
  const core_addr    = config.contratos.core;
  const cert_addr    = config.contratos.cert;
  const billing_addr = config.contratos.billing;
  const oracle_addr  = config.contratos.oracle;

  if (!core_addr || !config.oracle.privateKey) {
    L('');
    L('  ⛔ Falta CORE_ADDRESS o ORACLE_PRIVATE_KEY en el .env. No sigo.');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(config.red.rpc);
  const wallet   = new ethers.Wallet(config.oracle.privateKey, provider);
  const core     = new ethers.Contract(core_addr, ABI_CORE, provider);

  // ── 1) La pregunta que puede reordenar todo ─────────────────
  titulo('1 · ¿MODO TEST O PRODUCCIÓN?  (lo más importante)');

  const modoTest = await leer('Core.modoTest', () => core.modoTest(),
    v => v ? 'true    ⚠⚠⚠  EL CONTRATO ESTÁ EN MODO TEST' : 'false   ✓ producción');

  await leer('Período de billing', () => core.getPeriodoBilling(), periodoLegible);
  await leer('Ventana satelital',  () => core.getVentanaSatelital(), periodoLegible);

  if (modoTest === true) {
    L('');
    L('  ⚠ ATENCIÓN: en modo test el billing corre cada 60 segundos.');
    L('    Un cliente real caería en gracia el mismo día que paga.');
    L('    Para pasar a producción hay que llamar a setModoTest(false)');
    L('    — eso ESCRIBE en la cadena y lo hace el founder, con cuidado.');
    L('    NO se hace ahora. Solo queda anotado.');
  }

  // ── 2) Red y wallet ─────────────────────────────────────────
  titulo('2 · RED Y WALLET');

  await leer('Red (chainId)', async () => {
    const n = await provider.getNetwork();
    return `${Number(n.chainId)} ${Number(n.chainId) === 137 ? '(Polygon Mainnet ✓)' : '(⚠ NO es Polygon)'}`;
  });
  L(`  · ${'Wallet del oráculo'.padEnd(30)} ${wallet.address}`);
  await leer('Saldo POL', async () => ethers.formatEther(await provider.getBalance(wallet.address)) + ' POL');

  const founder = await leer('Founder del contrato', () => core.founder());
  if (founder) {
    L(`  ${mismo(founder, wallet.address) ? '✓ El oráculo ES el founder' : '· El oráculo NO es el founder'}`);
  }

  await leer('modeSuspension', () => core.modeSuspension(),
    v => v ? 'true    ⛔ SISTEMA SUSPENDIDO' : 'false   ✓ operativo');
  await leer('nextActivoId', () => core.nextActivoId());

  // ── 3) Fee de registro ──────────────────────────────────────
  titulo('3 · ¿CUÁNTO CUESTA EL ALTA?');
  if (billing_addr) {
    const billing = new ethers.Contract(billing_addr, ABI_BILLING, provider);
    await leer('getRegistrationFee()', () => billing.getRegistrationFee(),
      v => `${v.toString()} wei  =  ${ethers.formatEther(v)} POL`);
  } else {
    L('  · Sin BILLING_ADDRESS no se puede leer.');
  }

  // ── 4) ¿Módulos conectados? ─────────────────────────────────
  titulo('4 · ¿LOS MÓDULOS ESTÁN CONECTADOS?');
  L('  (si conectarModulos() nunca se llamó, certificarQ revierte siempre)');
  L('');

  const cCert    = await leer('Core → contratoCert',    () => core.contratoCert());
  const cBilling = await leer('Core → contratoBilling', () => core.contratoBilling());
  const cOracle  = await leer('Core → contratoOracle',  () => core.contratoOracle());

  L('');
  for (const [et, onchain, env] of [
    ['Cert coincide con .env',    cCert,    cert_addr],
    ['Billing coincide con .env', cBilling, billing_addr],
    ['Oracle coincide con .env',  cOracle,  oracle_addr],
  ]) {
    if (!onchain) continue;
    if (onchain === ZERO)          L(`  ⛔ ${et.padEnd(28)} el Core tiene 0x000 → SIN CONECTAR`);
    else if (mismo(onchain, env))  L(`  ✓ ${et.padEnd(28)} sí`);
    else                           L(`  ⚠ ${et.padEnd(28)} el .env apunta a otro contrato`);
  }

  // ── 5) ¿Oráculo autorizado? ─────────────────────────────────
  titulo('5 · ¿LA WALLET ESTÁ AUTORIZADA COMO ORÁCULO?');
  const dirOracle = (cOracle && cOracle !== ZERO) ? cOracle : oracle_addr;
  if (!dirOracle || dirOracle === ZERO) {
    L('  ⛔ No hay dirección del contrato Oracle.');
  } else {
    const oc = new ethers.Contract(dirOracle, ABI_ORACLE, provider);
    await leer('esOraculo(wallet)', () => oc.esOraculo(wallet.address),
      v => v ? 'true    ✓ AUTORIZADA — puede certificar' : 'false   ⛔ NO autorizada — certificarQ revertiría');
  }

  // ── 6) El escombro on-chain ─────────────────────────────────
  titulo('6 · ACTIVOS YA EN LA CADENA (el escombro)');

  let ids = [];
  try {
    const raw = await core.getListaActivoIds();
    ids = raw.map(Number);
  } catch (e) {
    L(`  ✗ No se pudo leer la lista: ${e.shortMessage || e.message}`);
  }

  L('');
  L(`  Total de activos en la cadena: ${ids.length}`);
  if (ids.length === 0) {
    L('  → La cadena está vacía. Nada que arrastrar.');
  }

  const cert = cert_addr ? new ethers.Contract(cert_addr, ABI_CERT, provider) : null;

  for (const id of ids) {
    L('');
    L(`  ┌─ ACTIVO #${id}`);
    try {
      const [activo, nivel, tipo, latRaw, lngRaw, radioKm, owner] = await core.getDatosOracle(id);
      L(`  │  vivo:    ${activo}`);
      L(`  │  nivel:   ${NIVELES[Number(nivel)] ?? nivel}   tipo: ${TIPOS[Number(tipo)] ?? tipo}`);
      L(`  │  PUNTO:   ${Number(latRaw) / 1e6}, ${Number(lngRaw) / 1e6}   RADIO: ${Number(radioKm)} km  ← modelo viejo`);
      L(`  │  owner:   ${owner}`);
      if (mismo(owner, wallet.address)) L(`  │           (= wallet del oráculo)`);
      if (mismo(owner, founder))        L(`  │           (= founder)`);
    } catch (e) {
      L(`  │  ✗ getDatosOracle: ${e.shortMessage || e.message}`);
    }
    if (cert) {
      try {
        const t = await cert.getTotalCertificaciones(id);
        const c = await cert.trimestresCertificados(id);
        const h = await cert.trimestresConHueco(id);
        L(`  │  certificaciones: ${Number(t)}   ·   trim. cert: ${Number(c)}   hueco: ${Number(h)}`);
      } catch (e) {
        L(`  │  ✗ lectura Cert: ${e.shortMessage || e.message}`);
      }
    }
    L(`  └─`);
  }

  // ── Cierre ──────────────────────────────────────────────────
  titulo('FIN — no se escribió nada. Copiá TODA la salida al chat.');
  L('');
  process.exit(0);
})().catch(e => {
  console.error('\n⛔ Se cortó por un error inesperado:');
  console.error('   ' + (e.shortMessage || e.message));
  console.error('   Pegá esto igual en el chat — el error también dice algo.\n');
  process.exit(1);
});
