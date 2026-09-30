/**
 * EPIMELEIA V3.4 — Oracle Node · reports.js
 * (cabecera original — sin cambios)
 */

const axios    = require('axios');
const { config } = require('./config');
const { log }    = require('./logger');

async function enviarReporteTrimestral(params) {
  const {
    activoId, owner, trimestre, datosBilling,
    certs, huecos, indiceCont, emailDestino, nombreActivo
  } = params;

  const año  = Math.floor(trimestre / 10);
  const q    = trimestre % 10;
  const asunto = `[EPIMELEIA] Reporte Trimestral Q${q} ${año} — ${nombreActivo}`;

  const html = _generarHTMLReporte({
    activoId, owner, año, q, datosBilling,
    certs, huecos, indiceCont, nombreActivo
  });

  log('EMAIL', `Enviando reporte trimestral`, { activoId, trimestre, emailDestino });
  await _enviarEmail({ para: emailDestino, asunto, html });
  log('EMAIL', `Reporte Q${q}/${año} enviado`, { activoId, emailDestino });
}

function _generarHTMLReporte({ activoId, owner, año, q, datosBilling, certs, huecos, indiceCont, nombreActivo }) {
  const estadoColor = indiceCont >= 75 ? '#1a4a1a' : indiceCont >= 50 ? '#8a6a1a' : '#7a2a1a';
  const estadoTexto = indiceCont >= 75 ? 'EXCELENTE' : indiceCont >= 50 ? 'REGULAR' : 'CRÍTICO';

  const filaCerts = certs.map(c => `
    <tr>
      <td style="padding:8px;border:1px solid #ddd;font-family:monospace;font-size:12px;">${c.satelite}</td>
      <td style="padding:8px;border:1px solid #ddd;font-size:12px;">${c.bandaEspectral}</td>
      <td style="padding:8px;border:1px solid #ddd;font-size:12px;">${c.nubosidadPct}%</td>
      <td style="padding:8px;border:1px solid #ddd;font-family:monospace;font-size:11px;">${c.hashEvidencia?.slice(0,16)}...</td>
      <td style="padding:8px;border:1px solid #ddd;font-size:11px;">${new Date(c.timestamp * 1000).toLocaleDateString('es-AR')}</td>
      <td style="padding:8px;border:1px solid #ddd;">
        ${c.urlDescargaDatos
          ? `<a href="${c.urlDescargaDatos}" style="color:#1a4a1a;font-size:11px;">⬇ DESCARGAR</a>`
          : '—'}
      </td>
    </tr>`).join('');

  const filaHuecos = huecos.map(h => `
    <tr>
      <td style="padding:8px;border:1px solid #fdd;font-size:12px;color:#7a2a1a;">${h.causa}</td>
      <td style="padding:8px;border:1px solid #fdd;font-size:12px;">${h.esCausaClimatica ? '🌧 Climática' : '⚠ Técnica/Humana'}</td>
      <td style="padding:8px;border:1px solid #fdd;font-size:11px;">${new Date(h.timestamp * 1000).toLocaleDateString('es-AR')}</td>
    </tr>`).join('');

  return `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f0e8;font-family:'Georgia',serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f0e8;padding:40px 20px;">
<tr><td>
<table width="600" cellpadding="0" cellspacing="0" style="margin:0 auto;background:#ffffff;border:1px solid #ddd;">
  <tr>
    <td style="background:#0f1a0f;padding:32px 40px;">
      <div style="font-family:'Georgia',serif;font-size:24px;letter-spacing:4px;color:#f4f0e8;">EPIMELEIA</div>
      <div style="font-family:monospace;font-size:10px;color:#8a9e8a;letter-spacing:2px;margin-top:4px;">
        NOTARIO DIGITAL AMBIENTAL · POLYGON MAINNET · V3.4
      </div>
    </td>
  </tr>
  <tr>
    <td style="padding:32px 40px;border-bottom:1px solid #eee;">
      <div style="font-family:monospace;font-size:10px;letter-spacing:3px;color:#8a9e8a;margin-bottom:8px;">
        REPORTE DE CIERRE TRIMESTRAL
      </div>
      <h1 style="font-size:28px;font-weight:300;color:#0f1a0f;margin:0 0 8px 0;">
        Q${q} ${año} — ${nombreActivo}
      </h1>
      <div style="font-family:monospace;font-size:11px;color:#5a6a5a;">
        Activo ID: ${activoId} &nbsp;·&nbsp; Wallet: ${owner?.slice(0,10)}...${owner?.slice(-6)}
      </div>
    </td>
  </tr>
  <tr>
    <td style="padding:24px 40px;background:#f9f9f7;border-bottom:1px solid #eee;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td>
            <div style="font-family:monospace;font-size:10px;letter-spacing:2px;color:#8a9e8a;">ÍNDICE DE CONTINUIDAD</div>
            <div style="font-size:48px;font-weight:bold;color:${estadoColor};margin-top:4px;">${indiceCont}%</div>
            <div style="font-family:monospace;font-size:12px;color:${estadoColor};letter-spacing:1px;">${estadoTexto}</div>
          </td>
          <td style="text-align:right;vertical-align:top;">
            <div style="font-family:monospace;font-size:10px;color:#8a9e8a;margin-bottom:4px;">CERTIFICACIONES Q</div>
            <div style="font-size:24px;color:#1a4a1a;font-weight:bold;">${certs.length}</div>
            <div style="font-family:monospace;font-size:10px;color:#8a9e8a;margin-top:12px;margin-bottom:4px;">HUECOS DE OPACIDAD</div>
            <div style="font-size:24px;color:#7a2a1a;font-weight:bold;">${huecos.length}</div>
          </td>
        </tr>
      </table>
      <p style="font-size:12px;color:#5a6a5a;margin:16px 0 0 0;line-height:1.7;">
        El índice de continuidad representa el porcentaje de trimestres con certificación satelital exitosa
        sobre el total de trimestres transcurridos desde el registro. Es el indicador principal de
        consistencia ambiental de tu empresa ante terceros.
      </p>
    </td>
  </tr>
  ${certs.length > 0 ? `
  <tr>
    <td style="padding:24px 40px;border-bottom:1px solid #eee;">
      <div style="font-family:monospace;font-size:10px;letter-spacing:2px;color:#8a9e8a;margin-bottom:16px;">
        CERTIFICACIONES SATELITALES DEL TRIMESTRE
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px;">
        <tr style="background:#f0ece0;">
          <th style="padding:8px;border:1px solid #ddd;text-align:left;font-family:monospace;font-size:10px;">SATÉLITE</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;font-family:monospace;font-size:10px;">BANDA</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;font-family:monospace;font-size:10px;">NUBOSIDAD</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;font-family:monospace;font-size:10px;">HASH</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;font-family:monospace;font-size:10px;">FECHA</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;font-family:monospace;font-size:10px;">DATOS</th>
        </tr>
        ${filaCerts}
      </table>
      <p style="font-size:11px;color:#8a9e8a;margin-top:8px;font-family:monospace;">
        Cada hash de evidencia es el keccak256 del reporte satelital completo, grabado en Polygon Mainnet. Inalterable.
      </p>
    </td>
  </tr>` : ''}
  ${huecos.length > 0 ? `
  <tr>
    <td style="padding:24px 40px;border-bottom:1px solid #eee;background:#fff8f8;">
      <div style="font-family:monospace;font-size:10px;letter-spacing:2px;color:#7a2a1a;margin-bottom:16px;">
        HUECOS DE OPACIDAD REGISTRADOS
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px;">
        <tr style="background:#fdd;">
          <th style="padding:8px;border:1px solid #fdd;text-align:left;font-family:monospace;font-size:10px;">CAUSA</th>
          <th style="padding:8px;border:1px solid #fdd;text-align:left;font-family:monospace;font-size:10px;">TIPO</th>
          <th style="padding:8px;border:1px solid #fdd;text-align:left;font-family:monospace;font-size:10px;">FECHA</th>
        </tr>
        ${filaHuecos}
      </table>
      <p style="font-size:11px;color:#7a2a1a;margin-top:8px;line-height:1.6;">
        Un Hueco de Opacidad no es una penalización. Es la verdad grabada permanentemente.
        Un hueco con causa climática acreditada no afecta la reputación de la empresa.
      </p>
    </td>
  </tr>` : ''}
  <tr>
    <td style="padding:24px 40px;border-bottom:1px solid #eee;">
      <div style="font-family:monospace;font-size:10px;letter-spacing:2px;color:#8a9e8a;margin-bottom:12px;">ESTADO DE CUENTA</div>
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="font-size:13px;color:#3a4a3a;padding:4px 0;">Saldo disponible:</td>
          <td style="font-family:monospace;font-size:13px;color:#1a4a1a;text-align:right;padding:4px 0;">
            ${datosBilling?.saldo || '—'} POL
          </td>
        </tr>
        <tr>
          <td style="font-size:13px;color:#3a4a3a;padding:4px 0;">Próximo billing:</td>
          <td style="font-family:monospace;font-size:13px;color:#3a4a3a;text-align:right;padding:4px 0;">
            ${datosBilling?.diasHastaBilling != null ? `${datosBilling.diasHastaBilling} días` : '—'}
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td style="padding:24px 40px;background:#0f1a0f;">
      <p style="color:rgba(244,240,232,0.6);font-size:11px;font-family:monospace;margin:0;line-height:1.8;">
        Este reporte fue generado automáticamente por el protocolo EPIMELEIA V3.4.<br>
        Contrato activo en Polygon Mainnet. Datos verificables públicamente en blockchain.<br>
        Consultas: <a href="mailto:info@epimeleia.world" style="color:#4a7c4a;">info@epimeleia.world</a>
        &nbsp;·&nbsp; <a href="https://epimeleia.world" style="color:#4a7c4a;">epimeleia.world</a>
      </p>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ─── Aviso QUINCENAL de evidencia de ventana ───────────────────
// (cabecera original — sin cambios)
//
// AJUSTE 44 — LAS MEDICIONES, EN FORMA HUMANA, TAMBIÉN EN EL MAIL
// Hasta acá el mail mostraba solo la CALIDAD (%). Los números medidos
// (NDVI, humedad, etc.) con su interpretación en palabras —"vegetación
// densa y sana", "el agua está clara"— existían en la medición y se veían
// en el simulacro founder, pero NO llegaban al mail: quien llama no los
// pasaba, y el mail no tenía dónde mostrarlos. Ahora, si quien llama pasa
// `mediciones` (el array que devuelve satellite.medirIndicadores), el mail
// suma la sección "Lo que midió el satélite", con cada índice, su valor y
// su lectura humana — lo mismo que ve el founder. Mismo espíritu honesto:
// si no llegan mediciones, la sección no aparece (no se inventa).

async function enviarEvidenciaQuincenal(p) {
  const {
    activoId, nombreActivo, emailDestino,
    trimestre, quincenaDelTrimestre,
    caso,
    calidadPct, satelite, fechaPasada, hashEvidencia, txHash, bloque,
    esClimatica,
    deforestacion,
    mediciones,                      // ← AJUSTE 44: números + interpretación humana
  } = p;

  const geometria = p.geometria || p.geoJSON || p.poligono || p.coordinates || null;

  const q       = trimestre % 10;
  const anio    = Math.floor(trimestre / 10);
  const sellado = caso === 'sellado';
  const parcial = sellado && typeof calidadPct === 'number' && calidadPct < 70;

  let asunto;
  if (sellado && !parcial) {
    asunto = `[EPIMELEIA] Evidencia sellada · ${nombreActivo}`;
  } else if (sellado && parcial) {
    asunto = `[EPIMELEIA] Evidencia sellada (visibilidad parcial) · ${nombreActivo}`;
  } else {
    asunto = `[EPIMELEIA] Reporte quincenal · ${nombreActivo}`;
  }

  const imagenMapa = await _imagenMapaStatic(geometria);

  const html = _generarHTMLQuincenal({
    activoId, nombreActivo, q, anio, quincenaDelTrimestre,
    sellado, parcial,
    calidadPct, satelite, fechaPasada, hashEvidencia, txHash, bloque,
    esClimatica,
    deforestacion,
    mediciones,                      // ← AJUSTE 44
    geometria,
    tieneImagenMapa: !!imagenMapa,
  });

  log('EMAIL', `Enviando aviso quincenal`, { activoId, trimestre, caso, emailDestino, conImagen: !!imagenMapa });
  await _enviarEmail({ para: emailDestino, asunto, html, adjuntos: imagenMapa ? [imagenMapa] : [] });
  log('EMAIL', `Aviso quincenal enviado`, { activoId, caso, emailDestino });
}

function _fechaCorta(v) {
  if (!v) return '—';
  const d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' });
}

const MAPA_CID = 'mapa_activo';

function _tokenMapbox() {
  return (config.mapbox && config.mapbox.token) ||
         process.env.MAPBOX_TOKEN ||
         process.env.MAPBOX_STATIC_TOKEN ||
         '';
}

function _anilloDeGeometria(geometria) {
  if (!geometria) return null;
  let g = geometria;
  if (typeof g === 'string') {
    try { g = JSON.parse(g); } catch (e) { return null; }
  }
  if (g && g.type === 'Feature') g = g.geometry;
  if (g && g.type === 'Polygon' && Array.isArray(g.coordinates)) return g.coordinates[0];
  if (g && g.type === 'MultiPolygon' && Array.isArray(g.coordinates)) return g.coordinates[0][0];
  if (g && Array.isArray(g.coordinates) && Array.isArray(g.coordinates[0]) && Array.isArray(g.coordinates[0][0])) return g.coordinates[0];
  if (Array.isArray(g) && Array.isArray(g[0])) return g;
  return null;
}

async function _imagenMapaStatic(geometria) {
  try {
    const token = _tokenMapbox();
    if (!token) { log('EMAIL', 'Sin token Mapbox server-side — el mail sale sin imagen del mapa'); return null; }

    let ring = _anilloDeGeometria(geometria);
    if (!ring || ring.length < 3) return null;

    ring = ring.map(c => [ +Number(c[0]).toFixed(5), +Number(c[1]).toFixed(5) ]);
    const a = ring[0], z = ring[ring.length - 1];
    if (a[0] !== z[0] || a[1] !== z[1]) ring = ring.concat([[a[0], a[1]]]);

    const overlay = {
      type: 'Feature',
      properties: { 'stroke': '#4ade80', 'stroke-width': 3, 'stroke-opacity': 1, 'fill-opacity': 0 },
      geometry: { type: 'Polygon', coordinates: [ring] },
    };

    const geojsonParam = encodeURIComponent(JSON.stringify(overlay));
    const url = 'https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/static/geojson('
              + geojsonParam + ')/auto/600x360@2x?padding=40&access_token=' + token;

    if (url.length > 8000) { log('EMAIL', 'Polígono demasiado complejo para la imagen — mail sin mapa'); return null; }

    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
    const base64 = Buffer.from(resp.data, 'binary').toString('base64');
    return { base64, contentId: MAPA_CID, filename: 'mapa-activo.png', type: 'image/png' };
  } catch (err) {
    log('ERROR', `No se pudo generar la imagen del mapa: ${err.message}`);
    return null;
  }
}

function _seccionImagenMapa(tiene) {
  if (!tiene) return '';
  return `
  <tr>
    <td style="padding:0 40px 24px 40px;">
      <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#8a9e8a;margin-bottom:8px;">VISTA SATELITAL · CONTORNO CERTIFICADO</div>
      <img src="cid:${MAPA_CID}" width="520" alt="Vista satelital del activo con el contorno certificado" style="display:block;width:100%;max-width:520px;height:auto;border:1px solid #e0d8c8;border-radius:2px;" />
      <div style="font-family:monospace;font-size:10px;color:#8a9e8a;margin-top:6px;line-height:1.6;">Imagen satelital del área exacta que se certificó. El contorno marca el polígono sellado.</div>
    </td>
  </tr>`;
}

// ════════════════════════════════════════════════════════════════
//  AJUSTE 44 · LAS MEDICIONES EN FORMA HUMANA
//  ──────────────────────────────────────────────────────────────
//  Muestra cada índice medido sobre el polígono con tres cosas: su
//  nombre legible (etiqueta), el número, y la lectura en palabras
//  (interpretación, de la regla pública versionada). Es exactamente
//  lo que ve el founder en el simulacro. Vacía si no llegan mediciones
//  o ninguna tiene algo que decir (espíritu honesto: no se inventa).
// ════════════════════════════════════════════════════════════════
function _seccionMediciones(mediciones) {
  if (!Array.isArray(mediciones) || !mediciones.length) return '';

  // Solo filas con etiqueta o interpretación reales (algo que decir).
  const filas = mediciones.map(m => {
    if (!m) return '';
    const etiqueta = m.etiqueta || m.indice || '—';
    const valorTxt = (m.valor !== null && m.valor !== undefined) ? m.valor : '—';
    const interp   = m.interpretacion || '';
    return `<tr>
      <td style="padding:9px 12px;border-top:1px solid #e0d8c8;font-family:'Georgia',serif;font-size:13px;color:#0f1a0f;vertical-align:top;width:40%;">${etiqueta}</td>
      <td style="padding:9px 12px;border-top:1px solid #e0d8c8;font-family:monospace;font-size:13px;color:#0f1a0f;text-align:right;vertical-align:top;width:16%;white-space:nowrap;">${valorTxt}</td>
      <td style="padding:9px 12px;border-top:1px solid #e0d8c8;font-family:'Georgia',serif;font-style:italic;font-size:13px;color:#3a6a3a;vertical-align:top;">${interp}</td>
    </tr>`;
  }).join('');

  if (!filas.trim()) return '';

  return `
  <tr>
    <td style="padding:0 40px 24px 40px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4ee;border:1px solid #e0d8c8;border-radius:2px;">
        <tr>
          <td style="padding:20px 24px;">
            <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#8a9e8a;margin-bottom:6px;">LO QUE MIDIÓ EL SATÉLITE</div>
            <table width="100%" cellpadding="0" cellspacing="0">
              ${filas}
            </table>
            <div style="font-family:monospace;font-size:10px;color:#8a9e8a;margin-top:14px;line-height:1.6;">
              Cada índice es una medición real sobre tu polígono, con su lectura en palabras.<br>
              La interpretación sigue una regla pública y versionada — el mismo número, leído siempre igual.
            </div>
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function _seccionUbicacion(geometria) {
  const ring = _anilloDeGeometria(geometria);
  if (!ring || ring.length < 3) return '';

  let pts = ring.slice();
  const a = pts[0], z = pts[pts.length - 1];
  if (a && z && a[0] === z[0] && a[1] === z[1]) pts = pts.slice(0, -1);
  if (pts.length < 3) return '';

  let sumLon = 0, sumLat = 0;
  for (const c of pts) { sumLon += Number(c[0]); sumLat += Number(c[1]); }
  const cLat = (sumLat / pts.length).toFixed(6);
  const cLon = (sumLon / pts.length).toFixed(6);

  const TOPE  = 12;
  const total = pts.length;
  const filas = pts.slice(0, TOPE).map((c, i) => {
    const lat = Number(c[1]).toFixed(6);
    const lon = Number(c[0]).toFixed(6);
    return `<tr>
      <td style="padding:3px 10px;font-family:monospace;font-size:11px;color:#8a9e8a;width:28px;">${i + 1}</td>
      <td style="padding:3px 10px;font-family:monospace;font-size:11px;color:#0f1a0f;">${lat}, ${lon}</td>
    </tr>`;
  }).join('');

  const resto = total > TOPE
    ? `<div style="font-family:monospace;font-size:10px;color:#8a9e8a;margin-top:8px;">… y ${total - TOPE} vértice(s) más · ${total} en total.</div>`
    : '';

  return `
  <tr>
    <td style="padding:0 40px 24px 40px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4ee;border:1px solid #e0d8c8;border-radius:2px;">
        <tr>
          <td style="padding:20px 24px;">
            <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#8a9e8a;">UBICACIÓN CERTIFICADA · GEOLOCALIZACIÓN EUDR</div>
            <div style="font-family:monospace;font-size:11px;color:#8a9e8a;margin-top:12px;">Centro del predio</div>
            <div style="font-family:monospace;font-size:13px;color:#0f1a0f;margin-top:2px;">Lat ${cLat} · Lon ${cLon}</div>
            <div style="font-family:monospace;font-size:11px;color:#8a9e8a;margin-top:14px;margin-bottom:4px;">Polígono · ${total} vértice(s) &nbsp;(latitud, longitud)</div>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e0d8c8;">
              ${filas}
            </table>
            ${resto}
            <div style="font-family:monospace;font-size:10px;color:#8a9e8a;margin-top:14px;line-height:1.6;">
              Coordenadas en grados decimales (WGS84 · EPSG:4326), el formato del portal TRACES de la UE.<br>
              Son las coordenadas exactas que se sellaron: cualquiera puede reproducir el chequeo sobre este mismo polígono.
            </div>
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function _seccionDeforestacion(deforestacion) {
  if (!deforestacion || typeof deforestacion.huboDeforestacion !== 'boolean') return '';

  const hubo      = deforestacion.huboDeforestacion;
  const totalHa   = (typeof deforestacion.totalHectareasPerdidas === 'number')
    ? deforestacion.totalHectareasPerdidas : null;
  const periodo   = deforestacion.periodoAnalizado || '—';
  const fuente    = deforestacion.fuente || 'Global Forest Watch / UMD GLAD';
  const resol     = deforestacion.resolucion || '30m';

  const acento    = hubo ? '#8a6a1a' : '#3a6a3a';
  const fondo     = hubo ? '#faf6ec' : '#f2f6f0';
  const borde     = hubo ? '#e6d9b8' : '#d6e4d2';
  const titulo    = hubo ? 'Se detectó pérdida de cobertura en el período' : 'Sin pérdida de cobertura en el período';
  const veredicto = hubo ? 'HUBO DEFORESTACIÓN' : 'SIN DEFORESTACIÓN';

  let detalleAnios = '';
  if (hubo && Array.isArray(deforestacion.detallePorAnio) && deforestacion.detallePorAnio.length) {
    const filas = deforestacion.detallePorAnio
      .filter(d => d && Number(d.hectareas) > 0)
      .map(d => `<tr>
        <td style="padding:4px 10px;font-family:monospace;font-size:11px;color:#5a6a5a;">${d.anio}</td>
        <td style="padding:4px 10px;font-family:monospace;font-size:11px;color:${acento};text-align:right;">${d.hectareas} ha</td>
      </tr>`).join('');
    if (filas) {
      detalleAnios = `
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;border-top:1px solid ${borde};">
        ${filas}
      </table>`;
    }
  }

  return `
  <tr>
    <td style="padding:0 40px 24px 40px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:${fondo};border:1px solid ${borde};border-radius:2px;">
        <tr>
          <td style="padding:20px 24px;">
            <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#8a9e8a;">CHEQUEO DE DEFORESTACIÓN · EUDR</div>
            <div style="font-family:'Georgia',serif;font-size:18px;color:${acento};margin:8px 0 4px 0;">${veredicto}</div>
            <div style="font-family:'Georgia',serif;font-size:13px;color:#3a4a3a;line-height:1.6;">${titulo}${totalHa != null ? ` — <strong>${totalHa} ha</strong>` : ''}.</div>
            ${detalleAnios}
            <div style="font-family:monospace;font-size:10px;color:#8a9e8a;margin-top:12px;line-height:1.6;">
              Período analizado: ${periodo}<br>
              Fuente: ${fuente} · resolución ${resol}
            </div>
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function _generarHTMLQuincenal({
  activoId, nombreActivo, q, anio, quincenaDelTrimestre,
  sellado, parcial, calidadPct, satelite, fechaPasada, hashEvidencia, txHash, bloque,
  esClimatica, deforestacion, mediciones, tieneImagenMapa, geometria,
}) {
  const contratoCert = config.contratos?.cert || '';
  const urlTx        = txHash ? `https://polygonscan.com/tx/${txHash}` : '';
  const urlContrato  = contratoCert ? `https://polygonscan.com/address/${contratoCert}` : '';

  const eyebrow  = sellado ? 'EVIDENCIA QUINCENAL SELLADA' : 'REPORTE QUINCENAL';
  const subtitulo = sellado
    ? `Observación satelital · quincena ${quincenaDelTrimestre}/6 · pasada del ${_fechaCorta(fechaPasada)}`
    : `Quincena ${quincenaDelTrimestre}/6 · Q${q} · ${anio}`;

  let mensaje;
  if (sellado && !parcial) {
    mensaje = `Esta quincena el satélite observó <strong>${nombreActivo}</strong> y la lectura quedó sellada en Polygon.
      Acá está tu prueba: nadie puede tocarla ni cambiarla, y cualquiera puede verificarla.`;
  } else if (sellado && parcial) {
    mensaje = `Esta quincena el satélite observó <strong>${nombreActivo}</strong> y la lectura quedó sellada en Polygon.
      La visibilidad fue parcial, pero alcanzó para sellar: el registro queda igual de firme y verificable.`;
  } else if (esClimatica) {
    mensaje = `Esta quincena el satélite pasó sobre <strong>${nombreActivo}</strong>, pero la visibilidad no alcanzó
      para sellar con la calidad que exigimos. No es una falta ni penaliza nada: se retoma en la próxima ventana.
      Todo lo que sí se selló antes sigue público y verificable en la cadena.`;
  } else {
    mensaje = `Esta quincena no se obtuvo una observación utilizable de <strong>${nombreActivo}</strong>.
      No penaliza nada: se retoma en la próxima ventana. Y todo lo que sí se selló antes sigue público y
      verificable en la cadena.`;
  }

  const filaTecnica = sellado ? `
  <tr>
    <td style="padding:20px 40px;border-bottom:1px solid #eee;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          <td style="padding:10px 12px;border:1px solid #e6e0d4;width:33%;">
            <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#8a9e8a;">SATÉLITE</div>
            <div style="font-family:monospace;font-size:13px;color:#0f1a0f;margin-top:4px;">${satelite || 'Sentinel-2 L2A'}</div>
          </td>
          <td style="padding:10px 12px;border:1px solid #e6e0d4;width:34%;">
            <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#8a9e8a;">FUENTE</div>
            <div style="font-family:monospace;font-size:13px;color:#0f1a0f;margin-top:4px;">ESA · Copernicus</div>
          </td>
          <td style="padding:10px 12px;border:1px solid #e6e0d4;width:33%;">
            <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#8a9e8a;">CALIDAD</div>
            <div style="font-family:monospace;font-size:13px;color:#0f1a0f;margin-top:4px;">${typeof calidadPct === 'number' ? calidadPct + '%' : '—'}</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>` : '';

  const seccionImagen = _seccionImagenMapa(tieneImagenMapa);
  const seccionMediciones = _seccionMediciones(mediciones);   // ← AJUSTE 44
  const seccionUbicacion = _seccionUbicacion(geometria);
  const seccionDeforestacion = _seccionDeforestacion(deforestacion);

  const bloquePrueba = sellado ? `
  <tr>
    <td style="padding:28px 40px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1a0f;border-radius:2px;">
        <tr>
          <td style="padding:28px 32px;">
            <div style="font-family:monospace;font-size:9px;letter-spacing:3px;color:#c9a84a;">PRUEBA PÚBLICA · VERIFICABLE POR CUALQUIERA</div>
            <div style="font-family:'Georgia',serif;font-size:19px;color:#f4f0e8;margin:10px 0 16px 0;">Nadie tocó este dato. Y se puede probar.</div>
            <div style="font-family:monospace;font-size:10px;color:#8a9e8a;">Huella de evidencia</div>
            <div style="font-family:monospace;font-size:11px;color:#c9a84a;word-break:break-all;margin:2px 0 10px 0;">${hashEvidencia || '—'}</div>
            ${txHash ? `
            <div style="font-family:monospace;font-size:10px;color:#8a9e8a;">Hash de transacción</div>
            <div style="font-family:monospace;font-size:11px;color:#c9a84a;word-break:break-all;margin:2px 0 10px 0;">${txHash}</div>` : ''}
            <div style="font-family:monospace;font-size:11px;color:#8a9e8a;">Contrato · ${contratoCert} · Polygon Mainnet</div>
            ${bloque != null ? `<div style="font-family:monospace;font-size:11px;color:#8a9e8a;margin-top:4px;">Sellado · bloque #${bloque}</div>` : ''}
            ${urlTx ? `
            <div style="margin-top:18px;">
              <a href="${urlTx}" style="display:inline-block;background:#c9a84a;color:#0f1a0f;font-family:monospace;font-size:12px;letter-spacing:1px;text-decoration:none;padding:12px 22px;">Ver la transacción completa en Polygonscan →</a>
            </div>` : ''}
          </td>
        </tr>
      </table>
    </td>
  </tr>` : `
  <tr>
    <td style="padding:28px 40px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1a0f;border-radius:2px;">
        <tr>
          <td style="padding:28px 32px;">
            <div style="font-family:monospace;font-size:9px;letter-spacing:3px;color:#c9a84a;">REGISTRO PÚBLICO · VERIFICABLE POR CUALQUIERA</div>
            <div style="font-family:'Georgia',serif;font-size:19px;color:#f4f0e8;margin:10px 0 16px 0;">Esta quincena quedó registrada tal cual fue.</div>
            <p style="font-family:'Georgia',serif;font-size:13px;color:rgba(244,240,232,0.75);line-height:1.7;margin:0 0 12px 0;">
              Lo que el satélite sí pudo sellar antes está grabado y no se puede alterar. La verdad siempre está en la cadena.
            </p>
            <div style="font-family:monospace;font-size:11px;color:#8a9e8a;">Contrato · ${contratoCert} · Polygon Mainnet</div>
            ${urlContrato ? `
            <div style="margin-top:18px;">
              <a href="${urlContrato}" style="display:inline-block;background:#c9a84a;color:#0f1a0f;font-family:monospace;font-size:12px;letter-spacing:1px;text-decoration:none;padding:12px 22px;">Ver el historial en la cadena →</a>
            </div>` : ''}
          </td>
        </tr>
      </table>
    </td>
  </tr>`;

  return `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f0e8;font-family:'Georgia',serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f0e8;padding:40px 20px;">
<tr><td>
<table width="600" cellpadding="0" cellspacing="0" style="margin:0 auto;background:#f4f0e8;border:1px solid #e0d8c8;">
  <tr>
    <td style="background:#0f1a0f;padding:28px 40px;">
      <div style="font-family:'Georgia',serif;font-size:22px;letter-spacing:4px;color:#f4f0e8;">EPIMELEIA</div>
      <div style="font-family:monospace;font-size:10px;color:#8a9e8a;letter-spacing:2px;margin-top:4px;">
        NOTARIO DIGITAL AMBIENTAL · POLYGON MAINNET
      </div>
    </td>
  </tr>
  <tr>
    <td style="padding:32px 40px 24px 40px;">
      <div style="font-family:monospace;font-size:10px;letter-spacing:3px;color:#8a9e8a;margin-bottom:10px;">${eyebrow}</div>
      <h1 style="font-family:'Georgia',serif;font-size:26px;font-weight:400;color:#0f1a0f;margin:0 0 6px 0;">${nombreActivo}</h1>
      <div style="font-family:'Georgia',serif;font-style:italic;font-size:14px;color:#5a6a5a;">${subtitulo}</div>
      <div style="font-family:monospace;font-size:11px;color:#8a9e8a;margin-top:8px;">Activo ID: ${activoId}</div>
    </td>
  </tr>
  <tr>
    <td style="padding:0 40px 24px 40px;">
      <p style="font-family:'Georgia',serif;font-size:15px;color:#3a4a3a;line-height:1.75;margin:0;">${mensaje}</p>
    </td>
  </tr>

  ${seccionImagen}
  ${filaTecnica}
  ${seccionMediciones}
  ${seccionUbicacion}
  ${seccionDeforestacion}
  ${bloquePrueba}

  <tr>
    <td style="padding:8px 40px 28px 40px;text-align:center;">
      <div style="font-family:'Georgia',serif;font-style:italic;font-size:15px;color:#5a6a5a;">No vendemos el dato.</div>
      <div style="font-family:'Georgia',serif;font-size:16px;color:#0f1a0f;margin-top:2px;">Vendemos la prueba de que nadie lo tocó.</div>
    </td>
  </tr>
  <tr>
    <td style="padding:22px 40px;background:#0f1a0f;">
      <p style="color:rgba(244,240,232,0.6);font-size:11px;font-family:monospace;margin:0;line-height:1.8;">
        Aviso generado automáticamente por el protocolo EPIMELEIA.<br>
        <a href="mailto:info@epimeleia.world" style="color:#4a7c4a;">info@epimeleia.world</a>
        &nbsp;·&nbsp; <a href="https://www.epimeleia.world" style="color:#4a7c4a;">epimeleia.world</a>
      </p>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ─── Alerta de saldo bajo (Ajuste 5) — sin cambios ─────────────
async function enviarAlertaSaldo(params) {
  const { activoId, owner, emailDestino, nombreActivo, saldoPOL, feeProximo, diasRestantes } = params;

  const asunto = `[EPIMELEIA] ⚠ Saldo bajo — ${nombreActivo} · Recargá antes de ${diasRestantes} días`;

  const html = `
  <div style="font-family:Georgia,serif;max-width:500px;margin:0 auto;background:#f4f0e8;padding:32px;">
    <div style="font-size:20px;letter-spacing:3px;color:#0f1a0f;margin-bottom:16px;">EPIMELEIA</div>
    <h2 style="font-size:20px;font-weight:400;color:#7a2a1a;margin-bottom:16px;">⚠ Alerta: Saldo insuficiente</h2>
    <p style="font-size:14px;color:#3a4a3a;line-height:1.7;">
      El activo <strong>${nombreActivo}</strong> (ID: ${activoId}) no tiene saldo suficiente
      para el próximo ciclo de certificación trimestral.
    </p>
    <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:13px;">
      <tr><td style="padding:8px;border:1px solid #ddd;">Saldo actual</td>
          <td style="padding:8px;border:1px solid #ddd;font-family:monospace;color:#7a2a1a;">${saldoPOL} POL</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">Fee requerido</td>
          <td style="padding:8px;border:1px solid #ddd;font-family:monospace;">${feeProximo} POL</td></tr>
      <tr><td style="padding:8px;border:1px solid #ddd;">Días para actuar</td>
          <td style="padding:8px;border:1px solid #ddd;font-family:monospace;color:#8a6a1a;">${diasRestantes} días</td></tr>
    </table>
    <p style="font-size:13px;color:#5a6a5a;line-height:1.7;">
      Si no recargás saldo dentro de los <strong>7 días de gracia</strong> a partir del vencimiento,
      el activo quedará con un <strong>Hueco de Opacidad</strong> registrado permanentemente en blockchain.
      El activo no se cancela — se preserva con el historial completo.
    </p>
    <p style="font-size:11px;color:#8a9e8a;margin-top:16px;font-family:monospace;">
      Recargá en: epimeleia.world · Consultas: info@epimeleia.world
    </p>
  </div>`;

  log('EMAIL', `Enviando alerta de saldo bajo`, { activoId, emailDestino, diasRestantes });
  await _enviarEmail({ para: emailDestino, asunto, html });
}

async function notificarAdmin(evento, datos) {
  if (!config.notificaciones.webhookUrl) return;
  try {
    await axios.post(
      config.notificaciones.webhookUrl,
      {
        evento, datos,
        timestamp:  new Date().toISOString(),
        red:        'POLYGON_MAINNET',
        protocolo:  'EPIMELEIA_V3.4',
      },
      { timeout: config.notificaciones.timeoutWebhook }
    );
    log('WEBHOOK', `Notificación enviada: ${evento}`);
  } catch (err) {
    log('ERROR', `Webhook fallido: ${err.message}`);
  }
}

async function _enviarEmail({ para, asunto, html, adjuntos }) {
  if (!config.notificaciones.sendgridKey) {
    log('EMAIL', `MOCK (SendGrid no configurado): ${asunto} → ${para}`);
    return;
  }

  const payload = {
    personalizations: [{ to: [{ email: para }] }],
    from:    { email: config.notificaciones.sendgridFrom, name: 'EPIMELEIA Protocol' },
    subject: asunto,
    content: [{ type: 'text/html', value: html }],
  };

  if (Array.isArray(adjuntos) && adjuntos.length) {
    payload.attachments = adjuntos
      .filter(a => a && a.base64 && a.contentId)
      .map(a => ({
        content:     a.base64,
        type:        a.type || 'image/png',
        filename:    a.filename || (a.contentId + '.png'),
        disposition: 'inline',
        content_id:  a.contentId,
      }));
  }

  try {
    await axios.post(
      'https://api.sendgrid.com/v3/mail/send',
      payload,
      {
        headers: {
          'Authorization': `Bearer ${config.notificaciones.sendgridKey}`,
          'Content-Type':  'application/json',
        },
        timeout: 15000,
      }
    );
    log('EMAIL', `Email enviado: ${asunto} → ${para}`);
  } catch (err) {
    log('ERROR', `Error enviando email: ${err.message}`);
  }
}

module.exports = {
  enviarReporteTrimestral,
  enviarEvidenciaQuincenal,
  enviarAlertaSaldo,
  notificarAdmin,
};
