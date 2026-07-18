// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA V3.4 — Procesador de Pagos (VPS)
// ────────────────────────────────────────────────────────────────────────────
// Este proceso corre en paralelo al oráculo (index.js) bajo PM2.
// Cada 30 segundos consulta la cola de Redis "cola:pagos:pendientes".
// Si encuentra un pago nuevo, lo procesa:
//   1. Lee los datos del pago y del cliente desde Redis
//   2. Ejecuta el registro on-chain (founder emite código + verifica email,
//      wallet Registro registra el activo)
//   3. Guarda todo en Supabase (cliente, activo, pago, recordatorios)
//   4. Envía email de confirmación al cliente y al founder
//   5. Marca el pago como procesado
//
// Variables de entorno requeridas (ya están en .env):
//   KV_REST_API_URL, KV_REST_API_TOKEN  — Redis Upstash
//   ORACLE_PRIVATE_KEY                  — firma como founder
//   REGISTRO_PRIVATE_KEY                — registra activos
//   REGISTRO_WALLET_ADDRESS             — dirección pública wallet registro
//   CORE_ADDRESS                        — contrato EpimeleiaCore
//   POLYGON_RPC                         — RPC de Polygon
//   SENDGRID_API_KEY, SENDGRID_FROM     — emails
//   SUPABASE_URL                        — URL del proyecto Supabase
//   SUPABASE_SERVICE_KEY                — clave service_role de Supabase
// ────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');

const INTERVALO_POLLING = 30000; // 30 segundos

// ─── REDIS (Upstash REST API) ────────────────────────────────────────────────
const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function redis(path) {
  const url = `${KV_URL}${path}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!resp.ok) throw new Error(`Redis error ${resp.status}`);
  return await resp.json();
}

async function redisGet(key) {
  try {
    const data = await redis(`/get/${encodeURIComponent(key)}`);
    return data.result ? JSON.parse(data.result) : null;
  } catch { return null; }
}

async function redisSet(key, value, ttl = 2592000) {
  const encoded = encodeURIComponent(JSON.stringify(value));
  await redis(`/set/${encodeURIComponent(key)}/${encoded}?EX=${ttl}`);
}

// ─── SUPABASE ────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function guardarEnSupabase(cliente, pago, resultado) {
  const email = (cliente.email || pago.email).toLowerCase().trim();
  const ahora = new Date().toISOString();

  try {
    // 1. Upsert cliente (si ya existe, actualiza última interacción)
    const { error: errCliente } = await supabase
      .from('clientes')
      .upsert({
        email,
        nombre:              cliente.nombre    || null,
        empresa:             cliente.empresa   || null,
        pais:                cliente.pais      || null,
        wallet_address:      cliente.wallet    || null,
        estado:              'activo',
        ultima_interaccion:  ahora,
      }, { onConflict: 'email' });

    if (errCliente) console.error('[supabase] Error guardando cliente:', errCliente.message);

    // 2. Insertar activo
    const fechaInicio = new Date();
    const fechaVencimiento = new Date(fechaInicio);
    fechaVencimiento.setMonth(fechaVencimiento.getMonth() + 3); // trimestre

    const { data: activoData, error: errActivo } = await supabase
      .from('activos')
      .insert({
        cliente_email:    email,
        nombre_activo:    cliente.activo       || 'Activo pendiente de nombre',
        tipo:             cliente.tipoActividad || 'OTRO',
        latitud:          cliente.latitud       || null,
        longitud:         cliente.longitud      || null,
        radio_km:         cliente.radioKm       || null,
        nivel:            'PV-L1',
        trimestre_inicio: fechaInicio.toISOString().split('T')[0],
        estado:           'activo',
        activo_id_onchain: resultado.activoId  || null,
        tx_hash:          resultado.txRegistro  || null,
        hash_firma:       pago.hashAceptacion   || null,
      })
      .select('id')
      .single();

    if (errActivo) {
      console.error('[supabase] Error guardando activo:', errActivo.message);
    }

    // 3. Insertar pago
    const { error: errPago } = await supabase
      .from('pagos')
      .insert({
        cliente_email:   email,
        monto_usd:       pago.monto     || null,
        metodo:          pago.proveedor || null,
        status:          'aprobado',
        hash_pago:       pago.idExterno || null,
        webhook_payload: pago.rawMP || pago.rawPayPal || null,
      });

    if (errPago) console.error('[supabase] Error guardando pago:', errPago.message);

    // 4. Crear recordatorios a 30, 15 y 5 días del vencimiento
    if (activoData?.id) {
      const recordatorios = [30, 15, 5].map(dias => {
        const fecha = new Date(fechaVencimiento);
        fecha.setDate(fecha.getDate() - dias);
        return {
          cliente_email:    email,
          activo_id:        activoData.id,
          tipo:             `vencimiento_${dias}`,
          fecha_programada: fecha.toISOString().split('T')[0],
          enviado:          false,
        };
      });

      const { error: errRec } = await supabase
        .from('recordatorios')
        .insert(recordatorios);

      if (errRec) console.error('[supabase] Error creando recordatorios:', errRec.message);
      else console.log(`[supabase] 3 recordatorios creados para ${email}`);
    }

    console.log(`[supabase] Datos guardados correctamente para ${email}`);

  } catch (e) {
    // El error de Supabase nunca frena el procesamiento principal
    console.error('[supabase] Error inesperado:', e.message);
  }
}

// ─── ABI MÍNIMO DEL CONTRATO CORE ───────────────────────────────────────────
const CORE_ABI = [
  "function registrarCodigoVerificacion(bytes32 codigo, address wallet) external",
  "function verificarEmail(bytes32 codigo, bytes32 emailHash) external",
  "function registrarActivo(string nombre, uint8 tipoActividad, uint8 nivel, int256 latitud, int256 longitud, uint256 radioKm, bytes32 emailHash) external payable returns (uint256)",
  "function emailsVerificados(bytes32) external view returns (bool)"
];

const TIPO_ACTIVIDAD = {
  "MINERIA": 0, "FORESTAL": 1, "NAVAL": 2, "INDUSTRIAL": 3,
  "DATA_CENTER": 4, "RESIDUOS": 5, "HIDROVIA": 6, "OTRO": 7
};

// ─── EMAIL (SendGrid) ────────────────────────────────────────────────────────
async function enviarEmail(to, subject, body) {
  if (!process.env.SENDGRID_API_KEY) {
    console.log(`[email] SendGrid no configurado — email a ${to} no enviado`);
    return false;
  }
  try {
    const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.SENDGRID_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: process.env.SENDGRID_FROM || "oracle@epimeleia.world", name: "EPIMELEIA Protocol" },
        subject: subject,
        content: [{ type: "text/plain", value: body }]
      })
    });
    return resp.status === 202;
  } catch (e) {
    console.error(`[email] Error enviando a ${to}:`, e.message);
    return false;
  }
}

// ─── PROCESAMIENTO ON-CHAIN ──────────────────────────────────────────────────
async function registrarActivoOnChain(cliente, pago) {
  const provider       = new ethers.JsonRpcProvider(process.env.POLYGON_RPC);
  const founderWallet  = new ethers.Wallet(process.env.ORACLE_PRIVATE_KEY,   provider);
  const registroWallet = new ethers.Wallet(process.env.REGISTRO_PRIVATE_KEY, provider);
  const coreAddress    = process.env.CORE_ADDRESS;

  const coreFounder  = new ethers.Contract(coreAddress, CORE_ABI, founderWallet);
  const coreRegistro = new ethers.Contract(coreAddress, CORE_ABI, registroWallet);

  const email      = (cliente.email || pago.email).toLowerCase().trim();
  const emailHash  = ethers.keccak256(ethers.toUtf8Bytes(email));

  // Paso 1: Verificar si el email ya está verificado on-chain
  let yaVerificado = false;
  try {
    yaVerificado = await coreFounder.emailsVerificados(emailHash);
  } catch { yaVerificado = false; }

  if (!yaVerificado) {
    // Paso 2: Emitir código de verificación (founder)
    const codigo = ethers.keccak256(ethers.toUtf8Bytes(`epimeleia-${email}-${Date.now()}`));
    console.log(`[onchain] Emitiendo código de verificación para ${email}...`);
    const tx1 = await coreFounder.registrarCodigoVerificacion(codigo, registroWallet.address);
    await tx1.wait();
    console.log(`[onchain] Código emitido — tx: ${tx1.hash}`);

    // Paso 3: Verificar email (founder)
    console.log(`[onchain] Verificando email ${email}...`);
    const tx2 = await coreFounder.verificarEmail(codigo, emailHash);
    await tx2.wait();
    console.log(`[onchain] Email verificado — tx: ${tx2.hash}`);
  } else {
    console.log(`[onchain] Email ${email} ya estaba verificado on-chain`);
  }

  // Paso 4: Registrar activo (wallet Registro, con 1 wei de fee)
  const nombre  = cliente.activo || "Activo pendiente de nombre";
  const tipo    = TIPO_ACTIVIDAD[cliente.tipoActividad] ?? TIPO_ACTIVIDAD["OTRO"];
  const nivel   = 0; // PV-L1
  const latitud = cliente.latitud  || 0;
  const longitud= cliente.longitud || 0;
  const radioKm = cliente.radioKm  || 10;

  console.log(`[onchain] Registrando activo "${nombre}"...`);
  const tx3 = await coreRegistro.registrarActivo(
    nombre, tipo, nivel, latitud, longitud, radioKm, emailHash,
    { value: 1 } // 1 wei — fee simbólico
  );
  const receipt = await tx3.wait();
  console.log(`[onchain] Activo registrado — tx: ${tx3.hash}`);

  // Intentar extraer el ID del activo del evento
  let activoId = null;
  try {
    const evento = receipt.logs?.[0];
    if (evento?.topics?.[1]) {
      activoId = parseInt(evento.topics[1], 16);
    }
  } catch { /* no crítico */ }

  return {
    txVerificacion: yaVerificado ? "ya-verificado" : tx1?.hash,
    txRegistro:     tx3.hash,
    blockNumber:    receipt.blockNumber,
    activoId,
  };
}

// ─── PROCESAR UN PAGO ────────────────────────────────────────────────────────
async function procesarPago(pagoId) {
  console.log(`\n[procesador] Procesando pago: ${pagoId}`);

  // Leer datos del pago
  const pago = await redisGet(`pago:${pagoId}`);
  if (!pago) {
    console.log(`[procesador] Pago ${pagoId} no encontrado en Redis — saltando`);
    return;
  }

  if (pago.estado === "PROCESADO") {
    console.log(`[procesador] Pago ${pagoId} ya procesado — saltando`);
    return;
  }

  const email = pago.email;
  if (!email) {
    console.log(`[procesador] Pago ${pagoId} sin email — no se puede procesar`);
    pago.estado = "ERROR_SIN_EMAIL";
    await redisSet(`pago:${pagoId}`, pago);
    return;
  }

  // Leer datos del cliente (guardados por EPI durante la conversación)
  const cliente = await redisGet(`cliente:${email}`) || { email };

  // Intentar registro on-chain
  const tieneDataCompleta = cliente.activo && (cliente.latitud || cliente.longitud);

  if (tieneDataCompleta) {
    try {
      console.log(`[procesador] Cliente ${email} tiene datos completos — registrando on-chain`);
      const resultado = await registrarActivoOnChain(cliente, pago);

      pago.estado      = "PROCESADO";
      pago.txRegistro  = resultado.txRegistro;
      pago.procesadoEn = new Date().toISOString();
      await redisSet(`pago:${pagoId}`, pago);

      // Actualizar estado del cliente en Redis
      cliente.estado      = "activo";
      cliente.txRegistro  = resultado.txRegistro;
      await redisSet(`cliente:${email}`, cliente);

      // Guardar todo en Supabase
      await guardarEnSupabase(cliente, pago, resultado);

      // Email al cliente
      await enviarEmail(
        email,
        "EPIMELEIA — Asset Registered Successfully",
        `Your asset "${cliente.activo}" has been registered on Polygon Mainnet.\n\n` +
        `Transaction: https://polygonscan.com/tx/${resultado.txRegistro}\n\n` +
        `The oracle will certify your asset on the next satellite window (day 1 or 15 of the month).\n\n` +
        `Protocol: EPIMELEIA V3.4\n"Data does not lie. Neither does time."`
      );

      // Email al founder
      if (process.env.FOUNDER_EMAIL) {
        await enviarEmail(
          process.env.FOUNDER_EMAIL,
          `[EPIMELEIA] Nuevo activo registrado — ${cliente.activo}`,
          `Pago confirmado y activo registrado on-chain.\n\n` +
          `Cliente: ${email}\nActivo: ${cliente.activo}\nMonto: ${pago.monto} ${pago.moneda}\n` +
          `Tx: ${resultado.txRegistro}\nFecha: ${new Date().toISOString()}`
        );
      }

      console.log(`[procesador] ✅ Pago ${pagoId} procesado exitosamente`);

    } catch (error) {
      console.error(`[procesador] ❌ Error on-chain para ${pagoId}:`, error.message);
      pago.estado = "ERROR_ONCHAIN";
      pago.error  = error.message;
      await redisSet(`pago:${pagoId}`, pago);

      if (process.env.FOUNDER_EMAIL) {
        await enviarEmail(
          process.env.FOUNDER_EMAIL,
          `[EPIMELEIA] ERROR registrando activo — ${email}`,
          `Error al intentar registrar on-chain.\n\nCliente: ${email}\nPago: ${pagoId}\nError: ${error.message}\n\nAcción requerida: revisar manualmente.`
        );
      }
    }
  } else {
    // Sin datos completos — solo notificar al founder
    console.log(`[procesador] Cliente ${email} sin datos completos — notificando founder`);
    pago.estado = "PENDIENTE_DATOS_CLIENTE";
    await redisSet(`pago:${pagoId}`, pago);

    if (process.env.FOUNDER_EMAIL) {
      await enviarEmail(
        process.env.FOUNDER_EMAIL,
        `[EPIMELEIA] Pago recibido — datos del activo incompletos`,
        `Se recibió un pago pero el cliente no completó los datos del activo con EPI.\n\n` +
        `Cliente: ${email}\nMonto: ${pago.monto} ${pago.moneda}\nFecha: ${pago.fechaAprobacion}\n\n` +
        `Acción sugerida: el cliente debe completar el registro con EPI en epimeleia.world antes de que el activo pueda ser registrado on-chain.`
      );
    }
  }
}

// ─── LOOP PRINCIPAL ──────────────────────────────────────────────────────────
async function verificarCola() {
  try {
    // Leer el siguiente pago de la cola (RPOP = sacar del final de la lista)
    const data = await redis(`/rpop/cola:pagos:pendientes`);
    if (data.result) {
      await procesarPago(data.result);
    }
  } catch (error) {
    // Errores de conexión a Redis no son fatales — reintentamos en 30 seg
    if (!error.message.includes('404')) {
      console.error('[procesador] Error verificando cola:', error.message);
    }
  }
}

// ─── ARRANQUE ────────────────────────────────────────────────────────────────
console.log("─────────────────────────────────────────────────────");
console.log("  EPIMELEIA V3.4 — Procesador de Pagos");
console.log("  Polling cada 30 segundos a Redis");
console.log(`  Redis: ${KV_URL ? "configurado" : "NO CONFIGURADO"}`);
console.log(`  RPC: ${process.env.POLYGON_RPC ? "configurado" : "NO CONFIGURADO"}`);
console.log(`  Wallet Registro: ${process.env.REGISTRO_WALLET_ADDRESS || "NO CONFIGURADA"}`);
console.log(`  Supabase: ${process.env.SUPABASE_URL ? "configurado" : "NO CONFIGURADO"}`);
console.log("─────────────────────────────────────────────────────");

// Verificar inmediatamente al arrancar, después cada 30 segundos
verificarCola();
setInterval(verificarCola, INTERVALO_POLLING);
