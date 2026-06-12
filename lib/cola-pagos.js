// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA V3.4 — Cola de Pagos en Redis (Upstash)
// ────────────────────────────────────────────────────────────────────────────
// Cuando un webhook (MercadoPago o PayPal) confirma un pago, lo deja en una
// "cola" de Redis. El VPS lee esa cola cada X segundos y procesa los pagos
// pendientes: emite código de verificación, verifica email, registra el
// activo on-chain, manda ticket y notifica al founder.
//
// Estructura en Redis:
//   - cola:pagos:pendientes   → lista de IDs de pagos a procesar
//   - pago:{id}               → objeto JSON con todos los datos del pago
//   - cliente:{email}         → datos del cliente (compartido con chat.js)
// ────────────────────────────────────────────────────────────────────────────

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// Llamada genérica a Upstash REST API
async function upstashCall(path) {
  const url = `${KV_URL}${path}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!resp.ok) {
    const detalle = await resp.text();
    throw new Error(`Redis error ${resp.status}: ${detalle}`);
  }
  return await resp.json();
}

// Guarda un pago confirmado en Redis y lo agrega a la cola de procesamiento.
// TTL: 30 días (suficiente tiempo para que el VPS procese todo).
async function encolarPago(pagoData) {
  const pagoId = `${pagoData.proveedor}-${pagoData.idExterno}`;
  const ttl = 30 * 24 * 60 * 60; // 30 días en segundos

  const datosCompletos = {
    ...pagoData,
    pagoId,
    estado: "PENDIENTE_PROCESAMIENTO",
    encoladoEn: new Date().toISOString()
  };

  // Guardar los datos del pago
  const valorEncoded = encodeURIComponent(JSON.stringify(datosCompletos));
  const setUrl = `/set/${encodeURIComponent(`pago:${pagoId}`)}/${valorEncoded}?EX=${ttl}`;
  await upstashCall(setUrl);

  // Agregar el ID a la cola (lista) de pagos pendientes
  const pushUrl = `/lpush/cola:pagos:pendientes/${encodeURIComponent(pagoId)}`;
  await upstashCall(pushUrl);

  return { pagoId, estado: "ENCOLADO" };
}

// Verifica si un pago ya fue encolado anteriormente (anti-duplicados).
// MercadoPago a veces envía la misma notificación varias veces.
async function pagoYaExiste(proveedor, idExterno) {
  const pagoId = `${proveedor}-${idExterno}`;
  try {
    const getUrl = `/get/${encodeURIComponent(`pago:${pagoId}`)}`;
    const data = await upstashCall(getUrl);
    return data.result !== null;
  } catch {
    return false;
  }
}

// Guarda la aceptación de cláusulas del cliente (clickwrap).
// Se llama desde el webhook al confirmar el pago, asumiendo que el cliente
// ya aceptó antes en el frontend.
async function guardarAceptacionClausulas(email, hashAceptacion, version, timestamp) {
  const ttl = 365 * 24 * 60 * 60; // 1 año

  const datos = {
    email: email.toLowerCase().trim(),
    versionClausulas: version,
    hashAceptacion,
    timestamp,
    registradoEn: new Date().toISOString()
  };

  const valorEncoded = encodeURIComponent(JSON.stringify(datos));
  const setUrl = `/set/${encodeURIComponent(`aceptacion:${email.toLowerCase()}`)}/${valorEncoded}?EX=${ttl}`;
  await upstashCall(setUrl);

  return datos;
}

module.exports = {
  encolarPago,
  pagoYaExiste,
  guardarAceptacionClausulas
};
