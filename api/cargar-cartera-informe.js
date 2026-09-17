// ============================================================
// FUNCIÓN SERVERLESS — Carga del Informe de Cartera (HTML)
//
// Mismo patrón que las demás funciones de "Cargar información"
// (cargar-inventario.js, cargar-ventas.js): corre en el servidor de
// Vercel, nunca en el navegador, porque usa la llave de servicio de
// Supabase — la única forma de escribir en `cartera_informe` ahora
// que esa tabla quedó protegida por RLS (Fase 40).
//
// A diferencia de inventario/ventas, acá no se parsea ningún dato:
// el archivo que sube Carlos es el reporte HTML completo tal cual se
// lo entrega el jefe contable (con sus gráficos y datos embebidos).
// Esta función solo valida que venga contenido y quién lo autoriza,
// y reemplaza la única fila de la tabla (id = 1) — no se acumula
// historial de versiones anteriores.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://fpqogvxssnoarzgxcitc.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Tamaño máximo aceptado para el HTML (10 MB) — el reporte real pesa
// unos cientos de KB con Chart.js embebido; este tope es solo una
// defensa razonable contra un archivo equivocado.
const MAX_BYTES = 10 * 1024 * 1024;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  if (!SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Falta configurar SUPABASE_SERVICE_ROLE_KEY en Vercel' });
  }

  const sbAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Falta autenticación' });

    const { data: userData, error: userError } = await sbAdmin.auth.getUser(token);
    if (userError || !userData || !userData.user) {
      return res.status(401).json({ error: 'Sesión inválida, vuelve a iniciar sesión' });
    }

    const { data: perfil, error: perfilError } = await sbAdmin
      .from('perfiles')
      .select('es_super_admin, nombre')
      .eq('id', userData.user.id)
      .single();
    if (perfilError || !perfil) {
      return res.status(403).json({ error: 'No se encontró tu perfil' });
    }

    // Es información financiera sensible (saldos y mora por cliente),
    // así que se restringe a Super Admin o Módulo 2 completo — mismo
    // criterio ya usado para sap_prefijos_excluidos y márgenes de precio.
    let autorizado = perfil.es_super_admin;
    if (!autorizado) {
      const { data: permiso } = await sbAdmin
        .from('permisos_modulo')
        .select('nivel')
        .eq('perfil_id', userData.user.id)
        .eq('modulo', 2)
        .maybeSingle();
      autorizado = permiso?.nivel === 'completo';
    }
    if (!autorizado) {
      return res.status(403).json({ error: 'No tienes permiso para cargar el informe de cartera (requiere Módulo 2 completo o Super Admin)' });
    }

    const body = req.body || {};
    const html = typeof body.html === 'string' ? body.html : '';
    if (!html.trim()) {
      return res.status(400).json({ error: 'No llegó contenido HTML para guardar' });
    }
    if (Buffer.byteLength(html, 'utf8') > MAX_BYTES) {
      return res.status(400).json({ error: 'El archivo es demasiado grande (más de 10 MB) — revisa que sea el reporte correcto' });
    }
    if (!html.includes('<html')) {
      return res.status(400).json({ error: 'El archivo no parece un HTML completo (no se encontró la etiqueta <html>)' });
    }

    const { error: upsertError } = await sbAdmin
      .from('cartera_informe')
      .upsert(
        { id: 1, html, actualizado_en: new Date().toISOString(), actualizado_por: perfil.nombre || userData.user.email },
        { onConflict: 'id' }
      );
    if (upsertError) throw upsertError;

    await sbAdmin.from('sync_log').insert({
      fecha: new Date().toISOString(),
      modulo: 'cartera',
      registros: 1,
      status: 'ok',
      mensaje: `Informe de cartera actualizado por ${perfil.nombre || userData.user.email} (${Buffer.byteLength(html, 'utf8')} bytes)`,
    });

    return res.status(200).json({ ok: true, bytes: Buffer.byteLength(html, 'utf8') });
  } catch (e) {
    try {
      await sbAdmin.from('sync_log').insert({
        fecha: new Date().toISOString(),
        modulo: 'cartera',
        registros: 0,
        status: 'error',
        mensaje: e.message,
      });
    } catch (e2) { /* no dejar que un error del log tumbe la respuesta */ }
    return res.status(500).json({ error: 'Error interno: ' + e.message });
  }
};
