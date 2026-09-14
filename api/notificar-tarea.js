// ============================================================
// FUNCIÓN SERVERLESS — Notificación por correo de tareas asignadas
//
// Se llama desde tareas.html justo después de crear una tarea nueva
// (o de agregarle asignados), pasando el id de la tarea. Esta función:
//   1. Busca la tarea y sus asignados (tarea_asignados → perfiles).
//   2. Para cada persona asignada, obtiene su correo real desde
//      auth.users (perfiles.id === auth.users.id, pero el correo solo
//      vive en auth.users — por eso se necesita la service_role key,
//      igual que en api/gestion-usuarios.js).
//   3. Envía un correo con Resend (https://resend.com) a cada persona.
//
// Es "best effort": si el envío de correo falla, NO debe romper la
// creación de la tarea en el tablero — tareas.html ignora el resultado
// de esta llamada salvo para mostrar un aviso silencioso en consola.
//
// Variables de entorno necesarias en Vercel (Project Settings → Environment
// Variables), además de la que ya existe:
//   - SUPABASE_SERVICE_ROLE_KEY   (ya configurada para el Panel de Accesos)
//   - RESEND_API_KEY              (nueva — cuenta gratuita en resend.com)
//   - EMAIL_FROM                  (opcional; si no se define se usa
//                                  "Agrotienda Bioplanta <onboarding@resend.dev>",
//                                  el remitente de prueba de Resend que no
//                                  requiere verificar un dominio propio)
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://fpqogvxssnoarzgxcitc.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'Agrotienda Bioplanta <onboarding@resend.dev>';
const SITIO = 'https://crm-bioplanta.vercel.app';

function prioTexto(p) {
  return p === 'alta' ? 'Alta' : p === 'media' ? 'Media' : p === 'baja' ? 'Baja' : (p || '—');
}

function fechaTexto(iso) {
  if (!iso) return 'Sin fecha límite';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' });
}

async function enviarCorreo(destinatario, asunto, html) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: destinatario,
      subject: asunto,
      html,
    }),
  });
  if (!r.ok) {
    const texto = await r.text().catch(() => '');
    throw new Error(`Resend respondió ${r.status}: ${texto}`);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Falta configurar SUPABASE_SERVICE_ROLE_KEY en Vercel' });
  }
  if (!RESEND_API_KEY) {
    // No es un error fatal para el resto del sistema — simplemente no se
    // puede enviar el correo todavía porque falta esa variable.
    return res.status(200).json({ ok: false, motivo: 'RESEND_API_KEY no está configurada en Vercel todavía' });
  }

  const { tarea_id } = req.body || {};
  if (!tarea_id) return res.status(400).json({ error: 'Falta tarea_id' });

  const sbAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const { data: tarea, error: errTarea } = await sbAdmin
      .from('tareas')
      .select('*, tarea_asignados(perfil_id, perfiles(nombre))')
      .eq('id', tarea_id)
      .single();

    if (errTarea || !tarea) {
      return res.status(404).json({ error: 'No se encontró la tarea' });
    }

    const asignados = tarea.tarea_asignados || [];
    const resultados = [];

    for (const a of asignados) {
      if (!a.perfil_id) continue;
      const { data: usuario, error: errUsuario } = await sbAdmin.auth.admin.getUserById(a.perfil_id);
      const correo = usuario && usuario.user ? usuario.user.email : null;
      if (errUsuario || !correo) {
        resultados.push({ perfil_id: a.perfil_id, enviado: false, motivo: 'sin correo asociado' });
        continue;
      }

      const nombre = (a.perfiles && a.perfiles.nombre) || 'compañero(a)';
      const html = `
        <div style="font-family:'Segoe UI',sans-serif;color:#1a2e1a;max-width:480px">
          <p>Hola ${nombre},</p>
          <p><b>${tarea.creado_por || 'Alguien del equipo'}</b> te asignó una nueva tarea en el CRM de Agrotienda Bioplanta:</p>
          <div style="background:#eaefeb;border-radius:10px;padding:14px 16px;margin:14px 0">
            <div style="font-size:15px;font-weight:700;color:#33513a">${tarea.titulo}</div>
            ${tarea.descripcion ? `<div style="font-size:13px;color:#444;margin-top:6px">${tarea.descripcion}</div>` : ''}
            <div style="font-size:12px;color:#666;margin-top:10px">Prioridad: <b>${prioTexto(tarea.prioridad)}</b> · Fecha límite: <b>${fechaTexto(tarea.fecha_limite)}</b></div>
          </div>
          <p><a href="${SITIO}/tareas.html" style="background:#4f7c5a;color:#fff;padding:10px 18px;border-radius:20px;text-decoration:none;font-weight:600;display:inline-block">Ver en el Tablero de Tareas</a></p>
          <p style="font-size:11px;color:#999;margin-top:20px">Este es un correo automático del CRM de Agrotienda Bioplanta.</p>
        </div>`;

      try {
        await enviarCorreo(correo, `Nueva tarea: ${tarea.titulo}`, html);
        resultados.push({ perfil_id: a.perfil_id, enviado: true });
      } catch (e) {
        resultados.push({ perfil_id: a.perfil_id, enviado: false, motivo: e.message });
      }
    }

    return res.status(200).json({ ok: true, resultados });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Error inesperado enviando notificaciones' });
  }
};
