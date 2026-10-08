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

async function accionLote(supabase, body, res) {
  const accion = body.accion;
  if (accion === 'estado') {
    const codigo = String(body.codigo || '').trim();
    if (!codigo) return res.status(400).json({ ok: false, error: 'Falta el código.' });
    const { data, error } = await supabase.from('traz_lotes')
      .select('codigo, estado, error, veredicto, tx_hash, bloque, sellado_en, toneladas').eq('codigo', codigo).maybeSingle();
    if (error) return res.status(500).json({ ok: false, error: 'No se pudo leer el lote.' });
    return res.status(200).json({ ok: true, lote: data || null });
  }
  if (accion === 'listar') {
    const clienteId = String(body.clienteId || '').trim();
    if (!clienteId) return res.status(400).json({ ok: false, error: 'Falta el cliente.' });
    const { data, error } = await supabase.from('traz_lotes')
      .select('codigo, estado, cultivo, anio, fecha, toneladas, tx_hash, sellado_en, error')
      .eq('cliente_id', clienteId).order('creado_en', { ascending: false });
    if (error) return res.status(500).json({ ok: false, error: 'No se pudieron leer los lotes.' });
    return res.status(200).json({ ok: true, lotes: data || [] });
  }
  if (accion === 'simular' || accion === 'sellar') {
    if (!TRAZ_SECRET || !TRAZ_VPS_URL) return res.status(500).json({ ok: false, error: 'Faltan TRAZ_SECRET o TRAZ_VPS_URL en Vercel.' });
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
  if ((u.user.email || '').toLowerCase().trim() !== SELLO_FOUNDER_EMAIL) {
    console.warn('[panel] RECHAZADO · no es el founder');
    return res.status(403).json({ ok: false, error: 'No tenés permiso para ver este panel.' });
  }

  res.setHeader('Cache-Control', 'no-store');
  if (body.accion) return accionLote(supabase, body, res);
  return datosPanel(supabase, res);
};
