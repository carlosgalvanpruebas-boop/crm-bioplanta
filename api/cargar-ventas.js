// ============================================================
// FUNCIÓN SERVERLESS — Carga de histórico de ventas
//
// Mismo patrón que cargar-inventario.js: corre en el servidor de
// Vercel (nunca en el navegador) porque usa la llave de servicio
// de Supabase, la única forma de escribir en `ventas` ahora que
// esa tabla quedó protegida por RLS (Fase 21).
//
// A diferencia de inventario (que se REEMPLAZA completo cada
// carga), ventas es un histórico que solo CRECE: cada carga se
// AGREGA a lo que ya existe, sin borrar nada. Se hace upsert por
// (factura, codigo_sap) para que si el mismo archivo (o uno que
// se solape en fechas) se sube dos veces, no queden líneas
// duplicadas — simplemente se actualiza la línea ya existente.
//
// También filtra automáticamente cualquier línea cuyo código SAP
// pertenezca a un grupo ya marcado como "no es de Agrotienda" en
// `sap_prefijos_excluidos` (la misma lista que se usa en la carga
// de inventario), para no ensuciar el histórico de ventas con
// ventas de otro negocio que comparte el mismo SAP.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://fpqogvxssnoarzgxcitc.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function prefijoDe(codigo) {
  const m = (codigo || '').toString().trim().match(/^([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : '';
}

function numeroOr(valor, porDefecto) {
  if (valor === undefined || valor === null || valor === '') return porDefecto;
  if (typeof valor === 'number') return valor;
  const limpio = String(valor).trim().replace(/\./g, '').replace(',', '.').replace(/[^0-9.\-]/g, '');
  const n = Number(limpio);
  return Number.isFinite(n) ? n : porDefecto;
}

function fechaISO(valor) {
  if (!valor) return null;
  if (valor instanceof Date) return valor.toISOString().slice(0, 10);
  if (typeof valor === 'number') {
    // Serial de fecha de Excel (días desde 1899-12-30)
    const ms = Math.round((valor - 25569) * 86400 * 1000);
    return new Date(ms).toISOString().slice(0, 10);
  }
  const d = new Date(valor);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
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
      .select('es_super_admin, cargo, nombre')
      .eq('id', userData.user.id)
      .single();

    if (perfilError || !perfil) {
      return res.status(403).json({ error: 'No se encontró tu perfil' });
    }

    const cargo = (perfil.cargo || '').toLowerCase();
    const autorizado = perfil.es_super_admin || cargo.includes('almacén') || cargo.includes('almacen');
    if (!autorizado) {
      return res.status(403).json({ error: 'No tienes permiso para cargar el histórico de ventas' });
    }

    const body = req.body || {};
    const filas = Array.isArray(body.ventas) ? body.ventas : null;
    if (!filas || !filas.length) {
      return res.status(400).json({ error: 'No llegó ninguna fila para cargar' });
    }

    // Grupos SAP que no son de Agrotienda (misma lista que usa el
    // cargador de inventario) — se filtran también aquí.
    const { data: excluidosRows } = await sbAdmin.from('sap_prefijos_excluidos').select('prefijo');
    const prefijosExcluidos = new Set((excluidosRows || []).map(r => (r.prefijo || '').toUpperCase()));

    let omitidosPorGrupo = 0;
    const limpiasMap = new Map(); // clave factura||codigo_sap -> fila (colapsa duplicados del mismo archivo)
    let sinFacturaOProducto = 0;

    for (const f of filas) {
      const factura = (f.factura || '').toString().trim();
      const producto = (f.producto || '').toString().trim();
      if (!factura || !producto) { sinFacturaOProducto++; continue; }

      const codigo_sap = (f.codigo_sap || '').toString().trim();
      if (codigo_sap && prefijosExcluidos.has(prefijoDe(codigo_sap))) { omitidosPorGrupo++; continue; }

      const fila = {
        factura,
        producto,
        codigo_sap: codigo_sap || null,
        fecha: fechaISO(f.fecha),
        cantidad: numeroOr(f.cantidad, 0),
        valor: numeroOr(f.valor, 0),
        cliente: f.cliente ? String(f.cliente).trim() : null,
        cliente_nit: f.cliente_nit ? String(f.cliente_nit).trim() : null,
        vendedor: f.vendedor ? String(f.vendedor).trim() : null,
      };
      limpiasMap.set(`${factura}||${codigo_sap}`, fila);
    }

    const limpios = [...limpiasMap.values()];
    const duplicadosColapsados = filas.length - sinFacturaOProducto - omitidosPorGrupo - limpios.length;

    if (!limpios.length) {
      return res.status(400).json({ error: 'Ninguna fila tenía factura y producto válidos' });
    }

    const { error: upsertError } = await sbAdmin
      .from('ventas')
      .upsert(limpios, { onConflict: 'factura,codigo_sap' });
    if (upsertError) throw upsertError;

    await sbAdmin.from('sync_log').insert({
      fecha: new Date().toISOString(),
      modulo: 'ventas',
      registros: limpios.length,
      status: 'ok',
      mensaje: `Cargado por ${perfil.nombre}: ${limpios.length} líneas procesadas, ${omitidosPorGrupo} omitidas por grupos excluidos, ${duplicadosColapsados} duplicadas dentro del mismo archivo, ${sinFacturaOProducto} sin factura/producto válidos`,
    });

    return res.status(200).json({
      ok: true,
      procesadas: limpios.length,
      omitidosPorGrupo,
      duplicadosColapsados,
      sinFacturaOProducto,
    });
  } catch (e) {
    try {
      await sbAdmin.from('sync_log').insert({
        fecha: new Date().toISOString(),
        modulo: 'ventas',
        registros: 0,
        status: 'error',
        mensaje: e.message,
      });
    } catch (e2) { /* no dejar que un error del log tumbe la respuesta */ }
    return res.status(500).json({ error: 'Error interno: ' + e.message });
  }
};
