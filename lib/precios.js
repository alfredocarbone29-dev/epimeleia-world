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
// · Tolerancia del 5% en cada borde (opción B): si te pasás poco del límite,
//   no saltás de golpe al tier de arriba — pagás un proporcional al salto,
//   según cuánto entraste en la zona del 5%. En el 5% justo, el proporcional
//   empalma con el precio del tier siguiente (transición suave, sin escalón).
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
// El orden importa: de menor a mayor.
const TIERS = [
  { id: 'base',       nombre: 'Base',       hasta: 500,   precioMensualUSD: 180,
    apunta: 'Productor individual, obra chica, barrio cerrado' },
  { id: 'pro',        nombre: 'Pro',        hasta: 5000,  precioMensualUSD: 450,
    apunta: 'Campo grande, forestal mediana, inmobiliaria' },
  { id: 'corporate',  nombre: 'Corporate',  hasta: 25000, precioMensualUSD: 900,
    apunta: 'Minera media, constructora, múltiples parcelas' },
  { id: 'enterprise', nombre: 'Enterprise', hasta: 62500, precioMensualUSD: 1800,
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
 *     precioMensualUSD,      ← lo que se cobra por mes (con tolerancia aplicada)
 *     precioAnualUSD,        ← 11 meses (el gratis por adelantado)
 *     precioBaseTier,        ← el precio "de lista" del tier, sin tolerancia
 *     ajusteTolerancia,      ← cuánto se sumó por estar en zona de tolerancia (0 si no)
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

  // ── ¿Está en zona de tolerancia de ALGÚN borde inferior? ──────────────────
  // La tolerancia aplica cuando la superficie superó el borde del tier anterior
  // por hasta un 5%. Ejemplo: 510 ha superó el borde de Base (500) en 10 ha.
  // El tramo de tolerancia de Base es 500 → 525 (5% de 500 = 25 ha).
  //
  // Buscamos si `ha` cae en el tramo de tolerancia que arranca en el borde de
  // un tier. Ese borde es el `hasta` de un tier, y el tramo llega hasta
  // borde*(1+5%). Si cae ahí, el cliente "se pasó poco" de ese borde.
  let enTolerancia = false;
  let ajusteTolerancia = 0;
  let tierCobrado = tier;

  for (let i = 0; i < TIERS.length - 1; i++) {
    const borde = TIERS[i].hasta;                 // ej: 500 (borde de Base)
    const topeTolerancia = borde * (1 + TOLERANCIA); // ej: 525

    if (ha > borde && ha <= topeTolerancia) {
      // El cliente se pasó del borde `borde` por poco (dentro del 5%).
      // Se queda en el tier de ABAJO (TIERS[i]) y paga un proporcional del
      // salto al tier de arriba (TIERS[i+1]).
      const tierAbajo  = TIERS[i];
      const tierArriba = TIERS[i + 1];
      const salto = tierArriba.precioMensualUSD - tierAbajo.precioMensualUSD;

      // Qué fracción de la zona de tolerancia usó (0 a 1).
      const fraccion = (ha - borde) / (topeTolerancia - borde);

      enTolerancia = true;
      ajusteTolerancia = Math.round(salto * fraccion);
      tierCobrado = tierAbajo;
      break;
    }
  }

  const precioMensualUSD = tierCobrado.precioMensualUSD + ajusteTolerancia;
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
    precioBaseTier: tierCobrado.precioMensualUSD,
    ajusteTolerancia,
    enTolerancia,
    leyendaImpuestos,
    // Nota honesta para el frontend:
    nota: enTolerancia
      ? `Tu activo se pasó apenas del límite de ${tierCobrado.nombre}. En vez de cobrarte el tier de arriba, pagás un proporcional.`
      : null,
  };
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
    const nota    = r.enTolerancia ? `tolerancia +$${r.ajusteTolerancia}` : '';
    console.log(`  ${String(ha).padStart(9)} │ ${pais.padEnd(4)} │ ${r.tier.nombre.padEnd(11)} │ ${mensual.padStart(7)} │ ${anual.padStart(7)} │ ${nota}`);
  }
  console.log('');
  console.log('  Leyenda impuestos AR: ', LEYENDA_IMPUESTOS.AR);
  console.log('  Leyenda impuestos INT:', LEYENDA_IMPUESTOS.INT);
  console.log('');
}
