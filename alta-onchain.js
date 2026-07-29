/**
 * EPIMELEIA · alta-onchain.js  (Fase 7 · opción A.2)  v2
 * ═════════════════════════════════════════════════════════════
 * Registra en la blockchain los activos que YA PAGARON pero todavía no
 * están dados de alta on-chain (activo_id_onchain vacío).
 *
 * ─────────────────────────────────────────────────────────────
 * CAMBIO CLAVE v2 (verificado contra EpimeleiaCore.sol):
 * ─────────────────────────────────────────────────────────────
 * Las columnas latitud/longitud/radio_km de Supabase están VACÍAS en el
 * recorrido nuevo (el cliente dibuja un POLÍGONO, no un punto+radio). Así que
 * el centro y el radio se CALCULAN a partir del polígono (columna `poligono`,
 * GeoJSON estándar).
 *
 * ESCALA CONFIRMADA por el propio contrato:
 *   EpimeleiaCore.sol línea 85:  int256 latitud; // multiplicado x1e6
 *   línea 329: "@param latitud Latitud x1e6 (ej: -34603700 para -34.6037)"
 *   → lat/long se pasan al contrato multiplicadas por 1e6 y redondeadas.
 *
 * ORDEN GeoJSON: coordinates son pares [longitud, latitud] (NO al revés).
 *   Verificado con el polígono real de "mar de aral": [60.02.., 45.19..].
 *
 * El polígono real y su hash siguen en Supabase (la prueba de verdad). On-chain
 * va el centro+radio como "estampa de nacimiento", que es lo que el contrato
 * acepta sin tocarlo (opción A). No se modifica ningún contrato.
 *
 * ─────────────────────────────────────────────────────────────
 * SEGURIDAD (esto GASTA GAS REAL en Polygon):
 *   · Candado 1: sin --ejecutar, es DRY-RUN (muestra, no gasta).
 *   · Candado 2: procesa de a UNO salvo --todos.
 *   · Re-chequea antes de cada alta que el activo siga sin onchain.
 *   · Muestra el centro/radio calculado ANTES de registrar, para revisarlo.
 *
 * USO (en el VPS, ~/epimeleia-world):
 *   node alta-onchain.js               → DRY-RUN (muestra centro/radio, no gasta)
 *   node alta-onchain.js --ejecutar    → registra UNO
 *   node alta-onchain.js --ejecutar --todos → registra todos
 * ═════════════════════════════════════════════════════════════
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const CORE_ABI = [
  "function registrarActivo(string nombre, uint8 tipoActividad, uint8 nivel, int256 latitud, int256 longitud, uint256 radioKm, bytes32 emailHash) external payable returns (uint256)",
  "function emailsVerificados(bytes32 emailHash) external view returns (bool)",
  "function registrarCodigoVerificacion(bytes32 codigo, address wallet) external",
  "function verificarEmail(bytes32 codigo, bytes32 emailHash) external",
];

const TIPO_ACTIVIDAD = {
  MINERIA: 0, FORESTAL: 1, NAVAL: 2, INDUSTRIAL: 3, DATA_CENTER: 4,
  RESIDUOS: 5, HIDROVIA: 6, HIDRICO: 7, GLACIAR: 8, AGRICOLA: 9, OTRO: 0,
};

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const TODOS    = args.includes('--todos');
const L = (t = '') => console.log(t);

// ── Centro y radio de un polígono GeoJSON ──────────────────────
// coordinates[0] es el anillo exterior: [[lon,lat],[lon,lat],...].
// Centro = promedio de los vértices (sin contar el último, que repite el primero).
// Radio = distancia máxima del centro a cualquier vértice, en km, +10% de margen.
function centroYRadio(poligono) {
  let anillo = null;
  try {
    const p = typeof poligono === 'string' ? JSON.parse(poligono) : poligono;
    anillo = p?.coordinates?.[0];
  } catch { return null; }
  if (!Array.isArray(anillo) || anillo.length < 3) return null;

  // Quitar el vértice de cierre si repite el primero.
  let pts = anillo.slice();
  const a = pts[0], b = pts[pts.length - 1];
  if (a && b && a[0] === b[0] && a[1] === b[1]) pts = pts.slice(0, -1);

  let sumLon = 0, sumLat = 0;
  for (const [lon, lat] of pts) { sumLon += lon; sumLat += lat; }
  const cLon = sumLon / pts.length;
  const cLat = sumLat / pts.length;

  // Radio: distancia máxima centro→vértice (haversine), en km.
  const R = 6371; // km
  const rad = (g) => g * Math.PI / 180;
  let maxKm = 0;
  for (const [lon, lat] of pts) {
    const dLat = rad(lat - cLat), dLon = rad(lon - cLon);
    const h = Math.sin(dLat/2)**2 + Math.cos(rad(cLat))*Math.cos(rad(lat))*Math.sin(dLon/2)**2;
    const d = 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    if (d > maxKm) maxKm = d;
  }
  const radioKm = Math.max(1, Math.ceil(maxKm * 1.1)); // +10% de margen, mínimo 1

  return { cLon, cLat, radioKm };
}

function aEntero6(valor) {
  return Math.round(Number(valor) * 1e6);
}

async function buscarPendientes() {
  const ahora = new Date().toISOString();
  const { data, error } = await supabase
    .from('activos')
    .select('id, nombre_activo, tipo, nivel, poligono, hash_firma, cliente_id, cobertura_hasta, activo_id_onchain, suscripcion_id')
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

function calcularDatos(activo) {
  const cr = centroYRadio(activo.poligono);
  if (!cr) return null;
  return {
    nombre:  activo.nombre_activo || 'Activo EPIMELEIA',
    tipoNum: TIPO_ACTIVIDAD[String(activo.tipo || 'OTRO').toUpperCase()] ?? 0,
    nivel:   Number(activo.nivel) || 0,
    latE6:   aEntero6(cr.cLat),   // el contrato guarda lat x1e6
    lonE6:   aEntero6(cr.cLon),   // y long x1e6
    radioKm: cr.radioKm,
    cLat: cr.cLat, cLon: cr.cLon,
  };
}

async function registrarUno(activo, contexto) {
  const { coreFounder, coreRegistro, registroWallet } = contexto;

  const { data: fresco } = await supabase
    .from('activos').select('activo_id_onchain').eq('id', activo.id).maybeSingle();
  if (fresco?.activo_id_onchain) {
    L(`   ⏭  ya tiene onchain (${fresco.activo_id_onchain}), se saltea.`); return;
  }

  const datos = calcularDatos(activo);
  if (!datos) { L(`   ⚠  sin polígono válido, se saltea.`); return; }

  const email = await emailDelCliente(activo.cliente_id);
  if (!email) { L(`   ⚠  sin email de cliente, se saltea.`); return; }
  const emailHash = ethers.keccak256(ethers.toUtf8Bytes(email.toLowerCase().trim()));

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

  L(`   · registrando "${datos.nombre}" (lat ${datos.latE6}, lon ${datos.lonE6}, radio ${datos.radioKm}km)…`);
  const tx3 = await coreRegistro.registrarActivo(
    datos.nombre, datos.tipoNum, datos.nivel, datos.latE6, datos.lonE6, datos.radioKm, emailHash,
    { value: 1 }
  );
  const receipt = await tx3.wait();

  let activoId = null;
  try {
    const ev = receipt.logs?.[0];
    if (ev?.topics?.[1]) activoId = parseInt(ev.topics[1], 16);
  } catch { /* no crítico */ }

  const { error: errUpd } = await supabase
    .from('activos')
    .update({ activo_id_onchain: activoId, tx_hash: tx3.hash })
    .eq('id', activo.id);

  if (errUpd) {
    L(`   ⛔ Registrado on-chain (tx ${tx3.hash}) pero NO se guardó en Supabase: ${errUpd.message}`);
    L(`      activoId on-chain = ${activoId} — ANOTAR.`);
    return;
  }
  L(`   ✅ activo_id_onchain=${activoId}, tx=${tx3.hash}`);
}

(async () => {
  L('');
  L('═'.repeat(60));
  L('  EPIMELEIA · alta on-chain de activos pagos (Fase 7 · A.2) v2');
  L('═'.repeat(60));
  L(EJECUTAR ? '  MODO: EJECUTAR (gasta gas real)' : '  MODO: DRY-RUN (no gasta nada)');
  L('');

  let pendientes;
  try { pendientes = await buscarPendientes(); }
  catch (e) { L('  ⛔ ' + e.message); process.exit(1); }

  if (pendientes.length === 0) {
    L('  No hay activos pagos pendientes de alta on-chain.'); L(''); process.exit(0);
  }

  L(`  Activos pagos SIN alta on-chain: ${pendientes.length}`);
  L('');
  L('  Centro y radio que se calcularían de cada polígono:');
  L('  (revisá que el centro caiga donde debe estar el activo)');
  L('');
  for (const a of pendientes) {
    const d = calcularDatos(a);
    if (!d) { L(`   · ${a.nombre_activo}: ⚠ sin polígono válido`); continue; }
    L(`   · "${a.nombre_activo}"`);
    L(`       centro: lat ${d.cLat.toFixed(5)}, lon ${d.cLon.toFixed(5)}  ·  radio ${d.radioKm} km`);
    L(`       al contrato: lat ${d.latE6}, lon ${d.lonE6} (x1e6)`);
  }
  L('');

  if (!EJECUTAR) {
    L('  DRY-RUN: no se registró nada.');
    L('  Revisá que los centros caigan bien. Si está OK, para registrar:');
    L('     node alta-onchain.js --ejecutar          (uno)');
    L('     node alta-onchain.js --ejecutar --todos   (todos)');
    L('');
    process.exit(0);
  }

  const provider       = new ethers.JsonRpcProvider(process.env.POLYGON_RPC);
  const founderWallet  = new ethers.Wallet(process.env.ORACLE_PRIVATE_KEY, provider);
  const registroWallet = new ethers.Wallet(process.env.REGISTRO_PRIVATE_KEY, provider);
  const coreAddress    = process.env.CORE_ADDRESS;
  const coreFounder    = new ethers.Contract(coreAddress, CORE_ABI, founderWallet);
  const coreRegistro   = new ethers.Contract(coreAddress, CORE_ABI, registroWallet);
  const contexto = { coreFounder, coreRegistro, registroWallet };

  const aProcesar = TODOS ? pendientes : [pendientes[0]];
  L(`  Registrando ${aProcesar.length} de ${pendientes.length}…`); L('');
  for (const activo of aProcesar) {
    L(`  ▶ "${activo.nombre_activo}"`);
    try { await registrarUno(activo, contexto); }
    catch (e) { L(`   ⛔ Falló: ${e.message}`); }
    L('');
  }
  L('  Listo.'); L('');
  process.exit(0);
})();
