/**
 * api/panel.js — Panel de cartera + Certificado de lote (UNA sola función)
 *
 * Todo en un archivo para no superar el límite de 12 funciones del plan Hobby.
 *
 * GET  /api/panel?lote=CODIGO   → PÚBLICO. Lote sellado (para lote.html). Sin sesión.
 * POST /api/panel  { token }     → SOLO FOUNDER. Datos del panel de cartera.
 * POST /api/panel  { token, accion: 'simular'|'sellar'|'estado'|'listar', ... }
 *                                → SOLO FOUNDER. Armado y sellado de lotes (vía VPS).
 *
 * Candado founder: igual que api/confirmar-sello.js (Supabase confirma el email
 * y se compara con SELLO_FOUNDER_EMAIL).
 *
 * AJUSTE OFICINA (16/10/2026) · "TU OFICINA" DEL CLIENTE
 *   Antes: cualquier sesión que no fuera la del founder se rechazaba (403).
 *   Ahora: una sesión de cliente (entró a oficina.html con el link de su mail)
 *   también pasa, pero SOLO ve y opera lo suyo:
 *     - sin accion      → solo SUS parcelas (cliente_id = su usuario).
 *     - infoParcela     → solo si la parcela es suya.
 *     - simular/sellar  → solo si TODAS las parcelas del lote son suyas.
 *     - estado/listar   → solo SUS lotes.
 *     - siguienteCodigo → igual que el founder (es solo el próximo número).
 *   El founder sigue viendo y operando todo, exactamente como antes.
 *
 * AJUSTE SEMÁFORO (17/10/2026) · SEÑAL DE RIESGO DE ORIGEN
 *   accion 'riesgo' { parcelas:[{activoIdOnchain, toneladas}], anio }
 *   → para cada parcela: color (verde/amarillo/rojo/gris) y motivos, contando
 *     las toneladas del lote que se está armando. El cliente solo puede
 *     consultar sus parcelas. Es informativo: NO cambia APTO / NO APTO.
 *
 * Variables de entorno (Vercel):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, SELLO_FOUNDER_EMAIL   (ya existen)
 *   TRAZ_SECRET, TRAZ_VPS_URL                                 (para lotes)
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const SELLO_FOUNDER_EMAIL = (process.env.SELLO_FOUNDER_EMAIL || '').toLowerCase().trim();
const TRAZ_SECRET = process.env.TRAZ_SECRET || '';
const TRAZ_VPS_URL = (process.env.TRAZ_VPS_URL || '').replace(/\/+$/, '');

const CODIGO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

function cliente() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

// ─── Público: lote sellado ──────────────────────────────────────
async function lotePublico(req, res) {
  const codigo = String((req.query && req.query.lote) || '').trim();
  if (!CODIGO_RE.test(codigo)) return res.status(400).json({ ok: false, error: 'Código de lote inválido.' });
  const { data, error } = await cliente().from('traz_lotes')
    .select('codigo, estado, paquete_canonical, paquete_hash, tx_hash, bloque, sellado_en')
    .eq('codigo', codigo).maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: 'No se pudo consultar el lote.' });
  if (!data || data.estado !== 'SELLADO') return res.status(404).json({ ok: false, error: 'No hay un lote sellado con ese código.' });
  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.status(200).json({
    ok: true, codigo: data.codigo, canonical: data.paquete_canonical, hashPaquete: data.paquete_hash,
    txHash: data.tx_hash, bloque: data.bloque, selladoEn: data.sellado_en,
    polygonscanTx: `https://polygonscan.com/tx/${data.tx_hash}`,
  });
}

// ─── Cliente: solo SUS parcelas (AJUSTE OFICINA) ────────────────
async function datosCliente(supabase, userId, res) {
  const { data, error } = await supabase.from('v_panel_parcelas').select(
    'id, activo_id_onchain, cliente_id, cliente, nombre_activo, superficie_ha, ' +
    'veredicto, ha_perdidas, cobertura, ultimo_sello, fecha_alta, sellada_onchain'
  ).eq('cliente_id', userId).order('fecha_alta', { ascending: false });
  if (error) {
    console.error('[panel/oficina] Error leyendo parcelas:', error);
    return res.status(500).json({ ok: false, error: 'No se pudieron leer tus parcelas.' });
  }
  return res.status(200).json({ ok: true, generado: new Date().toISOString(), parcelas: data || [] });
}

// ¿Todas estas parcelas (por ID on-chain) son de este cliente?
async function sonDelCliente(supabase, ids, userId) {
  const lista = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!lista.length) return false;
  const { data, error } = await supabase.from('activos')
    .select('activo_id_onchain, cliente_id').in('activo_id_onchain', lista);
  if (error || !data || data.length !== lista.length) return false;
  return data.every((a) => String(a.cliente_id) === String(userId));
}

// ─── Founder: panel ─────────────────────────────────────────────
async function datosPanel(supabase, res) {
  const [clientes, parcelas] = await Promise.all([
    supabase.from('v_panel_clientes').select('*').order('parcelas', { ascending: false }),
    supabase.from('v_panel_parcelas').select(
      'id, activo_id_onchain, cliente_id, cliente, nombre_activo, superficie_ha, ' +
      'modo_certificacion, veredicto, ha_perdidas, cobertura, cobertura_hasta, ' +
      'ultimo_sello, fecha_alta, sellada_onchain'
    ).order('fecha_alta', { ascending: false }),
  ]);
  if (clientes.error || parcelas.error) {
    console.error('[panel] Error leyendo vistas:', clientes.error || parcelas.error);
    return res.status(500).json({ ok: false, error: 'No se pudieron leer los datos del panel.' });
  }
  return res.status(200).json({ ok: true, generado: new Date().toISOString(), clientes: clientes.data || [], parcelas: parcelas.data || [] });
}

// ─── Founder: lotes ─────────────────────────────────────────────
async function llamarVps(datos, ejecutar) {
  const ctrl = new AbortController();
  const corte = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(`${TRAZ_VPS_URL}/lote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-traz-secret': TRAZ_SECRET },
      body: JSON.stringify({ ...datos, ejecutar }),
      signal: ctrl.signal,
    });
    return await r.json().catch(() => ({ ok: false, error: 'Respuesta inválida del servidor de trazabilidad.' }));
  } finally {
    clearTimeout(corte);
  }
}

// ─── SEMÁFORO DE RIESGO DE ORIGEN (AJUSTE 17/10/2026) ───────────────────────
// Un indicador simple y explicable, calculado al momento con datos que ya
// están sellados (veredicto de deforestación, polígono, capacidad y lotes).
// NO reemplaza la debida diligencia: señala DÓNDE mirar (enfoque de riesgo).
//   ROJO     → revisar antes de comprar.
//   AMARILLO → mirar con atención.
//   VERDE    → sin señales.
//   GRIS     → no hay datos suficientes (sin capacidad declarada).
// Reglas (iguales para todos, siempre las mismas):
//   · Deforestación detectada en el propio campo ............... ROJO
//   · Sin saldo (usó el 100 % de su capacidad del año) .......... ROJO
//   · Usó el 90 % o más de su capacidad del año ................. AMARILLO
//   · Vendió el 50 % o más de su capacidad en los últimos 30 días AMARILLO
//     (al simular un lote, cuenta también ese lote)
//   · Campo con deforestación detectada a 500 m o menos ......... ROJO
//   · Campo con deforestación detectada a 5 km o menos .......... AMARILLO
//     (solo entre los campos registrados en EPIMELEIA)
const RIESGO_ORDEN = { verde: 0, gris: 1, amarillo: 2, rojo: 3 };
const RIESGO_KM_ROJO = 0.5, RIESGO_KM_AMARILLO = 5;

function _rPaquete(v) {
  if (!v) return null;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return null; }
}
function _rAnillo(paq) {
  const g = paq && (paq.poligono || paq.geometry || paq.geometria);
  if (!g || !Array.isArray(g.coordinates)) return null;
  let c = g.coordinates;
  if (g.type === "MultiPolygon") c = c[0];
  const anillo = Array.isArray(c) && Array.isArray(c[0]) && Array.isArray(c[0][0]) ? c[0] : c;
  return Array.isArray(anillo) && anillo.length >= 3 && anillo.every((p) => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1])) ? anillo : null;
}
function _rKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLa = (b[1] - a[1]) * rad, dLo = (b[0] - a[0]) * rad;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function _rDentro(p, anillo) {
  let dentro = false;
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
    const [xi, yi] = anillo[i], [xj, yj] = anillo[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}
// Distancia aproximada entre dos polígonos (0 si se tocan o se pisan).
function _rDistPoligonos(A, B) {
  if (A.some((p) => _rDentro(p, B)) || B.some((p) => _rDentro(p, A))) return 0;
  const paso = (n) => Math.max(1, Math.floor(n / 150));
  let min = Infinity;
  for (let i = 0; i < A.length; i += paso(A.length))
    for (let j = 0; j < B.length; j += paso(B.length)) {
      const d = _rKm(A[i], B[j]); if (d < min) min = d;
    }
  return min;
}
function _rFechaDe(fila) {
  const v = fila && (fila.creado_en || fila.created_at || fila.atribuido_en || fila.sellado_en || fila.fecha);
  const t = v ? Date.parse(v) : NaN;
  return isFinite(t) ? t : null;
}
const _rPct = (n) => Math.round(n * 10) / 10;
const _rFmt = (n) => Number(n).toLocaleString("es-AR", { maximumFractionDigits: 1 });

// supabase: cliente con service key · idOnchain: número · opciones: { anio, toneladasLote }
async function calcularRiesgo(supabase, idOnchain, opciones) {
  const anio = Number(opciones && opciones.anio) || new Date().getFullYear();
  const tonLote = Math.max(0, Number(opciones && opciones.toneladasLote) || 0);
  const motivos = [];
  const sumar = (nivel, texto) => motivos.push({ nivel, texto });
  const id = Number(idOnchain);

  // 1) El propio campo: deforestación y polígono.
  const { data: act } = await supabase.from("activos")
    .select("activo_id_onchain, paquete_evidencia").eq("activo_id_onchain", id).maybeSingle();
  const { data: vp } = await supabase.from("v_panel_parcelas")
    .select("veredicto").eq("activo_id_onchain", id).maybeSingle();
  const paq = _rPaquete(act && act.paquete_evidencia);
  const hubo = (vp && vp.veredicto === "hubo deforestacion") || (paq && paq.deforestacion && paq.deforestacion.hubo === true);
  if (hubo) sumar("rojo", "Deforestación detectada en este campo: ninguna tonelada puede salir en un lote.");

  // 2) Capacidad del año y uso.
  const { data: decls } = await supabase.from("traz_declaraciones")
    .select("id, capacidad_anual").eq("origen_tipo", "epimeleia").eq("origen_ref", String(id))
    .eq("anio", anio).eq("veredicto", "ACEPTADA").limit(1);
  const decl = decls && decls[0];
  let capacidad = null, usado = 0, usoPct = null;
  if (!decl) {
    if (!hubo) sumar("gris", `Sin capacidad declarada para ${anio}: no hay base para medir el volumen.`);
  } else {
    capacidad = Number(decl.capacidad_anual) || 0;
    const { data: at } = await supabase.from("traz_atribuciones")
      .select("*").eq("declaracion_id", decl.id).eq("veredicto", "ATRIBUIDA");
    const filas = Array.isArray(at) ? at : [];
    usado = filas.reduce((s, x) => s + (Number(x.toneladas) || 0), 0);
    const despues = usado + tonLote;
    usoPct = capacidad > 0 ? (despues / capacidad) * 100 : 100;
    if (capacidad > 0) {
      if (usoPct >= 100 - 1e-9) sumar("rojo", `Sin saldo: ${tonLote ? "con este lote " : ""}llega al ${_rFmt(usoPct)} % de su capacidad de ${anio}.`);
      else if (usoPct >= 90) sumar("amarillo", `${tonLote ? "Con este lote usa" : "Usó"} el ${_rFmt(usoPct)} % de su capacidad de ${anio}: queda poco margen.`);
      const hace30 = Date.now() - 30 * 24 * 3600 * 1000;
      const recientes = filas.filter((x) => { const t = _rFechaDe(x); return t !== null && t >= hace30; })
        .reduce((s, x) => s + (Number(x.toneladas) || 0), 0) + tonLote;
      const recPct = (recientes / capacidad) * 100;
      if (recPct >= 50) sumar("amarillo", `Vendió el ${_rFmt(recPct)} % de su capacidad anual en los últimos 30 días${tonLote ? " (contando este lote)" : ""}. Puede ser normal justo después de la cosecha; fuera de esa época, conviene mirar.`);
    } else if (!hubo) {
      sumar("gris", `Capacidad declarada en cero para ${anio}.`);
    }
  }

  // 3) Vecinos con deforestación (entre los campos registrados en EPIMELEIA).
  let vecino = null;
  const anillo = _rAnillo(paq);
  if (anillo) {
    const { data: sucios } = await supabase.from("v_panel_parcelas")
      .select("activo_id_onchain, nombre_activo").eq("veredicto", "hubo deforestacion").limit(500);
    const otros = (sucios || []).filter((s) => s.activo_id_onchain != null && Number(s.activo_id_onchain) !== id);
    if (otros.length) {
      const { data: geos } = await supabase.from("activos")
        .select("activo_id_onchain, paquete_evidencia").in("activo_id_onchain", otros.map((s) => Number(s.activo_id_onchain)));
      for (const g of geos || []) {
        const otro = _rAnillo(_rPaquete(g.paquete_evidencia));
        if (!otro) continue;
        const km = _rDistPoligonos(anillo, otro);
        if (km <= RIESGO_KM_AMARILLO && (!vecino || km < vecino.km)) vecino = { id: Number(g.activo_id_onchain), km };
      }
    }
    if (vecino) {
      const dist = vecino.km === 0 ? "pegado o superpuesto a este campo" : `a ${vecino.km < 1 ? Math.round(vecino.km * 1000) + " m" : _rFmt(vecino.km) + " km"}`;
      sumar(vecino.km <= RIESGO_KM_ROJO ? "rojo" : "amarillo", `Hay un campo con deforestación detectada ${dist} (#${vecino.id}): riesgo de que su producción salga por este campo.`);
    }
  }

  let color = "verde";
  for (const m of motivos) if (RIESGO_ORDEN[m.nivel] > RIESGO_ORDEN[color]) color = m.nivel;
  if (!motivos.length) sumar("verde", "Sin señales de riesgo con los datos sellados a hoy.");
  return {
    color, motivos, anio,
    capacidad: capacidad !== null ? Math.round(capacidad * 1000) / 1000 : null,
    usoPct: usoPct !== null ? _rPct(usoPct) : null,
    vecinoKm: vecino ? Math.round(vecino.km * 1000) / 1000 : null,
    calculadoEn: new Date().toISOString(),
  };
}

async function accionRiesgo(supabase, body, res, soloCliente) {
  const lista = (Array.isArray(body.parcelas) ? body.parcelas : [])
    .map((p) => ({ id: Number(p && p.activoIdOnchain), ton: Number(p && p.toneladas) || 0 }))
    .filter((p) => Number.isInteger(p.id) && p.id > 0).slice(0, 60);
  if (!lista.length) return res.status(400).json({ ok: false, error: 'Faltan parcelas.' });
  if (soloCliente && !(await sonDelCliente(supabase, lista.map((p) => p.id), soloCliente))) {
    return res.status(403).json({ ok: false, error: 'Solo podés consultar parcelas registradas a tu nombre.' });
  }
  const anio = Number(body.anio) || new Date().getFullYear();
  const riesgos = {};
  let color = 'verde';
  for (const p of lista) {
    try {
      const r = await calcularRiesgo(supabase, p.id, { anio, toneladasLote: p.ton });
      riesgos[p.id] = r;
      if (RIESGO_ORDEN[r.color] > RIESGO_ORDEN[color]) color = r.color;
    } catch (e) {
      console.error('[panel/riesgo]', p.id, e && e.message);
      riesgos[p.id] = null;
    }
  }
  return res.status(200).json({ ok: true, color, riesgos });
}

async function accionLote(supabase, body, res, soloCliente) {
  // soloCliente: null = founder (todo) · id de usuario = cliente (solo lo suyo)
  const accion = body.accion;
  if (accion === 'riesgo') return accionRiesgo(supabase, body, res, soloCliente);
  if (accion === 'estado') {
    const codigo = String(body.codigo || '').trim();
    if (!codigo) return res.status(400).json({ ok: false, error: 'Falta el código.' });
    const { data, error } = await supabase.from('traz_lotes')
      .select('codigo, estado, error, veredicto, tx_hash, bloque, sellado_en, toneladas, cliente_id').eq('codigo', codigo).maybeSingle();
    if (error) return res.status(500).json({ ok: false, error: 'No se pudo leer el lote.' });
    if (data && soloCliente && String(data.cliente_id) !== String(soloCliente)) {
      return res.status(200).json({ ok: true, lote: null });
    }
    if (data) delete data.cliente_id;
    return res.status(200).json({ ok: true, lote: data || null });
  }
  if (accion === 'listar') {
    const clienteId = soloCliente ? String(soloCliente) : String(body.clienteId || '').trim();
    if (!clienteId) return res.status(400).json({ ok: false, error: 'Falta el cliente.' });
    const { data, error } = await supabase.from('traz_lotes')
      .select('codigo, estado, cultivo, anio, fecha, toneladas, tx_hash, sellado_en, error')
      .eq('cliente_id', clienteId).order('creado_en', { ascending: false });
    if (error) return res.status(500).json({ ok: false, error: 'No se pudieron leer los lotes.' });
    return res.status(200).json({ ok: true, lotes: data || [] });
  }
  // LOTE POR ID: lo que el sistema ya sabe de una parcela (cultivo y saldo).
  if (accion === 'infoParcela') {
    const id = Number(body.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, error: 'ID inválido.' });
    const anio = Number(body.anio) || new Date().getFullYear();
    const { data: act } = await supabase.from('activos')
      .select('activo_id_onchain, nombre_activo, cultivo, pais, cliente_id').eq('activo_id_onchain', id).maybeSingle();
    if (!act) return res.status(404).json({ ok: false, error: `No existe la parcela #${id}.` });
    if (soloCliente && String(act.cliente_id) !== String(soloCliente)) {
      return res.status(403).json({ ok: false, error: `La parcela #${id} no está registrada a tu nombre.` });
    }
    const { data: decls } = await supabase.from('traz_declaraciones')
      .select('id, cultivo, anio, capacidad_anual').eq('origen_tipo', 'epimeleia').eq('origen_ref', String(id))
      .eq('anio', anio).eq('veredicto', 'ACEPTADA').order('sellado_en', { ascending: false }).limit(1);
    const decl = (decls && decls[0]) || null;
    let usadas = 0;
    if (decl) {
      const { data: at } = await supabase.from('traz_atribuciones')
        .select('toneladas').eq('declaracion_id', decl.id).eq('veredicto', 'ATRIBUIDA');
      usadas = (at || []).reduce((s, x) => s + (Number(x.toneladas) || 0), 0);
    }
    return res.status(200).json({ ok: true, parcela: {
      id, nombre: act.nombre_activo, clienteId: act.cliente_id,
      cultivo: (decl && decl.cultivo) || act.cultivo || null, pais: act.pais || null, anio,
      capacidad: decl ? Number(decl.capacidad_anual) : null,
      usadas: Math.round(usadas * 1000) / 1000,
      saldo: decl ? Math.round((Number(decl.capacidad_anual) - usadas) * 1000) / 1000 : null,
    } });
  }
  // LOTE POR ID: el próximo código libre (LOTE-AAAA-NNN), para no inventarlo.
  if (accion === 'siguienteCodigo') {
    const anio = Number(body.anio) || new Date().getFullYear();
    const pref = `LOTE-${anio}-`;
    const { data } = await supabase.from('traz_lotes').select('codigo').like('codigo', pref + '%');
    let max = 0;
    for (const f of data || []) { const n = parseInt(String(f.codigo).slice(pref.length), 10); if (n > max) max = n; }
    return res.status(200).json({ ok: true, codigo: pref + String(max + 1).padStart(3, '0') });
  }
  if (accion === 'simular' || accion === 'sellar') {
    if (!TRAZ_SECRET || !TRAZ_VPS_URL) return res.status(500).json({ ok: false, error: 'Faltan TRAZ_SECRET o TRAZ_VPS_URL en Vercel.' });
    if (soloCliente) {
      const ids = (Array.isArray(body.parcelas) ? body.parcelas : []).map((p) => p && p.activoIdOnchain);
      if (!(await sonDelCliente(supabase, ids, soloCliente))) {
        return res.status(403).json({ ok: false, error: 'Solo podés armar lotes con parcelas registradas a tu nombre.' });
      }
    }
    const datos = { codigo: body.codigo, cultivo: body.cultivo, anio: body.anio, fecha: body.fecha, receptor: body.receptor, parcelas: body.parcelas };
    try {
      return res.status(200).json(await llamarVps(datos, accion === 'sellar'));
    } catch (err) {
      console.error('[panel/lote] VPS no respondió:', err.message);
      return res.status(502).json({ ok: false, error: 'El servidor de trazabilidad no respondió. Probá de nuevo.' });
    }
  }
  return res.status(400).json({ ok: false, error: 'Acción desconocida.' });
}

module.exports = async function handler(req, res) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ ok: false, error: 'Configuración incompleta del servidor.' });
  }

  if (req.method === 'GET') return lotePublico(req, res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'Método no permitido.' });
  }
  if (!SELLO_FOUNDER_EMAIL) return res.status(500).json({ ok: false, error: 'Configuración incompleta del servidor.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};
  const token = typeof body.token === 'string' ? body.token : '';
  if (!token) return res.status(401).json({ ok: false, error: 'Falta la sesión. Iniciá sesión.' });

  const supabase = cliente();
  const { data: u, error: eU } = await supabase.auth.getUser(token);
  if (eU || !u || !u.user) return res.status(401).json({ ok: false, error: 'Tu sesión no es válida. Iniciá sesión de nuevo.' });
  const esFounder = (u.user.email || '').toLowerCase().trim() === SELLO_FOUNDER_EMAIL;

  res.setHeader('Cache-Control', 'no-store');

  // AJUSTE OFICINA: el cliente pasa, pero solo con lo suyo.
  // modo 'oficina' lo pide oficina.html; así el founder también puede ver
  // SU propia oficina sin que se mezcle con la cartera completa.
  const modoOficina = body.modo === 'oficina' || !esFounder;
  if (modoOficina) {
    if (body.accion) return accionLote(supabase, body, res, u.user.id);
    return datosCliente(supabase, u.user.id, res);
  }

  if (body.accion) return accionLote(supabase, body, res, null);
  return datosPanel(supabase, res);
};