// redactarDeforestacionHistorica.js
//
// Convierte el JSON guardado en la columna `deforestacion_historica` de la
// tabla `activos` (el resultado de consultarDeforestacionHistorica.js) en un
// párrafo en español, listo para insertar en el certificado del cliente.
//
// Sigue la misma lógica honesta que ya usás en reports.js para los informes
// quincenales: casos claros, sin adornos, siempre citando la fuente y la
// resolución del dato — eso es lo que le da credibilidad frente a un
// auditor o comprador.
//
// ---------------------------------------------------------------------------
// CÓMO USAR ESTE ARCHIVO:
//
// 1. Subilo a la carpeta lib/ de tu repo, junto a consultarDeforestacionHistorica.js
//
// 2. Importalo donde armes el contenido del certificado (el archivo que
//    genera el PDF o la página que ve el cliente):
//
//        const { redactarDeforestacionHistorica } = require('./redactarDeforestacionHistorica');
//        const parrafo = redactarDeforestacionHistorica(activo.deforestacion_historica);
//
// 3. "parrafo" es un string listo para mostrar tal cual, ya sea en el PDF,
//    en la página del certificado, o en el email de confirmación.
// ---------------------------------------------------------------------------

/**
 * @param {Object|null} datos - el contenido de la columna deforestacion_historica
 *   (puede ser null si el chequeo todavía no corrió o falló)
 * @returns {string} párrafo en español, listo para mostrar
 */
function redactarDeforestacionHistorica(datos) {
  // CASO 1 — el chequeo no corrió o falló (dato ausente)
  // Pasa si GFW estaba caído en el momento del registro, o si es un activo
  // registrado antes de que existiera esta función. Se dice la verdad: no
  // se especula con un resultado que no se tiene.
  if (!datos) {
    return (
      'El análisis histórico de deforestación para este predio todavía no ' +
      'está disponible. Puede deberse a que el activo fue registrado antes ' +
      'de incorporarse esta verificación, o a una interrupción temporal en ' +
      'el servicio de datos satelitales. EPIMELEIA puede generar este ' +
      'análisis a pedido.'
    );
  }

  const {
    huboDeforestacion,
    totalHectareasPerdidas,
    detallePorAnio = [],
    periodoAnalizado,
    fuente,
    resolucion,
  } = datos;

  // CASO 2 — no se detectó pérdida de cobertura forestal
  if (!huboDeforestacion) {
    return (
      `Se analizó el polígono de este predio contra el registro histórico ` +
      `satelital correspondiente al período ${periodoAnalizado}. ` +
      `No se detectó pérdida de cobertura forestal en esa superficie durante ` +
      `ese período. Este análisis se basa en ${fuente}, con una resolución ` +
      `de ${resolucion} por píxel — la misma metodología utilizada por ` +
      `organismos internacionales y programas de cumplimiento ambiental. ` +
      `Al tratarse de una fuente pública y de acceso abierto, el resultado ` +
      `puede ser verificado de forma independiente por cualquier tercero.`
    );
  }

  // CASO 3 — sí se detectó pérdida de cobertura forestal
  // Se listan los años con pérdida real (>0 ha) para que el lector vea el
  // detalle temporal, no solo el total acumulado.
  const aniosConPerdida = detallePorAnio.filter(d => d.hectareas > 0);
  const detalleTexto = aniosConPerdida.length
    ? aniosConPerdida
        .map(d => `${d.hectareas.toFixed(2)} ha en ${d.anio}`)
        .join(', ')
    : 'sin desglose disponible por año';

  return (
    `Se analizó el polígono de este predio contra el registro histórico ` +
    `satelital correspondiente al período ${periodoAnalizado}. ` +
    `Se detectó una pérdida de cobertura forestal total de ` +
    `${totalHectareasPerdidas.toFixed(2)} hectáreas en ese período ` +
    `(${detalleTexto}). Este análisis se basa en ${fuente}, con una ` +
    `resolución de ${resolucion} por píxel. Al tratarse de una fuente ` +
    `pública y de acceso abierto, este resultado puede ser verificado de ` +
    `forma independiente por cualquier tercero — comprador, banco o ` +
    `auditor — sin depender de la palabra del productor.`
  );
}

module.exports = { redactarDeforestacionHistorica };
