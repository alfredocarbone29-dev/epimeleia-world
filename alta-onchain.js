/**
 * EPIMELEIA · alta-onchain.js  (Fase 7 · opción A.2)
 * ═════════════════════════════════════════════════════════════
 * Registra en la blockchain los activos que YA PAGARON pero todavía no
 * están dados de alta on-chain (activo_id_onchain vacío).
 *
 * POR QUÉ ASÍ (decisión del fundador — opción A.2):
 *   El alta on-chain hace 3 transacciones en Polygon y tarda. El webhook
 *   de PayPal tiene que responder rápido. Entonces el alta NO la hace el
 *   webhook: la hace el VPS, a su ritmo, reintentando si hace falta.
 *   PayPal cobra → escribe cobertura_hasta. Este script, aparte, ve qué
 *   activo pagó y lo registra on-chain. Responsabilidades separadas.
 *
 * QUÉ ES "PAGÓ": tiene cobertura_hasta con fecha futura (lo escribió el
 *   webhook al confirmar el pago) Y todavía no tiene activo_id_onchain.
 *
 * NO TOCA LOS CONTRATOS. Usa registrarActivo(nombre, tipo, nivel, lat,
 *   long, radioKm, emailHash) tal como existe. El polígono real sigue en
 *   Supabase con su hash; on-chain va el punto+radio que YA está calculado
 *   en las columnas latitud/longitud/radio_km del activo (opción A).
 *
 * ⚠️ GASTA GAS REAL (Polygon). Por eso:
 *   · Candado 1: no corre sin el flag --ejecutar. Sin él, solo MUESTRA qué
 *     haría (dry-run), sin gastar nada.
 *   · Candado 2: procesa de a UNO por corrida por defecto (--todos para más).
 *   · Antes de cada alta, re-chequea que el activo siga sin onchain (evita
 *     duplicar si se corrió dos veces).
 *
 * CÓMO USAR (en el VPS, dentro de ~/epimeleia-world):
 *   node alta-onchain.js              → DRY-RUN: lista qué activos registraría, sin gastar
 *   node alta-onchain.js --ejecutar   → registra UNO (el más antiguo pago sin onchain)
 *   node alta-onchain.js --ejecutar --todos → registra todos los pendientes
 *
 * VARIABLES: las mismas del oráculo (.env ya las tiene):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, POLYGON_RPC, ORACLE_PRIVATE_KEY,
 *   REGISTRO_PRIVATE_KEY, CORE_ADDRESS
 * ═════════════════════════════════════════════════════════════
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── ABI mínimo del Core, solo lo que se usa acá ──
const CORE_ABI = [
  "function registrarActivo(string nombre, uint8 tipoActividad, uint8 nivel, int256 latitud, int256 longitud, uint256 radioKm, bytes32 emailHash) external payable returns (uint256)",
  "function emailsVerificados(bytes32 emailHash) external view returns (bool)",
  "function registrarCodigoVerificacion(bytes32 codigo, address wallet) external",
  "function verificarEmail(bytes32 codigo, bytes32 emailHash) external",
];

// Mapa de tipos (código → número que espera el contrato). Igual que TIPO_ACTIVIDAD
// del procesador viejo. Si el tipo no está, usa 0 (OTRO).
const TIPO_ACTIVIDAD = {
  MINERIA: 0, FORESTAL: 1, NAVAL: 2, INDUSTRIAL: 3, DATA_CENTER: 4,
  RESIDUOS: 5, HIDROVIA: 6, HIDRICO: 7, GLACIAR: 8, AGRICOLA: 9, OTRO: 0,
};

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const TODOS    = args.includes('--todos');

const L = (t = '') => console.log(t);

// ── Escala para lat/long: el contrato usa int256 con 6 decimales fijos ──
// (-34.603722 se guarda como -34603722). Es la convención del proyecto.
function aEntero6(valor) {
  if (valor === null || valor === undefined) return 0;
  return Math.round(Number(valor) * 1e6);
}

async function buscarPendientes() {
  const ahora = new Date().toISOString();
  // Activos que pagaron (cobertura futura) y no tienen onchain todavía.
  const { data, error } = await supabase
    .from('activos')
    .select('id, nombre_activo, tipo, nivel, latitud, longitud, radio_km, hash_firma, cliente_id, cobertura_hasta, activo_id_onchain, suscripcion_id')
    .is('activo_id_onchain', null)
    .not('cobertura_hasta', 'is', null)
    .gte('cobertura_hasta', ahora)
    .order('fecha_creacion', { ascending: true });

  if (error) throw new Error('Supabase: ' + error.message);
  return data || [];
}

async function emailDelCliente(clienteId) {
  if (!clienteId) return null;
  const { data } = await supabase.from('clientes').select('email').eq('id', clienteId).maybeSingle();
  return data?.email || null;
}

async function registrarUno(activo, contexto) {
  const { coreFounder, coreRegistro, registroWallet } = contexto;

  // Re-chequeo anti-duplicado: ¿sigue sin onchain?
  const { data: fresco } = await supabase
    .from('activos').select('activo_id_onchain').eq('id', activo.id).maybeSingle();
  if (fresco?.activo_id_onchain) {
    L(`   ⏭  ${activo.id} ya tiene onchain (${fresco.activo_id_onchain}), se saltea.`);
    return;
  }

  const email = await emailDelCliente(activo.cliente_id);
  if (!email) { L(`   ⚠  ${activo.id} sin email de cliente, se saltea.`); return; }

  const emailHash = ethers.keccak256(ethers.toUtf8Bytes(email.toLowerCase().trim()));

  // Paso 1-3: verificar email on-chain (si no lo está)
  let yaVerificado = false;
  try { yaVerificado = await coreFounder.emailsVerificados(emailHash); } catch { yaVerificado = false; }

  if (!yaVerificado) {
    const codigo = ethers.keccak256(ethers.toUtf8Bytes(`epimeleia-${email}-${Date.now()}`));
    L(`   · emitiendo código de verificación…`);
    const tx1 = await coreFounder.registrarCodigoVerificacion(codigo, registroWallet.address);
    await tx1.wait();
    L(`   · verificando email…`);
    const tx2 = await coreFounder.verificarEmail(codigo, emailHash);
    await tx2.wait();
  } else {
    L(`   · email ya verificado on-chain`);
  }

  // Paso 4: registrar el activo (punto+radio ya calculados en la fila)
  const nombre  = activo.nombre_activo || 'Activo EPIMELEIA';
  const tipoNum = TIPO_ACTIVIDAD[String(activo.tipo || 'OTRO').toUpperCase()] ?? 0;
  const nivel   = Number(activo.nivel) || 0;
  const lat     = aEntero6(activo.latitud);
  const lon     = aEntero6(activo.longitud);
  const radioKm = Math.max(1, Math.round(Number(activo.radio_km) || 10));

  L(`   · registrando activo "${nombre}" (tipo ${tipoNum}, lat ${lat}, lon ${lon}, radio ${radioKm}km)…`);
  const tx3 = await coreRegistro.registrarActivo(
    nombre, tipoNum, nivel, lat, lon, radioKm, emailHash,
    { value: 1 } // 1 wei de fee simbólico
  );
  const receipt = await tx3.wait();

  // Extraer el activoId del evento
  let activoId = null;
  try {
    const ev = receipt.logs?.[0];
    if (ev?.topics?.[1]) activoId = parseInt(ev.topics[1], 16);
  } catch { /* no crítico */ }

  // Guardar en Supabase
  const { error: errUpd } = await supabase
    .from('activos')
    .update({ activo_id_onchain: activoId, tx_hash: tx3.hash })
    .eq('id', activo.id);

  if (errUpd) {
    L(`   ⛔ Registrado on-chain (tx ${tx3.hash}) pero NO se pudo guardar en Supabase: ${errUpd.message}`);
    L(`      activoId on-chain = ${activoId} — ANOTAR para no perderlo.`);
    return;
  }

  L(`   ✅ ${activo.id} → activo_id_onchain=${activoId}, tx=${tx3.hash}`);
}

(async () => {
  L('');
  L('═'.repeat(60));
  L('  EPIMELEIA · alta on-chain de activos pagos (Fase 7 · A.2)');
  L('═'.repeat(60));
  L(EJECUTAR ? '  MODO: EJECUTAR (gasta gas real)' : '  MODO: DRY-RUN (no gasta nada, solo muestra)');
  L('');

  let pendientes;
  try { pendientes = await buscarPendientes(); }
  catch (e) { L('  ⛔ ' + e.message); process.exit(1); }

  if (pendientes.length === 0) {
    L('  No hay activos pagos pendientes de alta on-chain. Todo al día.');
    L('');
    process.exit(0);
  }

  L(`  Activos pagos SIN alta on-chain: ${pendientes.length}`);
  L('');
  for (const a of pendientes) {
    L(`   · ${a.id}  "${a.nombre_activo}"  cobertura hasta ${String(a.cobertura_hasta).slice(0,10)}`);
  }
  L('');

  if (!EJECUTAR) {
    L('  Esto es un DRY-RUN. No se registró nada.');
    L('  Para registrar DE VERDAD (gasta gas):');
    L('     node alta-onchain.js --ejecutar          (uno, el más antiguo)');
    L('     node alta-onchain.js --ejecutar --todos   (todos)');
    L('');
    process.exit(0);
  }

  // Preparar wallets/contratos (igual que el procesador viejo)
  const provider       = new ethers.JsonRpcProvider(process.env.POLYGON_RPC);
  const founderWallet  = new ethers.Wallet(process.env.ORACLE_PRIVATE_KEY, provider);
  const registroWallet = new ethers.Wallet(process.env.REGISTRO_PRIVATE_KEY, provider);
  const coreAddress    = process.env.CORE_ADDRESS;
  const coreFounder    = new ethers.Contract(coreAddress, CORE_ABI, founderWallet);
  const coreRegistro   = new ethers.Contract(coreAddress, CORE_ABI, registroWallet);
  const contexto = { coreFounder, coreRegistro, registroWallet };

  const aProcesar = TODOS ? pendientes : [pendientes[0]];
  L(`  Registrando ${aProcesar.length} de ${pendientes.length}…`);
  L('');

  for (const activo of aProcesar) {
    L(`  ▶ ${activo.id} "${activo.nombre_activo}"`);
    try {
      await registrarUno(activo, contexto);
    } catch (e) {
      L(`   ⛔ Falló: ${e.message}`);
    }
    L('');
  }

  L('  Listo.');
  L('');
  process.exit(0);
})();
