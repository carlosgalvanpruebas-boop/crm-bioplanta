// ============================================================
// FUNCIÓN SERVERLESS — Carga de inventario real (Diego)
//
// Igual que gestion-usuarios.js (Panel de Accesos): corre en el
// servidor de Vercel, nunca en el navegador, porque es la única
// forma de escribir en `inventario` sin depender de los permisos
// limitados que tiene el usuario normal desde el navegador (esa
// tabla está protegida a nivel de columna desde la Fase 11 para
// que nadie pueda alterar cantidades/costos por accidente o mala
// intención — aquí sí se permite, pero solo después de validar
// en el servidor que quien llama es Diego o el Super Admin).
//
// Recibe el listado completo de artículos ya parseado desde el
// Excel (lo hace el navegador con la librería SheetJS, este
// archivo no toca Excel directamente) y actualiza `inventario`:
//   - Actualiza los artículos que ya existían (por código SAP),
//     sin tocar su `sede` ni sus ajustes manuales de mínimo/máximo
//     (esas columnas no se pisan).
//   - Inserta los artículos nuevos.
//   - Elimina los que ya no aparecen en el archivo (se asume que
//     el archivo que sube Diego es el listado COMPLETO del día,
//     no un incremento).
// Deja un registro en `sync_log` con el resultado, para que quede
// un historial de cada carga.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://fpqogvxssnoarzgxcitc.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
      return res.status(403).json({ error: 'Solo Diego (Analista Almacén) o el Super Admin pueden cargar el inventario' });
    }

    const body = req.body || {};
    const articulos = Array.isArray(body.articulos) ? body.articulos : null;
    if (!articulos || !articulos.length) {
      return res.status(400).json({ error: 'No llegó ningún artículo para cargar' });
    }

    // Validación básica de cada fila
    const limpios = [];
    for (const a of articulos) {
      const codigo_sap = (a.codigo_sap || '').toString().trim();
      const producto = (a.producto || '').toString().trim();
      if (!codigo_sap || !producto) continue;
      limpios.push({
        codigo_sap,
        producto,
        categoria: a.categoria ? String(a.categoria).trim() : null,
        proveedor: a.proveedor ? String(a.proveedor).trim() : null,
        unidad: a.unidad ? String(a.unidad).trim() : null,
        cantidad: a.cantidad !== undefined && a.cantidad !== null ? Number(a.cantidad) : 0,
        costo_unit: a.costo_unit !== undefined && a.costo_unit !== null ? Number(a.costo_unit) : null,
        valor_total: a.valor_total !== undefined && a.valor_total !== null ? Number(a.valor_total) : null,
        actualizado_en: new Date().toISOString(),
      });
    }

    if (!limpios.length) {
      return res.status(400).json({ error: 'Ningún artículo tenía código y nombre válidos' });
    }

    const codigosNuevos = limpios.map(a => a.codigo_sap);

    const { data: existentes, error: existentesError } = await sbAdmin
      .from('inventario')
      .select('codigo_sap');
    if (existentesError) throw existentesError;

    const codigosExistentes = new Set((existentes || []).map(x => x.codigo_sap));
    const codigosSet = new Set(codigosNuevos);
    const actualizados = codigosNuevos.filter(c => codigosExistentes.has(c)).length;
    const nuevos = codigosNuevos.filter(c => !codigosExistentes.has(c)).length;
    const aEliminar = [...codigosExistentes].filter(c => !codigosSet.has(c));

    // Upsert por código SAP — no pisa `sede` ni `stock_minimo_manual` /
    // `stock_maximo_manual` porque esas columnas no se incluyen aquí.
    const { error: upsertError } = await sbAdmin
      .from('inventario')
      .upsert(limpios, { onConflict: 'codigo_sap' });
    if (upsertError) throw upsertError;

    if (aEliminar.length) {
      const { error: deleteError } = await sbAdmin
        .from('inventario')
        .delete()
        .in('codigo_sap', aEliminar);
      if (deleteError) throw deleteError;
    }

    await sbAdmin.from('sync_log').insert({
      fecha: new Date().toISOString(),
      modulo: 'inventario',
      registros: limpios.length,
      status: 'ok',
      mensaje: `Cargado por ${perfil.nombre}: ${nuevos} nuevos, ${actualizados} actualizados, ${aEliminar.length} eliminados (ya no estaban en el archivo)`,
    });

    return res.status(200).json({
      ok: true,
      total: limpios.length,
      nuevos,
      actualizados,
      eliminados: aEliminar.length,
    });
  } catch (e) {
    try {
      await sbAdmin.from('sync_log').insert({
        fecha: new Date().toISOString(),
        modulo: 'inventario',
        registros: 0,
        status: 'error',
        mensaje: e.message,
      });
    } catch (e2) { /* no dejar que un error del log tumbe la respuesta */ }
    return res.status(500).json({ error: 'Error interno: ' + e.message });
  }
};
