// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA V3.4 — Crear los 4 Planes de Suscripción en PayPal (PRODUCCIÓN/LIVE)
// ────────────────────────────────────────────────────────────────────────────
// QUÉ HACE:
//   Script de UNA SOLA VEZ. Crea en PayPal PRODUCCIÓN (dinero real):
//     1. Un Producto: "EPIMELEIA — Certificación Ambiental Satelital"
//     2. Los CUATRO planes (Base, Pro, Corporate, Enterprise), cada uno con
//        1 MES GRATIS (trial) y después el cobro mensual del tier.
//   Los precios NO están escritos acá: se leen de lib/precios.js, la fuente
//   única de verdad. Así el precio que cobra el sistema y el que crea PayPal
//   son SIEMPRE el mismo número.
//
//   Al terminar, imprime los 4 PLAN IDs (P-xxxx). Esos IDs van, uno por uno,
//   a las variables de entorno de Vercel:
//     PAYPAL_PLAN_BASE
//     PAYPAL_PLAN_PRO
//     PAYPAL_PLAN_CORPORATE
//     PAYPAL_PLAN_ENTERPRISE
//
// ════════════════════════════════════════════════════════════════════════════
// ⚠️  ESTO ES PRODUCCIÓN — DINERO REAL
// ════════════════════════════════════════════════════════════════════════════
//   - Usa las credenciales LIVE (las mismas que pusiste en Vercel).
//   - Los precios de un plan de PayPal NO se pueden editar después de creado.
//     Si un precio está mal, hay que crear un plan nuevo. Por eso el script
//     MUESTRA los precios y PIDE confirmación antes de crear nada.
//   - Corré esto UNA sola vez. Si lo corrés dos veces, crea planes duplicados
//     (no rompe nada, pero quedan planes de más dando vueltas).
//
// CÓMO SE USA (en el VPS, por SSH, una sola vez):
//   1. Asegurate de tener en el .env del VPS las credenciales LIVE:
//        PAYPAL_CLIENT_ID=...        (el de PRODUCCIÓN, empieza con BAAW89...)
//        PAYPAL_CLIENT_SECRET=...    (el de PRODUCCIÓN)
//   2. Poné este archivo junto a la carpeta lib/ (misma ubicación que el
//      script viejo, para que encuentre ../lib/precios.js).
//   3. Corré:   node crear-planes-paypal-live.js
//   4. Leé los precios que muestra. Si están bien, escribí  SI  y Enter.
//   5. Anotá los 4 PLAN IDs que aparecen al final.
//   6. Cargá cada PLAN ID en su variable de Vercel y hacé Redeploy.
// ────────────────────────────────────────────────────────────────────────────

try { require('dotenv').config(); } catch (e) { /* dotenv opcional */ }

const readline = require('readline');
const { config: _cfg } = (() => { try { return {}; } catch (e) { return {}; } })();

// Los tiers y precios salen de la fuente única de verdad.
// (Buscamos precios.js en ./lib o en ../lib, según desde dónde se corra.)
let precios;
try {
  precios = require('./lib/precios');
} catch (e1) {
  try {
    precios = require('../lib/precios');
  } catch (e2) {
    console.error('');
    console.error('  ✗ No encontré lib/precios.js.');
    console.error('    Poné este script en la raíz del repo (donde está la carpeta lib/),');
    console.error('    o en la misma carpeta que el script viejo. Rutas probadas:');
    console.error('      ./lib/precios.js   y   ../lib/precios.js');
    console.error('');
    process.exit(1);
  }
}

const { TIERS } = precios;

// ─── Entorno PayPal: PRODUCCIÓN ─────────────────────────────────────────────
const API_BASE = 'https://api-m.paypal.com';   // ← LIVE. Dinero real.

const PRODUCTO = {
  nombre:      'EPIMELEIA — Certificación Ambiental Satelital',
  descripcion: 'Certificación de estado ambiental satelital, registrada de forma inmutable en blockchain (Polygon). El dato no miente. El tiempo tampoco.',
  tipo:        'SERVICE',
  categoria:   'SOFTWARE',
};

const MONEDA     = 'USD';
const DIAS_GRATIS = 30;   // el mes de cortesía (trial) — va en los 4 planes

// Mapa tier.id → nombre de la variable de entorno de Vercel donde va el Plan ID.
const ENV_POR_TIER = {
  base:       'PAYPAL_PLAN_BASE',
  pro:        'PAYPAL_PLAN_PRO',
  corporate:  'PAYPAL_PLAN_CORPORATE',
  enterprise: 'PAYPAL_PLAN_ENTERPRISE',
};

// ─── Token de PayPal ────────────────────────────────────────────────────────
async function obtenerToken() {
  const clientId     = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('');
    console.error('  ✗ FALTAN CREDENCIALES en el .env del VPS.');
    console.error('    Necesito las de PRODUCCIÓN (live):');
    console.error('      PAYPAL_CLIENT_ID=...      (empieza con BAAW89...)');
    console.error('      PAYPAL_CLIENT_SECRET=...');
    console.error('');
    process.exit(1);
  }

  // Chequeo suave: el Client ID live suele empezar distinto al de sandbox.
  if (clientId.startsWith('sb-') || clientId.startsWith('AeA') ) {
    console.error('  ⚠  OJO: el PAYPAL_CLIENT_ID parece de SANDBOX, no de producción.');
    console.error('     Este script crea planes con DINERO REAL. Verificá las credenciales.');
    process.exit(1);
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const resp = await fetch(`${API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error(`  ✗ Error obteniendo token de PayPal (HTTP ${resp.status}).`);
    console.error(`    Respuesta: ${txt}`);
    console.error('    Posible causa: credenciales mal copiadas, o no son de producción.');
    process.exit(1);
  }

  const data = await resp.json();
  return data.access_token;
}

// ─── Crear el Producto (uno solo, compartido por los 4 planes) ──────────────
async function crearProducto(token) {
  console.log('  → Creando producto...');
  const resp = await fetch(`${API_BASE}/v1/catalogs/products`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      name:        PRODUCTO.nombre,
      description: PRODUCTO.descripcion,
      type:        PRODUCTO.tipo,
      category:    PRODUCTO.categoria,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error(`  ✗ Error creando producto (HTTP ${resp.status}): ${txt}`);
    process.exit(1);
  }

  const data = await resp.json();
  console.log(`  ✓ Producto creado — ID: ${data.id}`);
  return data.id;
}

// ─── Crear UN plan (con mes gratis + cobro mensual del tier) ────────────────
async function crearPlan(token, productoId, tier) {
  const precioMensual = String(tier.precioMensualUSD);
  console.log(`  → Creando plan ${tier.nombre} (USD ${precioMensual}/mes)...`);

  const resp = await fetch(`${API_BASE}/v1/billing/plans`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=representation',
    },
    body: JSON.stringify({
      product_id:  productoId,
      name:        `EPIMELEIA ${tier.nombre} — Mensual`,
      description: `Certificación ambiental satelital · tier ${tier.nombre}. Primer mes de cortesía sin cargo.`,
      status:      'ACTIVE',
      billing_cycles: [
        // Ciclo 1: MES GRATIS (trial)
        {
          frequency:   { interval_unit: 'DAY', interval_count: DIAS_GRATIS },
          tenure_type: 'TRIAL',
          sequence:    1,
          total_cycles: 1,
          pricing_scheme: {
            fixed_price: { value: '0', currency_code: MONEDA },
          },
        },
        // Ciclo 2: COBRO MENSUAL (indefinido, hasta que cancele)
        {
          frequency:   { interval_unit: 'MONTH', interval_count: 1 },
          tenure_type: 'REGULAR',
          sequence:    2,
          total_cycles: 0,
          pricing_scheme: {
            fixed_price: { value: precioMensual, currency_code: MONEDA },
          },
        },
      ],
      payment_preferences: {
        auto_bill_outstanding:     true,
        setup_fee:                 { value: '0', currency_code: MONEDA },
        setup_fee_failure_action:  'CONTINUE',
        payment_failure_threshold: 3,
      },
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error(`  ✗ Error creando plan ${tier.nombre} (HTTP ${resp.status}): ${txt}`);
    process.exit(1);
  }

  const data = await resp.json();
  console.log(`  ✓ Plan ${tier.nombre} creado — ID: ${data.id}`);
  return data.id;
}

// ─── Confirmación por teclado ───────────────────────────────────────────────
function preguntar(texto) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(texto, ans => { rl.close(); resolve(ans); }));
}

// ─── Ejecución ──────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('════════════════════════════════════════════════════════════════');
  console.log('  EPIMELEIA — Crear los 4 Planes en PayPal  ⚠  PRODUCCIÓN (LIVE)');
  console.log('════════════════════════════════════════════════════════════════');
  console.log('');
  console.log('  Se van a crear estos 4 planes, con 1 MES GRATIS cada uno:');
  console.log('  ──────────────────────────────────────────────────────────────');
  for (const t of TIERS) {
    const linea = `    ${t.nombre.padEnd(11)}  USD ${String(t.precioMensualUSD).padStart(5)}/mes   (hasta ${t.hasta} ha)`;
    console.log(linea);
  }
  console.log('  ──────────────────────────────────────────────────────────────');
  console.log('  ⚠  Esto es DINERO REAL. Los precios NO se pueden editar después.');
  console.log('     Si un precio está mal, se cancela (Ctrl+C) y se corrige precios.js.');
  console.log('');

  const resp = await preguntar('  ¿Los precios están bien? Escribí  SI  para crear los planes: ');
  if (resp.trim().toUpperCase() !== 'SI') {
    console.log('');
    console.log('  Cancelado. No se creó nada. (Escribiste algo distinto de "SI".)');
    console.log('');
    process.exit(0);
  }

  console.log('');
  const token = await obtenerToken();
  console.log('  ✓ Autenticado con PayPal PRODUCCIÓN.');
  console.log('');

  const productoId = await crearProducto(token);
  console.log('');

  const resultados = [];
  for (const tier of TIERS) {
    const planId = await crearPlan(token, productoId, tier);
    resultados.push({ tier, planId, envVar: ENV_POR_TIER[tier.id] });
    // Pequeña pausa entre creaciones, para no atosigar la API.
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log('');
  console.log('════════════════════════════════════════════════════════════════');
  console.log('  ✓ LISTO. Cargá estos 4 valores en Vercel (Environment Variables):');
  console.log('════════════════════════════════════════════════════════════════');
  console.log('');
  console.log(`    PRODUCTO ID: ${productoId}`);
  console.log('');
  for (const r of resultados) {
    console.log(`    ${r.envVar.padEnd(24)} = ${r.planId}`);
  }
  console.log('');
  console.log('  Pasos finales:');
  console.log('   1. En Vercel, editá cada variable de arriba con su Plan ID.');
  console.log('   2. Verificá que PAYPAL_ENV = live  (ya debería estar).');
  console.log('   3. Redeploy.');
  console.log('   4. Probá una suscripción real (modo cortesía) y cancelá antes del mes.');
  console.log('════════════════════════════════════════════════════════════════');
  console.log('');
}

main().catch(err => {
  console.error('  ✗ Error inesperado:', err.message);
  process.exit(1);
});
