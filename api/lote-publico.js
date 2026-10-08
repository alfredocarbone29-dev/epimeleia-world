/**
 * api/lote-publico.js — Lectura PÚBLICA de un lote sellado (para lote.html)
 *
 * GET /api/lote-publico?codigo=LOTE-2026-001
 *
 * Devuelve solo lotes en estado SELLADO y solo datos públicos: el paquete
 * canónico (sin email ni coordenadas, por diseño), su huella y la tx.
 * La página recalcula la huella en el navegador y la compara con la que
 * está escrita en Polygon; no tiene que creerle a esta respuesta.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Método no permitido.' });
  }
  const codigo = String((req.query && req.query.codigo) || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(codigo)) {
    return res.status(400).json({ ok: false, error: 'Código de lote inválido.' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await supabase.from('traz_lotes')
    .select('codigo, estado, paquete_canonical, paquete_hash, tx_hash, bloque, sellado_en')
    .eq('codigo', codigo).maybeSingle();

  if (error) return res.status(500).json({ ok: false, error: 'No se pudo consultar el lote.' });
  if (!data || data.estado !== 'SELLADO') {
    return res.status(404).json({ ok: false, error: 'No hay un lote sellado con ese código.' });
  }

  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.status(200).json({
    ok: true,
    codigo: data.codigo,
    canonical: data.paquete_canonical,
    hashPaquete: data.paquete_hash,
    txHash: data.tx_hash,
    bloque: data.bloque,
    selladoEn: data.sellado_en,
    polygonscanTx: `https://polygonscan.com/tx/${data.tx_hash}`,
  });
};
