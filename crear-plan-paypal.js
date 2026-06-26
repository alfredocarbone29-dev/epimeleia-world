// ────────────────────────────────────────────────────────────────────────────
// EPIMELEIA V3.4 — Crear Plan de Suscripción en PayPal (SANDBOX)
// ────────────────────────────────────────────────────────────────────────────
// QUÉ HACE:
//   Script de UNA SOLA VEZ. Crea en PayPal:
//     1. Un Producto: "EPIMELEIA — Certificación Ambiental Satelital"
//     2. Un Plan:     "Plan Mensual L1" — USD 550/mes, con 30 días gratis
//   Al terminar, imprime el PLAN ID (P-xxxx). Guardá ese ID: es la pieza que
//   el resto del sistema usará para suscribir clientes.
//
// CÓMO SE USA (en el VPS, una sola vez):
//   1. Asegurate de tener en el .env del VPS:
//        PAYPAL_CLIENT_ID=...        (el de SANDBOX)
//        PAYPAL_CLIENT_SECRET=...    (el de SANDBOX)
//   2. Corré:   node crear-plan-paypal.js
//   3. Anotá el PLAN ID que aparece al final.
//
// IMPORTANTE: Este script usa el entorno SANDBOX (api-m.sandbox.paypal.com).
//   Cuando pasemos a producción real, se cambia esa URL y las credenciales.
// ────────────────────────────────────────────────────────────────────────────

// Carga el .env si existe (no rompe si no está dotenv instalado)
try { require('dotenv').config(); } catch (e) { /* dotenv opcional */ }

// ─── CONFIGURACIÓN DEL PLAN (decisiones del fundador) ───────────────────────
const CONFIG = {
  // Entorno PayPal: SANDBOX (prueba). No mueve plata real.
  apiBase: 'https://api-m.sandbox.paypal.com',

  producto: {
    nombre:      'EPIMELEIA — Certificación Ambiental Satelital',
    descripcion: 'Certificación de estado ambiental satelital, registrada de forma inmutable en blockchain (Polygon). El dato no miente. El tiempo tampoco.',
    tipo:        'SERVICE',          // es un servicio, no un bien físico
    categoria:   'SOFTWARE',
  },

  plan: {
    nombre:      'Plan Mensual L1',
    descripcion: 'Suscripción mensual de certificación ambiental satelital. Primer mes de cortesía sin cargo.',
    precio:      '550',             // USD 550
    moneda:      'USD',
    diasGratis:  30,                // mes de cortesía (trial sin cobro)
  },
};

// ─── Obtener token de acceso de PayPal ──────────────────────────────────────
async function obtenerToken() {
  const clientId     = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('');
    console.error('  ✗ FALTAN CREDENCIALES.');
    console.error('    El script necesita estas dos variables en el .env del VPS:');
    console.error('      PAYPAL_CLIENT_ID=...      (el de sandbox)');
    console.error('      PAYPAL_CLIENT_SECRET=...  (el de sandbox)');
    console.error('');
    process.exit(1);
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const resp = await fetch(`${CONFIG.apiBase}/v1/oauth2/token`, {
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
    console.error('    Posible causa: las credenciales no son de SANDBOX, o están mal copiadas.');
    process.exit(1);
  }

  const data = await resp.json();
  return data.access_token;
}

// ─── Crear el Producto ──────────────────────────────────────────────────────
async function crearProducto(token) {
  console.log('  → Creando producto...');

  const resp = await fetch(`${CONFIG.apiBase}/v1/catalogs/products`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      name:        CONFIG.producto.nombre,
      description: CONFIG.producto.descripcion,
      type:        CONFIG.producto.tipo,
      category:    CONFIG.producto.categoria,
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

// ─── Crear el Plan ──────────────────────────────────────────────────────────
async function crearPlan(token, productoId) {
  console.log('  → Creando plan con mes de cortesía...');

  const resp = await fetch(`${CONFIG.apiBase}/v1/billing/plans`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=representation',
    },
    body: JSON.stringify({
      product_id:  productoId,
      name:        CONFIG.plan.nombre,
      description: CONFIG.plan.descripcion,
      status:      'ACTIVE',
      billing_cycles: [
        // ── Ciclo 1: MES GRATIS (trial) ──────────────────────────────
        {
          frequency: { interval_unit: 'DAY', interval_count: CONFIG.plan.diasGratis },
          tenure_type: 'TRIAL',
          sequence: 1,
          total_cycles: 1,             // un solo período de prueba
          pricing_scheme: {
            fixed_price: { value: '0', currency_code: CONFIG.plan.moneda },
          },
        },
        // ── Ciclo 2: COBRO MENSUAL (indefinido) ──────────────────────
        {
          frequency: { interval_unit: 'MONTH', interval_count: 1 },
          tenure_type: 'REGULAR',
          sequence: 2,
          total_cycles: 0,             // 0 = indefinido, hasta que cancele
          pricing_scheme: {
            fixed_price: { value: CONFIG.plan.precio, currency_code: CONFIG.plan.moneda },
          },
        },
      ],
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee: { value: '0', currency_code: CONFIG.plan.moneda },
        setup_fee_failure_action: 'CONTINUE',
        payment_failure_threshold: 3,
      },
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error(`  ✗ Error creando plan (HTTP ${resp.status}): ${txt}`);
    process.exit(1);
  }

  const data = await resp.json();
  console.log(`  ✓ Plan creado — ID: ${data.id}`);
  return data.id;
}

// ─── Ejecución ──────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('════════════════════════════════════════════════════════════');
  console.log('  EPIMELEIA — Crear Plan de Suscripción en PayPal (SANDBOX)');
  console.log('════════════════════════════════════════════════════════════');
  console.log('');

  const token      = await obtenerToken();
  console.log('  ✓ Autenticado con PayPal sandbox.');

  const productoId = await crearProducto(token);
  const planId     = await crearPlan(token, productoId);

  console.log('');
  console.log('════════════════════════════════════════════════════════════');
  console.log('  ✓ LISTO. Guardá estos datos:');
  console.log('');
  console.log(`    PRODUCTO ID: ${productoId}`);
  console.log(`    PLAN ID:     ${planId}`);
  console.log('');
  console.log('  El PLAN ID es la pieza clave. Guardalo — el sistema lo usará');
  console.log('  para suscribir clientes al plan mensual con mes de cortesía.');
  console.log('════════════════════════════════════════════════════════════');
  console.log('');
}

main().catch(err => {
  console.error('  ✗ Error inesperado:', err.message);
  process.exit(1);
});
