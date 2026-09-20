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
//   - Actualiza los artículos que ya existían (por código SAP +
//     sede — desde la Fase 25 la tabla real tiene una fila por
//     (codigo_sap, sede), con restricción única
//     `inventario_codigo_sap_sede_key`), sin tocar sus ajustes
//     manuales de mínimo/máximo (esas columnas no se pisan).
//   - Inserta los artículos nuevos.
//   - Elimina, DENTRO DE CADA SEDE QUE VINO EN ESTA CARGA, los que
//     ya no aparecen en el archivo de esa sede (Fase 40, 20-sep):
//     como ahora se puede subir el archivo de una sola sede a la
//     vez, el borrado NUNCA toca una sede que no vino en este
//     envío — de lo contrario, cargar solo Chigorodó hoy borraría
//     por error todo el inventario de Belén de Bajirá.
// Deja un registro en `sync_log` con el resultado, para que quede
// un historial de cada carga.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://fpqogvxssnoarzgxcitc.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SEDES_VALIDAS = new Set(['Chigorodó', 'Belén de Bajirá']);

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

    // Validación básica de cada fila + defensa adicional: si dos filas
    // comparten la misma clave (codigo_sap + sede) — normalmente ya no
    // debería pasar, porque el navegador las suma antes de enviar
    // (Fase 40, 20-sep) — se suman aquí también en vez de sobrescribir,
    // para no perder en silencio la existencia de ninguna de las dos.
    const limpiosMap = new Map();
    for (const a of articulos) {
      const codigo_sap = (a.codigo_sap || '').toString().trim();
      const producto = (a.producto || '').toString().trim();
      const sede = (a.sede || '').toString().trim();
      if (!codigo_sap || !producto || !SEDES_VALIDAS.has(sede)) continue;

      const cantidad = a.cantidad !== undefined && a.cantidad !== null ? Number(a.cantidad) : 0;
      const costo_unit = a.costo_unit !== undefined && a.costo_unit !== null ? Number(a.costo_unit) : null;
      const clave = codigo_sap + '||' + sede;
      const existente = limpiosMap.get(clave);
      if (existente) {
        const cantidadTotal = (Number(existente.cantidad) || 0) + cantidad;
        const valorExistente = existente.costo_unit !== null ? existente.costo_unit * (Number(existente.cantidad) || 0) : 0;
        const valorNuevo = costo_unit !== null ? costo_unit * cantidad : 0;
        existente.cantidad = cantidadTotal;
        existente.costo_unit = cantidadTotal ? Math.round(((valorExistente + valorNuevo) / cantidadTotal) * 10000) / 10000 : costo_unit;
      } else {
        limpiosMap.set(clave, {
          codigo_sap,
          sede,
          producto,
          categoria: a.categoria ? String(a.categoria).trim() : null,
          proveedor: a.proveedor ? String(a.proveedor).trim() : null,
          unidad: a.unidad ? String(a.unidad).trim() : null,
          cantidad,
          costo_unit,
          // valor_total NO se envía: es una columna calculada automáticamente
          // por la base de datos (cantidad × costo_unit) y Postgres rechaza
          // cualquier intento de escribirla directamente.
          actualizado_en: new Date().toISOString(),
        });
      }
    }

    const limpios = [...limpiosMap.values()];
    if (!limpios.length) {
      return res.status(400).json({ error: 'Ningún artículo tenía código, nombre y sede válidos (sede debe ser Chigorodó o Belén de Bajirá)' });
    }

    // Sedes que efectivamente vinieron en esta carga — el borrado de abajo
    // se limita a estas, nunca toca una sede que no vino en este envío.
    const sedesIncluidas = [...new Set(limpios.map(a => a.sede))];

    const { data: existentes, error: existentesError } = await sbAdmin
      .from('inventario')
      .select('codigo_sap, sede')
      .in('sede', sedesIncluidas);
    if (existentesError) throw existentesError;

    const clavesExistentes = new Set((existentes || []).map(x => x.codigo_sap + '||' + x.sede));
    const actualizados = limpios.filter(a => clavesExistentes.has(a.codigo_sap + '||' + a.sede)).length;
    const nuevos = limpios.length - actualizados;

    // Upsert por (código SAP, sede) — no pisa `stock_minimo_manual` /
    // `stock_maximo_manual` porque esas columnas no se incluyen aquí.
    const { error: upsertError } = await sbAdmin
      .from('inventario')
      .upsert(limpios, { onConflict: 'codigo_sap,sede' });
    if (upsertError) throw upsertError;

    // Borrado por sede: dentro de cada sede que vino en este archivo, se
    // borra lo que ya no aparece — nunca se toca una sede que no vino.
    let eliminados = 0;
    for (const sede of sedesIncluidas) {
      const codigosDeEstaSede = new Set(limpios.filter(a => a.sede === sede).map(a => a.codigo_sap));
      const aEliminar = (existentes || [])
        .filter(x => x.sede === sede && !codigosDeEstaSede.has(x.codigo_sap))
        .map(x => x.codigo_sap);
      if (aEliminar.length) {
        const { error: deleteError } = await sbAdmin
          .from('inventario')
          .delete()
          .eq('sede', sede)
          .in('codigo_sap', aEliminar);
        if (deleteError) throw deleteError;
        eliminados += aEliminar.length;
      }
    }

    await sbAdmin.from('sync_log').insert({
      fecha: new Date().toISOString(),
      modulo: 'inventario',
      registros: limpios.length,
      status: 'ok',
      mensaje: `Cargado por ${perfil.nombre} (${sedesIncluidas.join(' y ')}): ${nuevos} nuevos, ${actualizados} actualizados, ${eliminados} eliminados`,
    });

    return res.status(200).json({
      ok: true,
      total: limpios.length,
      nuevos,
      actualizados,
      eliminados,
      sedes: sedesIncluidas,
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
