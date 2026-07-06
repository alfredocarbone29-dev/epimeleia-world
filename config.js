/**
 * EPIMELEIA V3.4 — Oracle Node · config.js
 * ─────────────────────────────────────────
 * Fuente única de verdad para toda la configuración.
 * En producción, todas las variables sensibles vienen de .env
 *
 * .env requerido:
 *   ORACLE_PRIVATE_KEY=0x...
 *   CORE_ADDRESS=0x...
 *   CERT_ADDRESS=0x...
 *   BILLING_ADDRESS=0x...
 *   ORACLE_CONTRACT_ADDRESS=0x...
 *   POLYGON_RPC=https://polygon-rpc.com
 *   SENTINEL_API_USER=...
 *   SENTINEL_API_KEY=...
 *   WEBHOOK_URL=https://...
 *   SENDGRID_API_KEY=...         (para reportes por email)
 *   SENDGRID_FROM=oracle@epimeleia.world
 *   MODO_TEST=true               (false en producción)
 */

require('dotenv').config();

const config = {

  // ── Red ────────────────────────────────────────────
  red: {
    rpc:     process.env.POLYGON_RPC     || 'https://polygon-rpc.com',
    chainId: 137,
    nombre:  'Polygon Mainnet',
  },

  // ── Contratos V3.4 ────────────────────────────────
  contratos: {
    core:    process.env.CORE_ADDRESS            || '',
    cert:    process.env.CERT_ADDRESS            || '',
    billing: process.env.BILLING_ADDRESS         || '',
    oracle:  process.env.ORACLE_CONTRACT_ADDRESS || '',
  },

  // ── Oracle wallet ─────────────────────────────────
  oracle: {
    privateKey: process.env.ORACLE_PRIVATE_KEY || '',
  },

  // ── Sentinel / Copernicus PV-L1 ───────────────────
  sentinel: {
    apiUser:    process.env.SENTINEL_API_USER || 'epimeleia_oracle',
    apiKey:     process.env.SENTINEL_API_KEY  || '',
    baseUrl:    'https://scihub.copernicus.eu/dhus/search',
    timeout:    15000,
    // Umbral de nubosidad: si supera este %, no se puede certificar (Ajuste 1)
    umbralNubosidad: 70,
  },

  // ── Modo Test vs Producción (Ajuste 15) ───────────
  modoTest: process.env.MODO_TEST === 'true' || process.env.MODO_TEST === '1',

  // Períodos en modo test (segundos) vs producción (días)
  periodos: {
    billing:       process.env.MODO_TEST === 'true' ? 60     : 90 * 24 * 3600,
    ventana:       process.env.MODO_TEST === 'true' ? 10     : 15 * 24 * 3600,
    gracia:        process.env.MODO_TEST === 'true' ? 30     :  7 * 24 * 3600,
    continuidad:   process.env.MODO_TEST === 'true' ? 20     : 24 * 3600,
  },

  // ── Notificaciones ────────────────────────────────
  notificaciones: {
    webhookUrl:      process.env.WEBHOOK_URL        || '',
    sendgridKey:     process.env.SENDGRID_API_KEY   || '',
    sendgridFrom:    process.env.SENDGRID_FROM      || 'oracle@epimeleia.world',
    timeoutWebhook:  8000,
  },

  // ── Gas settings ──────────────────────────────────
  gas: {
    certificar:     600000,
    hueco:          500000,
    continuidad:    300000,
    transferencia:  400000,
  },

  // ── Índices espectrales que EPIMELEIA es CAPAZ de medir ────────────
  // Fuente única de lo que el satélite realmente certifica. Si un fenómeno
  // no está acá, Sentinel-2 no lo mide y NO se informa: no se inventa el dato.
  //   confianza 'medido'       → índice directo, número duro.
  //   confianza 'aproximacion' → estimación honesta, se informa como tal.
  indicesDisponibles: {
    NDVI: { etiqueta: 'Vigor de la vegetación',        bandas: 'B04 RED / B08 NIR',   confianza: 'medido' },
    NDWI: { etiqueta: 'Presencia y nivel de agua',     bandas: 'B03 GREEN / B08 NIR', confianza: 'medido' },
    NDMI: { etiqueta: 'Humedad de vegetación y suelo', bandas: 'B08 NIR / B11 SWIR',  confianza: 'medido' },
    NDTI: { etiqueta: 'Turbidez y sedimentos del agua',bandas: 'B03 GREEN / B04 RED', confianza: 'aproximacion' },
    NDBI: { etiqueta: 'Superficie construida o pelada',bandas: 'B08 NIR / B11 SWIR',  confianza: 'aproximacion' },
  },

  // ── Indicadores por tipo de actividad ─────────────
  // SOLO lo que Sentinel-2 mide de verdad. Se retiró todo lo que exigía un
  // satélite térmico (temperatura superficial), uno atmosférico (emisiones)
  // o que no se observa desde el espacio (consumo energético, lixiviados).
  indicadoresPorTipo: {
    0: { nombre: 'MINERIA',     bandas: 'B03/B04/B08/B11', indicadores: [
           { clave: 'cobertura_vegetal',  etiqueta: 'Cobertura vegetal',         indice: 'NDVI' },
           { clave: 'expansion_area',     etiqueta: 'Expansión del área',        indice: 'NDBI' },
           { clave: 'sedimentos_agua',    etiqueta: 'Sedimentos en el agua',     indice: 'NDTI' },
         ] },
    1: { nombre: 'FORESTAL',    bandas: 'B04/B08/B11',     indicadores: [
           { clave: 'cobertura_vegetal',  etiqueta: 'Cobertura vegetal (NDVI)',  indice: 'NDVI' },
           { clave: 'humedad_vegetal',    etiqueta: 'Humedad de la vegetación',  indice: 'NDMI' },
         ] },
    2: { nombre: 'NAVAL',       bandas: 'B03/B04/B08/B11', indicadores: [
           { clave: 'area_portuaria',     etiqueta: 'Área portuaria construida', indice: 'NDBI' },
           { clave: 'turbidez_agua',      etiqueta: 'Turbidez del agua',         indice: 'NDTI' },
         ] },
    3: { nombre: 'INDUSTRIAL',  bandas: 'B04/B08/B11',     indicadores: [
           { clave: 'expansion_area',     etiqueta: 'Expansión del área',        indice: 'NDBI' },
           { clave: 'cobertura_vegetal',  etiqueta: 'Cobertura vegetal lindante',indice: 'NDVI' },
         ] },
    4: { nombre: 'DATA_CENTER', bandas: 'B04/B08/B11',     indicadores: [
           { clave: 'area_construccion',  etiqueta: 'Área construida',           indice: 'NDBI' },
           { clave: 'cobertura_vegetal',  etiqueta: 'Cobertura vegetal lindante',indice: 'NDVI' },
         ] },
    5: { nombre: 'RESIDUOS',    bandas: 'B04/B08/B11',     indicadores: [
           { clave: 'expansion_area',     etiqueta: 'Expansión del área',        indice: 'NDBI' },
           { clave: 'cobertura_vegetal',  etiqueta: 'Cobertura vegetal lindante',indice: 'NDVI' },
         ] },
    6: { nombre: 'HIDROVIA',    bandas: 'B03/B04/B08',     indicadores: [
           { clave: 'nivel_hidrico',      etiqueta: 'Nivel / presencia de agua', indice: 'NDWI' },
           { clave: 'turbidez_sedimentos',etiqueta: 'Turbidez y sedimentos',     indice: 'NDTI' },
           { clave: 'cobertura_vegetal',  etiqueta: 'Cobertura vegetal ribereña',indice: 'NDVI' },
         ] },
    7: { nombre: 'OTRO',        bandas: 'B04/B08/B11',     indicadores: [
           { clave: 'cobertura_vegetal',  etiqueta: 'Cobertura vegetal (NDVI)',  indice: 'NDVI' },
           { clave: 'humedad',            etiqueta: 'Humedad',                   indice: 'NDMI' },
         ] },
  },

  // ── Cron schedules ────────────────────────────────
  cron: {
    // Ventana satelital cada 15 días: días 1 y 15 de cada mes a las 06:00 UTC
    ventanaSatelital:   '0 6 1,15 * *',
    // Continuidad: diaria a medianoche UTC
    continuidad:        '0 0 * * *',
    // Verificación de estado: cada hora
    healthcheck:        '0 * * * *',
    // Modo test: cada minuto para todas las tareas
    testVentana:        '* * * * *',
    testContinuidad:    '*/2 * * * *',
  },

  // ── Pausas entre operaciones (ms) ─────────────────
  pausas: {
    entreActivos:  2000,
    reintento:     5000,
    maxReintentos: 3,
  },

};

// Validación mínima en arranque
function validarConfig() {
  const errores = [];
  if (!config.oracle.privateKey)       errores.push('ORACLE_PRIVATE_KEY no definida');
  if (!config.contratos.core)          errores.push('CORE_ADDRESS no definida');
  if (!config.contratos.cert)          errores.push('CERT_ADDRESS no definida');
  if (!config.contratos.billing)       errores.push('BILLING_ADDRESS no definida');
  if (!config.contratos.oracle)        errores.push('ORACLE_CONTRACT_ADDRESS no definida');
  if (!config.sentinel.apiKey && !config.modoTest) errores.push('SENTINEL_API_KEY no definida (requerida en producción)');
  return errores;
}

module.exports = { config, validarConfig };
