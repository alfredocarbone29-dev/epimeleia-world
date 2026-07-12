/**
 * EPIMELEIA · /api/registrar-activo.js  (Vercel)
 * ─────────────────────────────────────────────
 * EL PUENTE QUE FALTABA.
 *
 * Hasta hoy, cuando el cliente apretaba "REGISTRAR Y CERTIFICAR" en el mapa,
 * los datos se mandaban a /api/registrar-activo ... que no existía. Se perdían
 * en el vacío.
 *
 * Este archivo es esa puerta. Su único trabajo, por ahora, es SIMPLE y SÓLIDO:
 *   1. Recibir lo que el mapa dibujó.
 *   2. Validar que venga lo mínimo indispensable.
 *   3. Guardarlo en la tabla `activos` de Supabase.
 *   4. Devolver el id del activo creado.
 *
 * LO QUE NO HACE (a propósito — son pasos siguientes):
 *   · NO sella en Polygon todavía.
 *   · NO genera el PDF.
 *   · NO manda email.
 *   · NO cobra.
 * Eso se cuelga encima una vez que ESTO funcione y esté probado.
 *
 * Se apoya en las mismas variables de entorno que ya usa /api/scheduler.js:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 * (Ya están configuradas en Vercel. No hay que tocar nada.)
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Traduce el "tipo" que manda el mapa al código interno del protocolo ───
// El mapa manda textos como "Bosque / forestación". El satélite y el resto
// del sistema trabajan con un tipo simple. Este diccionario los une.
// Si llega algo que no está acá, se guarda tal cual y se marca para revisar.
const MAPA_TIPOS = {
  'Bosque / forestación':            'FORESTAL',
  'Cuenca hídrica / cuerpo de agua': 'HIDRICO',
  'Minería / suelo intervenido':     'MINERIA',
  'Glaciar / reserva de hielo':      'GLACIAR',
  'Campo / vegetación agrícola':     'AGRICOLA',
  'Otro':                            'OTRO',
};

export default async function handler(req, res) {
  // Solo aceptamos POST (el mapa manda con POST).
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Método no permitido. Usá POST.' });
  }

  try {
    const datos = req.body;

    // ── 1) VALIDACIÓN — que venga lo mínimo indispensable ──
    // Sin polígono no hay activo. Sin nombre, no sabemos qué es.
    const faltan = [];
    if (!datos?.nombre || !datos.nombre.trim()) faltan.push('nombre');
    if (!datos?.coordinates || !Array.isArray(datos.coordinates)) faltan.push('coordinates (el polígono)');
    if (datos?.area_ha == null) faltan.push('area_ha');

    if (faltan.length) {
      return res.status(400).json({
        ok: false,
        error: 'Faltan datos para registrar el activo.',
        faltan,
      });
    }

    // ── 2) ARMAR el polígono en formato GeoJSON estándar ──
    // El mapa manda coordinates como array de puntos. Lo guardamos como un
    // GeoJSON Polygon completo, que es el formato que después leen el satélite
    // y el sello. Un solo formato para todo el sistema.
    const poligono = {
      type: 'Polygon',
      coordinates: [datos.coordinates],  // GeoJSON envuelve el anillo en un array
    };

    // ── 3) MAPEAR el tipo del mapa al tipo interno ──
    const tipoInterno = MAPA_TIPOS[datos.tipo] || 'OTRO';

    // ── 4) ARMAR la fila para Supabase ──
    // Solo llenamos lo que el mapa nos da de verdad. El resto queda para
    // los pasos siguientes:
    //   · cliente_id       → cuando esté el login con Google
    //   · activo_id_onchain, ultimo_hash, ultimo_bloque → cuando se selle
    //   · ultima_medicion  → cuando el satélite mida
    //   · tier, precio     → cuando definas los precios finales
    // El estado nace en 'alta': registrado, todavía sin certificar ni pagar.
    const fila = {
      nombre_activo:          datos.nombre.trim(),
      tipo:                   tipoInterno,
      poligono:               poligono,
      superficie_ha:          Number(datos.area_ha)  || null,
      superficie_km2:         Number(datos.area_km2) || null,
      // El polígono llega del mapa pero TODAVÍA no está "confirmado" en el
      // sentido de la doble aceptación. Eso es un paso aparte. Por ahora false.
      poligono_confirmado:    false,
      estado:                 'alta',
      // fecha_alta y fecha_creacion las pone Supabase solas (default now()).
    };

    // ── 5) GUARDAR en Supabase ──
    const { data, error } = await supabase
      .from('activos')
      .insert(fila)
      .select('id, nombre_activo, superficie_ha, estado')
      .single();

    if (error) {
      console.error('[registrar-activo] Error de Supabase:', error);
      return res.status(500).json({
        ok: false,
        error: 'No se pudo guardar el activo.',
        detalle: error.message,
      });
    }

    // ── 6) RESPONDER al mapa: quedó guardado ──
    console.log('[registrar-activo] Activo guardado:', data.id, '·', data.nombre_activo);
    return res.status(200).json({
      ok: true,
      mensaje: 'Tu activo quedó registrado.',
      activo: {
        id:        data.id,
        nombre:    data.nombre_activo,
        area_ha:   data.superficie_ha,
        estado:    data.estado,
      },
      // Nota honesta para el front: guardado sí, certificado todavía no.
      siguiente_paso: 'El activo está registrado. La certificación y el pago vienen después.',
    });

  } catch (err) {
    console.error('[registrar-activo] Error inesperado:', err);
    return res.status(500).json({
      ok: false,
      error: 'Error inesperado al registrar el activo.',
      detalle: err.message,
    });
  }
}
