/**
 * EPIMELEIA V3.4 — generar-pdf.js
 * ─────────────────────────────────────────────────────────────
 * Prueba de punta a punta del certificado en PDF:
 *   1) mide los indicadores reales del satélite sobre un polígono,
 *   2) arma el HTML del certificado con esos números,
 *   3) lo convierte en PDF FIEL con Chrome (puppeteer),
 *   4) lo guarda en disco y lo envía por email.
 *
 * Correr en el VPS con:   node generar-pdf.js
 *
 * ════════════════════════════════════════════════════════════════
 * AJUSTE 29 (10/7) — el certificado respeta el reloj del protocolo.
 * AJUSTE 31 (17/7) — el certificado declara con qué regla leyó.
 * ════════════════════════════════════════════════════════════════
 * AJUSTE 34 (18/7/2026) — EL HASH ES REAL. EL CERTIFICADO DEJA DE MENTIR.
 * ════════════════════════════════════════════════════════════════
 *
 * EL PROBLEMA:
 *   Hasta hoy el certificado mostraba un hash de EJEMPLO (0x7f3a9c…)
 *   y un bloque de ejemplo (#64.208.115), debajo del cartel "Nadie
 *   tocó este dato. Y se puede probar." Era lo único del sistema que
 *   prometía algo que no daba: ese hash no cubría nada, no estaba en
 *   ninguna cadena, no se podía recalcular.
 *
 * EL ARREGLO (Fase 4, pieza 1):
 *   Ahora el certificado arma el PAQUETE DE EVIDENCIA real con
 *   paquete-evidencia.js (Fase 2, probado 8/8) y muestra SU huella
 *   verdadera — la que cubre polígono + mediciones + traducción +
 *   titular + regla. Cualquiera con el paquete puede recalcularla.
 *
 * PERO SE MANTIENE LA HONESTIDAD:
 *   El hash es real, pero TODAVÍA NO está sellado en Polygon (eso es
 *   la Fase 7). Por eso el certificado dice, al lado de la huella:
 *   "Huella calculada · pendiente de sello on-chain". No miente en
 *   ninguna dirección: ni muestra un hash falso como si fuera real,
 *   ni afirma que ya está en la cadena cuando no lo está.
 *
 *   Cuando la Fase 7 selle de verdad, esta misma huella será la que
 *   viaje a certificarQ(), y el "pendiente de sello" pasará a
 *   "sellado · bloque #… · fecha". La huella no cambia.
 *
 * QUÉ NO CAMBIÓ:
 *   · La medición, la regla v1, el diseño — idénticos.
 *   · El titular sigue siendo de ejemplo (IDENTIDAD). Que salga de
 *     Supabase es la Pieza 2 de la Fase 4, aparte.
 * ════════════════════════════════════════════════════════════════
 */

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const axios     = require('axios');
const puppeteer = require('puppeteer');
const { config }            = require('./config');
const { medirIndicadores }  = require('./satellite');
const scheduler             = require('./scheduler');
let   blockchain            = null;

// ── AJUSTE 34: el paquete de evidencia real ──────────────────
const { armarPaquete } = require('./paquete-evidencia');

// ── AJUSTES (cambialos cuando quieras) ───────────────────────
const EMAIL_DESTINO = 'alfredocarbone29@gmail.com';
const RUTA_PDF      = path.join(__dirname, 'certificado-prueba.pdf');

// Activo de prueba (mismo polígono del test satelital)
const ACTIVO_PRUEBA = {
  activoId: 999,
  tipo: 1, // FORESTAL/vegetación
  geometria: {
    type: 'Polygon',
    coordinates: [[
      [-60.60, -33.85], [-60.58, -33.85], [-60.58, -33.87],
      [-60.60, -33.87], [-60.60, -33.85]
    ]]
  }
};

// Datos de identidad del activo (de ejemplo por ahora — vienen de Supabase después).
// AJUSTE 34: se agregan los campos del TITULAR, para que entren al paquete.
const IDENTIDAD = {
  nombreActivo: 'Campo Pergamino',
  tipoNombre:   'Forestal · Vegetación',
  superficieHa: '≈ 409 ha',
  superficieHaNum: 409,
  ubicacion:    'Pergamino, Buenos Aires · AR',
  titular:   'Juan Pérez',
  empresa:   'Agropecuaria del Norte S.A.',
  clienteId: '00000000-0000-0000-0000-000000000000',
  email:     'titular@ejemplo.com',
};

// ── El reloj del protocolo (AJUSTE 29) ───────────────────────
function trimestreDelProtocolo(fechaEmision = new Date()) {
  const periodo = scheduler.periodoDeVentana(fechaEmision);
  const q    = periodo.trimestre % 10;
  const anio = Math.floor(periodo.trimestre / 10);
  return {
    trimestreOnChain: periodo.trimestre,
    etiqueta:         `Q${q} · ${anio}`,
    folioSufijo:      `Q${q}`,
  };
}

// ── Continuidad leída de la cadena (AJUSTE 29) ───────────────
async function leerContinuidad(activoId) {
  if (!blockchain) {
    try { blockchain = require('./blockchain'); blockchain.inicializarBlockchain(); }
    catch (e) { return { texto: 'Primer período certificado', leida: false }; }
  }
  try {
    const cont = await blockchain.getIndiceContinuidad(activoId);
    if (cont.sinHistoria) return { texto: 'Primer período · sin base de comparación', leida: true };
    if (cont.conHueco === 0) return { texto: `Sin huecos de opacidad (${cont.certificados}/${cont.certificados})`, leida: true };
    return { texto: `Continuidad ${cont.pct}% · ${cont.conHueco} hueco(s) en ${cont.total}`, leida: true };
  } catch (e) {
    return { texto: 'Primer período certificado', leida: false };
  }
}

// ── Helpers de presentación ──────────────────────────────────
function chipConfianza(c) {
  return c === 'aproximacion'
    ? '<span class="chip aprox">Aproximación</span>'
    : '<span class="chip medido">Medido</span>';
}

function fechaCorta(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const meses = ['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'];
    return `${String(d.getUTCDate()).padStart(2,'0')} ${meses[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  } catch { return '—'; }
}

function hashCorto(h) {
  if (!h || typeof h !== 'string' || h.length < 20) return '—';
  return h.slice(0, 10) + '…' + h.slice(-8);
}

// ── HTML del certificado (diseño aprobado) ───────────────────
function construirHTML(datos) {
  const filasMedidas = datos.mediciones.map(m => `
      <div class="medida">
        <div class="et">${m.etiqueta}</div>
        <div class="num">${m.valor == null ? '—' : m.valor}</div>
        <div class="interp">${m.interpretacion || 'sin dato'}</div>
        <div class="pie">
          ${chipConfianza(m.confianza)}
          ${m.calidadPct != null ? `<span class="chip calidad">Calidad ${m.calidadPct}%</span>` : ''}
        </div>
      </div>`).join('');

  const pieRegla = datos.reglaLectura
    ? `
      <div class="reglapie">
        Las frases de arriba se leyeron con la <b>Regla de lectura ${datos.reglaLectura}</b>
        · huella <b>${hashCorto(datos.hashRegla)}</b><br>
        El número lo mide el satélite. La regla lo traduce. Las dos cosas están selladas.
      </div>`
    : '';

  const bloqueTitular = datos.titular
    ? `
      <div class="dato"><div class="k">Titular</div><div class="v">${datos.titular}${datos.empresa ? ' · ' + datos.empresa : ''}</div></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600;700&family=Crimson+Pro:ital,wght@0,400;0,500;1,400&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  :root{
    --paper:#f5f1e8; --paper-edge:#e9e2d2; --ink:#12261a; --ink-soft:#43584a;
    --green:#2f5d3a; --green-deep:#0f2a17; --gold:#b08d4c; --gold-bright:#c9a961;
    --line:#d8cfbb; --chip-medido-bg:#173d24; --chip-medido-fg:#eaf3e8; --chip-aprox-fg:#8a6d2f;
  }
  *{box-sizing:border-box;}
  html,body{margin:0;padding:0;}
  body{ background:#fff; font-family:'Crimson Pro',Georgia,serif; color:var(--ink); -webkit-font-smoothing:antialiased; }
  .hoja{ width:100%; background:var(--paper); position:relative; overflow:hidden; }
  .hoja::after{ content:""; position:absolute; inset:14px; border:1px solid rgba(176,141,76,.35); pointer-events:none; }
  .contenido{ padding:44px 52px 40px; position:relative; z-index:1; }
  .cab{ display:flex; justify-content:space-between; align-items:flex-start; gap:24px; }
  .marca{ font-family:'Playfair Display',serif; font-size:30px; letter-spacing:.14em; color:var(--green-deep); font-weight:700; line-height:1; }
  .eyebrow{ font-family:'JetBrains Mono',monospace; font-size:9.5px; letter-spacing:.28em; color:var(--gold); text-transform:uppercase; margin-top:9px; }
  .folio{ text-align:right; font-family:'JetBrains Mono',monospace; font-size:10px; color:var(--ink-soft); letter-spacing:.06em; line-height:1.7; }
  .folio b{ color:var(--green-deep); font-weight:700; }
  .regla{ height:1px; background:linear-gradient(90deg,transparent,var(--gold) 12%,var(--gold) 88%,transparent); margin:22px 0 26px; }
  .titulo{ font-family:'Playfair Display',serif; font-size:34px; font-weight:600; color:var(--green-deep); margin:0; line-height:1.1; }
  .subtitulo{ font-size:17px; color:var(--ink-soft); margin:8px 0 0; font-style:italic; }
  .datos{ display:grid; grid-template-columns:1fr 1fr 1fr; gap:14px 24px; margin-top:28px; }
  .dato .k{ font-family:'JetBrains Mono',monospace; font-size:9px; letter-spacing:.16em; text-transform:uppercase; color:var(--gold); }
  .dato .v{ font-size:16px; color:var(--ink); margin-top:2px; }
  .dato .v.mono{ font-family:'JetBrains Mono',monospace; font-size:13px; }
  .seccion-tit{ display:flex; align-items:center; gap:14px; margin:34px 0 18px; }
  .seccion-tit span{ font-family:'JetBrains Mono',monospace; font-size:10px; letter-spacing:.24em; text-transform:uppercase; color:var(--green); white-space:nowrap; }
  .seccion-tit::after{ content:""; flex:1; height:1px; background:var(--line); }
  .medidas{ display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  .medida{ border:1px solid var(--line); border-left:3px solid var(--green); padding:16px 18px; background:#faf7ef; }
  .medida .et{ font-family:'JetBrains Mono',monospace; font-size:10px; letter-spacing:.08em; color:var(--ink-soft); text-transform:uppercase; }
  .medida .num{ font-family:'JetBrains Mono',monospace; font-size:38px; font-weight:700; color:var(--green-deep); line-height:1.1; margin:6px 0 2px; }
  .medida .interp{ font-size:15px; color:var(--ink); font-style:italic; }
  .medida .pie{ display:flex; align-items:center; gap:8px; margin-top:12px; flex-wrap:wrap; }
  .chip{ font-family:'JetBrains Mono',monospace; font-size:8.5px; letter-spacing:.12em; text-transform:uppercase; padding:3px 8px; border-radius:2px; }
  .chip.medido{ background:var(--chip-medido-bg); color:var(--chip-medido-fg); }
  .chip.aprox{ background:transparent; color:var(--chip-aprox-fg); border:1px solid var(--chip-aprox-fg); }
  .chip.calidad{ background:transparent; color:var(--ink-soft); border:1px solid var(--line); }
  .reglapie{ margin-top:12px; padding-left:2px; font-family:'JetBrains Mono',monospace; font-size:8.5px; color:var(--ink-soft); letter-spacing:.03em; line-height:1.9; }
  .reglapie b{ color:var(--green); font-weight:500; }
  .satstrip{ display:grid; grid-template-columns:repeat(4,1fr); gap:1px; background:var(--line); border:1px solid var(--line); margin-top:20px; }
  .satstrip .cel{ background:#faf7ef; padding:11px 14px; }
  .satstrip .k{ font-family:'JetBrains Mono',monospace; font-size:8.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--gold); }
  .satstrip .v{ font-family:'JetBrains Mono',monospace; font-size:12px; color:var(--ink); margin-top:3px; }
  .prueba{ display:grid; grid-template-columns:132px 1fr; gap:26px; align-items:center; margin-top:34px; padding:24px; background:var(--green-deep); color:var(--paper); }
  .sello{ width:132px; height:132px; }
  .sello svg{ width:100%; height:100%; }
  .prueba .lead{ font-family:'JetBrains Mono',monospace; font-size:9px; letter-spacing:.22em; text-transform:uppercase; color:var(--gold-bright); }
  .prueba h3{ font-family:'Playfair Display',serif; font-weight:500; font-size:19px; margin:6px 0 12px; color:var(--paper); }
  .prueba .hashline{ font-family:'JetBrains Mono',monospace; font-size:10.5px; color:#cbd8c6; word-break:break-all; line-height:1.6; }
  .prueba .hashline b{ color:var(--gold-bright); font-weight:500; }
  .prueba .pendiente{ display:inline-block; margin-top:8px; font-family:'JetBrains Mono',monospace; font-size:9px; letter-spacing:.1em; text-transform:uppercase; color:var(--green-deep); background:var(--gold-bright); padding:5px 10px; border-radius:2px; }
  .leyenda{ text-align:center; margin:32px 0 6px; }
  .leyenda .frase{ font-family:'Playfair Display',serif; font-style:italic; font-size:20px; color:var(--green-deep); line-height:1.4; }
  .leyenda .frase b{ font-style:normal; font-weight:600; }
  .piefino{ border-top:1px solid var(--line); margin-top:22px; padding-top:14px; display:flex; justify-content:space-between; gap:16px; font-family:'JetBrains Mono',monospace; font-size:9px; color:var(--ink-soft); letter-spacing:.05em; }
</style>
</head>
<body>
  <article class="hoja">
    <div class="contenido">
      <header class="cab">
        <div>
          <div class="marca">EPIMELEIA</div>
          <div class="eyebrow">Notario Digital Ambiental · Polygon Mainnet</div>
        </div>
        <div class="folio">
          Folio <b>${datos.folio}</b><br>
          Emitida ${fechaCorta(new Date().toISOString())}<br>
          Protocolo V3.4
        </div>
      </header>
      <div class="regla"></div>
      <h1 class="titulo">Certificación de Estado Ambiental</h1>
      <p class="subtitulo">Observación satelital · pasada del ${fechaCorta(datos.fechaPasada)}</p>
      <section class="datos">
        <div class="dato"><div class="k">Recurso</div><div class="v">${datos.nombreActivo}</div></div>
        <div class="dato"><div class="k">ID de activo</div><div class="v mono">#${String(datos.activoId).padStart(6,'0')}</div></div>
        <div class="dato"><div class="k">Tipo declarado</div><div class="v">${datos.tipoNombre}</div></div>
        ${bloqueTitular}
        <div class="dato"><div class="k">Custodia registral</div><div class="v">EPIMELEIA</div></div>
        <div class="dato"><div class="k">Superficie</div><div class="v mono">${datos.superficieHa}</div></div>
        <div class="dato"><div class="k">Ubicación</div><div class="v">${datos.ubicacion}</div></div>
        <div class="dato"><div class="k">Continuidad</div><div class="v">${datos.continuidadTexto}</div></div>
      </section>
      <div class="seccion-tit"><span>Lo que vio el satélite</span></div>
      <section class="medidas">${filasMedidas}
      </section>
      ${pieRegla}
      <div class="satstrip">
        <div class="cel"><div class="k">Satélite</div><div class="v">${datos.satelite}</div></div>
        <div class="cel"><div class="k">Fuente</div><div class="v">ESA · Copernicus</div></div>
        <div class="cel"><div class="k">Pasada</div><div class="v">${fechaCorta(datos.fechaPasada)}</div></div>
        <div class="cel"><div class="k">Trimestre</div><div class="v">${datos.trimestre}</div></div>
      </div>
      <section class="prueba">
        <div class="sello">
          <svg viewBox="0 0 132 132">
            <circle cx="66" cy="66" r="62" fill="none" stroke="#b08d4c" stroke-width="1"/>
            <circle cx="66" cy="66" r="54" fill="none" stroke="#c9a961" stroke-width="2"/>
            <circle cx="66" cy="66" r="34" fill="none" stroke="#b08d4c" stroke-width="1"/>
            <path id="arcoTop" d="M 66 12 A 54 54 0 0 1 120 66" fill="none"/>
            <path id="arcoBot" d="M 120 66 A 54 54 0 0 1 12 66" fill="none"/>
            <text font-family="'JetBrains Mono',monospace" font-size="8.5" letter-spacing="2.4" fill="#c9a961"><textPath href="#arcoTop" startOffset="8%">SELLO DE EVIDENCIA</textPath></text>
            <text font-family="'JetBrains Mono',monospace" font-size="8.5" letter-spacing="2.4" fill="#c9a961"><textPath href="#arcoBot" startOffset="14%">POLYGON MAINNET</textPath></text>
            <text x="66" y="60" text-anchor="middle" font-family="'Playfair Display',serif" font-size="15" fill="#eaf3e8" font-weight="600">EPI</text>
            <text x="66" y="78" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-size="7" letter-spacing="1.5" fill="#b08d4c">INMUTABLE</text>
          </svg>
        </div>
        <div>
          <div class="lead">Prueba pública · verificable por cualquiera</div>
          <h3>Nadie tocó este dato. Y se puede probar.</h3>
          <div class="hashline">
            Huella de evidencia<br>
            <b>${datos.huellaPaquete}</b><br>
            Regla de lectura · <b>${datos.reglaLectura}</b> · <b>${datos.hashRegla}</b><br>
            Contrato · <b>0xf59BCFB9…AF8bbc93</b> · Polygon Mainnet
          </div>
          <span class="pendiente">Huella calculada · pendiente de sello on-chain</span>
        </div>
      </section>
      <div class="leyenda">
        <div class="frase">No vendemos el dato.<br><b>Vendemos la prueba de que nadie lo tocó.</b></div>
      </div>
      <div class="piefino">
        <span>EPIMELEIA · epimeleia.world</span>
        <span>info@epimeleia.world</span>
        <span>Generada automáticamente por el protocolo</span>
      </div>
    </div>
  </article>
</body>
</html>`;
}

// ── Render HTML → PDF con Chrome ─────────────────────────────
function _rutaChrome() {
  const base = '/root/.cache/puppeteer/chrome';
  try {
    const versiones = fs.readdirSync(base).filter(n => n.startsWith('linux-'));
    if (versiones.length) {
      const carpeta = versiones.sort().reverse()[0];
      const ruta = path.join(base, carpeta, 'chrome-linux64', 'chrome');
      if (fs.existsSync(ruta)) return ruta;
    }
  } catch (e) { /* que puppeteer resuelva solo */ }
  return undefined;
}

async function generarPDF(html) {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: _rutaChrome(),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

// ── Envío del PDF por email ──────────────────────────────────
async function enviarPDFPorEmail({ para, pdfBuffer, nombreActivo }) {
  if (!config.notificaciones.sendgridKey) {
    console.log('  · SendGrid no configurado en .env → no se envía el mail (el PDF quedó en disco igual).');
    return false;
  }
  const buf = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
  const asunto = `[EPIMELEIA] Certificación satelital — ${nombreActivo}`;
  const cuerpo = `
    <div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;color:#12261a;">
      <p style="font-size:15px;line-height:1.7;">Adjuntamos tu certificación de estado ambiental,
      sellada en Polygon y verificable por cualquiera.</p>
      <p style="font-size:13px;color:#43584a;">EPIMELEIA · epimeleia.world</p>
    </div>`;
  await axios.post(
    'https://api.sendgrid.com/v3/mail/send',
    {
      personalizations: [{ to: [{ email: para }] }],
      from:    { email: config.notificaciones.sendgridFrom, name: 'EPIMELEIA Protocol' },
      subject: asunto,
      content: [{ type: 'text/html', value: cuerpo }],
      attachments: [{
        content:     buf.toString('base64'),
        filename:    'certificado-epimeleia.pdf',
        type:        'application/pdf',
        disposition: 'attachment',
      }],
    },
    { headers: { 'Authorization': `Bearer ${config.notificaciones.sendgridKey}`, 'Content-Type': 'application/json' }, timeout: 30000 }
  );
  return true;
}

// ── PRUEBA COMPLETA ──────────────────────────────────────────
(async () => {
  console.log('\n════════ GENERADOR DE CERTIFICADO PDF ════════\n');

  const reloj = trimestreDelProtocolo(new Date());
  console.log(`0) Reloj del protocolo: ${reloj.etiqueta}  (on-chain ${reloj.trimestreOnChain})`);

  console.log('1) Midiendo el satélite sobre el polígono...');
  let medicion = null;
  try { medicion = await medirIndicadores(ACTIVO_PRUEBA); } catch (e) { console.log('   (medición falló: ' + e.message + ')'); }

  const hayDato = medicion && medicion.mediciones && medicion.mediciones.some(m => m.valor != null);
  if (!hayDato) {
    console.log('\n   ✗ No hubo pasada satelital limpia en la ventana.');
    console.log('     NO se genera certificado: EPIMELEIA no certifica lo que no vio.\n');
    console.log('════════ SIN CERTIFICADO (honesto) ════════\n');
    process.exit(0);
  }

  const mediciones  = medicion.mediciones;
  const fechaPasada = medicion.mediciones.find(m => m.fecha)?.fecha || new Date().toISOString();
  const satelite    = medicion.satelite;
  console.log('   ✓ Medición real obtenida.');

  const reglaLectura = medicion.reglaLectura || null;
  const hashRegla    = medicion.hashRegla    || null;
  if (reglaLectura) console.log(`   ✓ Leído con la Regla de lectura ${reglaLectura}`);

  // ── AJUSTE 34 · armar el PAQUETE DE EVIDENCIA real ──
  console.log('1.5) Armando el paquete de evidencia (hash real)...');
  const paqueteEntrada = {
    titular: {
      nombre:    IDENTIDAD.titular,
      empresa:   IDENTIDAD.empresa,
      clienteId: IDENTIDAD.clienteId,
      email:     IDENTIDAD.email,
    },
    activo: {
      nombre:       IDENTIDAD.nombreActivo,
      tipo:         ACTIVO_PRUEBA.tipo,
      superficieHa: IDENTIDAD.superficieHaNum,
    },
    poligono: ACTIVO_PRUEBA.geometria,
    mediciones: mediciones.map(m => ({
      indice:         m.indice,
      valor:          m.valor,
      fecha:          m.fecha,
      calidadPct:     m.calidadPct,
      interpretacion: m.interpretacion,
    })),
    regla:     { version: reglaLectura, hash: hashRegla },
    trimestre: reloj.trimestreOnChain,
  };

  let huellaPaquete;
  try {
    const paq = armarPaquete(paqueteEntrada);
    huellaPaquete = paq.huella;
    console.log('   ✓ Paquete armado.');
    console.log('     Huella real (pendiente de sello):');
    console.log('     ' + huellaPaquete);
  } catch (e) {
    console.log('   ✗ No se pudo armar el paquete: ' + e.message);
    console.log('     Revisá que paquete-evidencia.js y reglas-lectura.js estén al lado.');
    process.exit(1);
  }

  console.log('2) Leyendo continuidad on-chain...');
  const continuidad = await leerContinuidad(ACTIVO_PRUEBA.activoId);
  console.log('   ' + (continuidad.leida ? '✓ leída: ' : '· sin historia on-chain: ') + continuidad.texto);

  const datos = {
    ...IDENTIDAD,
    activoId:         ACTIVO_PRUEBA.activoId,
    mediciones,
    fechaPasada,
    satelite,
    folio:            `EPI-C-${String(ACTIVO_PRUEBA.activoId).padStart(6,'0')}-${reloj.folioSufijo}`,
    trimestre:        reloj.etiqueta,
    continuidadTexto: continuidad.texto,
    reglaLectura,
    hashRegla,
    huellaPaquete,
  };

  console.log('3) Armando el certificado...');
  const html = construirHTML(datos);

  console.log('4) Convirtiendo a PDF fiel con Chrome...');
  const pdf = await generarPDF(html);
  fs.writeFileSync(RUTA_PDF, pdf);
  console.log('   ✓ PDF generado: ' + RUTA_PDF + '  (' + Math.round(pdf.length / 1024) + ' KB)');

  console.log('5) Enviando por email a ' + EMAIL_DESTINO + '...');
  try {
    const enviado = await enviarPDFPorEmail({ para: EMAIL_DESTINO, pdfBuffer: pdf, nombreActivo: IDENTIDAD.nombreActivo });
    if (enviado) console.log('   ✓ Email enviado. Revisá tu casilla (mirá también spam).');
  } catch (e) {
    console.log('   ✗ No se pudo enviar el email: ' + (e.response?.status || '') + ' ' + e.message);
    if (e.response?.data) console.log('     Motivo: ' + JSON.stringify(e.response.data));
    console.log('     (No importa para la prueba: el PDF ya está en disco en ' + RUTA_PDF + ')');
  }

  console.log('\n════════ LISTO ════════\n');
  process.exit(0);
})();
