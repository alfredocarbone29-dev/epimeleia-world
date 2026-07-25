/**
 * EPIMELEIA · cobertura.js
 * ═════════════════════════════════════════════════════════════
 * EL CORTE POR BAJA — la parte aislada y segura.
 *
 * Contesta UNA sola pregunta sobre un activo:
 *
 *     ¿está al día para que se lo certifique, o dejó de pagar?
 *
 * Lee la columna `cobertura_hasta` de Supabase (la que escribe el
 * webhook de PayPal / Mercado Pago cada vez que confirma un cobro) y
 * la compara contra la fecha de la ventana satelital que se está
 * procesando. Nada más. No mide, no certifica, no escribe, no toca la
 * cadena. Solo LEE y DECIDE.
 *
 * Es una pieza AUTOCONTENIDA, igual que activo-supabase.js: si el
 * servicio se corta a la mitad, queda un archivo terminado y probado,
 * no un scheduler roto. Se engancha en scheduler.js recién en la
 * Fase 7, cuando el alta on-chain ate los dos mundos.
 *
 * ─────────────────────────────────────────────────────────────
 * LAS REGLAS (decisiones del fundador, 24/7/2026)
 * ─────────────────────────────────────────────────────────────
 *
 * · "Nadie está obligado a nada. Pagás y se certifica; dejás de pagar
 *   y se deja de certificar." No es un castigo: es que el acuerdo
 *   terminó. El activo queda DORMIDO, con todo su historial intacto.
 *   Si vuelve a pagar, retoma.
 *
 * · DEJAR DE PAGAR NO ES UN HUECO DE OPACIDAD. Un hueco significa que
 *   el satélite no pudo ver. La caja es otra cosa. Este módulo NUNCA
 *   registra un hueco — solo dice "no certifiques". El que llama decide
 *   qué hacer, y la decisión es: saltear el activo, sin marca.
 *
 * · TOLERANCIA DE UNA VENTANA. Una tarjeta que vence no es un cliente
 *   que se fue. Por eso, si la cobertura venció, todavía se certifica
 *   en la pasada actual (día 2 o 16). Si para la SIGUIENTE ventana
 *   sigue vencido, ahí sí se duerme. En la práctica: entre 1 y 15 días
 *   de gracia, y como mucho se regala UNA evidencia quincenal.
 *   Se eligió "una ventana" y no un número de días porque el sistema
 *   ya late al ritmo del 2 y el 16 — cualquier otro número obligaría a
 *   inventar un segundo reloj.
 *
 * · AL CIERRE DE TRIMESTRE, NO HAY TOLERANCIA. La evidencia quincenal
 *   es barata y se puede regalar. Pero el certificarQ es el sello
 *   formal, el que hace avanzar el Sello de Excelencia, y queda escrito
 *   para siempre en Polygon. Para ese, hay que estar al día de verdad.
 *   Regalar una foto es un gesto; regalar un trimestre certificado es
 *   otra cosa.
 *
 * ─────────────────────────────────────────────────────────────
 * POR QUÉ BUSCA POR filaId (id de la fila), NO POR activo_id_onchain
 * ─────────────────────────────────────────────────────────────
 *
 * La cobertura la escribe el webhook sobre la fila que se paga, y la
 * identifica por el `id` de la fila (el activoId que viajó en el
 * custom_id de PayPal). activo_id_onchain sigue vacío hasta la Fase 7.
 * Entonces la llave correcta para encontrar la cobertura es el id de
 * fila — la misma que usa traerActivoParaCertificado(). Buscar por
 * activo_id_onchain no encontraría nada hoy.
 *
 * ─────────────────────────────────────────────────────────────
 * VARIABLES DE ENTORNO (ya están en el .env del VPS)
 * ─────────────────────────────────────────────────────────────
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *
 * ─────────────────────────────────────────────────────────────
 * CÓMO PROBARLO
 * ─────────────────────────────────────────────────────────────
 *   node cobertura.js                      → lista activos con su estado de cobertura
 *   node cobertura.js <filaId>             → evalúa una fila puntual, ahora
 *   node cobertura.js <filaId> 2026-09-16  → la evalúa como si la ventana fuera esa fecha
 * ═════════════════════════════════════════════════════════════
 */

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const TABLA = 'activos';

// La tolerancia, en días. Es el ancho de UNA ventana quincenal: el
// sistema mide los días 2 y 16, así que dos ventanas seguidas están
// como mucho a ~15 días una de otra. Con 15 días de tolerancia, un
// activo que venció alcanza a recibir la pasada siguiente; si para la
// que viene después sigue vencido, ya cae fuera y se duerme.
//
// No es un reloj nuevo: es la distancia del reloj que ya existe.
const TOLERANCIA_DIAS = 15;
const MS_POR_DIA = 24 * 60 * 60 * 1000;

/**
 * El corazón de la decisión. No toca la base: recibe los datos ya
 * leídos y contesta. Se separa de la lectura para poder probar la
 * lógica sola, sin Supabase.
 *
 * @param {string|Date|null} coberturaHasta  valor de la columna (o null)
 * @param {Date}   fechaVentana       fecha de la ventana que se procesa
 * @param {boolean} esCierreDeTrimestre  true si esta ventana cierra el Q
 *
 * @returns {{
 *   puedeCertificar: boolean,
 *   estado: 'AL_DIA' | 'EN_TOLERANCIA' | 'VENCIDO' | 'SIN_COBERTURA',
 *   motivo: string,
 *   diasVencido: number|null
 * }}
 */
function evaluarCobertura(coberturaHasta, fechaVentana = new Date(), esCierreDeTrimestre = false) {
  // ── Sin cobertura registrada ──────────────────────────────────
  // La columna está en null: este activo nunca tuvo un pago confirmado
  // (o el webhook todavía no la escribió). No se certifica. No es un
  // hueco: es que no hay acuerdo de pago vigente.
  if (coberturaHasta === null || coberturaHasta === undefined || coberturaHasta === '') {
    return {
      puedeCertificar: false,
      estado: 'SIN_COBERTURA',
      motivo: 'El activo no tiene cobertura registrada (ningún pago confirmado). No se certifica.',
      diasVencido: null,
    };
  }

  const cobertura = new Date(coberturaHasta);
  if (isNaN(cobertura.getTime())) {
    // Dato corrupto. Se prefiere NO certificar antes que actuar sobre
    // una fecha que no se entiende. Se avisa con claridad.
    return {
      puedeCertificar: false,
      estado: 'SIN_COBERTURA',
      motivo: `cobertura_hasta no es una fecha válida: "${coberturaHasta}". No se certifica por las dudas.`,
      diasVencido: null,
    };
  }

  const ventana = fechaVentana instanceof Date ? fechaVentana : new Date(fechaVentana);

  // ── Al día ────────────────────────────────────────────────────
  // La cobertura llega hasta después de esta ventana: pagó, se certifica.
  if (cobertura.getTime() >= ventana.getTime()) {
    return {
      puedeCertificar: true,
      estado: 'AL_DIA',
      motivo: 'Cobertura vigente.',
      diasVencido: 0,
    };
  }

  // ── Venció: ¿cuánto hace? ─────────────────────────────────────
  const diasVencido = Math.floor((ventana.getTime() - cobertura.getTime()) / MS_POR_DIA);

  // Al cierre de trimestre no hay tolerancia: para el certificarQ hay
  // que estar al día de verdad.
  if (esCierreDeTrimestre) {
    return {
      puedeCertificar: false,
      estado: 'VENCIDO',
      motivo: `Cobertura vencida hace ${diasVencido} día(s). Es cierre de trimestre: sin tolerancia. No se certifica.`,
      diasVencido,
    };
  }

  // ── Ventana quincenal: tolerancia de una ventana ──────────────
  if (diasVencido <= TOLERANCIA_DIAS) {
    return {
      puedeCertificar: true,
      estado: 'EN_TOLERANCIA',
      motivo: `Cobertura vencida hace ${diasVencido} día(s), dentro de la tolerancia de ${TOLERANCIA_DIAS}. ` +
              `Se certifica esta ventana; si no paga, la próxima se duerme.`,
      diasVencido,
    };
  }

  // ── Fuera de tolerancia: dormido ──────────────────────────────
  return {
    puedeCertificar: false,
    estado: 'VENCIDO',
    motivo: `Cobertura vencida hace ${diasVencido} día(s), más que la tolerancia de ${TOLERANCIA_DIAS}. ` +
            `El activo queda dormido (sin hueco, con su historial intacto).`,
    diasVencido,
  };
}

/**
 * Lee la cobertura de una fila de Supabase y la evalúa contra la
 * ventana. Es la función que scheduler.js va a llamar (en Fase 7).
 *
 * Devuelve lo mismo que evaluarCobertura(), más el dato leído, para
 * que el log del scheduler pueda decir hasta cuándo estaba cubierto.
 *
 * NUNCA lanza por "no encontrado": eso es un resultado (no se certifica).
 * Solo lanza si Supabase mismo falla (red/credenciales), igual que
 * activo-supabase.js — así el scheduler lo trata como fallo del activo
 * y reintenta, en vez de saltearlo por error.
 *
 * @param {string|number} filaId  el id de la fila en `activos`
 * @param {Date} fechaVentana
 * @param {boolean} esCierreDeTrimestre
 */
async function evaluarCoberturaDeActivo(filaId, fechaVentana = new Date(), esCierreDeTrimestre = false) {
  if (filaId === null || filaId === undefined || filaId === '') {
    return {
      puedeCertificar: false,
      estado: 'SIN_COBERTURA',
      motivo: 'No se pasó el id de la fila.',
      diasVencido: null,
      coberturaHasta: null,
    };
  }

  const { data, error } = await supabase
    .from(TABLA)
    .select('id, nombre_activo, cobertura_hasta, suscripcion_id, estado')
    .eq('id', filaId)
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase falló leyendo cobertura (fila ${filaId}): ${error.message}`);
  }

  if (!data) {
    return {
      puedeCertificar: false,
      estado: 'SIN_COBERTURA',
      motivo: `No hay ninguna fila en 'activos' con id = ${filaId}.`,
      diasVencido: null,
      coberturaHasta: null,
    };
  }

  const evaluacion = evaluarCobertura(data.cobertura_hasta, fechaVentana, esCierreDeTrimestre);

  return {
    ...evaluacion,
    filaId: data.id,
    nombreActivo: data.nombre_activo ?? null,
    coberturaHasta: data.cobertura_hasta ?? null,
    suscripcionId: data.suscripcion_id ?? null,
  };
}

/**
 * Lista los activos con su estado de cobertura, para diagnóstico.
 * Solo lectura.
 */
async function listarCoberturas(fechaVentana = new Date()) {
  const { data, error } = await supabase
    .from(TABLA)
    .select('id, nombre_activo, cobertura_hasta, suscripcion_id, estado')
    .order('id', { ascending: true });

  if (error) throw new Error(`Supabase falló listando coberturas: ${error.message}`);

  return (data || []).map(a => {
    const ev = evaluarCobertura(a.cobertura_hasta, fechaVentana, false);
    return {
      filaId: a.id,
      nombreActivo: a.nombre_activo,
      coberturaHasta: a.cobertura_hasta,
      suscripcionId: a.suscripcion_id,
      estadoCobertura: ev.estado,
      puedeCertificar: ev.puedeCertificar,
    };
  });
}

// ═══════════════════════════════════════════════════════════════
//  PRUEBA  ·  node cobertura.js  [filaId]  [fechaVentana]
// ═══════════════════════════════════════════════════════════════

async function _prueba() {
  const L = (t = '') => console.log(t);

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    L('\n  ⛔ Falta SUPABASE_URL o SUPABASE_SERVICE_KEY en el .env.\n');
    process.exit(1);
  }

  const filaId      = process.argv[2];
  const fechaArg    = process.argv[3];
  const fechaVentana = fechaArg ? new Date(fechaArg) : new Date();

  L('');
  L('═'.repeat(64));
  L('  EPIMELEIA · cobertura.js — prueba (solo lee Supabase, no certifica)');
  L('═'.repeat(64));
  L(`  Ventana evaluada: ${fechaVentana.toISOString().slice(0, 10)}`);
  L(`  Tolerancia:       ${TOLERANCIA_DIAS} días (una ventana)`);

  // Panorama general.
  L('');
  L('  Cobertura de todos los activos:');
  L('');
  let lista;
  try {
    lista = await listarCoberturas(fechaVentana);
  } catch (e) {
    L('  ⛔ ' + e.message);
    process.exit(1);
  }

  if (lista.length === 0) {
    L('  (no hay activos)');
  } else {
    L('  fila                                 │ cobertura_hasta      │ estado        │ certifica');
    L('  ─────────────────────────────────────┼──────────────────────┼───────────────┼──────────');
    for (const a of lista) {
      const fila = String(a.filaId).slice(0, 36).padEnd(36);
      const cob  = a.coberturaHasta ? String(a.coberturaHasta).slice(0, 19).padEnd(20) : 'null'.padEnd(20);
      const est  = String(a.estadoCobertura).padEnd(13);
      const cert = a.puedeCertificar ? '   sí' : '   NO';
      L(`  ${fila} │ ${cob} │ ${est} │${cert}`);
    }
  }

  const alDia = lista.filter(a => a.puedeCertificar).length;
  L('');
  L(`  ${alDia} de ${lista.length} activos se certificarían en esta ventana.`);

  // Fila puntual.
  if (filaId !== undefined) {
    L('');
    L('─'.repeat(64));
    L(`  Evaluando la fila ${filaId}`);
    L('─'.repeat(64));
    try {
      // Se prueba en los dos modos: ventana quincenal y cierre de trimestre.
      const quincenal = await evaluarCoberturaDeActivo(filaId, fechaVentana, false);
      const cierre    = await evaluarCoberturaDeActivo(filaId, fechaVentana, true);

      L('');
      L(`    nombre:          ${quincenal.nombreActivo}`);
      L(`    cobertura_hasta: ${quincenal.coberturaHasta}`);
      L(`    suscripción:     ${quincenal.suscripcionId}`);
      L('');
      L('    En ventana quincenal:');
      L(`      certifica: ${quincenal.puedeCertificar ? 'SÍ' : 'NO'}  ·  estado: ${quincenal.estado}`);
      L(`      ${quincenal.motivo}`);
      L('');
      L('    En cierre de trimestre:');
      L(`      certifica: ${cierre.puedeCertificar ? 'SÍ' : 'NO'}  ·  estado: ${cierre.estado}`);
      L(`      ${cierre.motivo}`);
    } catch (e) {
      L('  ⛔ ' + e.message);
    }
  } else {
    L('');
    L('  Para evaluar una fila puntual:');
    L('    node cobertura.js <filaId>');
    L('    node cobertura.js <filaId> 2026-09-16   (como si la ventana fuera esa fecha)');
  }

  L('');
  L('  Nada de esto tocó la cadena, el scheduler ni el satélite.');
  L('');
  process.exit(0);
}

if (require.main === module) {
  _prueba();
}

module.exports = {
  evaluarCobertura,            // lógica pura, sin base (testeable sola)
  evaluarCoberturaDeActivo,    // lee Supabase + evalúa (la que usa scheduler)
  listarCoberturas,
  TOLERANCIA_DIAS,
};
