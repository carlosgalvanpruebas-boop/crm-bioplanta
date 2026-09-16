// ============================================================
// FUNCIÓN SERVERLESS — Guardar presupuesto de venta por sede
//
// Mismo patrón que cargar-ventas.js: corre en el servidor de Vercel
// (nunca en el navegador) porque usa la llave de servicio de
// Supabase. Solo Gerencia (Super Admin) puede definir la meta de
// venta mensual de cada sede — guarda una fila por (año, mes, sede)
// en `presupuesto_venta` (Fase 38).
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://fpqogvxssnoarzgxcitc.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SEDES_VALIDAS = ['Chigorodó', 'Belén de Bajirá'];

function numeroOr(valor, porDefecto) {
  if (valor === undefined || valor === null || valor === '') return porDefecto;
  if (typeof valor === 'number') return valor;
  const limpio = String(valor).trim().replace(/\./g, '').replace(',', '.').replace(/[^0-9.\-]/g, '');
  const n = Number(limpio);
  return Number.isFinite(n) ? n : porDefecto;
}

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
    // Solo Gerencia (Super Admin) define el presupuesto — a diferencia de
    // la carga de ventas/inventario, aquí no basta con ser de almacén.
    if (!perfil.es_super_admin) {
      return res.status(403).json({ error: 'Solo Gerencia puede definir el presupuesto de venta' });
    }

    const body = req.body || {};
    const anio = numeroOr(body.anio, null);
    const mes = numeroOr(body.mes, null);
    const metas = Array.isArray(body.metas) ? body.metas : null; // [{ sede, monto }, ...]

    if (!anio || !mes || !metas || !metas.length) {
      return res.status(400).json({ error: 'Faltan año, mes o las metas por sede' });
    }

    const filas = [];
    for (const m of metas) {
      const sede = (m.sede || '').toString().trim();
      if (!SEDES_VALIDAS.includes(sede)) {
        return res.status(400).json({ error: `Sede no reconocida: "${sede}"` });
      }
      const monto = numeroOr(m.monto, null);
      if (monto === null || monto < 0) {
        return res.status(400).json({ error: `El monto de ${sede} no es válido` });
      }
      filas.push({ anio, mes, sede, monto });
    }

    const { error: upsertError } = await sbAdmin
      .from('presupuesto_venta')
      .upsert(filas, { onConflict: 'anio,mes,sede' });
    if (upsertError) throw upsertError;

    await sbAdmin.from('sync_log').insert({
      fecha: new Date().toISOString(),
      modulo: 'presupuesto',
      registros: filas.length,
      status: 'ok',
      mensaje: `Presupuesto de ${mes}/${anio} guardado por ${perfil.nombre}: ` +
        filas.map(f => `${f.sede} $${f.monto.toLocaleString('es-CO')}`).join(', '),
    });

    return res.status(200).json({ ok: true, guardadas: filas.length });
  } catch (e) {
    return res.status(500).json({ error: 'Error interno: ' + e.message });
  }
};
