-- Fase 33 — Limpiar del historico de ventas las lineas sin codigo SAP
-- (Carlos, 2026-09-13): no son productos reales de la agrotienda.
--   CAMIONETA DUSTER LRQ-524          $71.952.000  (04-ago-2026)
--   TRANSPORTE DE REPUESTOS CABLE VIA    $420.000  (28-ago-2026)
--
-- Ya deployado el fix de codigo (commit dde581a) que excluye
-- automaticamente cualquier fila SIN codigo_sap en cargas futuras.

delete from ventas where codigo_sap is null;

-- Verificacion: no deberia quedar ninguna fila.
select producto, codigo_sap, valor, fecha from ventas where codigo_sap is null;
