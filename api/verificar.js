// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA · api/verificar.js  (Vercel · PASO B)
// ────────────────────────────────────────────────────────────────────────────
// EL ENDPOINT PÚBLICO DE VERIFICACIÓN.
//
// Devuelve, para un activo, el PAQUETE DE INSCRIPCIÓN canónico tal cual se
// selló: el polígono, el veredicto de deforestación, las mediciones, la regla
// y la huella del titular. Es la otra mitad de "verificable por cualquiera":
// el hash vive en Polygon; el paquete que lo produce vive acá, público.
//
// CÓMO SE USA (cualquiera, sin cuenta, sin confiar en EPIMELEIA):
//   1. GET https://www.epimeleia.world/api/verificar?id=16
//   2. Se toma el campo `canonical` (la cadena exacta) y se le aplica keccak256.
//   3. Se compara con el hash de evidencia que está en la transacción de Polygon.
//      Si coinciden → el dato es auténtico y nadie lo tocó.
//      Si no → algo se alteró.
//
// Para que el paso 2 sea infalible, el endpoint devuelve la cadena `canonical`
// EXACTA que se guardó al sellar (los mismos bytes que se hashearon). El
// verificador NO re-serializa nada: hashea esos bytes. Por eso funciona en
// cualquier lenguaje.
//
// PÚBLICO A PROPÓSITO (decisión del fundador): el polígono y el veredicto se
// muestran completos. "Verificable por cualquiera" sin asteriscos. El único
// dato personal —el email del titular— nunca se guardó en el paquete: viaja
// como huella (titularHash).
//
// BUSCA POR id on-chain (el número que se ve en Polygon), no por el UUID de
// fila. Es el identificador público natural.
//
// AJUSTE 11/10/2026: devuelve también `capacidad` (capacidad anual, lo usado
// en lotes y el saldo) leída de traz_declaraciones / traz_atribuciones.
//
// AJUSTE 17/10/2026: devuelve también `riesgo`, el SEMÁFORO DE RIESGO DE ORIGEN
// (verde / amarillo / rojo / gris + motivos), calculado al momento con los
// datos sellados. Si algo falla, la verificación sigue igual (riesgo: null).
//
// VARIABLES DE ENTORNO (ya están en Vercel):
//   SUPABASE_URL · SUPABASE_SERVICE_KEY
// ────────────────────────────────────────────────────────────────────────────

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Contrato Cert en Polygon (para armar el link de verificación on-chain).
const CONTRATO_CERT = "0xf59BCFB98Ba9e05dC82d44E508d90917AF8bbc93";

// ─── CAPACIDAD Y SALDO (AJUSTE 11/10/2026) ───────────────────────────────────
// La página pública muestra también cuánto puede vender la parcela por año
// (hectáreas × rinde de referencia) y cuánto ya salió en lotes sellados.
// Es el corazón del producto: "ningún campo declara más de lo que su
// superficie y su rinde permiten", visible para cualquiera.
// Solo datos públicos: NUNCA se devuelve el email del titular ni el receptor.
// Si algo falla acá, la verificación de la evidencia sigue igual (capacidad: null).
function _num(v) {
  const n = Number(v);
  return isFinite(n) ? Math.round(n * 1000) / 1000 : null;
}

async function leerCapacidad(idOnchain) {
  try {
    const { data: decls, error: eD } = await supabase
      .from("traz_declaraciones")
      .select("id, cultivo, pais, anio, base_ha, referencia, capacidad_anual, tx_hash, sellado_en")
      .eq("origen_tipo", "epimeleia")
      .eq("origen_ref", String(idOnchain))
      .eq("veredicto", "ACEPTADA");
    if (eD || !Array.isArray(decls) || !decls.length) return null;

    const ids = decls.map((d) => d.id);
    const { data: atribs, error: eA } = await supabase
      .from("traz_atribuciones")
      .select("declaracion_id, anio, toneladas")
      .in("declaracion_id", ids)
      .eq("veredicto", "ATRIBUIDA");
    const lista = (!eA && Array.isArray(atribs)) ? atribs : [];

    return decls
      .map((d) => {
        const suyas = lista.filter((a) => a.declaracion_id === d.id && String(a.anio) === String(d.anio));
        const usado = suyas.reduce((s, a) => s + Number(a.toneladas || 0), 0);
        const cap = Number(d.capacidad_anual) || 0;
        let ref = d.referencia;
        if (typeof ref === "string") { try { ref = JSON.parse(ref); } catch { ref = null; } }
        ref = ref || {};
        const rinde = ref.rinde ?? ref.rindeReferencia ?? ref.valor ??
          (Number(d.base_ha) > 0 ? cap / Number(d.base_ha) : null);
        return {
          cultivo: d.cultivo || null,
          pais: d.pais || null,
          anio: d.anio,
          hectareas: _num(d.base_ha),
          rindeReferencia: _num(rinde),
          fuenteReferencia: (typeof ref.fuente === "string" && ref.fuente) || (typeof ref.origen === "string" && ref.origen) || null,
          capacidadAnual: _num(cap),
          usado: _num(usado),
          saldo: _num(Math.max(0, cap - usado)),
          lotes: suyas.length,
          txHash: d.tx_hash || null,
          polygonscanTx: d.tx_hash ? `https://polygonscan.com/tx/${d.tx_hash}` : null,
        };
      })
      .sort((a, b) => Number(b.anio) - Number(a.anio));
  } catch (e) {
    console.error("[verificar] capacidad:", e && e.message);
    return null;
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
//   · Usó el 70 % o más de su capacidad del año, pero el satélite
//     vio una campaña 15 % o más por DEBAJO de su zona .......... AMARILLO
//     (rinde medido, solo cultivos anuales; ver rinde.js)
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
    // Rinde medido por satélite (AJUSTE 17/10): vende mucho pero el satélite vio poco.
    if (capacidad > 0 && usoPct !== null && usoPct >= 70) {
      try {
        const { data: rc } = await supabase.from("rinde_campanas")
          .select("campana, vs_zona, aplica").eq("activo_id_onchain", id).eq("anio_cosecha", anio).eq("aplica", true).limit(1);
        const r0 = rc && rc[0];
        if (r0 && r0.vs_zona !== null && Number(r0.vs_zona) <= -0.15) {
          sumar("amarillo", `${tonLote ? "Con este lote usa" : "Usó"} el ${_rFmt(usoPct)} % de su capacidad, pero el satélite vio la campaña ${r0.campana} un ${_rFmt(Math.abs(Number(r0.vs_zona)) * 100)} % por debajo de su zona: vende como si hubiera rendido más de lo que se vio crecer.`);
        }
      } catch (_) { /* sin tabla o sin dato: la regla no se aplica */ }
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

module.exports = async (req, res) => {
  // CORS abierto: cualquiera puede verificar desde donde sea.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Usá GET." });
  }

  // El id on-chain llega por query (?id=16) o por path si hubiera rewrite.
  const idCrudo = (req.query && (req.query.id ?? req.query.activo)) || null;
  const idOnchain = idCrudo != null ? String(idCrudo).trim() : null;

  if (!idOnchain || !/^\d+$/.test(idOnchain)) {
    return res.status(400).json({
      ok: false,
      error: "Falta el id on-chain del activo, o no es un número. Ej: /api/verificar?id=16",
    });
  }

  try {
    const { data, error } = await supabase
      .from("activos")
      .select("id, nombre_activo, activo_id_onchain, tx_hash, paquete_evidencia, paquete_hash, paquete_sellado_en")
      .eq("activo_id_onchain", Number(idOnchain))
      .maybeSingle();

    if (error) {
      console.error("[verificar] Supabase:", error.message);
      return res.status(500).json({ ok: false, error: "No se pudo consultar el registro." });
    }

    if (!data) {
      return res.status(404).json({
        ok: false,
        error: `No hay ningún activo sellado con id on-chain ${idOnchain}.`,
        idOnchain: Number(idOnchain),
      });
    }

    // Si el activo existe pero todavía no tiene el paquete guardado
    // (sello viejo, anterior a esta función), se dice con claridad.
    if (!data.paquete_evidencia) {
      return res.status(200).json({
        ok: false,
        verificable: false,
        motivo: "Este activo fue sellado antes de que existiera el paquete verificable. " +
                "Su hash on-chain es válido, pero el paquete público no está disponible para recomputar.",
        idOnchain: Number(idOnchain),
        nombreActivo: data.nombre_activo || null,
        txHash: data.tx_hash || null,
      });
    }

    // `paquete_evidencia` se guardó como la cadena canónica EXACTA (texto).
    // Se devuelve tal cual, sin re-serializar, para que el hash cierre.
    const canonical = typeof data.paquete_evidencia === "string"
      ? data.paquete_evidencia
      : JSON.stringify(data.paquete_evidencia); // red de seguridad si vino como jsonb

    // El paquete legible (parseado) para mostrarlo cómodo en la página.
    let paquete = null;
    try { paquete = JSON.parse(canonical); } catch { paquete = null; }

    // Capacidad y saldo (trazabilidad). No forma parte del paquete sellado:
    // cada declaración y cada lote tienen su propia huella en Polygon.
    const capacidad = await leerCapacidad(idOnchain);

    // Rinde medido por satélite (AJUSTE 17/10/2026): la última campaña guardada.
    let rinde = null;
    try {
      const { data: rc } = await supabase.from("rinde_campanas")
        .select("campana, anio_cosecha, cultivo, aplica, vigor, promedio_historia, vigor_zona, vs_historia, vs_zona, pasadas_opticas, rellenos_radar, calculado_en, detalle")
        .eq("activo_id_onchain", Number(idOnchain)).order("anio_cosecha", { ascending: false }).limit(1);
      const f = rc && rc[0];
      if (f) {
        const d = f.detalle || {};
        rinde = {
          campana: f.campana, anioCosecha: f.anio_cosecha, cultivo: f.cultivo, aplica: f.aplica,
          vigor: f.vigor, promedioHistoria: f.promedio_historia, vigorZona: f.vigor_zona,
          vsHistoria: f.vs_historia, vsZona: f.vs_zona, pasadasOpticas: f.pasadas_opticas, rellenosRadar: f.rellenos_radar,
          temporada: d.temporada || null, motivo: d.motivo || null,
          historia: Array.isArray(d.historia) ? d.historia.map((h) => ({ campana: h.campana, vigor: h.vigor })) : [],
          curva: Array.isArray(d.curva) ? d.curva.map((p) => ({ fecha: p.fecha, ndvi: p.ndvi, origen: p.origen })) : [],
          calculadoEn: f.calculado_en,
        };
      }
    } catch (e) { console.error("[verificar] rinde:", e && e.message); }

    // Semáforo de riesgo de origen (AJUSTE 17/10/2026). Nunca rompe la verificación.
    let riesgo = null;
    try { riesgo = await calcularRiesgo(supabase, Number(idOnchain), { anio: new Date().getFullYear() }); }
    catch (e) { console.error("[verificar] riesgo:", e && e.message); }

    return res.status(200).json({
      ok: true,
      verificable: true,
      idOnchain: Number(idOnchain),
      nombreActivo: data.nombre_activo || null,

      // ── Lo que se compara ──
      // hashPaquete: el keccak256 de `canonical` que se guardó al sellar.
      // Un tercero debe obtener este MISMO valor al hashear `canonical`.
      hashPaquete: data.paquete_hash || null,
      canonical,        // la cadena EXACTA a hashear
      paquete,          // la misma, ya parseada, para leerla cómoda

      // ── Dónde comprobarlo on-chain ──
      txHash: data.tx_hash || null,
      polygonscanTx: data.tx_hash ? `https://polygonscan.com/tx/${data.tx_hash}` : null,
      contrato: CONTRATO_CERT,
      polygonscanContrato: `https://polygonscan.com/address/${CONTRATO_CERT}`,

      selladoEn: data.paquete_sellado_en || null,

      // ── Capacidad anual y saldo por cultivo/año (null si no declaró) ──
      capacidad,

      // ── Semáforo de riesgo de origen (null si no se pudo calcular) ──
      riesgo,

      // ── Rinde medido por satélite, última campaña (null si no se midió) ──
      rinde,

      // ── Instrucciones de verificación, embebidas para que sean públicas ──
      comoVerificar: [
        "1. Tomá el campo 'canonical' (la cadena de texto exacta de esta respuesta).",
        "2. Calculá su keccak256 (por ejemplo con ethers: keccak256(toUtf8Bytes(canonical))).",
        "3. Ese resultado debe ser igual a 'hashPaquete'.",
        "4. Ese mismo hash es el que quedó sellado en Polygon (ver 'polygonscanTx').",
        "Si todo coincide, el polígono, el veredicto y las mediciones son auténticos y nadie los tocó.",
      ],
    });

  } catch (err) {
    console.error("[verificar] Error no capturado:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
};