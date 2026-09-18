// consultarDeforestacionHistorica.js
//
// Consulta la pérdida de cobertura forestal histórica (2020 → hoy) para un
// polígono dibujado por el productor, usando la Global Forest Watch Data API v3.
//
// Fuente de datos: Hansen et al. (2013), "High-Resolution Global Maps of
// 21st-Century Forest Cover Change", Science. Dataset umd_tree_cover_loss.
// Cobertura global, resolución 30m, actualización anual, licencia CC BY 4.0.
//
// ---------------------------------------------------------------------------
// CÓMO USAR ESTE ARCHIVO (paso a paso, sin tocar nada del código):
//
// 1. Subilo a tu repo de GitHub, en la misma carpeta donde tenés reports.js
//    (probablemente algo como /lib o /server, la que uses para funciones
//    de backend).
//
// 2. Conseguí una API key gratuita:
//    - Entrá a https://www.globalforestwatch.org/my-gfw/
//    - Creá una cuenta (gratis)
//    - Buscá la sección "API keys" / "Manage API keys"
//    - Generá una key nueva, ponele un nombre como "epimeleia-produccion"
//
// 3. Agregá esa key como variable de entorno en tu VPS:
//    - Entrá al archivo .env de tu proyecto (o donde tengas las otras keys
//      como las de SendGrid, Supabase, etc.)
//    - Agregá esta línea:
//        GFW_API_KEY=la_key_que_te_dio_globalforestwatch
//    - Reiniciá el proceso con PM2: pm2 restart epimeleia-oracle
//      (o el nombre que tenga tu proceso principal)
//
// 4. En el archivo donde manejás el submit del Paso 1 (cuando el usuario
//    termina de dibujar el polígono), importá y llamá la función:
//
//        const { consultarDeforestacionHistorica } = require('./consultarDeforestacionHistorica');
//        const resultado = await consultarDeforestacionHistorica(polygonGeoJSON);
//        // guardá "resultado" en la fila de Supabase asociada a ese predio
//
// 5. Probalo primero con UN polígono de prueba (por ejemplo el mismo predio
//    de "Mar de Aral" que ya tenés registrado) y fijate que la respuesta
//    tenga sentido antes de ponerlo en producción para clientes reales.
// ---------------------------------------------------------------------------

const GFW_API_BASE = 'https://data-api.globalforestwatch.org';

/**
 * Consulta la pérdida de cobertura forestal en un polígono, año por año,
 * desde anioInicio hasta el presente.
 *
 * @param {Object} polygon - GeoJSON Polygon o MultiPolygon (el mismo formato
 *   que ya generás al dibujar en protocolo.html)
 * @param {number} [anioInicio=2020] - año base de comparación. 2020 porque
 *   es el corte que usa la regulación europea EUDR (31/12/2020).
 * @returns {Promise<Object>} objeto con el resultado, listo para guardar en
 *   Supabase e inyectar en el certificado del Paso 4.
 */
async function consultarDeforestacionHistorica(polygon, anioInicio = 2020) {
  if (!process.env.GFW_API_KEY) {
    throw new Error(
      'Falta la variable de entorno GFW_API_KEY. Revisá el paso 2 y 3 de las ' +
      'instrucciones al principio de este archivo.'
    );
  }

  const anioActual = new Date().getFullYear();

  // OJO: no le ponemos límite superior de año a la consulta (ej. "<= anioActual").
  // El dataset de GFW se actualiza una vez por año y puede no tener todavía
  // datos del año en curso; pedirle un año que no existe en su codificación
  // interna hace que la API devuelva un error 500 ("Value XXXX not in pixel
  // encoding..."). Pidiendo solo "desde 2020 en adelante", GFW nos devuelve
  // automáticamente lo último que tenga cargado, sin que haya que tocar este
  // código cada año.
  const query = `
    SELECT umd_tree_cover_loss__year AS anio,
           SUM(area__ha) AS hectareas_perdidas
    FROM umd_tree_cover_loss
    WHERE umd_tree_cover_loss__year >= ${anioInicio}
    GROUP BY umd_tree_cover_loss__year
    ORDER BY umd_tree_cover_loss__year
  `;

  let res;
  try {
    res = await fetch(`${GFW_API_BASE}/dataset/umd_tree_cover_loss/latest/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.GFW_API_KEY,
      },
      body: JSON.stringify({ sql: query, geometry: polygon }),
    });
  } catch (err) {
    // Error de red (VPS sin salida a internet, DNS, etc.)
    throw new Error(`No se pudo conectar con la API de Global Forest Watch: ${err.message}`);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '(sin detalle)');
    throw new Error(`GFW API respondió con error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const filas = data?.data || [];

  const totalHectareas = filas.reduce((acc, f) => acc + (Number(f.hectareas_perdidas) || 0), 0);
  const huboDeforestacion = totalHectareas > 0;

  return {
    huboDeforestacion,
    totalHectareasPerdidas: Number(totalHectareas.toFixed(4)),
    detallePorAnio: filas.map(f => ({
      anio: f.anio,
      hectareas: Number((Number(f.hectareas_perdidas) || 0).toFixed(4)),
    })),
    periodoAnalizado: `${anioInicio}-${anioActual}`,
    fuente: 'Hansen et al. (2013), Global Forest Watch / UMD GLAD — dataset umd_tree_cover_loss',
    resolucion: '30m',
    consultadoEl: new Date().toISOString(),
  };
}

module.exports = { consultarDeforestacionHistorica };
