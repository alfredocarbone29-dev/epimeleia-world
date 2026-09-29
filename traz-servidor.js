/**
 * EPIMELEIA TRAZABILIDAD · traz-servidor.js  (la PUERTA del módulo)
 * ═════════════════════════════════════════════════════════════
 * Hermano de servidor-sello.js: un servidor HTTP mínimo en el VPS, cuarto
 * proceso PM2, que NO toca a los otros. Su trabajo es juntar las piezas:
 * traer la referencia pública, juzgar, sellar el hash en Polygon y guardar.
 *
 * DOS RUTAS:
 *   POST /declarar  → crea la cuenta de saldo de un origen para un año.
 *   POST /atribuir  → descuenta toneladas de una declaración existente.
 *
 * ═══ LA DECISIÓN DE SELLADO (acá vive) ═══
 *   El hash del paquete se sella con una TRANSACCIÓN CRUDA: una tx común
 *   desde la wallet del protocolo hacia sí misma, con el hash en el campo
 *   `data`. Eso deja el hash inmutable en Polygon, verificable en
 *   Polygonscan (input data de la tx), SIN tocar ninguno de los cuatro
 *   contratos .sol y SIN mezclarse con el historial de evidencias de los
 *   activos. Un hash es un hash: no precisa un contrato que lo interprete,
 *   solo que quede escrito y no se pueda cambiar. El txHash es el recibo.
 *   (Si mañana un cliente pide eventos indexables, se despliega un contrato
 *    mínimo de trazabilidad aparte; hasta entonces, esto alcanza y es barato.)
 *
 * ═══ ALCANCE (decisión de foco) ═══
 *   La puerta recibe `baseHa` como dato. El cálculo automático de A_limpia
 *   desde un activo EPIMELEIA (área del polígono menos deforestación) va en
 *   una pieza aparte (traz-base-epimeleia.js), porque es área geodésica y
 *   conviene validarla sola. Acá, `fuenteBase` dice de dónde vino la base.
 *
 * SEGURIDAD (igual que servidor-sello.js):
 *   Candado por clave secreta compartida en header `x-traz-secret`
 *   (TRAZ_SECRET). Sin la clave, todo pedido se rechaza. Quién puede
 *   declarar/atribuir lo autentica Vercel (sesión) antes de llegar acá.
 *
 * SIMULACRO:
 *   ejecutar:false (default) calcula y devuelve qué haría, SIN gastar gas
 *   ni escribir en Supabase. ejecutar:true sella y guarda de verdad.
 *
 * VARIABLES DE ENTORNO (.env del VPS):
 *   TRAZ_SECRET        clave larga al azar (la misma que en Vercel)
 *   TRAZ_PORT          puerto (default 8791; el sello usa 8790)
 *   TRAZ_PRIVATE_KEY   wallet que sella (si falta, usa ORACLE_PRIVATE_KEY)
 *   POLYGON_RPC, SUPABASE_URL, SUPABASE_SERVICE_KEY  (ya están)
 *
 * ALTA EN PM2 (una vez):
 *   pm2 start traz-servidor.js --name epimeleia-traz && pm2 save
 *
 * PROBAR desde el VPS (simulacro, no gasta gas):
 *   curl -X POST http://127.0.0.1:8791/declarar \
 *     -H "Content-Type: application/json" -H "x-traz-secret: LA_CLAVE" \
 *     -d '{"ejecutar":false,"origen":{"tipo":"epimeleia","ref":18},
 *          "cultivo":"cacao","pais":"GHA","anio":2026,"baseHa":20,
 *          "fuenteBase":"epimeleia-satelite","produccionDeclarada":20,
 *          "titularEmail":"quien@ejemplo.com"}'
 * ═════════════════════════════════════════════════════════════
 */

require('dotenv').config();
const http = require('http');
const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');

const declaracion = require('./traz-declaracion');
const atribucion  = require('./traz-atribucion');
const rendimiento = require('./traz-rendimiento');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const PORT   = Number(process.env.TRAZ_PORT) || 8791;
const SECRET = process.env.TRAZ_SECRET || '';

const TABLA_DECL   = 'traz_declaraciones';
const TABLA_ATRIB  = 'traz_atribuciones';

const L = (...a) => console.log('[traz-servidor]', ...a);

// ─────────────────────────────────────────────────────────────
//  SELLADO EN POLYGON — transacción cruda (la decisión de arriba)
// ─────────────────────────────────────────────────────────────
/**
 * Graba `hash` (0x + 64 hex) en Polygon como data de una tx a sí misma.
 * Devuelve { txHash, bloque }. No toca contratos.
 */
async function sellarHashEnPolygon(hash) {
  const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC);
  const pk = process.env.TRAZ_PRIVATE_KEY || process.env.ORACLE_PRIVATE_KEY;
  if (!pk) throw new Error('Falta TRAZ_PRIVATE_KEY / ORACLE_PRIVATE_KEY en el .env.');
  const wallet = new ethers.Wallet(pk, provider);

  const tx = await wallet.sendTransaction({ to: wallet.address, value: 0, data: hash });
  const receipt = await tx.wait();
  return { txHash: receipt.hash, bloque: Number(receipt.blockNumber) };
}

// ─── Validación mínima de entrada ───────────────────────────────
function _falta(campos, datos) {
  for (const c of campos) {
    const v = datos[c];
    if (v === undefined || v === null || v === '') return c;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
//  DECLARAR
// ─────────────────────────────────────────────────────────────
/**
 * `deps` permite inyectar mocks en pruebas; en producción usa los reales.
 */
async function procesarDeclaracion(datos, ejecutar, deps = {}) {
  const db          = deps.supabase || supabase;
  const sellar      = deps.sellar || sellarHashEnPolygon;
  const obtenerRef  = deps.obtenerReferencia || rendimiento.obtenerReferencia;

  const faltante = _falta(
    ['origen', 'cultivo', 'pais', 'anio', 'baseHa', 'produccionDeclarada', 'titularEmail'],
    datos
  );
  if (faltante) return { ok: false, error: `Falta el campo: ${faltante}.` };

  // 1) Referencia pública, consultada al momento del pedido.
  const referencia = await obtenerRef({ cultivo: datos.cultivo, pais: datos.pais });
  if (!referencia) {
    return { ok: false, error: `Cultivo no soportado para referencia: ${datos.cultivo}.`, tipo: 'cultivo' };
  }

  // 2) Armar y juzgar la declaración (módulo puro).
  const { paquete, canonical, hash } = declaracion.sellarDeclaracion({
    origen:              datos.origen,
    cultivo:             datos.cultivo,
    pais:                datos.pais,
    anio:                datos.anio,
    baseHa:              datos.baseHa,
    fuenteBase:          datos.fuenteBase || 'declarada-titular',
    produccionDeclarada: datos.produccionDeclarada,
    referencia,
    margen:              datos.margen,          // opcional; usa 3× por defecto
    titularEmail:        datos.titularEmail,
  });

  // PENDIENTE: sin referencia utilizable no se sella (no debería pasar acá,
  // porque ya validamos referencia, pero se contempla por prolijidad).
  if (paquete.veredicto === declaracion.VEREDICTO.PENDIENTE) {
    return { ok: false, error: 'Declaración pendiente: sin referencia utilizable.', tipo: 'pendiente' };
  }

  // Simulacro: qué haría, sin sellar ni guardar.
  if (!ejecutar) {
    return {
      ok: true, simulacro: true,
      veredicto: paquete.veredicto, capacidadAnual: paquete.capacidadAnual,
      rindeDeclarado: paquete.rindeDeclarado, techo: paquete.techo,
      referencia, hash,
    };
  }

  // 3) Sellar el hash en Polygon.
  const sello = await sellar(hash);

  // 4) Guardar la fila. `titular_email` va en columna aparte para gestión;
  //    NUNCA entra al canonical (que solo lleva la huella).
  const fila = {
    origen_tipo:          paquete.origen ? paquete.origen.tipo : null,
    origen_ref:           paquete.origen ? String(paquete.origen.ref) : null,
    cultivo:              paquete.cultivo,
    pais:                 paquete.pais,
    anio:                 paquete.anio,
    base_ha:              paquete.baseHa,
    fuente_base:          paquete.fuenteBase,
    produccion_declarada: paquete.produccionDeclarada,
    referencia:           referencia,
    margen:               paquete.margen,
    rinde_declarado:      paquete.rindeDeclarado,
    techo:                paquete.techo,
    veredicto:            paquete.veredicto,
    capacidad_anual:      paquete.capacidadAnual,
    titular_hash:         paquete.titularHash,
    titular_email:        datos.titularEmail,          // gestión, no público
    paquete_canonical:    canonical,
    paquete_hash:         hash,
    tx_hash:              sello.txHash,
    bloque:               sello.bloque,
    sellado_en:           new Date().toISOString(),
  };

  const { data, error } = await db.from(TABLA_DECL).insert(fila).select().single();
  if (error) return { ok: false, error: 'No se pudo guardar la declaración: ' + error.message };

  return {
    ok: true, sellado: true,
    id: data.id,
    veredicto: paquete.veredicto,
    capacidadAnual: paquete.capacidadAnual,
    hash, txHash: sello.txHash, bloque: sello.bloque,
    polygonscan: `https://polygonscan.com/tx/${sello.txHash}`,
  };
}

// ─────────────────────────────────────────────────────────────
//  ATRIBUIR
// ─────────────────────────────────────────────────────────────
async function procesarAtribucion(datos, ejecutar, deps = {}) {
  const db     = deps.supabase || supabase;
  const sellar = deps.sellar || sellarHashEnPolygon;

  const faltante = _falta(['declaracionId', 'toneladas', 'receptor'], datos);
  if (faltante) return { ok: false, error: `Falta el campo: ${faltante}.` };

  // 1) Leer la declaración raíz.
  const { data: decl, error: eDecl } =
    await db.from(TABLA_DECL).select('*').eq('id', datos.declaracionId).maybeSingle();
  if (eDecl)  return { ok: false, error: 'Error leyendo la declaración: ' + eDecl.message };
  if (!decl)  return { ok: false, error: 'No existe esa declaración.' };
  if (decl.veredicto !== 'ACEPTADA')
    return { ok: false, error: `La declaración no está ACEPTADA (está ${decl.veredicto}); no tiene capacidad.` };

  // 2) Sumar atribuciones ATRIBUIDAS de esa declaración y ese año; hallar el
  //    último eslabón (para encadenar) y el saldo.
  const { data: previas, error: ePrev } = await db.from(TABLA_ATRIB)
    .select('*').eq('declaracion_id', decl.id).eq('anio', decl.anio).eq('veredicto', 'ATRIBUIDA');
  if (ePrev) return { ok: false, error: 'Error leyendo atribuciones: ' + ePrev.message };

  const lista = Array.isArray(previas) ? previas.slice() : [];
  lista.sort((a, b) => String(a.creado_en).localeCompare(String(b.creado_en)));

  const usado = lista.reduce((s, r) => s + Number(r.toneladas || 0), 0);
  const saldoAnterior = Math.round((Number(decl.capacidad_anual) - usado) * 1e6) / 1e6;
  const hashAnterior  = lista.length ? lista[lista.length - 1].paquete_hash : decl.paquete_hash;

  // 3) Armar y juzgar la atribución (módulo puro).
  const { paquete, canonical, hash } = atribucion.sellarAtribucion({
    declaracionHash:     decl.paquete_hash,
    hashAnterior,
    origen:              { tipo: decl.origen_tipo, ref: decl.origen_ref },
    cultivo:             decl.cultivo,
    anio:                decl.anio,
    saldoAnterior,
    toneladas:           datos.toneladas,
    receptor:            datos.receptor,
    referenciaComercial: datos.referenciaComercial,
    fecha:               datos.fecha,
  });

  // RECHAZADA (saldo insuficiente): no se sella, el intento no es un eslabón.
  if (paquete.veredicto === atribucion.VEREDICTO.RECHAZADA) {
    return { ok: false, error: paquete.motivo, tipo: 'saldo',
      saldoAnterior, toneladasPedidas: paquete.toneladas };
  }

  // Simulacro.
  if (!ejecutar) {
    return {
      ok: true, simulacro: true,
      veredicto: paquete.veredicto,
      saldoAnterior, saldoNuevo: paquete.saldoNuevo,
      hashAnterior, hash,
    };
  }

  // 4) Sellar y guardar.
  const sello = await sellar(hash);
  const fila = {
    declaracion_id:       decl.id,
    declaracion_hash:     decl.paquete_hash,
    hash_anterior:        hashAnterior,
    origen_tipo:          decl.origen_tipo,
    origen_ref:           decl.origen_ref,
    cultivo:              decl.cultivo,
    anio:                 decl.anio,
    toneladas:            paquete.toneladas,
    saldo_anterior:       saldoAnterior,
    saldo_nuevo:          paquete.saldoNuevo,
    veredicto:            paquete.veredicto,
    receptor_hash:        paquete.receptorHash,
    referencia_comercial: paquete.referenciaComercial,
    fecha:                paquete.fecha,
    paquete_canonical:    canonical,
    paquete_hash:         hash,
    tx_hash:              sello.txHash,
    bloque:               sello.bloque,
    sellado_en:           new Date().toISOString(),
  };

  const { data, error } = await db.from(TABLA_ATRIB).insert(fila).select().single();
  if (error) return { ok: false, error: 'No se pudo guardar la atribución: ' + error.message };

  return {
    ok: true, sellado: true,
    id: data.id,
    veredicto: paquete.veredicto,
    saldoAnterior, saldoNuevo: paquete.saldoNuevo,
    hash, txHash: sello.txHash, bloque: sello.bloque,
    polygonscan: `https://polygonscan.com/tx/${sello.txHash}`,
  };
}

// ─────────────────────────────────────────────────────────────
//  EL SERVIDOR HTTP (mismo patrón que servidor-sello.js)
// ─────────────────────────────────────────────────────────────
const RUTAS = {
  '/declarar': procesarDeclaracion,
  '/atribuir': procesarAtribucion,
};

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');

  const handler = RUTAS[req.url];
  if (req.method !== 'POST' || !handler) {
    res.statusCode = 404;
    return res.end(JSON.stringify({ ok: false, error: 'Ruta no encontrada. Usá POST /declarar o /atribuir.' }));
  }

  const clave = req.headers['x-traz-secret'] || '';
  if (!SECRET || clave !== SECRET) {
    L('RECHAZADO · clave inválida o ausente');
    res.statusCode = 401;
    return res.end(JSON.stringify({ ok: false, error: 'No autorizado.' }));
  }

  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let datos;
    try { datos = JSON.parse(body || '{}'); }
    catch { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'JSON inválido.' })); }

    const ejecutar = datos.ejecutar === true;
    L(`pedido · ${req.url} · ejecutar=${ejecutar}`);
    try {
      const resultado = await handler(datos, ejecutar);
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

// Solo levanta el servidor si se ejecuta directo (no al importarlo en pruebas).
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    L(`escuchando en http://0.0.0.0:${PORT} (rutas /declarar y /atribuir, protegido por clave)`);
    if (!SECRET) L('⚠  ATENCION: TRAZ_SECRET no está configurada. El servidor rechaza TODO hasta configurarla.');
  });
}

module.exports = {
  sellarHashEnPolygon,
  procesarDeclaracion,
  procesarAtribucion,
};
