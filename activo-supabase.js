/**
 * EPIMELEIA · activo-supabase.js
 * ═════════════════════════════════════════════════════════════
 * LA PRIMERA PIEZA DEL NUDO (Fase 3) — la parte aislada y segura.
 *
 * Trae de Supabase todo lo que scheduler.js necesita para medir el
 * activo REAL (el polígono que dibujó el cliente), en vez del punto +
 * radio del modelo viejo.
 *
 * Es una pieza AUTOCONTENIDA: no toca scheduler.js, no toca la cadena,
 * no llama al satélite, no escribe nada. Solo LEE de Supabase. Si el
 * servicio se corta a la mitad, queda un archivo terminado y probado,
 * no un scheduler roto.
 *
 * ─────────────────────────────────────────────────────────────
 * EL PROBLEMA QUE RESUELVE
 * ─────────────────────────────────────────────────────────────
 *
 * Hay dos mundos que no se tocan:
 *   · scheduler.js recorre la lista de la CADENA y tiene un activoId
 *     on-chain. Mide con punto + radio.
 *   · el polígono real vive en SUPABASE.
 *   · scheduler.js no tiene ni un require de Supabase.
 *
 * Esta función es el puente: dado el activoId on-chain, trae la fila
 * de Supabase con el polígono y los datos del titular.
 *
 * ─────────────────────────────────────────────────────────────
 * POR QUÉ BUSCA POR activo_id_onchain (el camino simple Y correcto)
 * ─────────────────────────────────────────────────────────────
 *
 * Un cliente puede tener VARIOS activos (decisión del fundador: cada
 * activo es un pago propio). Por eso NO se puede buscar "el activo del
 * cliente X" — no diría CUÁL de sus activos.
 *
 * activo_id_onchain apunta a UN activo específico. Es una fila, un
 * activo, sin ambigüedad. Es el único puente que ata la fila de
 * Supabase con el activo de la cadena, uno a uno.
 *
 * HOY esa columna está VACÍA (nadie la llena todavía; la llenará el
 * alta on-chain en la Fase 7). Por eso esta función, si no encuentra
 * el activo, LO DICE CLARO y no inventa. No devuelve "el activo de
 * algún cliente" para tapar el hueco — eso sería la misma mentira que
 * el viejo `return 50`.
 *
 * Resultado: la función queda TERMINADA y CORRECTA hoy, y empieza a
 * funcionar sola en cuanto la Fase 7 llene activo_id_onchain. No hay
 * que volver a tocarla.
 *
 * ─────────────────────────────────────────────────────────────
 * VARIABLES DE ENTORNO (ya están en el .env del VPS)
 * ─────────────────────────────────────────────────────────────
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 * (las mismas que usa procesador-pagos.js — no se agregan nuevas)
 *
 * ─────────────────────────────────────────────────────────────
 * CÓMO PROBARLO
 * ─────────────────────────────────────────────────────────────
 *   node activo-supabase.js               → lista los activos que hay
 *   node activo-supabase.js 7             → trae el activo on-chain #7
 * ═════════════════════════════════════════════════════════════
 */

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const TABLA = 'activos';

const TIPO_A_NUMERO = {
  MINERIA:    0,
  FORESTAL:   1,
  NAVAL:      2,
  INDUSTRIAL: 3,
  DATA_CENTER:4,
  RESIDUOS:   5,
  HIDROVIA:   6,
  HIDRICO:    6,
  GLACIAR:    7,
  AGRICOLA:   1,
  OTRO:       7,
};

function _tipoANumero(tipo) {
  if (tipo === null || tipo === undefined) return 7;
  if (typeof tipo === 'number') return tipo;
  const t = String(tipo).toUpperCase().trim();
  return TIPO_A_NUMERO[t] ?? 7;
}

function _normalizarPoligono(poligono) {
  if (!poligono) return null;

  let p = poligono;
  if (typeof p === 'string') {
    try { p = JSON.parse(p); } catch { return null; }
  }

  if (p && p.type === 'Polygon' && Array.isArray(p.coordinates)) {
    return p;
  }
  if (p && p.type === 'Feature' && p.geometry?.type === 'Polygon') {
    return p.geometry;
  }
  return null;
}

async function traerActivoPorOnchainId(activoIdOnchain) {
  if (activoIdOnchain === null || activoIdOnchain === undefined) {
    return { encontrado: false, motivo: 'No se pasó activo_id_onchain.' };
  }

  const { data, error } = await supabase
    .from(TABLA)
    .select([
      'id',
      'nombre_activo',
      'tipo',
      'poligono',
      'poligono_confirmado',
      'superficie_ha',
      'superficie_km2',
      'cliente_id',
      'activo_id_onchain',
      'estado',
      'deforestacion_historica',
    ].join(', '))
    .eq('activo_id_onchain', activoIdOnchain)
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase falló leyendo activo ${activoIdOnchain}: ${error.message}`);
  }

  if (!data) {
    return {
      encontrado: false,
      motivo: `No hay ningún activo en Supabase con activo_id_onchain = ${activoIdOnchain}. ` +
              `Probablemente el alta on-chain todavía no llenó esa columna (Fase 7).`,
      activoIdOnchain,
    };
  }

  const geometria = _normalizarPoligono(data.poligono);

  return {
    encontrado:     true,
    activoIdOnchain,
    filaId:         data.id,
    clienteId:      data.cliente_id ?? null,
    nombreActivo:   data.nombre_activo ?? null,
    tipo:           _tipoANumero(data.tipo),
    tipoTexto:      data.tipo ?? null,
    geometria,
    esPoligonoReal: geometria !== null,
    poligonoConfirmado: data.poligono_confirmado === true,
    superficieHa:   data.superficie_ha ?? null,
    superficieKm2:  data.superficie_km2 ?? null,
    estado:         data.estado ?? null,
    deforestacionHistorica: data.deforestacion_historica ?? null,
  };
}

async function traerActivoParaCertificado(filaId) {
  if (filaId === null || filaId === undefined || filaId === '') {
    return { encontrado: false, motivo: 'No se pasó el id de la fila.' };
  }

  const { data, error } = await supabase
    .from(TABLA)
    .select([
      'id',
      'nombre_activo',
      'tipo',
      'poligono',
      'poligono_confirmado',
      'superficie_ha',
      'superficie_km2',
      'cliente_id',
      'activo_id_onchain',
      'estado',
      'deforestacion_historica',
    ].join(', '))
    .eq('id', filaId)
    .maybeSingle();

  if (error) {
    throw new Error(`Supabase falló leyendo activo (fila ${filaId}): ${error.message}`);
  }
  if (!data) {
    return {
      encontrado: false,
      motivo: `No hay ninguna fila en 'activos' con id = ${filaId}.`,
      filaId,
    };
  }

  const geometria = _normalizarPoligono(data.poligono);

  let titular = null;
  let titularMotivo = null;

  if (!data.cliente_id) {
    titularMotivo = 'El activo no tiene cliente_id (activo huérfano — deuda conocida). Sin titular.';
  } else {
    const { data: cli, error: errCli } = await supabase
      .from('clientes')
      .select('nombre, empresa, email')
      .eq('id', data.cliente_id)
      .maybeSingle();

    if (errCli) {
      titularMotivo = `No se pudo leer el cliente ${data.cliente_id}: ${errCli.message}`;
    } else if (!cli) {
      titularMotivo = `El activo apunta a cliente_id ${data.cliente_id}, pero ese cliente no existe.`;
    } else {
      titular = {
        nombre:  cli.nombre  ?? null,
        empresa: cli.empresa ?? null,
        email:   cli.email   ?? null,
      };
    }
  }

  return {
    encontrado:     true,
    filaId:         data.id,
    activoIdOnchain: data.activo_id_onchain ?? null,
    clienteId:      data.cliente_id ?? null,
    nombreActivo:   data.nombre_activo ?? null,
    tipo:           _tipoANumero(data.tipo),
    tipoTexto:      data.tipo ?? null,
    geometria,
    esPoligonoReal: geometria !== null,
    poligonoConfirmado: data.poligono_confirmado === true,
    superficieHa:   data.superficie_ha ?? null,
    superficieKm2:  data.superficie_km2 ?? null,
    estado:         data.estado ?? null,
    titular,
    titularMotivo,
    deforestacionHistorica: data.deforestacion_historica ?? null,
  };
}

async function listarActivos() {
  const { data, error } = await supabase
    .from(TABLA)
    .select('id, nombre_activo, tipo, activo_id_onchain, poligono_confirmado, superficie_ha, estado, cliente_id')
    .order('id', { ascending: true });

  if (error) throw new Error(`Supabase falló listando activos: ${error.message}`);
  return data || [];
}

async function _prueba() {
  const L = (t = '') => console.log(t);

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    L('');
    L('  ⛔ Falta SUPABASE_URL o SUPABASE_SERVICE_KEY en el .env.');
    L('');
    process.exit(1);
  }

  const arg = process.argv[2];

  L('');
  L('═'.repeat(62));
  L('  EPIMELEIA · activo-supabase.js — prueba (solo lee Supabase)');
  L('═'.repeat(62));

  L('');
  L('  Activos en Supabase:');
  L('');
  let lista;
  try {
    lista = await listarActivos();
  } catch (e) {
    L('  ⛔ ' + e.message);
    process.exit(1);
  }

  if (lista.length === 0) {
    L('  (no hay activos todavía)');
  } else {
    L('  fila │ nombre                    │ tipo       │ onchain │ polígono │ estado');
    L('  ─────┼───────────────────────────┼────────────┼─────────┼──────────┼────────');
    for (const a of lista) {
      const nombre = String(a.nombre_activo || '—').slice(0, 25).padEnd(25);
      const tipo   = String(a.tipo || '—').slice(0, 10).padEnd(10);
      const onchain = a.activo_id_onchain != null ? String(a.activo_id_onchain).padStart(7) : '  vacío';
      const poli   = a.poligono_confirmado ? '   sí   ' : '   no   ';
      const estado = String(a.estado || '—');
      L(`  ${String(a.id).padStart(4)} │ ${nombre} │ ${tipo} │ ${onchain} │ ${poli} │ ${estado}`);
    }
  }

  const atados = lista.filter(a => a.activo_id_onchain != null).length;
  L('');
  L(`  ${atados} de ${lista.length} activos tienen activo_id_onchain (atados a la cadena).`);
  if (atados === 0 && lista.length > 0) {
    L('  → Ninguno está atado todavía. Es lo esperado: el alta on-chain');
    L('    (Fase 7) es la que va a llenar esa columna. Hasta entonces, el');
    L('    nudo no tiene por dónde cruzar, y esta función lo dice honestamente.');
  }

  if (arg !== undefined) {
    L('');
    L('─'.repeat(62));
    L(`  Buscando el activo con activo_id_onchain = ${arg}`);
    L('─'.repeat(62));
    try {
      const r = await traerActivoPorOnchainId(Number(arg));
      if (!r.encontrado) {
        L('');
        L('  · No encontrado (resultado honesto, no es un error):');
        L('    ' + r.motivo);
      } else {
        L('');
        L('  ✓ Encontrado:');
        L(`    fila Supabase:  ${r.filaId}`);
        L(`    nombre:         ${r.nombreActivo}`);
        L(`    tipo:           ${r.tipoTexto}  (número ${r.tipo})`);
        L(`    cliente_id:     ${r.clienteId}`);
        L(`    superficie:     ${r.superficieHa} ha`);
        L(`    polígono real:  ${r.esPoligonoReal ? 'SÍ' : 'NO (sin polígono válido)'}`);
        L(`    confirmado:     ${r.poligonoConfirmado ? 'sí' : 'no'}`);
        L(`    estado:         ${r.estado}`);
        if (r.esPoligonoReal) {
          const n = r.geometria.coordinates?.[0]?.length ?? 0;
          L(`    vértices:       ${n}`);
        }
        L('');
        L('    → Este objeto es lo que se le pasaría a medirIndicadores().');
      }
    } catch (e) {
      L('  ⛔ ' + e.message);
    }
  } else {
    L('');
    L('  Para probar traer un activo puntual:');
    L('    node activo-supabase.js <activo_id_onchain>');
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
  traerActivoPorOnchainId,
  traerActivoParaCertificado,
  listarActivos,
};
