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
// AJUSTE 36 (Estación 2 · deslinde): el hash de la firma lo calcula el SERVIDOR,
// con la misma función que usa el resto del sistema. El cliente solo manda la
// intención (aceptado: true). Así la firma nunca difiere de la que se espera.
import {
  VERSION_VIGENTE,
  HASH_CLAUSULAS_VIGENTE,
  calcularHashAceptacion,
} from '../lib/hash-clausulas.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Traduce el "tipo" que manda el mapa al código interno del protocolo ───
// El motor manda textos legibles. El satélite y el resto del sistema trabajan
// con un código simple. Este diccionario los une.
// El tipo NO es decorativo: define QUÉ mide el satélite (no es lo mismo medir
// agua que vegetación).
const MAPA_TIPOS = {
  'Bosque / forestación':            'FORESTAL',
  'Campo / vegetación agrícola':     'AGRICOLA',
  'Cuenca hídrica / cuerpo de agua': 'HIDRICO',
  'Minería / suelo intervenido':     'MINERIA',
  'Glaciar / reserva de hielo':      'GLACIAR',
  'Industria / instalaciones':       'INDUSTRIAL',
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

    // ── 1b) AJUSTE 36 — SIN ACEPTACIÓN DEL DESLINDE, NO HAY ACTIVO ──
    // Regla del fundador: "sin aceptación no hay pago" — y acá se lleva más
    // lejos: sin aceptación no se guarda ni siquiera el activo. La firma es
    // condición para que el activo exista (Camino 1, atómico).
    //
    // El cliente manda solo la INTENCIÓN (datos.aceptado === true). El hash,
    // la versión y la fecha los pone el SERVIDOR abajo — el cliente no puede
    // firmar una versión distinta de la vigente, ni mandar un hash arbitrario.
    if (datos.aceptado !== true) {
      return res.status(400).json({
        ok: false,
        error: 'El deslinde no fue aceptado. Sin aceptación no se registra el activo.',
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

    // ── 3b) ASEGURAR QUE EL CLIENTE EXISTE ──────────────────────────
    // La tabla `activos` exige que cliente_id apunte a una fila real de
    // `clientes`. Pero la cuenta del cliente vive en Supabase Auth, que es
    // otro lado. Si el cliente todavía no tiene su fila en `clientes`, la
    // creamos acá con los datos que manda el motor.
    // (Esto es la "memoria del negocio": Auth dice quién puede entrar,
    //  la tabla clientes es quién es como cliente de EPIMELEIA.)
    let clienteId = null;
    if (datos.cliente_id) {
      const { data: existe, error: errBusca } = await supabase
        .from('clientes')
        .select('id')
        .eq('id', datos.cliente_id)
        .maybeSingle();

      if (errBusca) {
        console.error('[registrar-activo] Error buscando cliente:', errBusca);
      }

      if (existe) {
        clienteId = existe.id;
      } else {
        // No existe todavía → lo creamos con lo que sabemos de él.
        const { data: nuevo, error: errCrea } = await supabase
          .from('clientes')
          .insert({
            id:      datos.cliente_id,        // el mismo id de su cuenta Auth
            email:   datos.cliente_email || null,
            nombre:  datos.cliente_nombre || null,
            empresa: datos.cliente_empresa || null,
          })
          .select('id')
          .single();

        if (errCrea) {
          console.error('[registrar-activo] Error creando cliente:', errCrea);
          // Si no se pudo crear el cliente, guardamos el activo sin dueño
          // antes que perder el dibujo. Queda anotado para revisar.
          clienteId = null;
        } else {
          clienteId = nuevo.id;
          console.log('[registrar-activo] Cliente creado:', clienteId);
        }
      }
    }

    // ── 3c) AJUSTE 36 — LA FIRMA DEL DESLINDE (la calcula el servidor) ──
    // Se usa el email del cliente. Se prefiere el que manda el motor; si no
    // vino, se cae al de la cuenta. La versión y la fecha las pone el servidor.
    const emailFirma = (datos.cliente_email || datos.email || '').toLowerCase().trim();
    const firmaVersion = VERSION_VIGENTE;
    const firmaFecha   = new Date().toISOString();
    const firmaHash    = calcularHashAceptacion(emailFirma, firmaFecha, firmaVersion);

    // ── 4) ARMAR la fila para Supabase ──
    // El resto de las columnas se llenan en su momento del recorrido:
    //   · activo_id_onchain, ultimo_hash, ultimo_bloque → cuando se selle
    //   · ultima_medicion  → cuando el satélite mida
    //   · tier, precio     → cuando el cliente pague
    // El estado nace en 'alta': registrado, todavía sin certificar ni pagar.
    const fila = {
      nombre_activo:          datos.nombre.trim(),
      tipo:                   tipoInterno,
      poligono:               poligono,
      superficie_ha:          Number(datos.area_ha)  || null,
      superficie_km2:         Number(datos.area_km2) || null,
      // El dueño del activo. Ya nos aseguramos arriba de que exista en
      // la tabla `clientes` (si no estaba, lo creamos).
      cliente_id:             clienteId,
      // El polígono ya viene confirmado por el cliente en el mapa
      // (apretó "Confirmar activo" y después "Confirmar y continuar":
      //  esa es la doble aceptación).
      poligono_confirmado:    true,
      poligono_confirmado_en: new Date().toISOString(),
      estado:                 'alta',
      // AJUSTE 36 · Estación 2 — la firma del deslinde, sellada junto al activo.
      hash_firma:             firmaHash,
      firma_version:          firmaVersion,
      firma_fecha:            firmaFecha,
      // fecha_alta y fecha_creacion las pone Supabase solas (default now()).
    };

    // ── 5) GUARDAR en Supabase ──
    const { data, error } = await supabase
      .from('activos')
      .insert(fila)
      .select('id, nombre_activo, tipo, superficie_ha, estado, cliente_id, hash_firma, firma_version, firma_fecha')
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
      // AJUSTE 36 · Estación 2 — el deslinde quedó firmado junto al activo.
      deslinde: {
        firmado:          !!data.hash_firma,
        version:          data.firma_version,
        fecha:            data.firma_fecha,
        hash:             data.hash_firma,
        clausulasVigente: HASH_CLAUSULAS_VIGENTE,
      },
      // Nota honesta para el front: guardado sí, certificado todavía no.
      siguiente_paso: 'El activo está registrado y el deslinde aceptado. El pago viene después.',
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
