/**
 * EPIMELEIA · paquete-evidencia.js
 * ═════════════════════════════════════════════════════════════
 * EL PAQUETE DE EVIDENCIA — FASE 2 DEL PLAN.
 *
 * Esto es el corazón de la Junta A, y es la parte SIN RIESGO:
 * pura matemática. No escribe en la cadena. No lee Supabase. No
 * llama al satélite. Entra data, sale huella. Se prueba con datos
 * inventados y se corre mil veces sin consecuencias.
 *
 * ─────────────────────────────────────────────────────────────
 * QUÉ RESUELVE
 * ─────────────────────────────────────────────────────────────
 *
 * Hoy el certificado muestra un hash (generarHashEvidencia) que
 * cubre 7 campos de metadata: satélite, uuid, nubosidad, timestamp,
 * fuente... NO cubre el NDVI. NO cubre el polígono. NO cubre al
 * titular. Alguien podría cambiar 0.347 por 0.900 y el sello
 * seguiría válido — nunca miró ese número.
 *
 * Debajo, el certificado dice "Nadie tocó este dato. Y se puede
 * probar." Hoy eso NO es verdad. Este archivo lo hace verdad.
 *
 * ─────────────────────────────────────────────────────────────
 * QUÉ ES EL PAQUETE
 * ─────────────────────────────────────────────────────────────
 *
 * El TEXTO EXACTO que se va a sellar. Todo lo que el certificado
 * afirma como hecho, ordenado de forma canónica (siempre igual),
 * del que sale una huella keccak256.
 *
 * QUÉ ENTRA (decisiones del fundador, ya tomadas):
 *   · el titular declarado (nombre, empresa, cliente_id, email)
 *   · el polígono confirmado, tal cual lo dibujó el cliente
 *   · el nombre del activo, su tipo, su superficie (en hectáreas)
 *   · las mediciones (valor, fecha, calidad de cada índice)
 *   · la TRADUCCIÓN de lo que vio el satélite  ← ESTO ES EL SERVICIO
 *   · la regla de lectura y su huella
 *   · el trimestre del protocolo
 *
 * QUÉ NO ENTRA:
 *   · el diseño. Tipografías, colores, el dibujo del sello.
 *   · nada que sea presentación y no afirmación.
 *
 * La regla: entra todo lo que el certificado afirma como HECHO.
 * Queda afuera lo que es PRESENTACIÓN.
 *
 * ─────────────────────────────────────────────────────────────
 * POR QUÉ "CANÓNICO"
 * ─────────────────────────────────────────────────────────────
 *
 * Para que un tercero (el banco de Juan, por ejemplo) pueda
 * RECALCULAR la huella y comprobarla, el mismo contenido tiene que
 * dar SIEMPRE el mismo texto. JSON.stringify no garantiza eso: el
 * orden de las claves depende de cómo se armó el objeto.
 *
 * Por eso se serializa con canonico(): claves ordenadas
 * alfabéticamente, sin espacios, en todos los niveles. Mismo
 * contenido → mismo texto → misma huella.
 *
 * ⚠️ DECISIÓN DE DISEÑO: canonico() se REUTILIZA de reglas-lectura.js.
 *    NO se escribe otra igual. Si hubiera dos y difirieran en un
 *    detalle, las huellas no coincidirían y nadie sabría por qué.
 *    Una sola forma de serializar en todo el sistema.
 *
 * ─────────────────────────────────────────────────────────────
 * DÓNDE VIVE EL PAQUETE (decisión del fundador)
 * ─────────────────────────────────────────────────────────────
 *
 * En Polygon va SOLO la huella (bytes32). Pública, inmutable, no
 * dice nada de nadie.
 *
 * El PAQUETE COMPLETO es del TITULAR: le llega con su certificado,
 * y él se lo muestra a quien quiera. EPIMELEIA nunca lo entrega.
 * "El cliente es el protagonista absoluto, EPIMELEIA el puente."
 *
 * Por eso este archivo devuelve las DOS cosas por separado:
 *   · huella   → lo que va a la cadena
 *   · paquete  → lo que se le da al titular (el texto canónico)
 *
 * ─────────────────────────────────────────────────────────────
 * CÓMO PROBARLO
 * ─────────────────────────────────────────────────────────────
 *
 *   node paquete-evidencia.js
 *
 * Arma un paquete de ejemplo, muestra el texto y la huella, y
 * comprueba que:
 *   · la misma data da SIEMPRE la misma huella
 *   · cambiar un solo decimal del NDVI cambia la huella
 *   · cambiar el titular cambia la huella
 *   · el orden en que se pasan los campos NO cambia la huella
 * ═════════════════════════════════════════════════════════════
 */

const { ethers } = require('ethers');

// canonico() se reutiliza de reglas-lectura.js — una sola forma de
// serializar en todo el sistema. NO se reescribe.
const { canonico } = require('./reglas-lectura');

// La versión del formato del paquete. Si algún día cambia QUÉ campos
// entran o CÓMO se arma, se sube esta versión y entra al hash. Así un
// paquete viejo siempre se puede recalcular con su propio formato.
// (Misma lógica que la regla de lectura: el formato también se versiona.)
const FORMATO_PAQUETE = 'pkg-v1';

/**
 * Normaliza un número a una cantidad fija de decimales, como STRING.
 *
 * Por qué string y no number: 0.347 y 0.3470 son el mismo número para
 * JavaScript, pero un tercero que recalcule podría escribir uno u otro.
 * Fijando los decimales como texto, "0.347" es siempre "0.347".
 *
 * Por qué hace falta: el NDVI entra al hash. Si el número no está
 * normalizado, dos representaciones del mismo valor darían huellas
 * distintas, y la prueba se rompería sin que nadie lo note.
 */
function _num(valor, decimales = 3) {
  if (valor === null || valor === undefined || !isFinite(valor)) return null;
  return Number(valor).toFixed(decimales);
}

/**
 * Normaliza el polígono a una forma canónica.
 *
 * El polígono es una lista de vértices [lng, lat]. Para que el hash sea
 * estable:
 *   · cada coordenada se fija a 6 decimales como string (igual que el
 *     contrato, que guarda lat/lng × 1e6 — 6 decimales es su precisión).
 *   · NO se reordenan los vértices: el orden es parte de la figura.
 *     El cliente confirmó ESE polígono, con ESE orden. Reordenar sería
 *     cambiar lo que firmó. (La doble aceptación lo fija; esta duda ya
 *     se resolvió en el brief.)
 *
 * Acepta las formas que puede traer un GeoJSON Polygon:
 *   { type:'Polygon', coordinates: [ [ [lng,lat], ... ] ] }
 */
function _poligonoCanonico(poligono) {
  if (!poligono) return null;

  let anillos = null;
  if (poligono.type === 'Polygon' && Array.isArray(poligono.coordinates)) {
    anillos = poligono.coordinates;
  } else if (Array.isArray(poligono) && Array.isArray(poligono[0])) {
    // Ya vino como array de anillos.
    anillos = poligono;
  } else {
    return null;
  }

  // Cada punto → [lng6, lat6] como strings de 6 decimales.
  return anillos.map(anillo =>
    anillo.map(punto => {
      const lng = Number(punto[0]).toFixed(6);
      const lat = Number(punto[1]).toFixed(6);
      return [lng, lat];
    })
  );
}

/**
 * Arma el paquete de evidencia a partir de los datos del certificado.
 *
 * Recibe UN objeto con todo lo que el certificado afirma. Devuelve:
 *   · paquete  → el objeto canónico (lo que se le da al titular)
 *   · texto    → el string canónico exacto (lo que se hashea)
 *   · huella   → keccak256(texto) — lo que va a la cadena (bytes32)
 *   · formato  → la versión del formato del paquete
 *
 * NO valida contra Supabase ni la cadena: es una función pura. El que
 * llama es responsable de pasarle datos reales y confirmados.
 *
 * @param {Object} datos
 * @param {Object} datos.titular       { nombre, empresa, clienteId, email }
 * @param {Object} datos.activo        { nombre, tipo, superficieHa }
 * @param {Object} datos.poligono      GeoJSON Polygon confirmado
 * @param {Array}  datos.mediciones    [{ indice, valor, fecha, calidadPct, interpretacion }]
 * @param {Object} datos.regla         { version, hash }
 * @param {Number} datos.trimestre     trimestre on-chain (ej: 20263)
 */
function armarPaquete(datos) {
  if (!datos || typeof datos !== 'object') {
    throw new Error('EPIMELEIA: armarPaquete requiere un objeto con los datos del certificado');
  }

  const t = datos.titular || {};
  const a = datos.activo   || {};
  const r = datos.regla    || {};

  // Las mediciones se normalizan campo por campo. El orden de la lista
  // se conserva (es el orden en que se muestran en el certificado), pero
  // cada medición se reduce a sus campos que AFIRMAN algo:
  //   qué índice, qué valor midió, de qué fecha, con qué calidad, y
  //   cómo se tradujo (la interpretación — que ES el servicio).
  const mediciones = (datos.mediciones || []).map(m => ({
    indice:         m.indice ?? null,
    valor:          _num(m.valor),                    // string 3 decimales o null
    fecha:          m.fecha ?? null,
    calidadPct:     m.calidadPct ?? null,
    interpretacion: m.interpretacion ?? null,         // la traducción sellada
  }));

  // El paquete. Las claves de primer nivel se ordenan solas al
  // serializar con canonico(); acá se listan por claridad de lectura.
  const paquete = {
    formato: FORMATO_PAQUETE,

    titular: {
      nombre:    t.nombre    ?? null,
      empresa:   t.empresa   ?? null,
      clienteId: t.clienteId ?? null,
      email:     t.email ? String(t.email).toLowerCase().trim() : null,
    },

    activo: {
      nombre:       a.nombre ?? null,
      tipo:         a.tipo   ?? null,
      superficieHa: _num(a.superficieHa, 2),          // hectáreas, 2 decimales
    },

    poligono: _poligonoCanonico(datos.poligono),

    mediciones,

    regla: {
      version: r.version ?? null,
      hash:    r.hash    ?? null,
    },

    trimestre: datos.trimestre ?? null,
  };

  const texto  = canonico(paquete);
  const huella = ethers.keccak256(ethers.toUtf8Bytes(texto));

  return { paquete, texto, huella, formato: FORMATO_PAQUETE };
}

// ═══════════════════════════════════════════════════════════════
//  PRUEBA  ·  node paquete-evidencia.js
// ═══════════════════════════════════════════════════════════════

function _prueba() {
  const L = (t = '') => console.log(t);

  // Un activo de ejemplo, con los números REALES del certificado del
  // 10/7 (Campo Pergamino): NDVI 0.347, NDMI -0.07, calidad 47%.
  const base = {
    titular: {
      nombre:    'Juan Pérez',
      empresa:   'Agropecuaria del Norte S.A.',
      clienteId: '3f8a1c2e-0000-0000-0000-000000000000',
      email:     'Juan@Ejemplo.com',
    },
    activo: {
      nombre:       'Campo Pergamino',
      tipo:         'FORESTAL',
      superficieHa: 409,
    },
    poligono: {
      type: 'Polygon',
      coordinates: [[
        [-60.60, -33.85], [-60.58, -33.85], [-60.58, -33.87],
        [-60.60, -33.87], [-60.60, -33.85],
      ]],
    },
    mediciones: [
      { indice: 'NDVI', valor: 0.347, fecha: '2026-07-08', calidadPct: 47, interpretacion: 'vegetación moderada' },
      { indice: 'NDMI', valor: -0.07, fecha: '2026-07-08', calidadPct: 47, interpretacion: 'humedad baja' },
    ],
    regla: {
      version: 'v1',
      hash:    '0x196ec7110533897c2c0fd3d7cd089ab93a801e79c655018bc4a9c3109e5095cf',
    },
    trimestre: 20263,
  };

  L('');
  L('═'.repeat(64));
  L('  EPIMELEIA · PAQUETE DE EVIDENCIA — prueba');
  L('═'.repeat(64));

  const r1 = armarPaquete(base);

  L('');
  L('  Formato: ' + r1.formato);
  L('');
  L('  TEXTO CANÓNICO (esto es lo que se hashea, y lo que puede');
  L('  recalcular un tercero):');
  L('');
  // Se muestra el texto partido para que se lea; el hash es del texto entero.
  L('  ' + r1.texto.replace(/(.{1,60})/g, '$1\n  ').trim());
  L('');
  L('  HUELLA (esto es lo único que va a la cadena):');
  L('  ' + r1.huella);
  L('');

  // ── Comprobaciones ────────────────────────────────────────────
  L('─'.repeat(64));
  L('  COMPROBACIONES');
  L('─'.repeat(64));

  let ok = 0, fallo = 0;
  const chequear = (nombre, condicion) => {
    if (condicion) { L(`  ✓ ${nombre}`); ok++; }
    else           { L(`  ✗ ${nombre}`); fallo++; }
  };

  // 1. Determinista: la misma data da la misma huella.
  const r2 = armarPaquete(base);
  chequear('La misma data da la MISMA huella (determinista)', r1.huella === r2.huella);

  // 2. El orden de las claves de entrada NO importa (gracias a canonico).
  const desordenado = {
    trimestre: base.trimestre,
    regla: base.regla,
    mediciones: base.mediciones,
    poligono: base.poligono,
    activo: base.activo,
    titular: base.titular,
  };
  const r3 = armarPaquete(desordenado);
  chequear('El ORDEN de los campos de entrada NO cambia la huella', r1.huella === r3.huella);

  // 3. Cambiar un decimal del NDVI cambia la huella.
  const ndviCambiado = JSON.parse(JSON.stringify(base));
  ndviCambiado.mediciones[0].valor = 0.348;   // 0.347 → 0.348
  const r4 = armarPaquete(ndviCambiado);
  chequear('Cambiar el NDVI (0.347 → 0.348) CAMBIA la huella', r1.huella !== r4.huella);

  // 4. Cambiar el titular cambia la huella.
  const titularCambiado = JSON.parse(JSON.stringify(base));
  titularCambiado.titular.nombre = 'Otro Nombre';
  const r5 = armarPaquete(titularCambiado);
  chequear('Cambiar el TITULAR cambia la huella', r1.huella !== r5.huella);

  // 5. Cambiar la interpretación (el servicio) cambia la huella.
  const interpCambiada = JSON.parse(JSON.stringify(base));
  interpCambiada.mediciones[0].interpretacion = 'vegetación escasa o estresada';
  const r6 = armarPaquete(interpCambiada);
  chequear('Cambiar la TRADUCCIÓN (el servicio) cambia la huella', r1.huella !== r6.huella);

  // 6. Cambiar un vértice del polígono cambia la huella.
  const poliCambiado = JSON.parse(JSON.stringify(base));
  poliCambiado.poligono.coordinates[0][0][0] = -60.61;  // mover un vértice
  const r7 = armarPaquete(poliCambiado);
  chequear('Mover un VÉRTICE del polígono cambia la huella', r1.huella !== r7.huella);

  // 7. El email se normaliza (mayúsculas/espacios no cambian la huella).
  const emailRaro = JSON.parse(JSON.stringify(base));
  emailRaro.titular.email = '  JUAN@ejemplo.COM  ';
  const r8 = armarPaquete(emailRaro);
  chequear('El email se normaliza (mayúsculas/espacios dan la MISMA huella)', r1.huella === r8.huella);

  // 8. La regla entra al hash: cambiar su versión cambia la huella.
  const reglaCambiada = JSON.parse(JSON.stringify(base));
  reglaCambiada.regla.version = 'v2';
  const r9 = armarPaquete(reglaCambiada);
  chequear('Cambiar la VERSIÓN de la regla cambia la huella', r1.huella !== r9.huella);

  L('');
  if (fallo === 0) {
    L(`  ✓ ${ok}/${ok} — el paquete es determinista y sensible a cada campo.`);
    L('    Lo que afirma el certificado está adentro del hash.');
  } else {
    L(`  ⛔ ${fallo} comprobación(es) fallaron. NO usar hasta revisar.`);
  }
  L('');
  L('  Nada de esto tocó la cadena, Supabase ni el satélite.');
  L('');
}

if (require.main === module) {
  _prueba();
}

module.exports = {
  armarPaquete,
  FORMATO_PAQUETE,
};
