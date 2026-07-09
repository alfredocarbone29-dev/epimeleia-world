/**
 * EPIMELEIA V3.4 — Oracle Node · blockchain.js
 * ─────────────────────────────────────────────
 * Toda la interacción con los contratos del protocolo.
 * Expone funciones limpias para que scheduler.js no toque ethers directamente.
 *
 * AJUSTE 26 (9/7/2026) — Lectura de la serie histórica.
 *
 *   Se agregan las funciones de lectura que faltaban:
 *     getCertificaciones · getHuecos · getEvidenciasVentana
 *     getIndiceContinuidad · getTotalCertificaciones · getFounder
 *
 *   NOTA IMPORTANTE sobre cómo se lee:
 *   Las funciones getCertificaciones() / getHuecos() / getEvidenciasVentana()
 *   del contrato tienen un control de acceso (_verificarAcceso) que solo deja
 *   pasar al founder, al dueño del activo, o a los contratos hermanos.
 *   La wallet del oráculo NO está en esa lista.
 *
 *   Por eso acá NO se llaman esas funciones. Se leen los mapping públicos
 *   (certificaciones / huecos / evidenciasVentana), cuyos getters automáticos
 *   devuelven exactamente los mismos datos y no tienen control de acceso.
 *
 *   Si algún día se despliega una V3.5, conviene agregar la wallet del oráculo
 *   a _verificarAcceso y volver a los getters de array (una sola llamada RPC
 *   en vez de N). Hasta entonces, esto funciona y no requiere tocar la cadena.
 */

const { ethers }       = require('ethers');
const { config }       = require('./config');
const { log }          = require('./logger');

// ─── ABIs mínimos por contrato ──────────────────────────────────

const ABI_CORE = [
  // Lectura
  "function getTotalActivos() external view returns (uint256)",
  "function getListaActivoIds() external view returns (uint256[])",
  "function getDatosOracle(uint256 activoId) external view returns (bool, uint8, uint8, int256, int256, uint256, address)",
  "function getBadgePublico(uint256 activoId) external view returns (string, string, uint8, bool, uint256)",
  "function modoTest() external view returns (bool)",
  "function getPeriodoBilling() external view returns (uint256)",
  "function getVentanaSatelital() external view returns (uint256)",
  "function founder() external view returns (address)",           // ← AJUSTE 26
  // Eventos para escucha
  "event ActivoRegistrado(uint256 indexed activoId, address indexed wallet, string nombre, uint8 tipo, uint8 nivel, uint256 timestamp)",
  "event SelloExcelencia(uint256 indexed activoId, address indexed owner, string nombre, bytes32 selloHash, uint256 timestamp)",
  "event BajaMALUSO(uint256 indexed activoId, address indexed wallet, string motivo, uint256 timestamp)",
];

const ABI_CERT = [
  // ── Escritura ──
  "function certificarQ(uint256 activoId, bytes32 hashEvidencia, string metadataURI, uint256 trimestre, string satelite, string bandaEspectral, uint16 nubosidadPct, string urlDescarga, string uuid) external",
  "function registrarHuecoOpacidad(uint256 activoId, uint256 diaInicio, uint256 diaFin, string causa, bool esCausaClimatica) external",
  "function registrarEvidenciaVentana(uint256 activoId, uint256 trimestre, bytes32 hashEvidencia, string satelite, uint16 nubosidadPct, string urlDescarga) external",

  // ── Lectura sin control de acceso (mapping públicos) ── AJUSTE 26
  "function certificaciones(uint256 activoId, uint256 indice) external view returns (uint256 timestamp, uint256 trimestre, bytes32 hashEvidencia, address oraculo, uint8 nivel, uint8 tipoActividad, string metadataURI, bool valida, string satelite, string bandaEspectral, uint16 nubosidadPct, string urlDescargaDatos, string uuid)",
  "function huecos(uint256 activoId, uint256 indice) external view returns (uint256 diaInicio, uint256 diaFin, uint256 timestamp, string causa, bool esCausaClimatica)",
  "function evidenciasVentana(uint256 activoId, uint256 trimestre, uint256 indice) external view returns (uint256 timestamp, bytes32 hashEvidencia, address oraculo, string satelite, uint16 nubosidadPct, string urlDescargaDatos)",
  "function trimestresCertificados(uint256 activoId) external view returns (uint256)",
  "function trimestresConHueco(uint256 activoId) external view returns (uint256)",

  // ── Lectura sin control de acceso (funciones) ──
  "function getIndiceContinuidad(uint256 activoId) external view returns (uint256)",
  "function getTotalCertificaciones(uint256 activoId) external view returns (uint256)",

  // ── Lectura CON control de acceso (se dejan por completitud, no se usan) ──
  "function getCertificaciones(uint256 activoId) external view returns (tuple(uint256,uint256,bytes32,address,uint8,uint8,string,bool,string,string,uint16,string,string)[])",
  "function getHuecos(uint256 activoId) external view returns (tuple(uint256,uint256,uint256,string,bool)[])",
  "function getEvidenciasVentana(uint256 activoId, uint256 trimestre) external view returns (tuple(uint256,bytes32,address,string,uint16,string)[])",

  // ── Eventos ──
  "event CertificacionRealizada(uint256 indexed activoId, bytes32 hashEvidencia, uint256 trimestre, string satelite, uint16 nubosidadPct, uint256 timestamp)",
  "event HuecoOpacidadRegistrado(uint256 indexed activoId, string causa, bool esCausaClimatica, uint256 timestamp)",
  "event EvidenciaVentanaRegistrada(uint256 indexed activoId, uint256 trimestre, uint256 totalEvidencias, uint256 timestamp)",
];

const ABI_BILLING = [
  "function getEstadoBilling(uint256 activoId) external view returns (uint256, uint256, uint256, bool, uint256, bool)",
  "function getSaldo(uint256 activoId) external view returns (uint256)",
  "function getProximosVencimientos(uint256 activoId) external view returns (uint256, uint256)",
  "event ReporteTrimestralTrigger(uint256 indexed activoId, address indexed owner, uint256 trimestre, uint256 timestamp)",
  "event AlertaSaldoBajo(uint256 indexed activoId, address indexed owner, uint256 saldoActual, uint256 feeRequerido, uint256 diasRestantes, uint256 timestamp)",
];

// ─── Diccionarios de enums (espejo del contrato) ── AJUSTE 26 ───

const NIVELES = ['L1', 'L2', 'L3'];

const TIPOS_ACTIVIDAD = [
  'MINERIA', 'FORESTAL', 'NAVAL', 'INDUSTRIAL',
  'DATA_CENTER', 'RESIDUOS', 'HIDROVIA', 'OTRO',
];

// Máximo de evidencias por trimestre. Lo impone el contrato:
//   require(ev.length < 6, "EPIMELEIA: Maximo 6 evidencias por trimestre")
const MAX_EVIDENCIAS_POR_TRIMESTRE = 6;

// ─── Provider y signer ─────────────────────────────────────────

let provider, oracleWallet, contratoCore, contratoCert, contratoBilling;

function inicializarBlockchain() {
  provider     = new ethers.JsonRpcProvider(config.red.rpc);
  oracleWallet = new ethers.Wallet(config.oracle.privateKey, provider);

  contratoCore    = new ethers.Contract(config.contratos.core,    ABI_CORE,    oracleWallet);
  contratoCert    = new ethers.Contract(config.contratos.cert,    ABI_CERT,    oracleWallet);
  contratoBilling = new ethers.Contract(config.contratos.billing, ABI_BILLING, oracleWallet);

  log('BLOCKCHAIN', `Contratos inicializados`, {
    core:    config.contratos.core,
    cert:    config.contratos.cert,
    billing: config.contratos.billing,
  });
}

// ─── Lectura de activos ────────────────────────────────────────

/**
 * Retorna la lista completa de IDs de activos activos en el protocolo.
 */
async function getListaActivos() {
  const ids = await contratoCore.getListaActivoIds();
  return ids.map(id => Number(id));
}

/**
 * Retorna los datos necesarios para el oracle de un activo específico.
 */
async function getDatosActivo(activoId) {
  const [activo, nivel, tipo, latRaw, lngRaw, radioKm, owner] =
    await contratoCore.getDatosOracle(activoId);

  if (!activo) return null;

  return {
    activoId,
    activo,
    nivel:     Number(nivel),
    tipo:      Number(tipo),
    latitud:   Number(latRaw)  / 1e6,
    longitud:  Number(lngRaw)  / 1e6,
    radioKm:   Number(radioKm),
    owner,
  };
}

/**
 * Retorna el estado de billing de un activo.
 */
async function getEstadoBilling(activoId) {
  const [saldo, ultimoBilling, proximoBilling, enGracia, feeProximo, alertaActiva] =
    await contratoBilling.getEstadoBilling(activoId);
  return {
    saldo:         ethers.formatEther(saldo),
    saldoWei:      saldo,
    ultimoBilling: Number(ultimoBilling),
    proximoBilling:Number(proximoBilling),
    enGracia,
    feeProximo:    ethers.formatEther(feeProximo),
    alertaActiva,
  };
}

/**
 * Dirección del founder según el contrato Core. — AJUSTE 26
 */
async function getFounder() {
  return await contratoCore.founder();
}

// ─── Certificación ────────────────────────────────────────────

/**
 * Graba una certificación Q en blockchain.
 */
async function certificarEnChain(params) {
  const {
    activoId, hashEvidencia, metadataURI, trimestre,
    satelite, bandaEspectral, nubosidadPct,
    urlDescarga, uuid
  } = params;

  log('CERT', `Certificando en Polygon`, { activoId, trimestre, satelite });

  const tx = await contratoCert.certificarQ(
    activoId,
    hashEvidencia,
    metadataURI,
    trimestre,
    satelite,
    bandaEspectral,
    nubosidadPct,
    urlDescarga,
    uuid,
    { gasLimit: config.gas.certificar }
  );

  const receipt = await tx.wait();
  log('CERT', `Certificación confirmada`, {
    activoId,
    txHash:  receipt.hash,
    bloque:  receipt.blockNumber,
    trimestre,
  });

  return receipt;
}

/**
 * Registra evidencia de ventana de 15 días — Ajuste 7.
 */
async function registrarEvidenciaVentana(params) {
  const { activoId, trimestre, hashEvidencia, satelite, nubosidadPct, urlDescarga } = params;

  const tx = await contratoCert.registrarEvidenciaVentana(
    activoId, trimestre, hashEvidencia, satelite, nubosidadPct, urlDescarga,
    { gasLimit: config.gas.certificar }
  );

  const receipt = await tx.wait();
  log('VENTANA', `Evidencia de ventana grabada`, { activoId, trimestre, txHash: receipt.hash });
  return receipt;
}

/**
 * Registra un Hueco de Opacidad en blockchain.
 *
 * @param causaClimatica true si la causa es meteorológica (nubosidad).
 * @param diaInicio  día (epoch/86400) en que empieza el hueco. Por defecto, hoy.
 * @param diaFin     día (epoch/86400) en que termina.          Por defecto, hoy.
 *
 * AJUSTE 26: se agregan diaInicio y diaFin como parámetros OPCIONALES.
 * Si no se pasan, el comportamiento es idéntico al anterior (hoy → hoy).
 * Se agregan para que, cuando el scheduler sepa el rango real del hueco,
 * pueda grabarlo. Hoy la cadena guarda todos los huecos como de un solo día.
 */
async function registrarHueco(activoId, causa, causaClimatica = false, diaInicio = null, diaFin = null) {
  const diaActual = Math.floor(Date.now() / 1000 / 86400);
  const inicio = diaInicio === null ? diaActual : diaInicio;
  const fin    = diaFin    === null ? diaActual : diaFin;

  log('HUECO', `Registrando Hueco de Opacidad`, { activoId, causa, causaClimatica, inicio, fin });

  const tx = await contratoCert.registrarHuecoOpacidad(
    activoId,
    inicio,
    fin,
    causa,
    causaClimatica,
    { gasLimit: config.gas.hueco }
  );

  const receipt = await tx.wait();
  log('HUECO', `Hueco grabado — inalterable`, { activoId, txHash: receipt.hash });
  return receipt;
}

// ─── LECTURA DE LA SERIE HISTÓRICA (AJUSTE 26) ─────────────────
//
// Todo lo que sigue es SOLO LECTURA. No escribe nada en la cadena.
// No gasta gas. No puede romper nada.

/**
 * Cantidad de certificaciones trimestrales grabadas para un activo.
 */
async function getTotalCertificaciones(activoId) {
  return Number(await contratoCert.getTotalCertificaciones(activoId));
}

/**
 * Devuelve TODAS las certificaciones trimestrales de un activo,
 * en el orden en que fueron grabadas, como objetos con nombre.
 *
 * Esta es la serie histórica. Es lo que el informe trimestral necesita
 * para poder decir "el Q1 cerró acá, el Q2 acá".
 */
async function getCertificaciones(activoId) {
  const total = await getTotalCertificaciones(activoId);
  if (total === 0) return [];

  const lista = [];
  for (let i = 0; i < total; i++) {
    const c = await contratoCert.certificaciones(activoId, i);
    lista.push({
      indice:           i,
      timestamp:        Number(c.timestamp),
      fecha:            new Date(Number(c.timestamp) * 1000).toISOString(),
      trimestre:        Number(c.trimestre),
      hashEvidencia:    c.hashEvidencia,
      oraculo:          c.oraculo,
      nivel:            NIVELES[Number(c.nivel)] ?? `DESCONOCIDO(${c.nivel})`,
      tipoActividad:    TIPOS_ACTIVIDAD[Number(c.tipoActividad)] ?? `DESCONOCIDO(${c.tipoActividad})`,
      metadataURI:      c.metadataURI,
      valida:           c.valida,
      satelite:         c.satelite,
      bandaEspectral:   c.bandaEspectral,
      nubosidadPct:     Number(c.nubosidadPct),
      urlDescargaDatos: c.urlDescargaDatos,
      uuid:             c.uuid,
    });
  }
  return lista;
}

/**
 * Devuelve todos los Huecos de Opacidad de un activo.
 *
 * OJO (deuda conocida): hoy la cadena guarda casi todos los huecos con
 * diaInicio = diaFin, o directamente con 0 y 0 (cuando el hueco lo generó
 * el propio contrato por nubosidad > 70%). Es decir: la duración real del
 * hueco NO está grabada. El informe puede decir CUÁNDO se detectó
 * (timestamp) y POR QUÉ (causa), pero todavía no CUÁNTO DURÓ.
 */
async function getHuecos(activoId) {
  const lista = [];
  for (let i = 0; i < 1000; i++) {   // el array no tiene getter de largo; se corta al primer revert
    let h;
    try {
      h = await contratoCert.huecos(activoId, i);
    } catch (e) {
      break;                          // índice fuera de rango: se terminó el array
    }
    const diaInicio = Number(h.diaInicio);
    const diaFin    = Number(h.diaFin);
    lista.push({
      indice:            i,
      diaInicio,
      diaFin,
      fechasGrabadas:    diaInicio !== 0 || diaFin !== 0,   // false = el contrato grabó 0,0
      timestamp:         Number(h.timestamp),
      fecha:             new Date(Number(h.timestamp) * 1000).toISOString(),
      causa:             h.causa,
      esCausaClimatica:  h.esCausaClimatica,
    });
  }
  return lista;
}

/**
 * Devuelve las evidencias quincenales de un activo, para un trimestre dado.
 * Son como máximo 6 (el contrato no deja más).
 *
 * Estas son las 6 fotos del trimestre: el pulso.
 */
async function getEvidenciasVentana(activoId, trimestre) {
  const lista = [];
  for (let i = 0; i < MAX_EVIDENCIAS_POR_TRIMESTRE; i++) {
    let e;
    try {
      e = await contratoCert.evidenciasVentana(activoId, trimestre, i);
    } catch (err) {
      break;
    }
    lista.push({
      indice:           i,
      timestamp:        Number(e.timestamp),
      fecha:            new Date(Number(e.timestamp) * 1000).toISOString(),
      hashEvidencia:    e.hashEvidencia,
      oraculo:          e.oraculo,
      satelite:         e.satelite,
      nubosidadPct:     Number(e.nubosidadPct),
      urlDescargaDatos: e.urlDescargaDatos,
    });
  }
  return lista;
}

/**
 * Índice de continuidad: % de períodos que se pudo certificar.
 * Fórmula del contrato: certificados / (certificados + huecos) * 100.
 *
 * Si el activo nunca fue certificado ni tuvo huecos, el contrato devuelve 0.
 * Eso NO significa 0% de continuidad: significa que todavía no hay historia.
 * Por eso se devuelve también `sinHistoria`, para que el informe no mienta.
 */
async function getIndiceContinuidad(activoId) {
  const [pct, cert, huecoCount] = await Promise.all([
    contratoCert.getIndiceContinuidad(activoId),
    contratoCert.trimestresCertificados(activoId),
    contratoCert.trimestresConHueco(activoId),
  ]);

  const certificados = Number(cert);
  const conHueco     = Number(huecoCount);

  return {
    pct:          Number(pct),
    certificados,
    conHueco,
    total:        certificados + conHueco,
    sinHistoria:  (certificados + conHueco) === 0,
  };
}

/**
 * Todo lo que la cadena sabe sobre un activo, en un solo objeto.
 * Es la materia prima del informe trimestral.
 */
async function getHistorialCompleto(activoId) {
  const certs = await getCertificaciones(activoId);
  const huecosList = await getHuecos(activoId);
  const continuidad = await getIndiceContinuidad(activoId);

  // Para cada trimestre certificado, traer sus evidencias quincenales.
  const trimestres = [...new Set(certs.map(c => c.trimestre))];
  const evidenciasPorTrimestre = {};
  for (const t of trimestres) {
    evidenciasPorTrimestre[t] = await getEvidenciasVentana(activoId, t);
  }

  return {
    activoId,
    certificaciones: certs,
    huecos: huecosList,
    continuidad,
    evidenciasPorTrimestre,
    esPrimerPeriodo: certs.length <= 1,   // sin base de comparación
  };
}

// ─── Diagnóstico (AJUSTE 26) ───────────────────────────────────

/**
 * Comprueba si la wallet del oráculo puede leer las funciones protegidas
 * del contrato Cert. Sirve para saber si algún día se pueden usar los
 * getters de array (una llamada) en vez de los mapping (N llamadas).
 *
 * No escribe nada. Corré esto y mostrame la salida.
 */
async function diagnosticoLectura(activoId) {
  const resultado = {
    oracleWallet: oracleWallet.address,
    founder: null,
    oracleEsFounder: false,
    puedeLeerGetCertificaciones: false,
    errorGetCertificaciones: null,
  };

  try {
    resultado.founder = await contratoCore.founder();
    resultado.oracleEsFounder =
      resultado.founder.toLowerCase() === oracleWallet.address.toLowerCase();
  } catch (e) {
    resultado.founder = `ERROR: ${e.shortMessage || e.message}`;
  }

  try {
    await contratoCert.getCertificaciones(activoId);
    resultado.puedeLeerGetCertificaciones = true;
  } catch (e) {
    resultado.errorGetCertificaciones = e.shortMessage || e.message;
  }

  return resultado;
}

// ─── Escucha de eventos para reportes trimestrales (Ajuste 21) ──

/**
 * Escucha el evento ReporteTrimestralTrigger y dispara el reporte por email.
 */
function escucharReportesTrimestrales(onTrigger) {
  contratoBilling.on('ReporteTrimestralTrigger', (activoId, owner, trimestre, timestamp) => {
    log('EMAIL', `Trigger reporte trimestral`, { activoId: Number(activoId), owner, trimestre: Number(trimestre) });
    onTrigger({ activoId: Number(activoId), owner, trimestre: Number(trimestre), timestamp: Number(timestamp) });
  });
}

/**
 * Escucha alertas de saldo bajo para notificar a la empresa — Ajuste 5.
 */
function escucharAlertasSaldo(onAlerta) {
  contratoBilling.on('AlertaSaldoBajo', (activoId, owner, saldo, fee, diasRestantes) => {
    log('ALERTA', `Saldo bajo detectado`, { activoId: Number(activoId), owner, diasRestantes: Number(diasRestantes) });
    onAlerta({ activoId: Number(activoId), owner, saldo, fee, diasRestantes: Number(diasRestantes) });
  });
}

// ─── Info de red ───────────────────────────────────────────────

async function getInfoRed() {
  const network = await provider.getNetwork();
  const balance = await provider.getBalance(oracleWallet.address);
  const total   = await contratoCore.getTotalActivos();

  return {
    chainId:        Number(network.chainId),
    nombre:         network.name,
    oracleAddress:  oracleWallet.address,
    balancePOL:     ethers.formatEther(balance),
    totalActivos:   Number(total),
  };
}

module.exports = {
  inicializarBlockchain,
  getListaActivos,
  getDatosActivo,
  getEstadoBilling,
  getFounder,
  certificarEnChain,
  registrarEvidenciaVentana,
  registrarHueco,
  // ── Lectura de la serie histórica (Ajuste 26) ──
  getCertificaciones,
  getHuecos,
  getEvidenciasVentana,
  getIndiceContinuidad,
  getTotalCertificaciones,
  getHistorialCompleto,
  diagnosticoLectura,
  // ── Constantes útiles ──
  NIVELES,
  TIPOS_ACTIVIDAD,
  MAX_EVIDENCIAS_POR_TRIMESTRE,
  // ── Eventos ──
  escucharReportesTrimestrales,
  escucharAlertasSaldo,
  getInfoRed,
  get provider() { return provider; },
  get oracleWallet() { return oracleWallet; },
};
