/**
 * EPIMELEIA · servidor-sello.js  (la PUERTA del VPS)
 * ═════════════════════════════════════════════════════════════
 * Un servidor web mínimo que vive en el VPS, como tercer proceso PM2
 * (hermano de epimeleia-oracle y procesador-pagos, sin tocarlos).
 *
 * SU ÚNICO TRABAJO:
 *   Recibir de Vercel un pedido "sellá el activo X", verificar que el
 *   pedido es legítimo (clave secreta compartida), y disparar la misma
 *   cadena que ya probamos: alta on-chain (si es nuevo) + sello + PDF + email.
 *
 * POR QUÉ EXISTE:
 *   El sello vive acá, en el VPS, porque acá están las claves privadas
 *   de las wallets. Vercel (que sirve las páginas y el botón) NO puede
 *   sellar — no tiene las claves, ni debe tenerlas. Entonces el botón le
 *   habla a Vercel, Vercel le habla a esta puerta, y esta puerta sella.
 *
 * SEGURIDAD — TRES CANDADOS:
 *   1. Escucha en la IP pública del VPS, pero SOLO responde a pedidos
 *      que traigan la clave secreta correcta. Sin clave → "No autorizado".
 *      (No hay Nginx en este VPS; Vercel llega directo, con la clave.)
 *   2. Clave secreta compartida (SELLO_SECRET): todo pedido tiene que
 *      traerla en un header. Sin la clave correcta, se rechaza. Esa clave
 *      solo la conocen Vercel y este servidor.
 *   3. Reusa sellar-activo.js tal cual — la misma lógica probada, con su
 *      propio candado de "no sella si el satélite no vio bien el campo".
 *
 * NO TOCA:
 *   · El scheduler (epimeleia-oracle) — sigue corriendo su cron.
 *   · La cola (procesador-pagos) — intacta.
 *   · Ningún archivo del motor — solo LOS LLAMA, no los modifica.
 *
 * VARIABLES DE ENTORNO (se agregan al .env del VPS):
 *   SELLO_SECRET   una clave larga al azar (la misma que en Vercel)
 *   SELLO_PORT     puerto donde escucha (default 8790)
 *   (las demás — SUPABASE, POLYGON, wallets — ya están en el .env)
 *
 * CÓMO CORRERLO EN EL VPS (una sola vez, para darlo de alta en PM2):
 *   pm2 start servidor-sello.js --name epimeleia-sello
 *   pm2 save
 *
 * CÓMO PROBARLO desde el propio VPS (sin Vercel todavía):
 *   curl -X POST http://127.0.0.1:8790/sellar \
 *     -H "Content-Type: application/json" \
 *     -H "x-sello-secret: LA_CLAVE" \
 *     -d '{"filaId":"e63e2f1c-0e75-4772-8063-fe821d7627d3","ejecutar":false}'
 *   (ejecutar:false = simulacro, no gasta gas. true = sella de verdad.)
 * ═════════════════════════════════════════════════════════════
 */

require('dotenv').config();
const http = require('http');
const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');

const { config }     = require('./config');
const satellite      = require('./satellite');
const scheduler      = require('./scheduler');       // solo para periodoDeVentana
const blockchain     = require('./blockchain');
const activoSupabase = require('./activo-supabase');
const reports        = require('./reports');       // para disparar el email del certificado

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const PORT   = Number(process.env.SELLO_PORT) || 8790;
const SECRET = process.env.SELLO_SECRET || '';

// ── ABI mínimo del Core para el alta (igual que alta-onchain.js) ──
const CORE_ABI = [
  "function registrarActivo(string nombre, uint8 tipoActividad, uint8 nivel, int256 latitud, int256 longitud, uint256 radioKm, bytes32 emailHash) external payable returns (uint256)",
  "function emailsVerificados(bytes32 emailHash) external view returns (bool)",
  "function registrarCodigoVerificacion(bytes32 codigo, address wallet) external",
  "function verificarEmail(bytes32 codigo, bytes32 emailHash) external",
  "event ActivoRegistrado(uint256 indexed activoId, address indexed wallet, string nombre, uint8 tipo, uint8 nivel, uint256 timestamp)",
];

const L = (...a) => console.log('[servidor-sello]', ...a);

// ─────────────────────────────────────────────────────────────
//  HELPERS DE SELLADO (mismos que sellar-activo.js, ya probados)
// ─────────────────────────────────────────────────────────────

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
  const cLon = sumLon / pts.length, cLat = sumLat / pts.length;
  const R = 6371, rad = g => g * Math.PI / 180;
  let maxKm = 0;
  for (const [lon, lat] of pts) {
    const dLat = rad(lat - cLat), dLon = rad(lon - cLon);
    const h = Math.sin(dLat/2)**2 + Math.cos(rad(cLat))*Math.cos(rad(lat))*Math.sin(dLon/2)**2;
    const d = 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    if (d > maxKm) maxKm = d;
  }
  return { cLon, cLat, radioKm: Math.max(1, Math.ceil(maxKm * 1.1)) };
}
const aEntero6 = v => Math.round(Number(v) * 1e6);
function nubosidadParaContrato(n) {
  if (n === null || n === undefined || !isFinite(n)) return 100;
  const x = Math.round(n); return x < 0 ? 0 : x > 100 ? 100 : x;
}

async function medirYEvaluar(idParaLog, tipo, geometria) {
  const medicion = await satellite.medirIndicadores({ activoId: idParaLog, tipo, geometria });
  if (!medicion || medicion.sinDato)
    return { ok: false, motivo: 'El satelite no tuvo una pasada limpia sobre el campo en la ventana. Se retoma en unos dias.' };
  const nub = medicion.nubosidadPct;
  if (nub === null || nub === undefined)
    return { ok: false, motivo: 'Sin dato de calidad sobre el poligono. No se sella lo que no se midio.' };
  if (nub > config.sentinel.umbralNubosidad)
    return { ok: false, motivo: `Demasiada nube (${nub}%). Umbral ${config.sentinel.umbralNubosidad}%. Se retoma en otra pasada.` };
  return { ok: true, medicion };
}

async function darDeAltaOnChain(activo, datosAlta, email) {
  const provider       = new ethers.JsonRpcProvider(process.env.POLYGON_RPC);
  const founderWallet  = new ethers.Wallet(process.env.ORACLE_PRIVATE_KEY,   provider);
  const registroWallet = new ethers.Wallet(process.env.REGISTRO_PRIVATE_KEY, provider);
  const coreAddress    = process.env.CORE_ADDRESS;
  const coreFounder    = new ethers.Contract(coreAddress, CORE_ABI, founderWallet);
  const coreRegistro   = new ethers.Contract(coreAddress, CORE_ABI, registroWallet);

  const emailHash = ethers.keccak256(ethers.toUtf8Bytes(email.toLowerCase().trim()));
  let verificado = false;
  try { verificado = await coreFounder.emailsVerificados(emailHash); } catch { verificado = false; }
  if (!verificado) {
    const codigo = ethers.keccak256(ethers.toUtf8Bytes(`epimeleia-${email}-${Date.now()}`));
    L('emitiendo codigo de verificacion...');
    await (await coreFounder.registrarCodigoVerificacion(codigo, registroWallet.address)).wait();
    L('verificando email on-chain...');
    await (await coreRegistro.verificarEmail(codigo, emailHash)).wait();
  }
  L(`registrando "${datosAlta.nombre}"...`);
  const tx = await coreRegistro.registrarActivo(
    datosAlta.nombre, datosAlta.tipoNum, datosAlta.nivel,
    datosAlta.latE6, datosAlta.lonE6, datosAlta.radioKm, emailHash,
    { value: 1 }
  );
  const receipt = await tx.wait();
  let activoIdOnchain = null;
  for (const lg of receipt.logs) {
    try {
      const parsed = coreRegistro.interface.parseLog(lg);
      if (parsed && parsed.name === 'ActivoRegistrado') { activoIdOnchain = Number(parsed.args.activoId); break; }
    } catch {}
  }
  await supabase.from('activos').update({ activo_id_onchain: activoIdOnchain, tx_hash: tx.hash }).eq('id', activo.filaId);
  L(`alta OK · onchain=${activoIdOnchain} · tx=${tx.hash}`);
  return activoIdOnchain;
}

async function sellarEvidencia(onchainId, medicion) {
  const nub = nubosidadParaContrato(medicion.nubosidadPct);
  const periodo = scheduler.periodoDeVentana(new Date());
  const reporteParaHash = {
    activoId: onchainId, satelite: medicion.satelite,
    uuid: `POLY_${onchainId}_${medicion.fechaPasada || 'sinfecha'}`,
    nubosidadPct: nub, bandaEspectral: medicion.bandaEspectral,
    timestamp: medicion.timestamp, fuente: medicion.fuente,
  };
  const hashEvidencia = satellite.generarHashEvidencia(reporteParaHash);
  const recibo = await blockchain.registrarEvidenciaVentana({
    activoId: onchainId, trimestre: periodo.trimestre, hashEvidencia,
    satelite: medicion.satelite, nubosidadPct: nub, urlDescarga: '',
  });
  return { txHash: recibo.hash, bloque: Number(recibo.blockNumber), hashEvidencia };
}

// ── El trabajo completo: leer activo → medir → (alta) → sellar ──
async function procesarSello(filaId, ejecutar) {
  const activo = await activoSupabase.traerActivoParaCertificado(filaId);
  if (!activo.encontrado)   return { ok: false, error: activo.motivo };
  if (!activo.esPoligonoReal) return { ok: false, error: 'El activo no tiene un poligono valido.' };
  const email = activo.titular && activo.titular.email;
  if (!email) return { ok: false, error: 'El activo no tiene email de titular en Supabase.' };

  const cr = centroYRadio(activo.geometria);
  if (!cr) return { ok: false, error: 'No se pudo calcular el centro del poligono.' };

  const evaluacion = await medirYEvaluar(`FILA-${filaId}`, activo.tipo, activo.geometria);
  if (!evaluacion.ok) return { ok: false, error: evaluacion.motivo, tipo: 'medicion' };
  const m = evaluacion.medicion;

  // Simulacro: devuelve lo que sellaría, sin gastar gas.
  if (!ejecutar) {
    return {
      ok: true, simulacro: true,
      activo: activo.nombreActivo, tipo: activo.tipoTexto,
      calidad: m.calidadPct, fechaPasada: m.fechaPasada,
      mediciones: m.mediciones.map(x => ({ etiqueta: x.etiqueta, valor: x.valor, interpretacion: x.interpretacion })),
      onchain: activo.activoIdOnchain,
    };
  }

  // Ejecutar de verdad.
  blockchain.inicializarBlockchain();
  let onchainId = activo.activoIdOnchain;
  if (onchainId == null) {
    const { data: fresco } = await supabase.from('activos').select('activo_id_onchain').eq('id', activo.filaId).maybeSingle();
    if (fresco && fresco.activo_id_onchain != null) onchainId = fresco.activo_id_onchain;
    else onchainId = await darDeAltaOnChain(activo, {
      nombre: activo.nombreActivo, tipoNum: activo.tipo, nivel: 0,
      latE6: aEntero6(cr.cLat), lonE6: aEntero6(cr.cLon), radioKm: cr.radioKm,
    }, email);
    if (onchainId == null) return { ok: false, error: 'El alta no devolvio id on-chain. Revisar en Polygonscan.' };
  }
  const sello = await sellarEvidencia(onchainId, m);

  // ── DISPARAR EL EMAIL DEL CERTIFICADO ──────────────────────────────
  // Reusa reports.enviarEvidenciaQuincenal (el mismo mail del sello, con
  // hash, txHash y link a Polygonscan). Va en su PROPIO try: si el mail
  // falla, el sello YA quedó grabado y no se pierde. El destino es el email
  // del titular del activo (en Supabase).
  var emailEnviado = false;
  var emailMotivo = null;
  try {
    var emailDestino = (activo.titular && activo.titular.email) || null;
    if (emailDestino) {
      await reports.enviarEvidenciaQuincenal({
        activoId:             onchainId,
        nombreActivo:         activo.nombreActivo,
        emailDestino:         emailDestino,
        trimestre:            sello.trimestre,
        quincenaDelTrimestre: 1,
        caso:                 'sellado',
        calidadPct:           m.calidadPct,
        satelite:             m.satelite,
        fechaPasada:          m.fechaPasada,
        hashEvidencia:        sello.hashEvidencia,
        txHash:               sello.txHash,
        bloque:               sello.bloque,
        deforestacion:        activo.deforestacionHistorica || null,
      });
      emailEnviado = true;
      L('email del certificado enviado a ' + emailDestino);
    } else {
      emailMotivo = 'el activo no tiene email de titular en Supabase';
      L('sin email destino - no se envia el certificado');
    }
  } catch (errMail) {
    emailMotivo = errMail.message;
    L('el email fallo (el sello igual quedo): ' + errMail.message);
  }

  // Veredicto de deforestación (ya viene calculado en el activo, de cuando se registró).
  var def = activo.deforestacionHistorica || null;
  var deforestacionResumen = null;
  if (def && typeof def.huboDeforestacion === 'boolean') {
    deforestacionResumen = {
      hubo:            def.huboDeforestacion,
      totalHectareas:  def.totalHectareasPerdidas != null ? def.totalHectareasPerdidas : null,
      periodo:         def.periodoAnalizado || null,
    };
  }

  return {
    ok: true, sellado: true,
    activo: activo.nombreActivo, onchain: onchainId,
    huella: sello.hashEvidencia, txHash: sello.txHash, bloque: sello.bloque,
    polygonscan: `https://polygonscan.com/tx/${sello.txHash}`,
    emailEnviado: emailEnviado, emailMotivo: emailMotivo,
    deforestacion: deforestacionResumen,
  };
}

// ─────────────────────────────────────────────────────────────
//  EL SERVIDOR HTTP (mínimo, sin frameworks — http nativo)
// ─────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');

  // Solo POST /sellar
  if (req.method !== 'POST' || req.url !== '/sellar') {
    res.statusCode = 404;
    return res.end(JSON.stringify({ ok: false, error: 'Ruta no encontrada. Usá POST /sellar.' }));
  }

  // CANDADO 2: la clave secreta.
  const clave = req.headers['x-sello-secret'] || '';
  if (!SECRET || clave !== SECRET) {
    L('RECHAZADO · clave invalida o ausente');
    res.statusCode = 401;
    return res.end(JSON.stringify({ ok: false, error: 'No autorizado.' }));
  }

  // Leer el body.
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let datos;
    try { datos = JSON.parse(body || '{}'); }
    catch { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'JSON invalido.' })); }

    const filaId   = datos.filaId;
    const ejecutar = datos.ejecutar === true;   // por defecto simulacro (seguro)
    if (!filaId) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'Falta filaId.' })); }

    L(`pedido · fila=${filaId} · ejecutar=${ejecutar}`);
    try {
      const resultado = await procesarSello(filaId, ejecutar);
      res.statusCode = resultado.ok ? 200 : 422;
      res.end(JSON.stringify(resultado));
      L(`respuesta · ${resultado.ok ? (resultado.sellado ? 'SELLADO ' + resultado.txHash : 'simulacro OK') : 'rechazado: ' + resultado.error}`);
    } catch (err) {
      L('ERROR inesperado:', err.message);
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: 'Error interno: ' + err.message }));
    }
  });
});

// El servidor escucha en 0.0.0.0 (todas las interfaces) para que Vercel,
// desde afuera, pueda tocarlo. La seguridad la da la CLAVE SECRETA (candado 2):
// sin la clave correcta, todo pedido se rechaza con "No autorizado".
server.listen(PORT, '0.0.0.0', () => {
  L(`escuchando en http://0.0.0.0:${PORT}/sellar (accesible desde afuera, protegido por clave)`);
  if (!SECRET) L('⚠  ATENCION: SELLO_SECRET no esta configurada. El servidor rechaza TODO hasta configurarla en el .env.');
});
