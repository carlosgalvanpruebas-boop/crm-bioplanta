-- Fase 30 — Limpiar del histórico de ventas los códigos SAP que son de
-- otra área del negocio pero comparten el mismo centro de costo
-- (Carlos, 2026-09-13):
--   ACECRUDO  Aceite de palma crudo alto oleico
--   TUZAP     Fibra de palma
--   SER_04    Análisis foliar
--   SER_06    Toma de muestras foliares
--
-- Antes de correr esto, agrega los 4 códigos en la tarjeta de
-- "exclusiones" de Cargar información → Inventario (así queda con tu
-- usuario como quien la agregó, igual que las demás). Esto ya se apoya
-- en el fix de código desplegado (commit fdd5ad8) que permite excluir
-- un código SAP exacto como "SER_04" sin arrastrar también a SER_01,
-- SER_03, SER_05, SER_10 y SER_12, que sí son de Agrotienda.

delete from ventas where codigo_sap in ('ACECRUDO', 'TUZAP', 'SER_04', 'SER_06');

-- Verificación: no debería quedar ninguna fila.
select codigo_sap, count(*) from ventas
where codigo_sap in ('ACECRUDO', 'TUZAP', 'SER_04', 'SER_06')
group by codigo_sap;
