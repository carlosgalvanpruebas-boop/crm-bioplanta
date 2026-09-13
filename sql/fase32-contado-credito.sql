-- Fase 32 — Contado vs Credito (Carlos, 2026-09-13)
--
-- Criterio confirmado: el reporte de SAP no trae una columna directa de
-- condicion de pago, asi que se infiere por la diferencia entre "Fecha de
-- contabilizacion" (fecha real de la venta) y "Fecha de vencimiento"
-- (plazo del credito) -- mismo dia (0 de diferencia) = Contado, cualquier
-- plazo mayor (15/30/45/60/89 dias, etc.) = Credito. El calculo lo hace
-- api/cargar-ventas.js en cada carga, esta columna solo guarda el
-- resultado.

alter table ventas
  add column if not exists forma_pago text check (forma_pago in ('Contado', 'Crédito'));

-- Nota: las ventas ya cargadas ANTES de este cambio quedan con
-- forma_pago = NULL (no se puede calcular retroactivamente sin volver a
-- leer el Excel original, porque la fecha de vencimiento no se guardaba
-- todavia). Para completarlas, vuelve a subir los mismos archivos de SAP
-- ya cargados desde Cargar informacion -> Ventas: el upsert por
-- (factura, codigo_sap) actualiza esas filas con su Contado/Credito real,
-- sin duplicarlas.
