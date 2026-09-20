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
// ⚠️ IMPORTANTE (19-sep-2026): esta tabla es aditiva y nunca borra
// filas viejas al recibir un archivo nuevo. Si una fila entra alguna
// vez por un filtro más permisivo que el de hoy, se queda ahí para
// siempre hasta que alguien la borre a mano en Supabase — arreglar
// el filtro aquí NO limpia lo que ya quedó mal cargado antes. Ya
// pasó una vez (agosto-2026, ver claude/fix-carga-inventario-sede-15-sep.md
// y la limpieza puntual que se corrió el 18-sep-2026): si vuelve a
// aparecer un total que no cuadra contra Power BI aunque el filtro de
// abajo esté bien, sospechar primero de filas viejas contaminando el
// histórico, no del código.
//
// ============================================================
// REGLA DE INCLUSIÓN — validada AL PESO contra el informe de Power BI
// (reconciliación completa de los 9 meses corridos de 2026, 19-sep-2026):
//
//   1) Cuenta contable (AcctCode) empieza por "4135" (venta) o "4175"
//      (nota crédito — su "Ingreso Total" ya viene negativo en el
//      export de SAP, así que sumarla resta sola; no se invierte el
//      signo). Cualquier otra cuenta contable se excluye.
//   2) Cancelado = "N" exactamente. Cualquier otro valor (incluidos
//      "Y", "C", o la casilla vacía) se excluye — SAP usa "Y"/"C" para
//      marcar una factura anulada y su reemplazo, ambas inválidas.
//   3) El centro de costo (OcrCode) debe reconocer una de las 2 sedes
//      de la agrotienda: CHIGOROD o CAREPA (nombre viejo de la sede de
//      Chigorodó, antes del traslado) -> Chigorodó; BAJIRA/BAJIRÁ ->
//      Belén de Bajirá. Cualquier otro centro de costo (de otra línea
//      de negocio que comparte el mismo SAP) se excluye.
//   4) Se excluyen SOLO los artículos cuyo código empiece por "SEM"
//      (semilla de palma aceitera — es del vivero de la extractora, no
//      de la agrotienda). Ningún otro prefijo se excluye aquí: NOLI
//      (aceite/infusionados) y AGROLAB sí se venden de mostrador y sí
//      cuentan como venta real de Agrotienda — confirmado reconciliando
//      contra Power BI mes a mes. Esta regla es propia de ventas y NO
//      usa la tabla `sap_prefijos_excluidos` (esa tabla es para decidir
//      qué artículos entran al catálogo de INVENTARIO, un criterio
//      distinto — mezclar las dos causó el problema del 16 al 19-sep).
//
// No hay ningún filtro por OcrCode2 ni por OcrCode3 — se probaron ambos
// en algún punto de esta misma investigación y sobraban: excluir por
// OcrCode2 dejaba fuera notas crédito reales, y OcrCode3 (C30/C31)
// dejaba fuera ventas reales tageadas con otros valores (C10, C11,
// C19...). El único centro de costo que importa es OcrCode (punto 3).
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://fpqogvxssnoarzgxcitc.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Prefijo de letras al inicio de un código SAP (ej. "SEM-002" -> "SEM").
function prefijoLetras(codigo) {
  const m = (codigo || '').toString().trim().match(/^([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : '';
}

function esSemillaDePalma(codigoSap) {
  return prefijoLetras(codigoSap) === 'SEM';
}

// Punto 1 de la regla de inclusión (ver comentario de cabecera).
function esCuentaDeVentaOND(acctCode) {
  const c = (acctCode || '').toString().trim();
  return c.startsWith('4135') || c.startsWith('4175');
}

// Punto 2 de la regla de inclusión: solo pasa "N" exacto. Cualquier otro
// valor, incluida una casilla vacía o el dato ausente, se bloquea — esta
// es la misma verificación que ya hace el filtro del lado del navegador
// en cargar-ventas.html, aplicada otra vez aquí como segunda capa de
// protección por si algún día se llama a esta función sin pasar por ahí.
function estaCancelado(valor) {
  const v = (valor === undefined || valor === null) ? '' : String(valor).trim().toUpperCase();
  return v !== 'N';
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

    let omitidosPorCuenta = 0;
    let omitidosPorSemilla = 0;
    let omitidosSinCodigo = 0;
    let omitidosPorCancelado = 0;
    let omitidosPorSede = 0;
    const limpiasMap = new Map(); // clave factura||codigo_sap -> fila (colapsa duplicados del mismo archivo)
    let sinFacturaOProducto = 0;

    for (const f of filas) {
      const factura = (f.factura || '').toString().trim();
      const producto = (f.producto || '').toString().trim();
      if (!factura || !producto) { sinFacturaOProducto++; continue; }

      // La sede ya viene calculada desde el navegador (sedeDeCentroCosto sobre
      // OcrCode) — si no reconoció una sede válida, la fila no es de la
      // agrotienda (otro centro de costo del mismo SAP) y se descarta aquí
      // también, como segunda capa de protección.
      if (!f.sede) { omitidosPorSede++; continue; }

      if (estaCancelado(f.cancelado)) { omitidosPorCancelado++; continue; }

      if (!esCuentaDeVentaOND(f.acctcode)) { omitidosPorCuenta++; continue; }

      const codigo_sap = (f.codigo_sap || '').toString().trim();
      // Una venta real de mostrador siempre trae código de artículo. Las
      // pocas líneas que llegan sin código (ej. "CAMIONETA DUSTER LRQ-524",
      // "TRANSPORTE DE REPUESTOS CABLE VÍA") son movimientos sueltos de
      // SAP que no son productos de la agrotienda (Carlos, sep-2026).
      if (!codigo_sap) { omitidosSinCodigo++; continue; }
      if (esSemillaDePalma(codigo_sap)) { omitidosPorSemilla++; continue; }

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
      // Defensa adicional: si dos líneas del mismo lote comparten la misma
      // clave (factura + codigo_sap) — normalmente ya no debería pasar,
      // porque el navegador las suma antes de enviar (19-sep-2026) — se
      // suman aquí también en vez de sobrescribir, para no perder en
      // silencio el valor de ninguna de las dos líneas.
      const clave = `${factura}||${codigo_sap}`;
      const existente = limpiasMap.get(clave);
      if (existente) {
        existente.cantidad = (Number(existente.cantidad) || 0) + (Number(fila.cantidad) || 0);
        existente.valor = (Number(existente.valor) || 0) + (Number(fila.valor) || 0);
      } else {
        limpiasMap.set(clave, fila);
      }
    }

    const limpios = [...limpiasMap.values()];
    const duplicadosColapsados = filas.length - sinFacturaOProducto - omitidosPorSede - omitidosPorCancelado - omitidosPorCuenta - omitidosPorSemilla - omitidosSinCodigo - limpios.length;

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
      mensaje: `Cargado por ${perfil.nombre}: ${limpios.length} líneas procesadas, ${omitidosPorSede} omitidas por no tener sede reconocida (OcrCode), ${omitidosPorCancelado} omitidas por estar canceladas, ${omitidosPorCuenta} omitidas por cuenta contable distinta de venta/NC, ${omitidosPorSemilla} omitidas por ser semilla de palma, ${omitidosSinCodigo} omitidas por no traer código SAP, ${duplicadosColapsados} duplicadas dentro del mismo archivo, ${sinFacturaOProducto} sin factura/producto válidos`,
    });

    return res.status(200).json({
      ok: true,
      procesadas: limpios.length,
      omitidosPorSede,
      omitidosPorCancelado,
      omitidosPorCuenta,
      omitidosPorSemilla,
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
