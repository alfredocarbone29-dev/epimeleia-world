/**
 * EPIMELEIA · reglas-lectura.js
 * ═════════════════════════════════════════════════════════════
 * LA REGLA QUE TRADUCE EL NÚMERO EN UNA FRASE.
 *
 * El satélite mide 0.347. Eso no le dice nada a nadie.
 * "Vegetación moderada" sí. Esa traducción ES el servicio.
 * Y como es el servicio, se sella igual que el número.
 *
 * Pero una frase sellada sin decir CON QUÉ REGLA se leyó no
 * sirve de nada. Ejemplo real, del certificado del 10/7/2026:
 *
 *     NDVI 0.347  →  "vegetación moderada"   (corte v1 en 0.3)
 *
 * Ese número está a 0.047 del borde. Si mañana alguien decide
 * que el corte correcto para la pampa es 0.35, ese MISMO 0.347
 * pasaría a decir "vegetación escasa o estresada". Dos
 * certificados sellados, los dos válidos, contradiciéndose.
 *
 * Por eso: cada certificado declara con qué regla leyó, y esa
 * versión entra en el hash.
 *
 * ─────────────────────────────────────────────────────────────
 * LA REGLA DE ORO DE ESTE ARCHIVO
 * ─────────────────────────────────────────────────────────────
 *
 *   ⛔ v1 NO SE EDITA NUNCA. NI UN DECIMAL. NI UNA COMA.
 *   ✅ Si algo está mal calibrado, se AGREGA una v2.
 *
 * Si alguien edita la v1 dejando la etiqueta "v1", todos los
 * certificados viejos se vuelven imposibles de verificar: dicen
 * v1, pero la v1 que existe ya no es la que los selló. El sello
 * quedaría intacto y la prueba rota igual. Es la misma clase de
 * error que el viejo `return 50`: nadie miente a propósito, y el
 * resultado es una mentira.
 *
 * Por eso cada regla tiene SU PROPIA HUELLA (hashDeRegla).
 * Si alguien la edita, la huella cambia y se nota. La disciplina
 * no depende de que nadie se olvide.
 *
 * ─────────────────────────────────────────────────────────────
 * QUÉ ES v1
 * ─────────────────────────────────────────────────────────────
 *
 * v1 es, EXACTAMENTE, lo que la función _interpretar() de
 * satellite.js hace hoy. No se cambió ni un umbral al extraerla.
 * Extraer y mejorar a la vez es cómo se cuelan los errores.
 *
 * Comprobado contra el certificado real del 10/7/2026:
 *   NDVI  0.347  →  "vegetación moderada"   ✓ coincide
 *   NDMI -0.07   →  "humedad baja"          ✓ coincide
 *
 * ─────────────────────────────────────────────────────────────
 * CÓMO SE VE LA REGLA (cualquiera tiene que poder leerla)
 * ─────────────────────────────────────────────────────────────
 *
 *   node reglas-lectura.js
 *
 * Imprime la regla completa y su huella.
 * ═════════════════════════════════════════════════════════════
 */

const { ethers } = require('ethers');

// ═══════════════════════════════════════════════════════════════
//  LAS REGLAS
//  ───────────────────────────────────────────────────────────
//  Cada índice tiene una lista de CORTES, en orden.
//  Se recorre de arriba hacia abajo y gana el primero que da
//  verdadero. Si ninguno da, gana `resto`.
//
//  `comparador` importa y no es decorativo:
//    '<'   → el valor tiene que ser MENOR estricto
//    '<='  → menor o igual
//  Se respeta el comparador que usaba cada índice en el código
//  original. No se unificaron. Unificarlos habría cambiado el
//  resultado en el borde exacto (ej: NDWI justo en 0.000).
// ═══════════════════════════════════════════════════════════════

const REGLAS = {

  // ─────────────────────────────────────────────────────────
  //  v1 · La regla original de EPIMELEIA.
  //  ⛔ CONGELADA. No se toca. Nunca.
  // ─────────────────────────────────────────────────────────
  v1: {
    version:      'v1',
    vigenteDesde: '2026-07-17',
    titulo:       'Regla de lectura EPIMELEIA v1',
    descripcion:
      'Primera regla de lectura del protocolo. Traduce el valor medio ' +
      'de cada índice espectral, medido por Sentinel-2 sobre el polígono ' +
      'del activo, a una frase en castellano. Los cortes son los que el ' +
      'protocolo usó desde su origen.',

    indices: {

      NDVI: {
        etiqueta: 'Vigor de la vegetación',
        cortes: [
          { comparador: '<', hasta:  0.1, frase: 'suelo desnudo o sin vegetación' },
          { comparador: '<', hasta:  0.3, frase: 'vegetación escasa o estresada'  },
          { comparador: '<', hasta:  0.6, frase: 'vegetación moderada'            },
        ],
        resto: 'vegetación densa y sana',
      },

      NDWI: {
        etiqueta: 'Presencia y nivel de agua',
        cortes: [
          { comparador: '<=', hasta: 0, frase: 'sin agua abierta' },
        ],
        resto: 'presencia de agua abierta',
      },

      NDMI: {
        etiqueta: 'Humedad de vegetación y suelo',
        cortes: [
          { comparador: '<', hasta: -0.2, frase: 'muy seco'     },
          { comparador: '<', hasta:  0.1, frase: 'humedad baja' },
          { comparador: '<', hasta:  0.4, frase: 'humedad media' },
        ],
        resto: 'húmedo',
      },

      NDTI: {
        etiqueta: 'Turbidez y sedimentos del agua',
        cortes: [
          { comparador: '<=', hasta: 0, frase: 'agua clara' },
        ],
        resto: 'agua con carga de sedimentos',
      },

      NDBI: {
        etiqueta: 'Superficie construida o pelada',
        cortes: [
          { comparador: '<=', hasta: 0, frase: 'superficie natural' },
        ],
        resto: 'superficie construida o de suelo pelado',
      },

    },

    // Qué dice la regla cuando NO hay número que leer.
    // No es una frase de relleno: es un hecho. El satélite no vio.
    sinDato: 'sin dato',

    // Qué dice cuando el índice no está en la regla.
    // (El código original devolvía '' — cadena vacía. Se respeta.)
    indiceDesconocido: '',
  },

  // ─────────────────────────────────────────────────────────
  //  v2 · TODAVÍA NO EXISTE.
  //
  //  Cuando haga falta cambiar un umbral, se agrega ACÁ ABAJO
  //  una v2 completa. La v1 se queda donde está, intacta, para
  //  siempre — porque hay certificados sellados que la citan.
  // ─────────────────────────────────────────────────────────

};

// Congelado en profundidad: ni un descuido puede tocar la v1
// en tiempo de ejecución.
function _congelar(o) {
  Object.getOwnPropertyNames(o).forEach(k => {
    const v = o[k];
    if (v && typeof v === 'object') _congelar(v);
  });
  return Object.freeze(o);
}
_congelar(REGLAS);

const VERSION_VIGENTE = 'v1';

// ═══════════════════════════════════════════════════════════════
//  SERIALIZACIÓN CANÓNICA
//  ───────────────────────────────────────────────────────────
//  Para que una huella sea comprobable por un tercero, el mismo
//  contenido tiene que dar SIEMPRE el mismo texto. JSON.stringify
//  no garantiza eso: el orden de las claves depende de cómo se
//  armó el objeto.
//
//  Esto ordena las claves alfabéticamente, en todos los niveles,
//  y no mete espacios. Mismo contenido → mismo texto → misma huella.
//
//  ⚠️ Esta función va a hacer falta después para el hash del
//     paquete completo (polígono + mediciones + titular). Por ahora
//     vive acá. Cuando se use en más de un lado, se muda a un
//     archivo propio. No se duplica.
// ═══════════════════════════════════════════════════════════════

function canonico(valor) {
  if (valor === null || typeof valor !== 'object') {
    return JSON.stringify(valor);
  }
  if (Array.isArray(valor)) {
    return '[' + valor.map(canonico).join(',') + ']';
  }
  const claves = Object.keys(valor).sort();
  return '{' + claves.map(k => JSON.stringify(k) + ':' + canonico(valor[k])).join(',') + '}';
}

// ═══════════════════════════════════════════════════════════════
//  LA HUELLA DE LA REGLA
//  ───────────────────────────────────────────────────────────
//  Esto es lo que hace que "v1" no sea una etiqueta de confianza
//  sino un hecho comprobable. El certificado lleva la versión Y
//  la huella. Si alguien edita la v1, la huella deja de coincidir
//  y cualquiera lo ve.
// ═══════════════════════════════════════════════════════════════

function hashDeRegla(version = VERSION_VIGENTE) {
  const r = REGLAS[version];
  if (!r) throw new Error(`EPIMELEIA: no existe la regla de lectura "${version}"`);
  return ethers.keccak256(ethers.toUtf8Bytes(canonico(r)));
}

// ═══════════════════════════════════════════════════════════════
//  LEER UN NÚMERO
//  ───────────────────────────────────────────────────────────
//  Reemplazo exacto de _interpretar() de satellite.js.
//  Mismo resultado, para todo valor, en toda la recta.
// ═══════════════════════════════════════════════════════════════

function interpretar(indice, valor, version = VERSION_VIGENTE) {
  const r = REGLAS[version];
  if (!r) throw new Error(`EPIMELEIA: no existe la regla de lectura "${version}"`);

  // Sin número no hay lectura. No se inventa.
  if (valor === null || valor === undefined || !isFinite(valor)) return r.sinDato;

  const def = r.indices[indice];
  if (!def) return r.indiceDesconocido;

  for (const c of def.cortes) {
    if (c.comparador === '<'  && valor <  c.hasta) return c.frase;
    if (c.comparador === '<=' && valor <= c.hasta) return c.frase;
  }
  return def.resto;
}

/**
 * La regla completa, tal cual entra al hash. Para mostrarla, para
 * publicarla, para que un tercero recalcule la huella y compruebe.
 */
function reglaCompleta(version = VERSION_VIGENTE) {
  const r = REGLAS[version];
  if (!r) throw new Error(`EPIMELEIA: no existe la regla de lectura "${version}"`);
  return r;
}

/** Qué versiones existen. */
function versiones() {
  return Object.keys(REGLAS);
}

// ═══════════════════════════════════════════════════════════════
//  MOSTRAR  ·  node reglas-lectura.js
// ═══════════════════════════════════════════════════════════════

function _mostrar(version = VERSION_VIGENTE) {
  const r = reglaCompleta(version);
  const L = (t = '') => console.log(t);

  L('');
  L('═'.repeat(62));
  L('  ' + r.titulo);
  L('═'.repeat(62));
  L('  Vigente desde: ' + r.vigenteDesde);
  L('');
  L('  ' + r.descripcion.replace(/(.{1,56})(\s|$)/g, '$1\n  ').trim());
  L('');

  for (const [ind, def] of Object.entries(r.indices)) {
    L('─'.repeat(62));
    L(`  ${ind} · ${def.etiqueta}`);
    for (const c of def.cortes) {
      L(`      si el valor es ${c.comparador} ${c.hasta}`.padEnd(34) + '→  ' + c.frase);
    }
    L('      en cualquier otro caso'.padEnd(34) + '→  ' + def.resto);
  }
  L('─'.repeat(62));
  L(`  Sin número medido`.padEnd(34) + '→  ' + r.sinDato);
  L('');
  L('  HUELLA DE ESTA REGLA (keccak256):');
  L('  ' + hashDeRegla(version));
  L('');
  L('  Esta huella va en cada certificado que se lea con ' + version + '.');
  L('  Si alguien edita la regla, la huella cambia y se nota.');
  L('');
}

// ═══════════════════════════════════════════════════════════════
//  COMPROBACIÓN  ·  que v1 sea EXACTAMENTE lo de hoy
//  ───────────────────────────────────────────────────────────
//  Casos tomados del certificado real del 10/7/2026 y de los
//  bordes exactos de cada corte. Si alguno falla, algo se movió.
// ═══════════════════════════════════════════════════════════════

function _comprobar() {
  const casos = [
    // Del certificado real (Campo Pergamino, 10/7/2026):
    ['NDVI',  0.347, 'vegetación moderada'],
    ['NDMI', -0.07,  'humedad baja'],
    // Bordes exactos de NDVI:
    ['NDVI',  0.099, 'suelo desnudo o sin vegetación'],
    ['NDVI',  0.1,   'vegetación escasa o estresada'],
    ['NDVI',  0.299, 'vegetación escasa o estresada'],
    ['NDVI',  0.3,   'vegetación moderada'],
    ['NDVI',  0.599, 'vegetación moderada'],
    ['NDVI',  0.6,   'vegetación densa y sana'],
    ['NDVI',  0.95,  'vegetación densa y sana'],
    // Bordes exactos de NDMI:
    ['NDMI', -0.3,   'muy seco'],
    ['NDMI', -0.2,   'humedad baja'],
    ['NDMI',  0.1,   'humedad media'],
    ['NDMI',  0.4,   'húmedo'],
    // Los de umbral en cero (comparador <=, como el original):
    ['NDWI', -0.1,   'sin agua abierta'],
    ['NDWI',  0,     'sin agua abierta'],
    ['NDWI',  0.001, 'presencia de agua abierta'],
    ['NDTI',  0,     'agua clara'],
    ['NDTI',  0.5,   'agua con carga de sedimentos'],
    ['NDBI',  0,     'superficie natural'],
    ['NDBI',  0.2,   'superficie construida o de suelo pelado'],
    // Sin dato:
    ['NDVI',  null,  'sin dato'],
    ['NDVI',  undefined, 'sin dato'],
    // Índice que la regla no conoce:
    ['XXXX',  0.5,   ''],
  ];

  let fallos = 0;
  for (const [ind, val, esperado] of casos) {
    const dio = interpretar(ind, val);
    if (dio !== esperado) {
      console.log(`  ✗ ${ind} ${val} → dio "${dio}", esperaba "${esperado}"`);
      fallos++;
    }
  }

  if (fallos === 0) {
    console.log(`  ✓ ${casos.length}/${casos.length} — v1 lee exactamente igual que satellite.js hoy.`);
  } else {
    console.log(`  ⛔ ${fallos} caso(s) NO coinciden. La regla se movió. NO usar.`);
  }
  console.log('');
  return fallos === 0;
}

if (require.main === module) {
  _mostrar();
  console.log('  COMPROBACIÓN contra el comportamiento actual:');
  _comprobar();
}

module.exports = {
  interpretar,
  hashDeRegla,
  reglaCompleta,
  versiones,
  canonico,
  VERSION_VIGENTE,
  REGLAS,
};
