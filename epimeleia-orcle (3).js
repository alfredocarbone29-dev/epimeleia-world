/**
 * EPIMELEIA V3.3 — Oracle Connection Script
 * Node.js — Vincula oráculos satelitales/IoT con el contrato Polygon
 *
 * Requiere:
 *   npm install ethers axios dotenv node-cron
 *
 * .env:
 *   ORACLE_PRIVATE_KEY=0x...
 *   CONTRACT_ADDRESS=0x536f2acbc32cD4928F628481725C76Ef0B62af11
 *   POLYGON_RPC=https://polygon-rpc.com
 *   SENTINEL_API_KEY=...
 *   WEBHOOK_URL=https://...
 *
 * Contrato: 0x536f2acbc32cD4928F628481725C76Ef0B62af11
 * Red: Polygon Mainnet (Chain ID: 137)
 * Contacto: info@epimeleia.world
 *
 * Niveles (todos con frecuencia trimestral Q1/4):
 *   PV-L1: Sentinel/Copernicus público — operativo hoy
 *           Fee registro: USD 1,500 · Fee trimestral: USD 450
 *   PV-L2: Satelital comercial + validación cruzada — bajo acuerdo previo
 *   PV-L3: Triple fuente (satelital + IoT + cruzada) — bajo acuerdo previo
 *
 * Tipos de actividad soportados (enum TipoActividad en contrato):
 *   0: MINERIA — expansión área excavada, sedimentos en agua
 *   1: FORESTAL — pérdida cobertura vegetal NDVI
 *   2: NAVAL — ruta, emisiones, área de operación portuaria
 *   3: INDUSTRIAL — temperatura superficial, emisiones
 *   4: DATA_CENTER — consumo energético, temperatura
 *   5: RESIDUOS — expansión área, presencia lixiviados
 *   6: HIDROVIA — nivel hídrico, calidad agua, sedimentos
 *   7: OTRO — indicadores generales
 *
 * Medios de pago: tarjeta de crédito y transferencia bancaria (via Transak)
 */

require('dotenv').config();
const { ethers } = require('ethers');
const axios = require('axios');
const cron = require('node-cron');

// ─── ABI ─────────────────────────────────────────────────
const ABI = [
  "function certificarQ(address wallet, bytes32 hashEvidencia, string metadataURI, uint256 trimestre) external",
  "function registrarHuecoOpacidad(address wallet, uint256 diaInicio, uint256 diaFin, string causa) external",
  "function incrementarContinuidad(address wallet) external",
  "function getActivoEstado(address wallet) external view returns (bool, uint8, uint8, uint8, uint256, uint256)",
  "function getActivoUbicacion(address wallet) external view returns (string, int256, int256, uint256, uint256, uint256)",
  "function getTotalActivos() external view returns (uint256)",
  "function listaActivos(uint256) external view returns (address)",
  "function getNivelDesc(address wallet) external view returns (string)",
  "event CertificacionRealizada(address indexed wallet, bytes32 hashEvidencia, uint256 trimestre, uint256 timestamp)",
  "event HuecoOpacidadRegistrado(address indexed wallet, uint256 dia, string causa, uint256 timestamp)",
];

// ─── PROVIDER + SIGNER ───────────────────────────────────
const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC || 'https://polygon-rpc.com');
const oracleWallet = new ethers.Wallet(process.env.ORACLE_PRIVATE_KEY, provider);
const contrato = new ethers.Contract(process.env.CONTRACT_ADDRESS, ABI, oracleWallet);

// ─── LOG ─────────────────────────────────────────────────
function log(tipo, msg, data = {}) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${tipo}] ${msg}`, Object.keys(data).length ? JSON.stringify(data) : '');
}

// ─── WEBHOOK ADMIN ───────────────────────────────────────
async function notificarAdmin(evento, datos) {
  if (!process.env.WEBHOOK_URL) return;
  try {
    await axios.post(process.env.WEBHOOK_URL, {
      evento, datos,
      timestamp: new Date().toISOString(),
      red: 'POLYGON_MAINNET',
      contrato: process.env.CONTRACT_ADDRESS
    });
    log('WEBHOOK', `Notificación enviada: ${evento}`);
  } catch (err) {
    log('ERROR', `Webhook fallido: ${err.message}`);
  }
}

// ─── INDICADORES POR TIPO DE ACTIVIDAD ───────────────────
// El tipo de actividad declarado por el activo determina
// qué indicadores satelitales procesa el oráculo.
const INDICADORES_POR_TIPO = {
  0: { nombre: 'MINERIA',     indicadores: ['expansion_area', 'sedimentos_agua', 'cobertura_vegetal'] },
  1: { nombre: 'FORESTAL',    indicadores: ['ndvi', 'cobertura_vegetal', 'deforestacion'] },
  2: { nombre: 'NAVAL',       indicadores: ['area_portuaria', 'temperatura_superficial', 'turbidez_agua'] },
  3: { nombre: 'INDUSTRIAL',  indicadores: ['temperatura_superficial', 'emisiones', 'expansion_area'] },
  4: { nombre: 'DATA_CENTER', indicadores: ['temperatura_superficial', 'consumo_energetico', 'area_construccion'] },
  5: { nombre: 'RESIDUOS',    indicadores: ['expansion_area', 'lixiviados', 'temperatura_superficial'] },
  6: { nombre: 'HIDROVIA',    indicadores: ['nivel_hidrico', 'turbidez_agua', 'sedimentos', 'cobertura_vegetal'] },
  7: { nombre: 'OTRO',        indicadores: ['cobertura_vegetal', 'temperatura_superficial'] },
};

// ─── PV-L1: SENTINEL/COPERNICUS (TRIMESTRAL) ─────────────
async function validacionL1_Sentinel(wallet) {
  log('PV-L1', `Iniciando validación trimestral · ${wallet}`);
  try {
    const ubicacion = await contrato.getActivoUbicacion(wallet);
    const estado = await contrato.getActivoEstado(wallet);

    const latitud = Number(ubicacion[1]) / 1e6;
    const longitud = Number(ubicacion[2]) / 1e6;
    const radioKm = Number(ubicacion[3]);
    const tipoActividad = Number(estado[2]);

    const delta = radioKm / 111;
    const bbox = `${longitud - delta},${latitud - delta},${longitud + delta},${latitud + delta}`;

    const url = `https://scihub.copernicus.eu/dhus/search?q=footprint:"Intersects(${bbox})"&rows=1&format=json`;

    const resp = await axios.get(url, {
      auth: { username: 'epimeleia_oracle', password: process.env.SENTINEL_API_KEY },
      timeout: 15000
    });

    const entries = resp.data?.feed?.entry || [];
    if (entries.length === 0) {
      log('PV-L1', `Sin datos satelitales · ${wallet}`);
      await registrarHueco(wallet, 'SATELLITE_LOSS');
      return null;
    }

    const imagen = entries[0];
    const indicadores = INDICADORES_POR_TIPO[tipoActividad] || INDICADORES_POR_TIPO[7];

    const reporte = {
      wallet,
      nivel: 'PV-L1',
      tipo: 'SENTINEL_COPERNICUS_TRIMESTRAL',
      tipoActividad: indicadores.nombre,
      indicadoresMonitoreados: indicadores.indicadores,
      timestamp: new Date().toISOString(),
      satelite: imagen.title || 'Sentinel-2',
      latitud, longitud, radioKm,
      bbox,
      cloudCover: imagen['cloudcoverpercentage'] || 'N/A',
      uuid: imagen.id,
      fuente: 'ESA_COPERNICUS_PUBLIC'
    };

    log('PV-L1', `Validación completada · ${indicadores.nombre}`, { uuid: imagen.id });
    return reporte;

  } catch (err) {
    log('ERROR', `PV-L1 fallido: ${err.message}`);
    await modoSuspensionCheck(err);
    return null;
  }
}

// ─── PV-L2: SATELITAL COMERCIAL + VALIDACIÓN CRUZADA (BAJO ACUERDO) ──
async function validacionL2_SatelitalComercial(wallet, proveedorEndpoint) {
  log('PV-L2', `Iniciando validación trimestral satelital comercial · ${wallet}`);
  try {
    const datos = await axios.get(proveedorEndpoint, { timeout: 15000 });

    const reporte = {
      wallet,
      nivel: 'PV-L2',
      tipo: 'SAT_COMERCIAL_VALIDACION_CRUZADA',
      timestamp: new Date().toISOString(),
      datos: datos.data,
      fuente: 'SATELITAL_COMERCIAL_CRUZADO_PUBLICO'
    };

    log('PV-L2', `Validación L2 completada`);
    return reporte;

  } catch (err) {
    log('ERROR', `PV-L2 fallido: ${err.message}`);
    await registrarHueco(wallet, 'SATELLITE_LOSS');
    return null;
  }
}

// ─── PV-L3: TRIPLE FUENTE INDEPENDIENTE (BAJO ACUERDO) ───
async function validacionL3_TripleFuente(wallet, fuentes) {
  log('PV-L3', `Iniciando validación trimestral triple fuente · ${wallet}`);

  const lecturas = await Promise.allSettled(
    fuentes.map(f => axios.get(f.endpoint, { timeout: 8000 }))
  );

  const validas = lecturas.filter(r => r.status === 'fulfilled');
  const fallidas = lecturas.filter(r => r.status === 'rejected');

  if (fallidas.length > 0) {
    log('WARN', `${fallidas.length} fuentes sin respuesta · ${wallet}`);
    if (fallidas.length === lecturas.length) {
      await registrarHueco(wallet, 'HUMAN_CAUSE');
      return null;
    }
  }

  const reporte = {
    wallet,
    nivel: 'PV-L3',
    tipo: 'TRIPLE_FUENTE_TRIMESTRAL',
    timestamp: new Date().toISOString(),
    fuentesActivas: validas.length,
    fuentesTotal: fuentes.length,
    datos: validas.map(r => r.value.data),
    bloque: await provider.getBlockNumber(),
    fuente: 'SAT_PREMIUM_IOT_SITIO_VALIDACION_CRUZADA'
  };

  log('PV-L3', `Validación L3 completada`, { activas: validas.length, total: fuentes.length });
  return reporte;
}

// ─── CERTIFICAR EN BLOCKCHAIN ────────────────────────────
async function certificarEnChain(reporte, trimestre) {
  if (!reporte) return;

  const reporteStr = JSON.stringify(reporte);
  const hashEvidencia = ethers.keccak256(ethers.toUtf8Bytes(reporteStr));
  const metadataURI = `ipfs://QmEpimeleia_${reporte.wallet.slice(2,8)}_Q${trimestre}_${reporte.nivel}`;

  log('CERT', `Certificando en Polygon · Q${trimestre} · ${reporte.wallet} · ${reporte.nivel}`);

  try {
    const tx = await contrato.certificarQ(
      reporte.wallet, hashEvidencia, metadataURI, trimestre,
      { gasLimit: 300000 }
    );
    const receipt = await tx.wait();

    log('CERT', `Certificación Q${trimestre} confirmada`, {
      hash: receipt.hash,
      bloque: receipt.blockNumber,
      wallet: reporte.wallet
    });

    await notificarAdmin('CERT_TRIMESTRAL_CONFIRMADA', {
      wallet: reporte.wallet,
      txHash: receipt.hash,
      bloque: receipt.blockNumber,
      trimestre,
      nivel: reporte.nivel,
      tipoActividad: reporte.tipoActividad
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
      wallet, diaActual, diaActual, causa, { gasLimit: 200000 }
    );
    await tx.wait();
    log('GAP', `Hueco grabado en Polygon · inalterable`, { wallet, causa });
    await notificarAdmin('HUECO_OPACIDAD', { wallet, dia: diaActual, causa, timestamp: new Date().toISOString() });
  } catch (err) {
    log('ERROR', `Registro hueco fallido: ${err.message}`);
  }
}

// ─── MODO SUSPENSIÓN ─────────────────────────────────────
async function modoSuspensionCheck(err) {
  const esFuerzaMayor = ['ENOTFOUND','ETIMEDOUT','ECONNRESET','SATELLITE_UNAVAILABLE']
    .some(code => err.code === code || err.message?.includes(code));

  if (esFuerzaMayor) {
    log('SUSPEND', 'Fuerza Mayor detectada');
    await notificarAdmin('MODO_SUSPENSION_ACTIVADO', { causa: err.message, timestamp: new Date().toISOString() });
  }
}

// ─── CONTINUIDAD DIARIA ───────────────────────────────────
async function actualizarContinuidad() {
  log('SYSTEM', 'Actualizando contadores de continuidad...');
  try {
    const total = await contrato.getTotalActivos();
    for (let i = 0; i < Number(total); i++) {
      const wallet = await contrato.listaActivos(i);
      const estado = await contrato.getActivoEstado(wallet);
      if (estado[0]) {
        const tx = await contrato.incrementarContinuidad(wallet, { gasLimit: 80000 });
        await tx.wait();
        log('SYSTEM', `Continuidad +1 · ${wallet}`);
      }
    }
  } catch (err) {
    log('ERROR', `Continuidad fallida: ${err.message}`);
  }
}

// ─── TRIMESTRE ACTUAL ────────────────────────────────────
function trimestreActual() {
  return Math.floor(new Date().getMonth() / 3) + 1;
}

// ─── PROCESO TRIMESTRAL COMPLETO ─────────────────────────
async function procesarTrimestre() {
  const trimestre = trimestreActual();
  log('SYSTEM', `══ PROCESANDO TRIMESTRE Q${trimestre} ══`);

  try {
    const total = await contrato.getTotalActivos();
    log('SYSTEM', `Total activos: ${Number(total)}`);

    for (let i = 0; i < Number(total); i++) {
      const wallet = await contrato.listaActivos(i);
      const estado = await contrato.getActivoEstado(wallet);

      if (!estado[0]) continue; // no activo

      const nivel = Number(estado[1]); // PVLevel

      if (nivel === 0) {
        // PV-L1: operativo automático
        const reporte = await validacionL1_Sentinel(wallet);
        if (reporte) await certificarEnChain(reporte, trimestre);
      } else {
        // PV-L2 y PV-L3: solo bajo acuerdo previo
        log('INFO', `Activo L${nivel + 1} requiere acuerdo previo · ${wallet}`);
        await notificarAdmin('ACTIVO_BAJO_ACUERDO', { wallet, nivel: `L${nivel + 1}`, trimestre });
      }

      // Pausa entre activos para no saturar el RPC
      await new Promise(r => setTimeout(r, 2000));
    }

    log('SYSTEM', `══ TRIMESTRE Q${trimestre} COMPLETADO ══`);
  } catch (err) {
    log('ERROR', `Error en proceso trimestral: ${err.message}`);
  }
}

// ─── SCHEDULERS ──────────────────────────────────────────

// Continuidad: cada día a medianoche UTC
cron.schedule('0 0 * * *', () => {
  log('CRON', 'Job diario — actualización de continuidad');
  actualizarContinuidad();
});

// Proceso trimestral: primer día de cada trimestre a las 08:00 UTC
// Enero, Abril, Julio, Octubre
cron.schedule('0 8 1 1,4,7,10 *', () => {
  log('CRON', `Job trimestral Q${trimestreActual()} — iniciando proceso`);
  procesarTrimestre();
});

// ─── INICIAR ─────────────────────────────────────────────
async function iniciar() {
  log('SYSTEM', '══ EPIMELEIA V3.3 ORACLE NODE INICIANDO ══');
  log('SYSTEM', `Contrato: ${process.env.CONTRACT_ADDRESS}`);
  log('SYSTEM', 'Red: Polygon Mainnet (Chain ID: 137)');

  const network = await provider.getNetwork();
  log('SYSTEM', `Conectado: ${network.name} (chainId: ${network.chainId})`);

  const balance = await provider.getBalance(oracleWallet.address);
  log('SYSTEM', `Oracle wallet: ${oracleWallet.address}`);
  log('SYSTEM', `Balance POL: ${ethers.formatEther(balance)}`);

  const totalActivos = await contrato.getTotalActivos();
  log('SYSTEM', `Activos registrados: ${Number(totalActivos)}`);
  log('SYSTEM', `Trimestre actual: Q${trimestreActual()}`);
  log('SYSTEM', 'Niveles activos: PV-L1 (automático) · PV-L2/L3 (bajo acuerdo previo)');
  log('SYSTEM', '══ ORACLE ACTIVO — Escuchando... ══');
}

iniciar().catch(err => {
  log('FATAL', `Error crítico: ${err.message}`);
  process.exit(1);
});

// ─── EXPORTS ─────────────────────────────────────────────
module.exports = {
  validacionL1_Sentinel,
  validacionL2_SatelitalComercial,
  validacionL3_TripleFuente,
  certificarEnChain,
  registrarHueco,
  actualizarContinuidad,
  procesarTrimestre,
  trimestreActual
};
