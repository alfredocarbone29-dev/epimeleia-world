/**
 * EPIMELEIA TRAZABILIDAD · traz-lote.js  — CERTIFICADO DE LOTE
 * ═════════════════════════════════════════════════════════════
 * Un LOTE es un embarque: un código, un cultivo, un año de cosecha, un
 * receptor y la lista de parcelas de las que sale, con cuántas toneladas
 * aporta cada una. El certificado responde la pregunta del auditor:
 * "¿todo lo que viene en este embarque salió de tierra limpia, y esa
 *  tierra podía dar ese volumen?"
 *
 * LA REGLA (sin promedios):
 *   El lote es APTO solo si TODAS sus parcelas pasan las dos pruebas:
 *     1. SATÉLITE — la parcela tiene paquete de evidencia sellado y
 *        verificable, y ese paquete dice "sin deforestación". Se lee el
 *        paquete SELLADO (paquete_canonical), no la columna editable, y
 *        se comprueba que su keccak256 coincida con paquete_hash.
 *     2. SALDO — la parcela tiene UNA declaración ACEPTADA para ese
 *        cultivo y año, y le queda saldo para las toneladas pedidas.
 *   Si una sola falla, el lote es NO_APTO y se devuelve qué falló y por
 *   qué. Un NO_APTO no se sella ni descuenta nada: no ocurrió.
 *
 * QUÉ PASA AL SELLAR UN LOTE APTO:
 *   1. Por cada parcela, una ATRIBUCIÓN normal de TRAZ (la misma puerta
 *      /atribuir, sellada y encadenada), con referencia "LOTE:<código>".
 *   2. El paquete del lote — que guarda la huella del paquete satelital
 *      de cada parcela, la huella de su declaración y la de su atribución —
 *      se sella en Polygon con la misma transacción cruda que el resto.
 *   Quien tenga el paquete puede recalcular la huella y compararla con la
 *   de la cadena. Y desde ahí bajar a cada parcela y a cada atribución.
 *
 * REINTENTO SEGURO (idempotente por código):
 *   Si el proceso se corta a mitad (una tx que falla), se reintenta con el
 *   mismo código: las atribuciones que ya tienen "LOTE:<código>" se
 *   reutilizan, no se vuelven a descontar.
 *
 * PRIVACIDAD:
 *   El paquete es público: no lleva coordenadas (ya están comprometidas
 *   dentro de la huella de cada paquete satelital), ni el email del
 *   receptor (solo su huella), ni el cliente.
 *
 * Este módulo NO toca el oráculo ni los contratos .sol.
 * ═════════════════════════════════════════════════════════════
 */

const { ethers } = require('ethers');
const { sellarPaquete } = require('./paquete-evidencia');

const TRAZ_LOTE_VERSION = 'traz-lote-v1';

const TABLA_LOTES = 'traz_lotes';
const TABLA_DECL  = 'traz_declaraciones';
const TABLA_ATRIB = 'traz_atribuciones';

const VEREDICTO = { APTO: 'APTO', NO_APTO: 'NO_APTO' };
const ESTADO    = { EN_PROCESO: 'EN_PROCESO', SELLADO: 'SELLADO', ERROR: 'ERROR' };

const MAX_PARCELAS = 100;
const MIN_ESPERA_REPROCESO_MS = 10 * 60 * 1000; // un EN_PROCESO más viejo que esto se puede retomar

// ─── Helpers ────────────────────────────────────────────────────
function _red6(n) {
  if (n == null || !isFinite(Number(n))) return null;
  const x = Math.round(Number(n) * 1e6) / 1e6;
  return x === 0 ? 0 : x;
}

function _huella(valor) {
  if (!valor || typeof valor !== 'string') return null;
  return ethers.keccak256(ethers.toUtf8Bytes(valor.toLowerCase().trim()));
}

function _codigoValido(c) {
  return typeof c === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(c.trim());
}

function _fechaValida(f) {
  return typeof f === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f) && !isNaN(Date.parse(f));
}

function referenciaDeLote(codigo) {
  return `LOTE:${codigo}`;
}

// ─── Normalización de la entrada ────────────────────────────────
function normalizarEntrada(datos) {
  const d = datos || {};
  const codigo  = typeof d.codigo === 'string' ? d.codigo.trim() : '';
  const cultivo = typeof d.cultivo === 'string' ? d.cultivo.toLowerCase().trim() : '';
  const anio    = Number(d.anio);
  const fecha   = d.fecha ? String(d.fecha).trim() : new Date().toISOString().slice(0, 10);
  const receptor = typeof d.receptor === 'string' ? d.receptor.trim() : '';

  const errores = [];
  if (!_codigoValido(codigo)) errores.push('Código de lote inválido: de 3 a 64 caracteres, letras, números, punto, guion o guion bajo.');
  if (!cultivo) errores.push('Falta el cultivo.');
  if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) errores.push('Año de cosecha inválido.');
  if (!_fechaValida(fecha)) errores.push('Fecha inválida (formato AAAA-MM-DD).');
  if (!receptor) errores.push('Falta el receptor (email o identificador del comprador).');

  const crudos = Array.isArray(d.parcelas) ? d.parcelas : [];
  if (!crudos.length) errores.push('El lote no tiene parcelas.');
  if (crudos.length > MAX_PARCELAS) errores.push(`Máximo ${MAX_PARCELAS} parcelas por lote.`);

  const vistos = new Set();
  const parcelas = [];
  for (const p of crudos) {
    const id = Number(p && p.activoIdOnchain);
    const t  = _red6(p && p.toneladas);
    if (!Number.isInteger(id) || id <= 0) { errores.push('Hay una parcela con número on-chain inválido.'); continue; }
    if (vistos.has(id)) { errores.push(`La parcela #${id} está repetida en el lote.`); continue; }
    if (t == null || t <= 0) { errores.push(`La parcela #${id} tiene toneladas inválidas (deben ser mayores que cero).`); continue; }
    vistos.add(id);
    parcelas.push({ activoIdOnchain: id, toneladas: t });
  }
  parcelas.sort((a, b) => a.activoIdOnchain - b.activoIdOnchain);

  return { codigo, cultivo, anio, fecha, receptor, parcelas, errores };
}

// ─── Prueba 1: el satélite (sobre el paquete SELLADO) ───────────
function evaluarSatelite(filaActivo) {
  if (!filaActivo) return { ok: false, motivo: 'La parcela no existe.' };
  // `paquete_evidencia` guarda la cadena canónica EXACTA (texto). Si viniera
  // como jsonb, se serializa igual que api/verificar.js.
  const crudo     = filaActivo.paquete_evidencia;
  const canonical = crudo == null ? null : (typeof crudo === 'string' ? crudo : JSON.stringify(crudo));
  const hash      = filaActivo.paquete_hash;
  if (!canonical || !hash) {
    return { ok: false, motivo: 'Sin paquete de evidencia verificable (sellada antes del #18 o todavía sin sellar).' };
  }
  const recalculado = ethers.keccak256(ethers.toUtf8Bytes(canonical));
  if (recalculado.toLowerCase() !== String(hash).toLowerCase()) {
    return { ok: false, motivo: 'El paquete guardado no coincide con su huella sellada. No se usa.' };
  }
  let paquete;
  try { paquete = JSON.parse(canonical); } catch { return { ok: false, motivo: 'El paquete sellado no se puede leer.' }; }
  const def = paquete && paquete.deforestacion;
  if (!def || typeof def.hubo !== 'boolean') {
    return { ok: false, motivo: 'La prueba sellada no incluye chequeo de deforestación.' };
  }
  if (def.hubo) {
    const ha = def.totalHectareas != null ? ` (${def.totalHectareas} ha)` : '';
    return { ok: false, motivo: `Hubo deforestación${ha} según su prueba sellada.` };
  }
  return {
    ok: true,
    origenPaqueteHash: String(hash).toLowerCase(),
    deforestacion: { hubo: false, periodo: def.periodo || null, fuente: def.fuente || null },
  };
}

// ─── Prueba 2: el saldo (TRAZ) ──────────────────────────────────
/**
 * `declaraciones`: filas ACEPTADAS de ese origen/cultivo/año.
 * `atribuciones`: filas ATRIBUIDAS de esa declaración y año.
 */
function evaluarSaldo({ declaraciones, atribuciones, toneladas, referencia }) {
  if (!declaraciones || !declaraciones.length) {
    return { ok: false, motivo: 'Sin declaración de producción ACEPTADA para ese cultivo y año.' };
  }
  if (declaraciones.length > 1) {
    return { ok: false, motivo: 'Tiene más de una declaración ACEPTADA para el mismo cultivo y año. Hay que revisarla antes de usarla.' };
  }
  const decl = declaraciones[0];
  const lista = Array.isArray(atribuciones) ? atribuciones : [];
  const deEsteLote = lista.filter(a => a.referencia_comercial === referencia);
  const otras      = lista.filter(a => a.referencia_comercial !== referencia);

  if (deEsteLote.length > 1) {
    return { ok: false, motivo: 'Tiene más de una atribución para este mismo lote. Hay que revisarla.' };
  }
  if (deEsteLote.length === 1) {
    const prev = deEsteLote[0];
    if (_red6(prev.toneladas) !== _red6(toneladas)) {
      return { ok: false, motivo: `Ya tiene ${prev.toneladas} t atribuidas a este lote; no se puede cambiar a ${toneladas} t.` };
    }
    return { ok: true, declaracion: decl, atribucionExistente: prev, saldoDisponible: _red6(prev.saldo_nuevo) };
  }

  const usado = otras.reduce((s, a) => s + Number(a.toneladas || 0), 0);
  const saldo = _red6(Number(decl.capacidad_anual) - usado);
  if (saldo == null || saldo < toneladas) {
    return { ok: false, motivo: `Saldo insuficiente: quedan ${saldo} t y el lote pide ${toneladas} t.`, saldoDisponible: saldo };
  }
  return { ok: true, declaracion: decl, atribucionExistente: null, saldoDisponible: saldo };
}

// ─── Lectura de una parcela con sus dos pruebas ─────────────────
async function evaluarParcela(db, parcela, lote) {
  const ref = referenciaDeLote(lote.codigo);
  const item = { activoIdOnchain: parcela.activoIdOnchain, toneladas: parcela.toneladas, nombreActivo: null, clienteId: null, motivos: [] };

  const { data: filas, error: eAct } = await db.from('activos')
    .select('activo_id_onchain, nombre_activo, cliente_id, paquete_evidencia, paquete_hash')
    .eq('activo_id_onchain', parcela.activoIdOnchain)
    .limit(2);
  if (eAct) throw new Error(`Error leyendo la parcela #${parcela.activoIdOnchain}: ${eAct.message}`);
  if (filas && filas.length > 1) {
    item.motivos.push('Hay más de una fila con ese número on-chain. Hay que revisarla.');
    return item;
  }
  const fila = filas && filas[0];
  if (fila) { item.nombreActivo = fila.nombre_activo || null; item.clienteId = fila.cliente_id || null; }

  const sat = evaluarSatelite(fila);
  if (!sat.ok) item.motivos.push(sat.motivo);
  else { item.origenPaqueteHash = sat.origenPaqueteHash; item.deforestacion = sat.deforestacion; }

  const { data: decls, error: eDecl } = await db.from(TABLA_DECL).select('*')
    .eq('origen_tipo', 'epimeleia').eq('origen_ref', String(parcela.activoIdOnchain))
    .eq('cultivo', lote.cultivo).eq('anio', lote.anio).eq('veredicto', 'ACEPTADA');
  if (eDecl) throw new Error(`Error leyendo declaraciones de #${parcela.activoIdOnchain}: ${eDecl.message}`);

  let atribs = [];
  if (decls && decls.length === 1) {
    const { data: a, error: eAt } = await db.from(TABLA_ATRIB).select('*')
      .eq('declaracion_id', decls[0].id).eq('anio', lote.anio).eq('veredicto', 'ATRIBUIDA');
    if (eAt) throw new Error(`Error leyendo atribuciones de #${parcela.activoIdOnchain}: ${eAt.message}`);
    atribs = a || [];
  }

  const sal = evaluarSaldo({ declaraciones: decls || [], atribuciones: atribs, toneladas: parcela.toneladas, referencia: ref });
  item.saldoDisponible = sal.saldoDisponible != null ? sal.saldoDisponible : null;
  if (!sal.ok) item.motivos.push(sal.motivo);
  else { item.declaracion = sal.declaracion; item.atribucionExistente = sal.atribucionExistente; }

  item.ok = item.motivos.length === 0;
  return item;
}

// ─── El paquete público del lote ────────────────────────────────
function construirPaqueteLote(lote, items) {
  const ordenados = items.slice().sort((a, b) => a.activoIdOnchain - b.activoIdOnchain);
  return {
    version: TRAZ_LOTE_VERSION,
    tipo: 'lote',
    codigo: lote.codigo,
    cultivo: lote.cultivo,
    anio: lote.anio,
    fecha: lote.fecha,
    receptorHash: _huella(lote.receptor),
    toneladasTotal: _red6(ordenados.reduce((s, i) => s + i.toneladas, 0)),
    veredicto: VEREDICTO.APTO,
    parcelas: ordenados.map(i => ({
      activoIdOnchain: i.activoIdOnchain,
      nombreActivo: i.nombreActivo,
      toneladas: _red6(i.toneladas),
      origenPaqueteHash: i.origenPaqueteHash,
      deforestacion: i.deforestacion,
      declaracionHash: String(i.declaracion.paquete_hash).toLowerCase(),
      atribucionHash: String(i.atribucionHash).toLowerCase(),
    })),
  };
}

function _resumen(items) {
  return items.map(i => ({
    activoIdOnchain: i.activoIdOnchain,
    nombreActivo: i.nombreActivo,
    toneladas: i.toneladas,
    ok: !!i.ok,
    motivos: i.motivos,
    saldoDisponible: i.saldoDisponible,
    yaAtribuida: !!i.atribucionExistente,
  }));
}

// ─── Evaluación completa (lo que muestra el simulacro) ──────────
async function evaluarLote(db, lote) {
  const items = [];
  for (const p of lote.parcelas) items.push(await evaluarParcela(db, p, lote));

  const motivosGenerales = [];
  const clientes = new Set(items.map(i => i.clienteId).filter(Boolean));
  if (clientes.size > 1) motivosGenerales.push('Las parcelas pertenecen a distintos clientes. Un lote es de un solo exportador.');

  const apto = motivosGenerales.length === 0 && items.every(i => i.ok);
  return {
    veredicto: apto ? VEREDICTO.APTO : VEREDICTO.NO_APTO,
    motivosGenerales,
    items,
    clienteId: clientes.size === 1 ? [...clientes][0] : null,
    toneladasTotal: _red6(items.reduce((s, i) => s + i.toneladas, 0)),
  };
}

// ─── Ejecución real (corre en segundo plano) ────────────────────
async function ejecutarLote({ db, sellar, atribuir, lote, evaluacion, log = () => {} }) {
  const ref = referenciaDeLote(lote.codigo);
  try {
    for (const item of evaluacion.items) {
      if (item.atribucionExistente) {
        item.atribucionHash = item.atribucionExistente.paquete_hash;
        log(`lote ${lote.codigo} · #${item.activoIdOnchain} · atribución existente reutilizada`);
        continue;
      }
      const r = await atribuir({
        declaracionId: item.declaracion.id,
        toneladas: item.toneladas,
        receptor: lote.receptor,
        referenciaComercial: ref,
        fecha: lote.fecha,
      }, true);
      if (!r || !r.ok) throw new Error(`Atribución de #${item.activoIdOnchain} rechazada: ${(r && r.error) || 'sin detalle'}`);
      item.atribucionHash = r.hash;
      log(`lote ${lote.codigo} · #${item.activoIdOnchain} · atribuida (${r.txHash})`);
    }

    const paquete = construirPaqueteLote(lote, evaluacion.items);
    const { canonical, hash } = sellarPaquete(paquete);
    const sello = await sellar(hash);

    const { error } = await db.from(TABLA_LOTES).update({
      estado: ESTADO.SELLADO,
      error: null,
      veredicto: VEREDICTO.APTO,
      parcelas: paquete.parcelas,
      paquete_canonical: canonical,
      paquete_hash: hash,
      tx_hash: sello.txHash,
      bloque: sello.bloque,
      sellado_en: new Date().toISOString(),
    }).eq('codigo', lote.codigo);
    if (error) throw new Error('El lote se selló en Polygon pero no se pudo guardar: ' + error.message + ` (tx ${sello.txHash})`);

    log(`lote ${lote.codigo} · SELLADO ${sello.txHash}`);
    return { ok: true, hash, txHash: sello.txHash, bloque: sello.bloque };
  } catch (err) {
    log(`lote ${lote.codigo} · ERROR: ${err.message}`);
    await db.from(TABLA_LOTES).update({ estado: ESTADO.ERROR, error: err.message }).eq('codigo', lote.codigo);
    return { ok: false, error: err.message };
  }
}

// ─── La puerta del lote ─────────────────────────────────────────
/**
 * deps: { supabase, sellar, atribuir, log, enSegundoPlano }
 *   enSegundoPlano(fn): por defecto lanza fn sin esperar (setImmediate).
 *   En pruebas se inyecta uno que espera, para poder verificar el resultado.
 */
async function procesarLote(datos, ejecutar, deps = {}) {
  const db = deps.supabase;
  const sellar = deps.sellar;
  const atribuir = deps.atribuir;
  const log = deps.log || (() => {});
  const enSegundoPlano = deps.enSegundoPlano || (fn => setImmediate(() => { fn().catch(e => log('lote · fallo inesperado: ' + e.message)); }));
  if (!db || !sellar || !atribuir) return { ok: false, error: 'Configuración interna incompleta del módulo de lotes.' };

  const lote = normalizarEntrada(datos);
  if (lote.errores.length) return { ok: false, tipo: 'entrada', error: lote.errores.join(' '), errores: lote.errores };

  const { data: previo, error: ePrev } = await db.from(TABLA_LOTES).select('*').eq('codigo', lote.codigo).maybeSingle();
  if (ePrev) return { ok: false, error: 'Error leyendo lotes: ' + ePrev.message };
  if (previo && previo.estado === ESTADO.SELLADO) {
    return { ok: false, tipo: 'existe', error: `Ya existe un lote sellado con el código ${lote.codigo}.`, txHash: previo.tx_hash };
  }
  if (previo && previo.estado === ESTADO.EN_PROCESO) {
    const edad = Date.now() - Date.parse(previo.actualizado_en || previo.creado_en || 0);
    if (edad < MIN_ESPERA_REPROCESO_MS) {
      return { ok: false, tipo: 'en_proceso', error: `El lote ${lote.codigo} ya se está sellando. Esperá a que termine.` };
    }
  }

  const ev = await evaluarLote(db, lote);
  const respuesta = {
    codigo: lote.codigo,
    veredicto: ev.veredicto,
    motivosGenerales: ev.motivosGenerales,
    parcelas: _resumen(ev.items),
    toneladasTotal: ev.toneladasTotal,
  };

  if (!ejecutar) return { ok: true, simulacro: true, ...respuesta };
  if (ev.veredicto !== VEREDICTO.APTO) {
    return { ok: false, tipo: 'no_apto', error: 'El lote no es apto: no se sella ni se descuenta nada.', ...respuesta };
  }

  const fila = {
    codigo: lote.codigo,
    cliente_id: ev.clienteId,
    cultivo: lote.cultivo,
    anio: lote.anio,
    fecha: lote.fecha,
    toneladas: ev.toneladasTotal,
    receptor_hash: _huella(lote.receptor),
    estado: ESTADO.EN_PROCESO,
    error: null,
    actualizado_en: new Date().toISOString(),
  };
  const { error: eFila } = previo
    ? await db.from(TABLA_LOTES).update(fila).eq('codigo', lote.codigo)
    : await db.from(TABLA_LOTES).insert(fila);
  if (eFila) return { ok: false, error: 'No se pudo registrar el lote: ' + eFila.message };

  await enSegundoPlano(() => ejecutarLote({ db, sellar, atribuir, lote, evaluacion: ev, log }));
  return { ok: true, enProceso: true, ...respuesta };
}

module.exports = {
  TRAZ_LOTE_VERSION,
  VEREDICTO,
  ESTADO,
  referenciaDeLote,
  normalizarEntrada,
  evaluarSatelite,
  evaluarSaldo,
  construirPaqueteLote,
  evaluarLote,
  procesarLote,
};
