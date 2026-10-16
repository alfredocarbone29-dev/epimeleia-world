/**
 * api/panel.js — Panel de cartera + Certificado de lote (UNA sola función)
 *
 * Todo en un archivo para no superar el límite de 12 funciones del plan Hobby.
 *
 * GET  /api/panel?lote=CODIGO   → PÚBLICO. Lote sellado (para lote.html). Sin sesión.
 * POST /api/panel  { token }     → SOLO FOUNDER. Datos del panel de cartera.
 * POST /api/panel  { token, accion: 'simular'|'sellar'|'estado'|'listar', ... }
 *                                → SOLO FOUNDER. Armado y sellado de lotes (vía VPS).
 *
 * Candado founder: igual que api/confirmar-sello.js (Supabase confirma el email
 * y se compara con SELLO_FOUNDER_EMAIL).
 *
 * AJUSTE OFICINA (16/10/2026) · "TU OFICINA" DEL CLIENTE
 *   Antes: cualquier sesión que no fuera la del founder se rechazaba (403).
 *   Ahora: una sesión de cliente (entró a oficina.html con el link de su mail)
 *   también pasa, pero SOLO ve y opera lo suyo:
 *     - sin accion      → solo SUS parcelas (cliente_id = su usuario).
 *     - infoParcela     → solo si la parcela es suya.
 *     - simular/sellar  → solo si TODAS las parcelas del lote son suyas.
 *     - estado/listar   → solo SUS lotes.
 *     - siguienteCodigo → igual que el founder (es solo el próximo número).
 *   El founder sigue viendo y operando todo, exactamente como antes.
 *
 * Variables de entorno (Vercel):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, SELLO_FOUNDER_EMAIL   (ya existen)
 *   TRAZ_SECRET, TRAZ_VPS_URL                                 (para lotes)
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const SELLO_FOUNDER_EMAIL = (process.env.SELLO_FOUNDER_EMAIL || '').toLowerCase().trim();
const TRAZ_SECRET = process.env.TRAZ_SECRET || '';
const TRAZ_VPS_URL = (process.env.TRAZ_VPS_URL || '').replace(/\/+$/, '');

const CODIGO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

function cliente() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

// ─── Público: lote sellado ──────────────────────────────────────
async function lotePublico(req, res) {
  const codigo = String((req.query && req.query.lote) || '').trim();
  if (!CODIGO_RE.test(codigo)) return res.status(400).json({ ok: false, error: 'Código de lote inválido.' });
  const { data, error } = await cliente().from('traz_lotes')
    .select('codigo, estado, paquete_canonical, paquete_hash, tx_hash, bloque, sellado_en')
    .eq('codigo', codigo).maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: 'No se pudo consultar el lote.' });
  if (!data || data.estado !== 'SELLADO') return res.status(404).json({ ok: false, error: 'No hay un lote sellado con ese código.' });
  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.status(200).json({
    ok: true, codigo: data.codigo, canonical: data.paquete_canonical, hashPaquete: data.paquete_hash,
    txHash: data.tx_hash, bloque: data.bloque, selladoEn: data.sellado_en,
    polygonscanTx: `https://polygonscan.com/tx/${data.tx_hash}`,
  });
}

// ─── Cliente: solo SUS parcelas (AJUSTE OFICINA) ────────────────
async function datosCliente(supabase, userId, res) {
  const { data, error } = await supabase.from('v_panel_parcelas').select(
    'id, activo_id_onchain, cliente_id, cliente, nombre_activo, superficie_ha, ' +
    'veredicto, ha_perdidas, cobertura, ultimo_sello, fecha_alta, sellada_onchain'
  ).eq('cliente_id', userId).order('fecha_alta', { ascending: false });
  if (error) {
    console.error('[panel/oficina] Error leyendo parcelas:', error);
    return res.status(500).json({ ok: false, error: 'No se pudieron leer tus parcelas.' });
  }
  return res.status(200).json({ ok: true, generado: new Date().toISOString(), parcelas: data || [] });
}

// ¿Todas estas parcelas (por ID on-chain) son de este cliente?
async function sonDelCliente(supabase, ids, userId) {
  const lista = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!lista.length) return false;
  const { data, error } = await supabase.from('activos')
    .select('activo_id_onchain, cliente_id').in('activo_id_onchain', lista);
  if (error || !data || data.length !== lista.length) return false;
  return data.every((a) => String(a.cliente_id) === String(userId));
}

// ─── Founder: panel ─────────────────────────────────────────────
async function datosPanel(supabase, res) {
  const [clientes, parcelas] = await Promise.all([
    supabase.from('v_panel_clientes').select('*').order('parcelas', { ascending: false }),
    supabase.from('v_panel_parcelas').select(
      'id, activo_id_onchain, cliente_id, cliente, nombre_activo, superficie_ha, ' +
      'modo_certificacion, veredicto, ha_perdidas, cobertura, cobertura_hasta, ' +
      'ultimo_sello, fecha_alta, sellada_onchain'
    ).order('fecha_alta', { ascending: false }),
  ]);
  if (clientes.error || parcelas.error) {
    console.error('[panel] Error leyendo vistas:', clientes.error || parcelas.error);
    return res.status(500).json({ ok: false, error: 'No se pudieron leer los datos del panel.' });
  }
  return res.status(200).json({ ok: true, generado: new Date().toISOString(), clientes: clientes.data || [], parcelas: parcelas.data || [] });
}

// ─── Founder: lotes ─────────────────────────────────────────────
async function llamarVps(datos, ejecutar) {
  const ctrl = new AbortController();
  const corte = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(`${TRAZ_VPS_URL}/lote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-traz-secret': TRAZ_SECRET },
      body: JSON.stringify({ ...datos, ejecutar }),
      signal: ctrl.signal,
    });
    return await r.json().catch(() => ({ ok: false, error: 'Respuesta inválida del servidor de trazabilidad.' }));
  } finally {
    clearTimeout(corte);
  }
}

async function accionLote(supabase, body, res, soloCliente) {
  // soloCliente: null = founder (todo) · id de usuario = cliente (solo lo suyo)
  const accion = body.accion;
  if (accion === 'estado') {
    const codigo = String(body.codigo || '').trim();
    if (!codigo) return res.status(400).json({ ok: false, error: 'Falta el código.' });
    const { data, error } = await supabase.from('traz_lotes')
      .select('codigo, estado, error, veredicto, tx_hash, bloque, sellado_en, toneladas, cliente_id').eq('codigo', codigo).maybeSingle();
    if (error) return res.status(500).json({ ok: false, error: 'No se pudo leer el lote.' });
    if (data && soloCliente && String(data.cliente_id) !== String(soloCliente)) {
      return res.status(200).json({ ok: true, lote: null });
    }
    if (data) delete data.cliente_id;
    return res.status(200).json({ ok: true, lote: data || null });
  }
  if (accion === 'listar') {
    const clienteId = soloCliente ? String(soloCliente) : String(body.clienteId || '').trim();
    if (!clienteId) return res.status(400).json({ ok: false, error: 'Falta el cliente.' });
    const { data, error } = await supabase.from('traz_lotes')
      .select('codigo, estado, cultivo, anio, fecha, toneladas, tx_hash, sellado_en, error')
      .eq('cliente_id', clienteId).order('creado_en', { ascending: false });
    if (error) return res.status(500).json({ ok: false, error: 'No se pudieron leer los lotes.' });
    return res.status(200).json({ ok: true, lotes: data || [] });
  }
  // LOTE POR ID: lo que el sistema ya sabe de una parcela (cultivo y saldo).
  if (accion === 'infoParcela') {
    const id = Number(body.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: 'ID inválido.' });
    const anio = Number(body.anio) || new Date().getFullYear();
    const { data: act } = await supabase.from('activos')
      .select('activo_id_onchain, nombre_activo, cultivo, pais, cliente_id').eq('activo_id_onchain', id).maybeSingle();
    if (!act) return res.status(404).json({ ok: false, error: `No existe la parcela #${id}.` });
    if (soloCliente && String(act.cliente_id) !== String(soloCliente)) {
      return res.status(403).json({ ok: false, error: `La parcela #${id} no está registrada a tu nombre.` });
    }
    const { data: decls } = await supabase.from('traz_declaraciones')
      .select('id, cultivo, anio, capacidad_anual').eq('origen_tipo', 'epimeleia').eq('origen_ref', String(id))
      .eq('anio', anio).eq('veredicto', 'ACEPTADA').order('sellado_en', { ascending: false }).limit(1);
    const decl = (decls && decls[0]) || null;
    let usadas = 0;
    if (decl) {
      const { data: at } = await supabase.from('traz_atribuciones')
        .select('toneladas').eq('declaracion_id', decl.id).eq('veredicto', 'ATRIBUIDA');
      usadas = (at || []).reduce((s, x) => s + (Number(x.toneladas) || 0), 0);
    }
    return res.status(200).json({ ok: true, parcela: {
      id, nombre: act.nombre_activo, clienteId: act.cliente_id,
      cultivo: (decl && decl.cultivo) || act.cultivo || null, pais: act.pais || null, anio,
      capacidad: decl ? Number(decl.capacidad_anual) : null,
      usadas: Math.round(usadas * 1000) / 1000,
      saldo: decl ? Math.round((Number(decl.capacidad_anual) - usadas) * 1000) / 1000 : null,
    } });
  }
  // LOTE POR ID: el próximo código libre (LOTE-AAAA-NNN), para no inventarlo.
  if (accion === 'siguienteCodigo') {
    const anio = Number(body.anio) || new Date().getFullYear();
    const pref = `LOTE-${anio}-`;
    const { data } = await supabase.from('traz_lotes').select('codigo').like('codigo', pref + '%');
    let max = 0;
    for (const f of data || []) { const n = parseInt(String(f.codigo).slice(pref.length), 10); if (n > max) max = n; }
    return res.status(200).json({ ok: true, codigo: pref + String(max + 1).padStart(3, '0') });
  }
  if (accion === 'simular' || accion === 'sellar') {
    if (!TRAZ_SECRET || !TRAZ_VPS_URL) return res.status(500).json({ ok: false, error: 'Faltan TRAZ_SECRET o TRAZ_VPS_URL en Vercel.' });
    if (soloCliente) {
      const ids = (Array.isArray(body.parcelas) ? body.parcelas : []).map((p) => p && p.activoIdOnchain);
      if (!(await sonDelCliente(supabase, ids, soloCliente))) {
        return res.status(403).json({ ok: false, error: 'Solo podés armar lotes con parcelas registradas a tu nombre.' });
      }
    }
    const datos = { codigo: body.codigo, cultivo: body.cultivo, anio: body.anio, fecha: body.fecha, receptor: body.receptor, parcelas: body.parcelas };
    try {
      return res.status(200).json(await llamarVps(datos, accion === 'sellar'));
    } catch (err) {
      console.error('[panel/lote] VPS no respondió:', err.message);
      return res.status(502).json({ ok: false, error: 'El servidor de trazabilidad no respondió. Probá de nuevo.' });
    }
  }
  return res.status(400).json({ ok: false, error: 'Acción desconocida.' });
}

module.exports = async function handler(req, res) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ ok: false, error: 'Configuración incompleta del servidor.' });
  }

  if (req.method === 'GET') return lotePublico(req, res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'Método no permitido.' });
  }
  if (!SELLO_FOUNDER_EMAIL) return res.status(500).json({ ok: false, error: 'Configuración incompleta del servidor.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};
  const token = typeof body.token === 'string' ? body.token : '';
  if (!token) return res.status(401).json({ ok: false, error: 'Falta la sesión. Iniciá sesión.' });

  const supabase = cliente();
  const { data: u, error: eU } = await supabase.auth.getUser(token);
  if (eU || !u || !u.user) return res.status(401).json({ ok: false, error: 'Tu sesión no es válida. Iniciá sesión de nuevo.' });
  const esFounder = (u.user.email || '').toLowerCase().trim() === SELLO_FOUNDER_EMAIL;

  res.setHeader('Cache-Control', 'no-store');

  // AJUSTE OFICINA: el cliente pasa, pero solo con lo suyo.
  // modo 'oficina' lo pide oficina.html; así el founder también puede ver
  // SU propia oficina sin que se mezcle con la cartera completa.
  const modoOficina = body.modo === 'oficina' || !esFounder;
  if (modoOficina) {
    if (body.accion) return accionLote(supabase, body, res, u.user.id);
    return datosCliente(supabase, u.user.id, res);
  }

  if (body.accion) return accionLote(supabase, body, res, null);
  return datosPanel(supabase, res);
};