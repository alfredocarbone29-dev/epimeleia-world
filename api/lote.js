/**
 * api/lote.js — Certificado de lote (SOLO FOUNDER)
 *
 * Mismo candado que api/panel.js y api/confirmar-sello.js: la página manda
 * el access_token de Supabase; si el email no es SELLO_FOUNDER_EMAIL → 403.
 *
 * Acciones (body.accion):
 *   'simular' → pide al VPS (traz /lote, ejecutar:false) el veredicto. No gasta gas.
 *   'sellar'  → pide al VPS que atribuya y selle (ejecutar:true). El VPS responde
 *               al instante y sella en segundo plano.
 *   'estado'  → lee traz_lotes por código (para ir viendo cómo avanza).
 *   'listar'  → lotes de un cliente (cliente_id).
 *
 * Variables de entorno en Vercel:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, SELLO_FOUNDER_EMAIL   (ya existen)
 *   TRAZ_SECRET    la misma clave que TRAZ_SECRET del .env del VPS
 *   TRAZ_VPS_URL   ej. http://67.205.154.84:8791   (sin /lote al final)
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const SELLO_FOUNDER_EMAIL = (process.env.SELLO_FOUNDER_EMAIL || '').toLowerCase().trim();
const TRAZ_SECRET = process.env.TRAZ_SECRET || '';
const TRAZ_VPS_URL = (process.env.TRAZ_VPS_URL || '').replace(/\/+$/, '');

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
    const cuerpo = await r.json().catch(() => ({ ok: false, error: 'Respuesta inválida del servidor de trazabilidad.' }));
    return cuerpo;
  } finally {
    clearTimeout(corte);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Método no permitido.' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !SELLO_FOUNDER_EMAIL) {
    return res.status(500).json({ ok: false, error: 'Configuración incompleta del servidor.' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};

  const token = typeof body.token === 'string' ? body.token : '';
  if (!token) return res.status(401).json({ ok: false, error: 'Falta la sesión. Iniciá sesión.' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: u, error: eU } = await supabase.auth.getUser(token);
  if (eU || !u || !u.user) return res.status(401).json({ ok: false, error: 'Tu sesión no es válida. Iniciá sesión de nuevo.' });
  if ((u.user.email || '').toLowerCase().trim() !== SELLO_FOUNDER_EMAIL) {
    console.warn('[lote] RECHAZADO · no es el founder');
    return res.status(403).json({ ok: false, error: 'No tenés permiso para armar lotes.' });
  }

  res.setHeader('Cache-Control', 'no-store');
  const accion = body.accion;

  if (accion === 'estado') {
    const codigo = String(body.codigo || '').trim();
    if (!codigo) return res.status(400).json({ ok: false, error: 'Falta el código.' });
    const { data, error } = await supabase.from('traz_lotes')
      .select('codigo, estado, error, veredicto, tx_hash, bloque, sellado_en, toneladas')
      .eq('codigo', codigo).maybeSingle();
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
    if (!TRAZ_SECRET || !TRAZ_VPS_URL) {
      return res.status(500).json({ ok: false, error: 'Faltan TRAZ_SECRET o TRAZ_VPS_URL en Vercel.' });
    }
    const datos = {
      codigo: body.codigo, cultivo: body.cultivo, anio: body.anio,
      fecha: body.fecha, receptor: body.receptor, parcelas: body.parcelas,
    };
    try {
      const r = await llamarVps(datos, accion === 'sellar');
      return res.status(200).json(r);
    } catch (err) {
      console.error('[lote] VPS no respondió:', err.message);
      return res.status(502).json({ ok: false, error: 'El servidor de trazabilidad no respondió. Probá de nuevo.' });
    }
  }

  return res.status(400).json({ ok: false, error: 'Acción desconocida.' });
};
