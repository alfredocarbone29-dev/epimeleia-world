// ============================================================
// EPIMELEIA V3.4 — FASE 3
// api/scheduler.js
//
// Este archivo corre automáticamente cada día a las 8:00 AM
// (hora Argentina) gracias al cron configurado en vercel.json.
//
// Hace dos cosas:
//   1. Revisa la tabla "recordatorios" y envía emails a clientes
//      cuyo vencimiento esté a 30, 15 o 5 días.
//   2. Envía un resumen diario al founder con la actividad
//      del día anterior (pagos recibidos, recordatorios enviados).
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const sgMail = require('@sendgrid/mail');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

sgMail.setApiKey(process.env.SENDGRID_API_KEY);

module.exports = async (req, res) => {
  // ----------------------------------------------------------
  // SEGURIDAD: solo Vercel (con el secreto correcto) puede
  // ejecutar este endpoint. Sin esto, cualquiera en internet
  // podría llamarlo y disparar emails.
  // ----------------------------------------------------------
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const resultado = {
    fecha: new Date().toISOString(),
    recordatorios_enviados: 0,
    errores: [],
  };

  try {
    // --------------------------------------------------------
    // PASO 1: Recordatorios de vencimiento (30, 15, 5 días)
    // --------------------------------------------------------
    const hoy = new Date();

    for (const dias of [30, 15, 5]) {
      const fechaObjetivo = new Date(hoy);
      fechaObjetivo.setDate(fechaObjetivo.getDate() + dias);
      const fechaStr = fechaObjetivo.toISOString().split('T')[0]; // YYYY-MM-DD

      const { data: pendientes, error } = await supabase
        .from('recordatorios')
        .select('id, cliente_email, tipo, activos(nombre_activo)')
        .eq('fecha_programada', fechaStr)
        .eq('enviado', false);

      if (error) {
        resultado.errores.push(`Error consultando recordatorios (${dias}d): ${error.message}`);
        continue;
      }

      for (const r of pendientes || []) {
        const nombreActivo = r.activos?.nombre_activo || 'tu activo certificado';

        try {
          await sgMail.send({
            to: r.cliente_email,
            from: 'oracle@epimeleia.world',
            subject: `EPIMELEIA — Aviso de vencimiento en ${dias} días`,
            text:
              `Hola,\n\n` +
              `Te escribimos desde EPIMELEIA para informarte que la certificación ` +
              `de "${nombreActivo}" vence en ${dias} días.\n\n` +
              `Si tenés alguna duda, respondé este correo y el equipo te va a contactar.\n\n` +
              `— EPIMELEIA\n"El dato no miente. El tiempo tampoco."`,
          });

          await supabase
            .from('recordatorios')
            .update({ enviado: true })
            .eq('id', r.id);

          resultado.recordatorios_enviados++;
        } catch (e) {
          resultado.errores.push(`Error enviando recordatorio a ${r.cliente_email}: ${e.message}`);
        }
      }
    }

    // --------------------------------------------------------
    // PASO 2: Resumen diario para el founder
    // --------------------------------------------------------
    const ayer = new Date(hoy);
    ayer.setDate(ayer.getDate() - 1);
    const ayerISO = ayer.toISOString();

    const { data: pagosAyer, error: errPagos } = await supabase
      .from('pagos')
      .select('cliente_email, monto_usd, metodo, status, fecha')
      .gte('fecha', ayerISO);

    if (errPagos) {
      resultado.errores.push(`Error consultando pagos: ${errPagos.message}`);
    }

    const { data: clientesNuevos, error: errClientes } = await supabase
      .from('clientes')
      .select('email, nombre, fecha_registro')
      .gte('fecha_registro', ayerISO);

    if (errClientes) {
      resultado.errores.push(`Error consultando clientes nuevos: ${errClientes.message}`);
    }

    const lineasPagos = (pagosAyer || [])
      .map(p => `  - ${p.cliente_email}: USD ${p.monto_usd} (${p.metodo}, ${p.status})`)
      .join('\n') || '  (sin pagos nuevos)';

    const lineasClientes = (clientesNuevos || [])
      .map(c => `  - ${c.nombre || c.email} (${c.email})`)
      .join('\n') || '  (sin clientes nuevos)';

    const resumenTexto =
      `RESUMEN DIARIO EPIMELEIA — ${hoy.toISOString().split('T')[0]}\n\n` +
      `Pagos recibidos (últimas 24h):\n${lineasPagos}\n\n` +
      `Clientes nuevos (últimas 24h):\n${lineasClientes}\n\n` +
      `Recordatorios enviados hoy: ${resultado.recordatorios_enviados}\n\n` +
      (resultado.errores.length
        ? `Errores detectados:\n${resultado.errores.map(e => `  - ${e}`).join('\n')}\n\n`
        : '') +
      `— Oracle EPIMELEIA`;

    await sgMail.send({
      to: process.env.FOUNDER_EMAIL,
      from: 'oracle@epimeleia.world',
      subject: `Resumen diario EPIMELEIA — ${hoy.toISOString().split('T')[0]}`,
      text: resumenTexto,
    });

    return res.status(200).json(resultado);
  } catch (e) {
    return res.status(500).json({ error: e.message, ...resultado });
  }
}
