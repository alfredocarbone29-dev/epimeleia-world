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