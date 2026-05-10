/**
 * EPIMELEIA V3.1 — Oracle Connection Script
 * Node.js — Vincula oráculos IoT/Satelital con el contrato Polygon
 * 
 * Requiere:
 *   npm install ethers axios dotenv node-cron
 * 
 * .env:
 *   ORACLE_PRIVATE_KEY=0x...
 *   CONTRACT_ADDRESS=0x22E13Cfaef053441d4eA87f5b5C1df30ff42e676
 *   POLYGON_RPC=https://polygon-rpc.com
 *   SENTINEL_API_KEY=...
 *   WEBHOOK_URL=https://...   (notificaciones admin)
 */

require('dotenv').config();
const { ethers } = require('ethers');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');

// ─── ABI MÍNIMO ──────────────────────────────────────────
const ABI = [
  "function certificarQ(address wallet, bytes32 hashEvidencia, string metadataURI, uint256 trimestre) external",
  "function registrarHuecoOpacidad(address wallet, uint256 diaInicio, uint256 diaFin, string causa) external",
  "function incrementarContinuidad(address wallet) external",
  "function getEmpresaInfo(address wallet) external view returns (bool, uint8, uint256, uint256, uint8, uint256)",
  "function getTotalEmpresas() external view returns (uint256)",
  "function listaEmpresas(uint256) external view returns (address)",
  "event CertificacionRealizada(address indexed wallet, bytes32 hashEvidencia, uint256 trimestre, uint256 timestamp)",
  "event HuecoOpacidadRegistrado(address indexed wallet, uint256 dia, string causa, uint256 timestamp)",
];

// ─── PROVIDER + SIGNER ───────────────────────────────────
const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC || 'https://polygon-rpc.com');
const oracleWallet = new ethers.Wallet(process.env.ORACLE_PRIVATE_KEY, provider);
const contrato = new ethers.Contract(process.env.CONTRACT_ADDRESS, ABI, oracleWallet);

// ─── LOG TÉCNICO ─────────────────────────────────────────
function log(tipo, msg, data = {}) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${tipo}] ${msg}`, Object.keys(data).length ? JSON.stringify(data) : '');
}

// ─── WEBHOOK ADMIN ───────────────────────────────────────
async function notificarAdmin(evento, datos) {
  if (!process.env.WEBHOOK_URL) return;
  try {
    await axios.post(process.env.WEBHOOK_URL, {
      evento,
      datos,
      timestamp: new Date().toISOString(),
      red: 'POLYGON_MAINNET'
    });
    log('WEBHOOK', `Notificación enviada: ${evento}`);
  } catch (err) {
    log('ERROR', `Webhook fallido: ${err.message}`);
  }
}

// ─── PV-L1: SENTINEL/COPERNICUS (SEMANAL) ────────────────
async function validacionL1_Sentinel(wallet) {
  log('PV-L1', `Iniciando validación satelital · ${wallet}`);
  try {
    // Copernicus Open Access Hub API
    const bbox = await obtenerCoordenadasEmpresa(wallet);
    const url = `https://scihub.copernicus.eu/dhus/search?q=footprint:"Intersects(${bbox})"&rows=1&format=json`;
    
    const resp = await axios.get(url, {
      auth: { username: 'epimeleia_oracle', password: process.env.SENTINEL_API_KEY },
      timeout: 15000
    });

    const entries = resp.data?.feed?.entry || [];
    if (entries.length === 0) {
      log('PV-L1', `Sin datos satelitales · ${wallet}`);
      return null;
    }

    const imagen = entries[0];
    const reporte = {
      wallet,
      nivel: 'PV-L1',
      tipo: 'SENTINEL_MACRO',
      timestamp: new Date().toISOString(),
      satelite: imagen.title || 'Sentinel-2',
      coordenadas: bbox,
      cloudCover: imagen['cloudcoverpercentage'] || 'N/A',
      uuid: imagen.id
    };

    log('PV-L1', `Imagen satelital obtenida`, { uuid: imagen.id });
    return reporte;

  } catch (err) {
    log('ERROR', `PV-L1 Sentinel fallido: ${err.message}`);
    await modoSuspensionCheck(err);
    return null;
  }
}

// ─── PV-L2: IoT + SATÉLITE (DIARIO) ──────────────────────
async function validacionL2_IoT(wallet, sensorEndpoint) {
  log('PV-L2', `Iniciando validación híbrida IoT+Sat · ${wallet}`);
  try {
    // Lectura sensor IoT
    const iotData = await axios.get(sensorEndpoint, { timeout: 10000 });
    
    const reporte = {
      wallet,
      nivel: 'PV-L2',
      tipo: 'IOT_HYBRID',
      timestamp: new Date().toISOString(),
      consumoAgua_m3: iotData.data?.water_m3 || 0,
      consumoEnergia_kWh: iotData.data?.energy_kwh || 0,
      temperatura: iotData.data?.temp_c || null,
      coordenadas: iotData.data?.gps || null,
      sensor_id: iotData.data?.sensor_id || 'unknown',
      firma_sensor: iotData.data?.signature || null
    };

    // Verificar firma del sensor
    if (!reporte.firma_sensor) {
      log('WARN', `Sensor sin firma criptográfica · ${wallet}`);
      await registrarHueco(wallet, 'IOT_INTERRUPTION');
      return null;
    }

    log('PV-L2', `Datos IoT recibidos`, { 
      agua: reporte.consumoAgua_m3, 
      energia: reporte.consumoEnergia_kWh 
    });
    return reporte;

  } catch (err) {
    log('ERROR', `PV-L2 IoT fallido: ${err.message}`);
    // Interrupción → Hueco de Opacidad
    await registrarHueco(wallet, err.code === 'ECONNREFUSED' ? 'HUMAN_CAUSE' : 'SATELLITE_LOSS');
    return null;
  }
}

// ─── PV-L3: TIEMPO REAL BLOQUE A BLOQUE ──────────────────
async function validacionL3_RealTime(wallet, sensors) {
  log('PV-L3', `Validación tiempo real · ${wallet}`);
  
  const lecturas = await Promise.allSettled(
    sensors.map(s => axios.get(s.endpoint, { timeout: 5000 }))
  );

  const validas = lecturas.filter(r => r.status === 'fulfilled');
  const fallidas = lecturas.filter(r => r.status === 'rejected');

  if (fallidas.length > 0) {
    log('WARN', `${fallidas.length} sensores sin respuesta · ${wallet}`);
    if (fallidas.length === lecturas.length) {
      await registrarHueco(wallet, 'HUMAN_CAUSE');
      return null;
    }
  }

  const reporte = {
    wallet,
    nivel: 'PV-L3',
    tipo: 'REALTIME_REDUNDANT',
    timestamp: new Date().toISOString(),
    sensoresActivos: validas.length,
    sensoresTotal: sensors.length,
    datos: validas.map(r => r.value.data),
    bloque: await provider.getBlockNumber()
  };

  log('PV-L3', `Validación redundante OK`, { 
    activos: validas.length, 
    total: sensors.length 
  });
  return reporte;
}

// ─── CERTIFICAR EN BLOCKCHAIN ────────────────────────────
async function certificarEnChain(reporte, trimestre) {
  if (!reporte) return;

  const reporteStr = JSON.stringify(reporte);
  const hashEvidencia = ethers.keccak256(ethers.toUtf8Bytes(reporteStr));
  
  // En producción: subir reporte a IPFS y usar el CID
  const metadataURI = `ipfs://QmPlaceholder_${reporte.wallet.slice(2,8)}_Q${trimestre}`;

  log('CERT', `Enviando certificación a Polygon · Q${trimestre} · ${reporte.wallet}`);

  try {
    const tx = await contrato.certificarQ(
      reporte.wallet,
      hashEvidencia,
      metadataURI,
      trimestre,
      { gasLimit: 300000 }
    );

    const receipt = await tx.wait();
    
    log('CERT', `CertificaciónQ confirmada`, { 
      hash: receipt.hash, 
      bloque: receipt.blockNumber,
      wallet: reporte.wallet
    });

    await notificarAdmin('CERT_CONFIRMADA', {
      wallet: reporte.wallet,
      txHash: receipt.hash,
      bloque: receipt.blockNumber,
      trimestre,
      nivel: reporte.nivel
    });

    return receipt;

  } catch (err) {
    log('ERROR', `Certificación fallida: ${err.message}`);
    await notificarAdmin('CERT_ERROR', { wallet: reporte.wallet, error: err.message });
    throw err;
  }
}

// ─── REGISTRAR HUECO DE OPACIDAD ─────────────────────────
async function registrarHueco(wallet, causa) {
  const diaActual = Math.floor((Date.now() / 1000 - 86400) / 86400);
  
  log('GAP', `Registrando Hueco de Opacidad · ${wallet} · ${causa}`);

  try {
    const tx = await contrato.registrarHuecoOpacidad(
      wallet,
      diaActual,
      diaActual,
      causa,
      { gasLimit: 200000 }
    );
    await tx.wait();
    
    log('GAP', `Hueco registrado en Polygon · imborrable`, { wallet, causa });
    
    await notificarAdmin('HUECO_OPACIDAD', { 
      wallet, 
      dia: diaActual, 
      causa,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    log('ERROR', `Registro hueco fallido: ${err.message}`);
  }
}

// ─── MODO SUSPENSIÓN — Fuerza Mayor ──────────────────────
async function modoSuspensionCheck(err) {
  const esFuerzaMayor = [
    'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'SATELLITE_UNAVAILABLE'
  ].some(code => err.code === code || err.message?.includes(code));

  if (esFuerzaMayor) {
    log('SUSPEND', 'Fuerza Mayor detectada — notificando admin');
    await notificarAdmin('MODO_SUSPENSION_ACTIVADO', {
      causa: err.message,
      timestamp: new Date().toISOString()
    });
  }
}

// ─── CONTINUIDAD DIARIA ───────────────────────────────────
async function actualizarContinuidad() {
  log('SYSTEM', 'Actualizando contadores de continuidad...');
  try {
    const total = await contrato.getTotalEmpresas();
    for (let i = 0; i < Number(total); i++) {
      const wallet = await contrato.listaEmpresas(i);
      const info = await contrato.getEmpresaInfo(wallet);
      if (info[0]) { // activa
        const tx = await contrato.incrementarContinuidad(wallet, { gasLimit: 80000 });
        await tx.wait();
        log('SYSTEM', `Continuidad +1 · ${wallet}`);
      }
    }
  } catch (err) {
    log('ERROR', `Continuidad fallida: ${err.message}`);
  }
}

// ─── PLACEHOLDER COORDS ──────────────────────────────────
async function obtenerCoordenadasEmpresa(wallet) {
  // En producción: leer de base de datos privada cifrada
  return 'POLYGON((-58.5 -34.5,-58.2 -34.5,-58.2 -34.7,-58.5 -34.7,-58.5 -34.5))';
}

// ─── SCHEDULER ───────────────────────────────────────────

// Continuidad: cada día a medianoche
cron.schedule('0 0 * * *', () => {
  log('CRON', 'Job diario — continuidad');
  actualizarContinuidad();
});

// PV-L2: cada día a las 06:00
cron.schedule('0 6 * * *', () => {
  log('CRON', 'Job diario — validación PV-L2');
  // En producción: iterar empresas L2 con sus endpoints IoT
  // validacionL2_IoT(wallet, sensorEndpoint).then(r => certificarEnChain(r, trimestre));
});

// PV-L1: cada lunes a las 08:00
cron.schedule('0 8 * * 1', () => {
  log('CRON', 'Job semanal — validación PV-L1 Sentinel');
  // validacionL1_Sentinel(wallet).then(r => certificarEnChain(r, trimestre));
});

// ─── INICIAR ─────────────────────────────────────────────
async function iniciar() {
  log('SYSTEM', '══ EPIMELEIA ORACLE NODE INICIANDO ══');
  
  const network = await provider.getNetwork();
  log('SYSTEM', `Red conectada: ${network.name} (chainId: ${network.chainId})`);
  
  const balance = await provider.getBalance(oracleWallet.address);
  log('SYSTEM', `Oracle wallet: ${oracleWallet.address}`);
  log('SYSTEM', `Balance MATIC: ${ethers.formatEther(balance)}`);
  log('SYSTEM', `Contrato: ${process.env.CONTRACT_ADDRESS}`);
  log('SYSTEM', '══ ORACLE ACTIVO — Escuchando... ══');
}

iniciar().catch(err => {
  log('FATAL', `Error crítico al iniciar: ${err.message}`);
  process.exit(1);
});

// ─── EXPORTS (para testing) ───────────────────────────────
module.exports = {
  validacionL1_Sentinel,
  validacionL2_IoT,
  validacionL3_RealTime,
  certificarEnChain,
  registrarHueco,
  actualizarContinuidad
};
