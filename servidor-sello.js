/**
 * EPIMELEIA · servidor-sello.js  (la PUERTA del VPS)
 * (cabecera original sin cambios — ver repo)
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
const paqueteEvidencia = require('./paquete-evidencia'); // PASO D-3: hash del paquete verificable

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const PORT   = Number(process.env.SELLO_PORT) || 8790;
const SECRET = process.env.SELLO_SECRET || '';

const CORE_ABI = [
  "function registrarActivo(string nombre, uint8 tipoActividad, uint8 nivel, int256 latitud, int256 longitud, uint256 radioKm, bytes32 emailHash) external payable returns (uint256)",
  "function emailsVerificados(bytes32 emailHash) external view returns (bool)",
  "function registrarCodigoVerificacion(bytes32 codigo, address wallet) external",
  "function verificarEmail(bytes32 codigo, bytes32 emailHash) external",
  "event ActivoRegistrado(uint256 indexed activoId, address indexed wallet, string nombre, uint8 tipo, uint8 nivel, uint256 timestamp)",
];

const L = (...a) => console.log('[servidor-sello]', ...a);

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

async function sellarEvidencia(onchainId, medicion, activo) {
  const nub = nubosidadParaContrato(medicion.nubosidadPct);
  const periodo = scheduler.periodoDeVentana(new Date());

  const { paquete, canonical, hash: hashPaquete } = paqueteEvidencia.construirYSellar({
    activoIdOnchain: onchainId,
    nombreActivo:    activo.nombreActivo,
    tipoTexto:       activo.tipoTexto,
    trimestre:       periodo.trimestre,
    titularEmail:    (activo.titular && activo.titular.email) || null,
    poligono:        activo.geometria,
    medicion,
    deforestacion:   activo.deforestacionHistorica || null,
  });

  const recibo = await blockchain.registrarEvidenciaVentana({
    activoId: onchainId, trimestre: periodo.trimestre, hashEvidencia: hashPaquete,
    satelite: medicion.satelite, nubosidadPct: nub, urlDescarga: '',
  });

  try {
    await supabase.from('activos').update({
      paquete_evidencia:  canonical,
      paquete_hash:       hashPaquete,
      paquete_sellado_en: new Date().toISOString(),
    }).eq('id', activo.filaId);
    L('paquete verificable guardado en Supabase (hash ' + hashPaquete.slice(0, 12) + '…)');
  } catch (errPaq) {
    L('no se pudo guardar el paquete verificable (el sello igual quedo): ' + errPaq.message);
  }

  return {
    txHash: recibo.hash,
    bloque: Number(recibo.blockNumber),
    hashEvidencia: hashPaquete,
    hashPaquete,
    canonical,
    paquete,
    trimestre: periodo.trimestre,
  };
}

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

  if (!ejecutar) {
    return {
      ok: true, simulacro: true,
      activo: activo.nombreActivo, tipo: activo.tipoTexto,
      calidad: m.calidadPct, fechaPasada: m.fechaPasada,
      mediciones: m.mediciones.map(x => ({ etiqueta: x.etiqueta, valor: x.valor, interpretacion: x.interpretacion })),
      onchain: activo.activoIdOnchain,
    };
  }

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
  const sello = await sellarEvidencia(onchainId, m, activo);

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
        geometria:            activo.geometria || null,
        // AJUSTE 44: las mediciones (NDVI, humedad… con su interpretación
        // humana) para que el mail muestre "lo que midió el satélite", igual
        // que el simulacro. Es el mismo array que ya está en `m`. Si faltara,
        // reports.js simplemente no muestra la sección (no rompe).
        mediciones:           m.mediciones || null,
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

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST' || req.url !== '/sellar') {
    res.statusCode = 404;
    return res.end(JSON.stringify({ ok: false, error: 'Ruta no encontrada. Usá POST /sellar.' }));
  }

  const clave = req.headers['x-sello-secret'] || '';
  if (!SECRET || clave !== SECRET) {
    L('RECHAZADO · clave invalida o ausente');
    res.statusCode = 401;
    return res.end(JSON.stringify({ ok: false, error: 'No autorizado.' }));
  }

  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let datos;
    try { datos = JSON.parse(body || '{}'); }
    catch { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'JSON invalido.' })); }

    const filaId   = datos.filaId;
    const ejecutar = datos.ejecutar === true;
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

server.listen(PORT, '0.0.0.0', () => {
  L(`escuchando en http://0.0.0.0:${PORT}/sellar (accesible desde afuera, protegido por clave)`);
  if (!SECRET) L('⚠  ATENCION: SELLO_SECRET no esta configurada. El servidor rechaza TODO hasta configurarla en el .env.');
});
