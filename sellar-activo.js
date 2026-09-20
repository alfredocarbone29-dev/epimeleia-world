/**
 * EPIMELEIA · sellar-activo.js
 * ═════════════════════════════════════════════════════════════
 * EL MOTOR DEL TESTER (Fase 4 · pieza central)
 *
 * Toma UN activo por su id de fila en Supabase, y hace la cadena real,
 * sin pasar por PayPal:
 *   1. Lo lee de Supabase (nombre, polígono, tipo, titular).
 *   2. Lo MIDE de verdad contra Copernicus (Sentinel-2).
 *   3. Si la medición sirve, lo DA DE ALTA on-chain (si es nuevo).
 *   4. SELLA la evidencia en Polygon.
 *   5. Te devuelve el txHash y el bloque, verificables en Polygonscan.
 *
 * Reusa, sin tocarlas, las piezas que ya funcionan:
 *   · alta-onchain.js   -> la logica del alta (dos wallets, verificar email)
 *   · blockchain.js     -> el sello real (registrarEvidenciaVentana)
 *   · satellite.js      -> la medicion sobre el poligono
 *   · activo-supabase.js-> leer el activo real
 *   · scheduler.js      -> el reloj (que trimestre es)
 *
 * NO hace el PDF todavia -- eso es el paso siguiente (reusando tu
 * generar-pdf.js). Aca lo importante es el sello real, que es lo que
 * no puede salir mal. Primero probamos esto solo.
 *
 * ─────────────────────────────────────────────────────────────
 * SEGURIDAD (esto gasta gas real en Polygon):
 *   · Sin --ejecutar -> SIMULACRO: mide y muestra, NO gasta nada.
 *   · Procesa UN solo activo, el que vos elegis por su id.
 *   · Re-chequea que no este ya on-chain antes de darlo de alta.
 *   · Si el satelite no vio bien el campo, NO sella (no inventa).
 *
 * USO (en el VPS, ~/epimeleia-world):
 *   node sellar-activo.js               -> lista tus activos y sus ids
 *   node sellar-activo.js 12            -> SIMULACRO del activo fila 12
 *   node sellar-activo.js 12 --ejecutar -> lo sella de verdad
 * ═════════════════════════════════════════════════════════════
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');

const { config }      = require('./config');
const satellite       = require('./satellite');
const scheduler       = require('./scheduler');      // solo para el reloj (periodoDeVentana)
const blockchain      = require('./blockchain');
const activoSupabase  = require('./activo-supabase');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// El ABI minimo del Core para el alta (mismo que usa alta-onchain.js).
const CORE_ABI = [
  "function registrarActivo(string nombre, uint8 tipoActividad, uint8 nivel, int256 latitud, int256 longitud, uint256 radioKm, bytes32 emailHash) external payable returns (uint256)",
  "function emailsVerificados(bytes32 emailHash) external view returns (bool)",
  "function registrarCodigoVerificacion(bytes32 codigo, address wallet) external",
  "function verificarEmail(bytes32 codigo, bytes32 emailHash) external",
  "event ActivoRegistrado(uint256 indexed activoId, address indexed wallet, string nombre, uint8 tipo, uint8 nivel, uint256 timestamp)",
];

const args     = process.argv.slice(2);
const filaId   = args.find(a => !a.startsWith('--'));   // el id de fila que vos pasas
const EJECUTAR = args.includes('--ejecutar');
const L = (t = '') => console.log(t);

// ── Centro y radio de un poligono (igual que alta-onchain.js) ──
function centroYRadio(poligono) {
  let anillo = null;
  try {
    const p = typeof poligono === 'string' ? JSON.parse(poligono) : poligono;
    anillo = p && p.coordinates ? p.coordinates[0] : null;
  } catch { return null; }
  if (!Array.isArray(anillo) || anillo.length < 3) return null;

  let pts = anillo.slice();
  const a = pts[0], b = pts[pts.length - 1];
  if (a && b && a[0] === b[0] && a[1] === b[1]) pts = pts.slice(0, -1);

  let sumLon = 0, sumLat = 0;
  for (const [lon, lat] of pts) { sumLon += lon; sumLat += lat; }
  const cLon = sumLon / pts.length;
  const cLat = sumLat / pts.length;

  const R = 6371;
  const rad = (g) => g * Math.PI / 180;
  let maxKm = 0;
  for (const [lon, lat] of pts) {
    const dLat = rad(lat - cLat), dLon = rad(lon - cLon);
    const h = Math.sin(dLat/2)**2 + Math.cos(rad(cLat))*Math.cos(rad(lat))*Math.sin(dLon/2)**2;
    const d = 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    if (d > maxKm) maxKm = d;
  }
  const radioKm = Math.max(1, Math.ceil(maxKm * 1.1));
  return { cLon, cLat, radioKm };
}
const aEntero6 = (v) => Math.round(Number(v) * 1e6);

// ── Normaliza la nubosidad para el contrato (igual que scheduler.js) ──
function nubosidadParaContrato(n) {
  if (n === null || n === undefined || !isFinite(n)) return 100;
  const x = Math.round(n);
  return x < 0 ? 0 : x > 100 ? 100 : x;
}

// ── Mide el poligono y decide si se puede sellar (logica del scheduler) ──
async function medirYEvaluar(idParaLog, tipo, geometria) {
  const medicion = await satellite.medirIndicadores({ activoId: idParaLog, tipo, geometria });

  if (!medicion || medicion.sinDato) {
    return { ok: false, motivo: 'El satelite no tuvo una pasada limpia sobre el campo en la ventana. No es un error: es el clima. Proba de nuevo en unos dias u otro campo.' };
  }
  const nub = medicion.nubosidadPct;
  if (nub === null || nub === undefined) {
    return { ok: false, motivo: 'No hubo dato de calidad sobre el poligono. No se sella lo que no se midio.' };
  }
  if (nub > config.sentinel.umbralNubosidad) {
    return { ok: false, motivo: `Demasiada nube sobre el campo (${nub}%). El umbral es ${config.sentinel.umbralNubosidad}%. Se retoma en otra pasada.` };
  }
  return { ok: true, medicion };
}

// ── El alta on-chain (adaptado de alta-onchain.js, mismas dos wallets) ──
async function darDeAltaOnChain(activo, datosAlta, email) {
  const provider       = new ethers.JsonRpcProvider(process.env.POLYGON_RPC);
  const founderWallet  = new ethers.Wallet(process.env.ORACLE_PRIVATE_KEY,   provider);
  const registroWallet = new ethers.Wallet(process.env.REGISTRO_PRIVATE_KEY, provider);
  const coreAddress    = process.env.CORE_ADDRESS;
  const coreFounder    = new ethers.Contract(coreAddress, CORE_ABI, founderWallet);
  const coreRegistro   = new ethers.Contract(coreAddress, CORE_ABI, registroWallet);

  const emailHash = ethers.keccak256(ethers.toUtf8Bytes(email.toLowerCase().trim()));

  // Verificar el email on-chain si hace falta (el contrato lo exige).
  let verificado = false;
  try { verificado = await coreFounder.emailsVerificados(emailHash); } catch { verificado = false; }
  if (!verificado) {
    const codigo = ethers.keccak256(ethers.toUtf8Bytes(`epimeleia-${email}-${Date.now()}`));
    L('   · emitiendo codigo de verificacion...');
    await (await coreFounder.registrarCodigoVerificacion(codigo, registroWallet.address)).wait();
    L('   · verificando email on-chain...');
    await (await coreRegistro.verificarEmail(codigo, emailHash)).wait();
  } else {
    L('   · email ya verificado on-chain');
  }

  L(`   · registrando "${datosAlta.nombre}" (lat ${datosAlta.latE6}, lon ${datosAlta.lonE6}, radio ${datosAlta.radioKm}km)...`);
  // value: 1 = el fee simbolico del contrato en modo test (igual que alta-onchain.js).
  // Si esto revierte con "Fee insuficiente", el contrato salio de modo test.
  const tx = await coreRegistro.registrarActivo(
    datosAlta.nombre, datosAlta.tipoNum, datosAlta.nivel,
    datosAlta.latE6, datosAlta.lonE6, datosAlta.radioKm, emailHash,
    { value: 1 }
  );
  const receipt = await tx.wait();

  // Sacar el activoId del evento ActivoRegistrado, de forma robusta.
  let activoIdOnchain = null;
  for (const lg of receipt.logs) {
    try {
      const parsed = coreRegistro.interface.parseLog(lg);
      if (parsed && parsed.name === 'ActivoRegistrado') {
        activoIdOnchain = Number(parsed.args.activoId);
        break;
      }
    } catch { /* log de otro contrato, se ignora */ }
  }

  // Guardar el id on-chain en Supabase (lo que faltaba: atar los dos mundos).
  await supabase.from('activos')
    .update({ activo_id_onchain: activoIdOnchain, tx_hash: tx.hash })
    .eq('id', activo.filaId);

  L(`   OK alta · activo_id_onchain=${activoIdOnchain} · tx=${tx.hash}`);
  return activoIdOnchain;
}

// ── El sello de la evidencia (mismo camino que scheduler.js) ──
async function sellarEvidencia(onchainId, medicion) {
  const nub = nubosidadParaContrato(medicion.nubosidadPct);
  const periodo = scheduler.periodoDeVentana(new Date());

  const reporteParaHash = {
    activoId:       onchainId,
    satelite:       medicion.satelite,
    uuid:           `POLY_${onchainId}_${medicion.fechaPasada || 'sinfecha'}`,
    nubosidadPct:   nub,
    bandaEspectral: medicion.bandaEspectral,
    timestamp:      medicion.timestamp,
    fuente:         medicion.fuente,
  };
  const hashEvidencia = satellite.generarHashEvidencia(reporteParaHash);

  L(`   · sellando evidencia en Polygon (trimestre ${periodo.trimestre})...`);
  const recibo = await blockchain.registrarEvidenciaVentana({
    activoId:     onchainId,
    trimestre:    periodo.trimestre,
    hashEvidencia,
    satelite:     medicion.satelite,
    nubosidadPct: nub,
    urlDescarga:  '',
  });
  return { txHash: recibo.hash, bloque: recibo.blockNumber, hashEvidencia };
}

// ══════════════════ MAIN ══════════════════
(async () => {
  L('');
  L('='.repeat(60));
  L('  EPIMELEIA · sellar-activo.js -- alta + sello real');
  L('='.repeat(60));

  // Sin id: mostramos la lista de activos para que elijas.
  if (!filaId) {
    L('');
    L('  Pasa el id de fila del activo que queres sellar. Tus activos:');
    L('');
    const lista = await activoSupabase.listarActivos();
    L('  fila | nombre                         | tipo       | on-chain');
    L('  -----+--------------------------------+------------+---------');
    for (const a of lista) {
      const nom = String(a.nombre_activo || '-').slice(0,30).padEnd(30);
      const tip = String(a.tipo || '-').slice(0,10).padEnd(10);
      const oc  = a.activo_id_onchain != null ? String(a.activo_id_onchain).padStart(7) : '  nuevo';
      L(`  ${String(a.id).padStart(4)} | ${nom} | ${tip} | ${oc}`);
    }
    L('');
    L('  Despues:  node sellar-activo.js <fila>            (simulacro)');
    L('            node sellar-activo.js <fila> --ejecutar (de verdad)');
    L('');
    process.exit(0);
  }

  L(EJECUTAR ? '  MODO: EJECUTAR (gasta gas real)' : '  MODO: SIMULACRO (no gasta nada)');
  L('');

  // 1) Leer el activo real de Supabase.
  const activo = await activoSupabase.traerActivoParaCertificado(filaId);
  if (!activo.encontrado)  { L('  ERROR: ' + activo.motivo); process.exit(1); }
  if (!activo.esPoligonoReal) { L('  ERROR: El activo no tiene un poligono valido.'); process.exit(1); }

  const email = activo.titular && activo.titular.email;
  if (!email) { L('  ERROR: El activo no tiene email de titular en Supabase. No se puede dar de alta.'); process.exit(1); }

  L(`  Activo:    "${activo.nombreActivo}"  (fila ${activo.filaId})`);
  L(`  Tipo:      ${activo.tipoTexto} (codigo ${activo.tipo})`);
  L(`  Titular:   ${(activo.titular && activo.titular.nombre) || '-'} · ${email}`);
  L(`  On-chain:  ${activo.activoIdOnchain != null ? activo.activoIdOnchain : 'todavia no (campo nuevo)'}`);

  const cr = centroYRadio(activo.geometria);
  if (!cr) { L('  ERROR: No se pudo calcular el centro del poligono.'); process.exit(1); }
  L(`  Centro:    lat ${cr.cLat.toFixed(5)}, lon ${cr.cLon.toFixed(5)} · radio ${cr.radioKm} km`);
  L('');

  // 2) Medir de verdad contra el satelite.
  L('  Midiendo el campo contra Copernicus (Sentinel-2)...');
  const evaluacion = await medirYEvaluar(`FILA-${filaId}`, activo.tipo, activo.geometria);
  if (!evaluacion.ok) { L('  ERROR: ' + evaluacion.motivo); L(''); process.exit(0); }

  const m = evaluacion.medicion;
  L(`  OK Medicion · ${m.satelite} · calidad ${m.calidadPct}% · pasada del ${m.fechaPasada}`);
  for (const med of m.mediciones) {
    L(`      ${med.etiqueta}: ${med.valor}  (${med.interpretacion})`);
  }
  L('');

  // 3) Si es simulacro, mostramos y frenamos aca (sin gastar gas).
  if (!EJECUTAR) {
    L('  -- SIMULACRO --');
    L('  Esto es lo que se sellaria. No se registro ni se gasto nada.');
    L('  Si los numeros te cierran, para sellar de verdad:');
    L(`     node sellar-activo.js ${filaId} --ejecutar`);
    L('');
    process.exit(0);
  }

  // 4) Ejecutar de verdad: alta (si es nuevo) + sello.
  blockchain.inicializarBlockchain();

  let onchainId = activo.activoIdOnchain;
  if (onchainId == null) {
    // Re-chequeo por las dudas (que no se de de alta dos veces).
    const { data: fresco } = await supabase.from('activos').select('activo_id_onchain').eq('id', activo.filaId).maybeSingle();
    if (fresco && fresco.activo_id_onchain != null) {
      onchainId = fresco.activo_id_onchain;
      L(`  · ya estaba on-chain (${onchainId}), se saltea el alta.`);
    } else {
      L('  >> Dando de alta on-chain (campo nuevo)...');
      onchainId = await darDeAltaOnChain(activo, {
        nombre:  activo.nombreActivo,
        tipoNum: activo.tipo,     // ya viene como numero desde activo-supabase.js
        nivel:   0,               // L1 (Sentinel gratuito) -- todos estos son L1
        latE6:   aEntero6(cr.cLat),
        lonE6:   aEntero6(cr.cLon),
        radioKm: cr.radioKm,
      }, email);
      if (onchainId == null) { L('  ERROR: El alta no devolvio un id on-chain. Revisa la tx en Polygonscan.'); process.exit(1); }
    }
  } else {
    L(`  · el activo ya esta on-chain (${onchainId}); se sella una evidencia nueva encima.`);
  }

  L('  >> Sellando...');
  const sello = await sellarEvidencia(onchainId, m);

  L('');
  L('='.repeat(60));
  L('  LISTO -- evidencia sellada en Polygon');
  L('='.repeat(60));
  L(`  Activo on-chain:  ${onchainId}`);
  L(`  Huella:           ${sello.hashEvidencia}`);
  L(`  Transaccion:      ${sello.txHash}`);
  L(`  Bloque:           ${sello.bloque}`);
  L('');
  L(`  Verifica vos mismo:`);
  L(`     https://polygonscan.com/tx/${sello.txHash}`);
  L('');
  process.exit(0);
})().catch(e => { console.error('\n  ERROR inesperado:', e.message, '\n'); process.exit(1); });
