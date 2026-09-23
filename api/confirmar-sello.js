/**
 * EPIMELEIA · /api/confirmar-sello.js  (Vercel · EL PUENTE)
 * ═════════════════════════════════════════════════════════════
 * El puente entre TU PÁGINA (cuenta.html, servida por Vercel) y la
 * PUERTA DEL SELLO (servidor-sello.js, corriendo en el VPS).
 *
 * QUÉ HACE, en cuatro pasos:
 *   1. Recibe el pedido del botón: { filaId, ejecutar, token }.
 *   2. VERIFICA QUE SOS VOS: usa el token de tu sesión de Supabase para
 *      preguntarle a Supabase quién sos. Solo el FOUNDER puede sellar.
 *   3. Si sos vos, le pasa el pedido a la puerta del VPS, con la clave
 *      secreta compartida (que nadie más conoce).
 *   4. Devuelve el resultado del VPS al botón.
 *
 * POR QUÉ ESTE PUENTE EXISTE (y el botón no le habla directo al VPS):
 *   · La clave secreta del VPS NUNCA debe estar en el navegador (cualquiera
 *     la vería). Vive solo acá, en el servidor de Vercel, como variable de
 *     entorno. El navegador no la toca.
 *   · La verificación de identidad se hace del lado del servidor (acá), no
 *     en el navegador — donde cualquiera podría saltearla.
 *
 * SEGURIDAD — DOS CANDADOS:
 *   1. IDENTIDAD: verifica contra Supabase que el token es de un usuario
 *      real, y que su email es el del FOUNDER. Sin eso, rechaza.
 *   2. CLAVE DEL VPS: le habla a la puerta con SELLO_SECRET, que solo
 *      conocen este puente y el VPS.
 *
 * VARIABLES DE ENTORNO NECESARIAS EN VERCEL:
 *   SUPABASE_URL           (ya existe — la usa registrar-activo.js)
 *   SUPABASE_SERVICE_KEY   (ya existe — la usa registrar-activo.js)
 *   SELLO_SECRET           (NUEVA — la misma clave que en el .env del VPS)
 *   SELLO_VPS_URL          (NUEVA — http://67.205.154.84:8790/sellar)
 *   SELLO_FOUNDER_EMAIL          (NUEVA — alfredocarbone29@gmail.com)
 * ═════════════════════════════════════════════════════════════
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SELLO_SECRET  = process.env.SELLO_SECRET  || '';
const SELLO_VPS_URL = process.env.SELLO_VPS_URL || '';
const SELLO_FOUNDER_EMAIL = (process.env.SELLO_FOUNDER_EMAIL || '').toLowerCase().trim();

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Método no permitido. Usá POST.' });
  }

  // Chequeo de configuración: si falta algo, se dice claro (no se sella a ciegas).
  if (!SELLO_SECRET || !SELLO_VPS_URL || !SELLO_FOUNDER_EMAIL) {
    console.error('[confirmar-sello] Faltan variables de entorno en Vercel.');
    return res.status(500).json({ ok: false, error: 'El sistema de sellado no está configurado. Avisá al equipo.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { filaId, ejecutar, token } = body;

    if (!token)  return res.status(401).json({ ok: false, error: 'Falta el token de sesión. Iniciá sesión de nuevo.' });
    if (!filaId) return res.status(400).json({ ok: false, error: 'Falta el id del activo a sellar.' });

    // ── CANDADO 1: ¿SOS VOS? ──────────────────────────────────────
    // Le preguntamos a Supabase de quién es este token. Si el token es
    // inválido o vencido, Supabase no devuelve usuario → se rechaza.
    const { data: userData, error: errUser } = await supabase.auth.getUser(token);

    if (errUser || !userData || !userData.user) {
      console.warn('[confirmar-sello] Token inválido o vencido.');
      return res.status(401).json({ ok: false, error: 'Tu sesión no es válida. Iniciá sesión de nuevo.' });
    }

    const emailQuienPide = (userData.user.email || '').toLowerCase().trim();

    // Solo el FOUNDER puede sellar. Un cliente logueado NO.
    if (emailQuienPide !== SELLO_FOUNDER_EMAIL) {
      console.warn(`[confirmar-sello] RECHAZADO · ${emailQuienPide} no es el founder.`);
      return res.status(403).json({ ok: false, error: 'No tenés permiso para esta acción.' });
    }

    // ── CANDADO 2: le hablamos a la puerta del VPS con la clave ───
    console.log(`[confirmar-sello] Founder OK · sellando fila ${filaId} · ejecutar=${ejecutar === true}`);

    let respuestaVPS;
    try {
      const r = await fetch(SELLO_VPS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-sello-secret': SELLO_SECRET,
        },
        body: JSON.stringify({ filaId, ejecutar: ejecutar === true }),
        // el sellado real puede tardar (mide satélite + on-chain): damos margen
        signal: AbortSignal.timeout(120000),
      });
      respuestaVPS = await r.json();
    } catch (errVPS) {
      console.error('[confirmar-sello] No se pudo contactar al VPS:', errVPS.message);
      return res.status(502).json({
        ok: false,
        error: 'No se pudo contactar al motor de sellado. Puede estar procesando o caído. Probá en un momento.',
      });
    }

    // Devolvemos tal cual lo que respondió el VPS (simulacro o sellado real).
    console.log(`[confirmar-sello] VPS respondió · ok=${respuestaVPS?.ok}`);
    return res.status(200).json(respuestaVPS);

  } catch (err) {
    console.error('[confirmar-sello] Error inesperado:', err);
    return res.status(500).json({ ok: false, error: 'Error inesperado. Probá de nuevo.' });
  }
};
