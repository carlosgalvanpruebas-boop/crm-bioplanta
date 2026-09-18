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
//
// Regla adicional confirmada por Carlos (16-sep-2026): solo se cargan
// filas cuyo OcrCode3 sea "C30" o "C31" (los 2 centros de costo reales
// de la agrotienda); todo lo demás, incluido vacío, se descarta.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://fpqogvxssnoarzgxcitc.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function prefijoDe(codigo) {
  const m = (codigo || '').toString().trim().match(/^([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : '';
}

// Un código queda excluido si coincide EXACTO con algo guardado en
// `sap_prefijos_excluidos` (ej. "SER_04", para un sub-código puntual)
// o si su prefijo de letras coincide (ej. "TUZAP", "ACECRUDO" — grupos
// completos). Se necesitan las dos formas: el prefijo de letras solo
// no alcanza para distinguir sub-códigos de un mismo grupo (SER_04 vs
// SER_01, SER_05, SER_10, SER_12, que NO deben excluirse).
function estaExcluido(codigo, excluidosSet) {
  const c = (codigo || '').toString().trim().toUpperCase();
  if (!c) return false;
  if (excluidosSet.has(c)) return true;
  const p = prefijoDe(c);
  return !!p && excluidosSet.has(p);
}

// Regla confirmada por Carlos (sep-2026): solo se bloquea una fila cuando
// la columna "Cancelado" trae una letra DISTINTA de "N" (ej. "S"). Si la
// columna viene vacía o no llega el dato, la fila NO se bloquea — se
// asume válida, igual que ya hace el filtro del lado del navegador en
// cargar-ventas.html. Esta función es el mismo criterio aplicado también
// aquí en el servidor, como segunda capa de protección.
function estaCancelado(valor) {
  const v = (valor === undefined || valor === null) ? '' : String(valor).trim().toUpperCase();
  if (!v) return false; // sin dato => no se bloquea
  return v !== 'N';
}

// Regla confirmada por Carlos (16-sep-2026): solo son ventas reales de la
// agrotienda las filas cuyo OcrCode3 sea "C30" (Chigorodó) o "C31" (Belén
// de Bajirá) — cualquier otro valor, incluido vacío, pertenece a otro
// centro de costo del mismo SAP (extractora, viveros, semillas, etc.) y se
// descarta. Ya se filtra en el navegador (cargar-ventas.html); esta función
// es la segunda capa de protección aquí en el servidor, mismo patrón que
// estaCancelado/estaExcluido.
function esAlmacenValido(valor) {
  const v = (valor === undefined || valor === null) ? '' : String(valor).trim().toUpperCase();
  return v === 'C30' || v === 'C31';
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

// Contado/Crédito (confirmado por Carlos, sep-2026): el reporte de SAP no
// trae una columna directa de condición de pago, así que se infiere de la
// diferencia entre "Fecha de contabilización" (la venta) y "Fecha de
// vencimiento" (el plazo del crédito) — mismo día (0 de diferencia) es
// Contado, cualquier plazo mayor es Crédito.
function formaPagoDe(fechaContabISO, fechaVencISO) {
  if (!fechaContabISO || !fechaVencISO) return null;
  const a = new Date(fechaContabISO + 'T00:00:00');
  const b = new Date(fechaVencISO + 'T00:00:00');
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  const dias = Math.round((b - a) / 86400000);
  return dias <= 0 ? 'Contado' : 'Crédito';
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
    // NOLI queda excluido del catálogo de INVENTARIO (no es artículo propio
    // de Agrotienda), pero sí se vende ocasionalmente de mostrador — Carlos
    // confirmó (sep-2026, reconciliación contra Power BI) que esas ventas
    // puntuales sí cuentan como venta real de la agrotienda. Se quita solo
    // de esta copia en memoria — no se toca la tabla `sap_prefijos_excluidos`,
    // que sigue rigiendo tal cual para la carga de inventario.
    prefijosExcluidos.delete('NOLI');

    let omitidosPorGrupo = 0;
    let omitidosSinCodigo = 0;
    let omitidosPorCancelado = 0;
    let omitidosPorOcrCode3 = 0;
    const limpiasMap = new Map(); // clave factura||codigo_sap -> fila (colapsa duplicados del mismo archivo)
    let sinFacturaOProducto = 0;

    for (const f of filas) {
      const factura = (f.factura || '').toString().trim();
      const producto = (f.producto || '').toString().trim();
      if (!factura || !producto) { sinFacturaOProducto++; continue; }

      if (!esAlmacenValido(f.ocr_code3)) { omitidosPorOcrCode3++; continue; }

      if (estaCancelado(f.cancelado)) { omitidosPorCancelado++; continue; }

      const codigo_sap = (f.codigo_sap || '').toString().trim();
      // Una venta real de mostrador siempre trae código de artículo. Las
      // pocas líneas que llegan sin código (ej. "CAMIONETA DUSTER LRQ-524",
      // "TRANSPORTE DE REPUESTOS CABLE VÍA") son movimientos sueltos de
      // SAP que no son productos de la agrotienda (Carlos, sep-2026).
      if (!codigo_sap) { omitidosSinCodigo++; continue; }
      if (estaExcluido(codigo_sap, prefijosExcluidos)) { omitidosPorGrupo++; continue; }

      const fechaContab = fechaISO(f.fecha);
      const fechaVenc = fechaISO(f.fecha_vencimiento);
      const fila = {
        factura,
        producto,
        codigo_sap: codigo_sap || null,
        fecha: fechaContab,
        cantidad: numeroOr(f.cantidad, 0),
        valor: numeroOr(f.valor, 0),
        cliente: f.cliente ? String(f.cliente).trim() : null,
        cliente_nit: f.cliente_nit ? String(f.cliente_nit).trim() : null,
        vendedor: f.vendedor ? String(f.vendedor).trim() : null,
        sede: f.sede ? String(f.sede).trim() : null,
        forma_pago: formaPagoDe(fechaContab, fechaVenc),
      };
      limpiasMap.set(`${factura}||${codigo_sap}`, fila);
    }

    const limpios = [...limpiasMap.values()];
    const duplicadosColapsados = filas.length - sinFacturaOProducto - omitidosPorOcrCode3 - omitidosPorCancelado - omitidosPorGrupo - omitidosSinCodigo - limpios.length;

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
      mensaje: `Cargado por ${perfil.nombre}: ${limpios.length} líneas procesadas, ${omitidosPorOcrCode3} omitidas por no ser OcrCode3 C30/C31, ${omitidosPorCancelado} omitidas por estar canceladas, ${omitidosPorGrupo} omitidas por grupos excluidos, ${omitidosSinCodigo} omitidas por no traer código SAP, ${duplicadosColapsados} duplicadas dentro del mismo archivo, ${sinFacturaOProducto} sin factura/producto válidos`,
    });

    return res.status(200).json({
      ok: true,
      procesadas: limpios.length,
      omitidosPorOcrCode3,
      omitidosPorCancelado,
      omitidosPorGrupo,
      omitidosSinCodigo,
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
