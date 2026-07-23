// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA V3.4 — Precios (fuente única de verdad)
// ────────────────────────────────────────────────────────────────────────────
// TODO lo que tenga que ver con precios sale de acá: el frontend que los
// muestra, el cálculo de tier según superficie, y el pago que cobra.
// Si un precio cambia, se cambia en UN solo lugar: este archivo.
//
// Antes los precios estaban escritos a mano en varios archivos, cada uno
// distinto. Esto lo unifica. Nunca más dos precios diferentes dando vueltas.
//
// ────────────────────────────────────────────────────────────────────────────
// LAS REGLAS (decisiones del fundador, 20/7/2026)
// ────────────────────────────────────────────────────────────────────────────
//
// · El precio depende de UNA sola cosa: la superficie del activo en hectáreas.
// · Cada activo es un pago propio (un cliente con 3 campos paga 3 veces).
// · 4 tiers. Precio mensual. También anual: se pagan 11 meses (el mes gratis
//   va por adelantado, tipo Netflix — el cliente ya dejó la tarjeta).
// · Tolerancia del 5% en cada borde: si te pasás poco del límite (hasta 5%),
//   NO saltás al tier de arriba — te quedás en el tier de abajo y pagás su
//   precio. Pasado el 5%, sí sube de tier. Son extensiones gigantes: 25 ha
//   sobre 500 es despreciable, y en algún lado tiene que haber un corte.
// · El Enterprise NO tiene tolerancia hacia arriba: arriba está el límite
//   físico de Copernicus (62.500 ha = 25×25 km). Un activo más grande no entra
//   en un polígono: se divide en varios (y cada uno es un pago propio).
// · Los precios son VALORES BASE, sin impuestos. Cada uno lleva una leyenda:
//   los impuestos se agregan según normativa, y el porcentaje lo define el
//   contador — NO se hardcodea acá.
// · La baja se produce al final del período pagado ("pagó el mes, tiene el
//   mes"). Eso lo maneja el contrato (estaActivo) + el scheduler; no es un
//   precio, pero se documenta acá para tener todo junto.
// ────────────────────────────────────────────────────────────────────────────

// El límite físico de un polígono de Copernicus: 25 km × 25 km = 62.500 ha.
// Un activo más grande no se puede medir en una sola pasada: se divide.
const MAX_HECTAREAS = 62500;

// La tolerancia sobre cada borde de tier: 5%.
const TOLERANCIA = 0.05;

// ── LOS CUATRO TIERS ──────────────────────────────────────────────────────
// `hasta` es el borde superior del tier, en hectáreas.
// `precioMensualUSD` es el valor BASE (sin impuestos).
// `envPlan` es el NOMBRE de la variable de entorno que guarda el Plan ID de
//   PayPal para ese tier. El Plan ID NO se escribe acá a propósito: así, para
//   pasar de sandbox a producción, se cambian las variables de entorno y no
//   se toca una línea de código. (Decisión del fundador, opción B.)
// El orden importa: de menor a mayor.
const TIERS = [
  { id: 'base',       nombre: 'Base',       hasta: 500,   precioMensualUSD: 180,
    envPlan: 'PAYPAL_PLAN_BASE',
    apunta: 'Productor individual, obra chica, barrio cerrado' },
  { id: 'pro',        nombre: 'Pro',        hasta: 5000,  precioMensualUSD: 450,
    envPlan: 'PAYPAL_PLAN_PRO',
    apunta: 'Campo grande, forestal mediana, inmobiliaria' },
  { id: 'corporate',  nombre: 'Corporate',  hasta: 25000, precioMensualUSD: 900,
    envPlan: 'PAYPAL_PLAN_CORPORATE',
    apunta: 'Minera media, constructora, múltiples parcelas' },
  { id: 'enterprise', nombre: 'Enterprise', hasta: 62500, precioMensualUSD: 1800,
    envPlan: 'PAYPAL_PLAN_ENTERPRISE',
    apunta: 'Gran holding, aseguradora, cuenca, gobierno' },
];

// ── LAS LEYENDAS DE IMPUESTOS ─────────────────────────────────────────────
// El precio que se muestra es BASE. Estas leyendas avisan que puede haber
// impuestos encima. El porcentaje real lo define el contador, según el país
// del cliente y la situación fiscal de EPIMELEIA. NO se calcula acá.
const LEYENDA_IMPUESTOS = {
  AR:  'Precio en USD. Se agregarán los impuestos que correspondan según normativa vigente (AR).',
  INT: 'Price in USD. Taxes may apply according to your jurisdiction.',
};

/**
 * Dada una superficie en hectáreas, devuelve el tier base que le corresponde
 * (sin considerar tolerancia todavía). Es el primer tier cuyo `hasta` alcanza.
 * Si supera el máximo, devuelve null (hay que dividir el activo).
 */
function _tierBase(ha) {
  for (const t of TIERS) {
    if (ha <= t.hasta) return t;
  }
  return null; // supera el máximo de Copernicus
}

/**
 * EL CÁLCULO PRINCIPAL.
 * Dada la superficie del activo en hectáreas, devuelve TODO lo que el resto
 * del sistema necesita saber para mostrar y cobrar:
 *
 *   {
 *     ok: true/false,
 *     motivo: (si ok=false, por qué)
 *     superficieHa,
 *     tier:        { id, nombre, apunta },
 *     precioMensualUSD,      ← lo que se cobra por mes
 *     precioAnualUSD,        ← 11 meses (el gratis por adelantado)
 *     enTolerancia:  true/false,
 *     leyendaImpuestos,      ← según el país
 *   }
 *
 * @param {number} superficieHa  hectáreas del polígono
 * @param {string} pais          código de país ('AR' o cualquier otro)
 */
function calcularPrecio(superficieHa, pais = 'INT') {
  const ha = Number(superficieHa);

  // Validaciones básicas.
  if (!isFinite(ha) || ha <= 0) {
    return { ok: false, motivo: 'La superficie tiene que ser un número mayor que cero.' };
  }

  // Arriba del máximo de Copernicus: no entra en un polígono.
  if (ha > MAX_HECTAREAS) {
    return {
      ok: false,
      motivo: `El activo tiene ${ha} ha y supera el máximo por polígono (${MAX_HECTAREAS} ha = 25×25 km, ` +
              `el límite del satélite). Hay que dividirlo en varios activos, y cada uno es un registro propio.`,
      superficieHa: ha,
      superaMaximo: true,
    };
  }

  const leyendaImpuestos = pais === 'AR' ? LEYENDA_IMPUESTOS.AR : LEYENDA_IMPUESTOS.INT;

  const tier = _tierBase(ha);
  const precioBaseTier = tier.precioMensualUSD;

  // ── ¿Está en zona de tolerancia de algún borde? ──────────────────────────
  // La tolerancia aplica cuando la superficie superó el borde de un tier por
  // hasta un 5%. Ejemplo: 510 ha superó el borde de Base (500) en 10 ha, y el
  // 5% de 500 son 25 ha → está dentro de la tolerancia.
  //
  // En ese caso el activo SE QUEDA en el tier de abajo, y paga el precio de
  // ese tier. No hay proporcional: en algún lado tiene que haber un corte, y
  // el corte es el 5%.
  let enTolerancia = false;
  let tierCobrado = tier;

  for (let i = 0; i < TIERS.length - 1; i++) {
    const borde = TIERS[i].hasta;                    // ej: 500 (borde de Base)
    const topeTolerancia = borde * (1 + TOLERANCIA); // ej: 525

    if (ha > borde && ha <= topeTolerancia) {
      enTolerancia = true;
      tierCobrado = TIERS[i];   // se queda en el tier de abajo
      break;
    }
  }

  // La zona de tolerancia evita el salto brusco de tier: si te pasaste por
  // poco (hasta 5%), NO subís al tier de arriba. Se cobra el precio del tier
  // de abajo, tal cual.
  //
  // DECISIÓN DEL FUNDADOR (22/7): se cobra el precio de lista del tier, sin
  // proporcional. Razón: son extensiones gigantes — 10 ha de diferencia sobre
  // 500 es despreciable en el mundo real, y el precio de PayPal es fijo por
  // plan. En algún lado tiene que haber un corte, y el corte es el 5%: pasado
  // eso, sí sube de tier. Así lo que se muestra y lo que se cobra es lo MISMO.
  const precioMensualUSD = tierCobrado.precioMensualUSD;
  // Anual = 11 meses (el mes gratis va por adelantado).
  const precioAnualUSD = precioMensualUSD * 11;

  return {
    ok: true,
    superficieHa: ha,
    tier: {
      id:     tierCobrado.id,
      nombre: tierCobrado.nombre,
      apunta: tierCobrado.apunta,
    },
    precioMensualUSD,
    precioAnualUSD,
    enTolerancia,
    leyendaImpuestos,
    // Nota para el frontend cuando el activo cayó en zona de tolerancia.
    nota: enTolerancia
      ? `Tu activo se pasó apenas del límite de ${tierCobrado.nombre} (menos del 5%). Se mantiene en este tier.`
      : null,
  };
}

/**
 * Devuelve el Plan ID de PayPal de un tier, leyéndolo de la variable de
 * entorno que le corresponde.
 *
 * Por qué así y no el ID escrito en el código (decisión del fundador, opción B):
 * para pasar de sandbox a producción se cambian las 4 variables de entorno y
 * NO se toca una línea de código. Los Plan IDs de sandbox y de live son
 * distintos, así que hardcodearlos obligaría a editar el código en cada salto.
 *
 * Si la variable no está configurada, devuelve null y lo DICE — no se inventa
 * un plan ni se cae a uno por defecto (eso podría cobrar el precio equivocado).
 *
 * @param {string} tierId  'base' | 'pro' | 'corporate' | 'enterprise'
 */
function planIdDePayPal(tierId) {
  const tier = TIERS.find(t => t.id === tierId);
  if (!tier) return { ok: false, motivo: `No existe el tier "${tierId}".` };

  const planId = process.env[tier.envPlan];
  if (!planId) {
    return {
      ok: false,
      motivo: `Falta la variable de entorno ${tier.envPlan} (Plan ID de PayPal para el tier ${tier.nombre}).`,
      envPlan: tier.envPlan,
    };
  }
  return { ok: true, planId, envPlan: tier.envPlan };
}

/**
 * Devuelve la tabla de tiers para mostrar en el frontend (la "vidriera" de
 * precios). Solo lectura, sin cálculo.
 */
function tablaDeTiers(pais = 'INT') {
  return {
    tiers: TIERS.map((t, i) => ({
      id:     t.id,
      nombre: t.nombre,
      desde:  i === 0 ? 1 : TIERS[i - 1].hasta + 1,
      hasta:  t.hasta,
      precioMensualUSD: t.precioMensualUSD,
      precioAnualUSD:   t.precioMensualUSD * 11,
      apunta: t.apunta,
    })),
    maxHectareas: MAX_HECTAREAS,
    leyendaImpuestos: pais === 'AR' ? LEYENDA_IMPUESTOS.AR : LEYENDA_IMPUESTOS.INT,
    notaMax: `Activos de más de ${MAX_HECTAREAS} ha se dividen en varios polígonos (cada uno es un registro propio).`,
  };
}

module.exports = {
  TIERS,
  MAX_HECTAREAS,
  TOLERANCIA,
  LEYENDA_IMPUESTOS,
  calcularPrecio,
  tablaDeTiers,
  planIdDePayPal,
};

// ── Prueba:  node lib/precios.js ──────────────────────────────────────────
if (require.main === module) {
  const casos = [
    [100,   'AR'],   // Base claro
    [500,   'AR'],   // Base, borde exacto
    [510,   'INT'],  // Base + tolerancia (se pasó 10 de 25 → 40% del salto)
    [520,   'INT'],  // Base + tolerancia (80%)
    [525,   'INT'],  // Base + tolerancia (100% → empalma con Pro)
    [526,   'INT'],  // Pro (pasó el 5%)
    [3000,  'AR'],   // Pro claro
    [5000,  'INT'],  // Pro, borde
    [5200,  'INT'],  // Pro + tolerancia
    [25000, 'AR'],   // Corporate, borde
    [40000, 'INT'],  // Enterprise
    [62500, 'AR'],   // Enterprise, borde máximo
    [70000, 'AR'],   // supera el máximo → dividir
    [0,     'AR'],   // inválido
  ];

  console.log('');
  console.log('EPIMELEIA · Precios — prueba');
  console.log('═'.repeat(72));
  console.log('  superficie │ país │ tier        │ mensual │ anual   │ nota');
  console.log('  ───────────┼──────┼─────────────┼─────────┼─────────┼─────────────');
  for (const [ha, pais] of casos) {
    const r = calcularPrecio(ha, pais);
    if (!r.ok) {
      console.log(`  ${String(ha).padStart(9)} │ ${pais.padEnd(4)} │ ${'—'.padEnd(11)} │ ${'—'.padStart(7)} │ ${'—'.padStart(7)} │ ${r.superaMaximo ? 'DIVIDIR' : 'inválido'}`);
      continue;
    }
    const mensual = '$' + r.precioMensualUSD;
    const anual   = '$' + r.precioAnualUSD;
    const nota    = r.enTolerancia ? 'en tolerancia (se queda en el tier)' : '';
    console.log(`  ${String(ha).padStart(9)} │ ${pais.padEnd(4)} │ ${r.tier.nombre.padEnd(11)} │ ${mensual.padStart(7)} │ ${anual.padStart(7)} │ ${nota}`);
  }
  console.log('');
  console.log('  Leyenda impuestos AR: ', LEYENDA_IMPUESTOS.AR);
  console.log('  Leyenda impuestos INT:', LEYENDA_IMPUESTOS.INT);
  console.log('');
}
