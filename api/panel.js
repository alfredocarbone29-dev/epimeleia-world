/**
 * api/panel.js — Panel de cartera (SOLO FOUNDER)
 *
 * Devuelve el resumen por cliente y el detalle de parcelas, leyendo las
 * vistas v_panel_clientes y v_panel_parcelas de Supabase.
 *
 * Mismo candado que api/confirmar-sello.js:
 *   1. La página manda el access_token de la sesión de Supabase.
 *   2. Le preguntamos a Supabase quién es el dueño de ese token.
 *   3. Si el email no es SELLO_FOUNDER_EMAIL, rechazamos (403).
 *
 * Solo lee. No escribe ni modifica nada.
 *
 * Variables de entorno (ya existen en Vercel, no hay que crear ninguna):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   SELLO_FOUNDER_EMAIL
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const SELLO_FOUNDER_EMAIL = (process.env.SELLO_FOUNDER_EMAIL || '')
  .toLowerCase()
  .trim();

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Método no permitido.' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !SELLO_FOUNDER_EMAIL) {
    console.error('[panel] Faltan variables de entorno.');
    return res.status(500).json({ ok: false, error: 'Configuración incompleta del servidor.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  const token = body && typeof body.token === 'string' ? body.token : '';
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Falta la sesión. Iniciá sesión.' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── CANDADO: ¿quién sos? ──
  const { data: userData, error: errUser } = await supabase.auth.getUser(token);
  if (errUser || !userData || !userData.user) {
    console.warn('[panel] Token inválido o vencido.');
    return res.status(401).json({ ok: false, error: 'Tu sesión no es válida. Iniciá sesión de nuevo.' });
  }

  const emailQuienPide = (userData.user.email || '').toLowerCase().trim();
  if (emailQuienPide !== SELLO_FOUNDER_EMAIL) {
    console.warn(`[panel] RECHAZADO · ${emailQuienPide} no es el founder.`);
    return res.status(403).json({ ok: false, error: 'No tenés permiso para ver este panel.' });
  }

  // ── Founder OK: leemos las vistas ──
  const [clientes, parcelas] = await Promise.all([
    supabase.from('v_panel_clientes').select('*').order('parcelas', { ascending: false }),
    supabase
      .from('v_panel_parcelas')
      .select(
        'id, activo_id_onchain, cliente_id, cliente, nombre_activo, superficie_ha, ' +
          'modo_certificacion, veredicto, ha_perdidas, cobertura, cobertura_hasta, ' +
          'ultimo_sello, fecha_alta, sellada_onchain'
      )
      .order('fecha_alta', { ascending: false }),
  ]);

  if (clientes.error || parcelas.error) {
    console.error('[panel] Error leyendo vistas:', clientes.error || parcelas.error);
    return res.status(500).json({ ok: false, error: 'No se pudieron leer los datos del panel.' });
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ok: true,
    generado: new Date().toISOString(),
    clientes: clientes.data || [],
    parcelas: parcelas.data || [],
  });
};
