-- Fase 31 — Limpieza consolidada de codigos SAP que no son de Agrotienda
-- (Carlos, 2026-09-13). Reemplaza y amplia a fase30-exclusiones-otras-lineas.sql:
-- si ya corriste esa, correr esta no hace dano (el DELETE simplemente no
-- encuentra nada que borrar en los codigos que ya se habian limpiado).
--
-- Codigos incluidos:
--   ACECRUDO           Aceite de palma crudo alto oleico
--   TUZAP              Fibra de palma
--   SER_04, SER_06     Analisis foliar / toma de muestras foliares
--   SER_01, SER_03,
--   SER_05, SER_10,
--   SER_12             Resto de servicios de laboratorio/campo (SG-SST,
--                      analisis de suelo, secado de muestras, etc.)
--   SEM-002, SEM-003   Ya deberian estar cubiertos por la exclusion del
--                      prefijo "SEM" completo desde la Fase 19 -- si
--                      aparecen aqui es porque se cargaron ANTES de esa
--                      exclusion, así que solo hace falta esta limpieza,
--                      no una regla nueva.

delete from ventas where codigo_sap in (
  'ACECRUDO', 'TUZAP',
  'SER_01', 'SER_03', 'SER_04', 'SER_05', 'SER_06', 'SER_10', 'SER_12',
  'SEM-002', 'SEM-003'
);

-- Verificacion: no deberia quedar ninguna fila.
select codigo_sap, count(*) from ventas
where codigo_sap in (
  'ACECRUDO', 'TUZAP',
  'SER_01', 'SER_03', 'SER_04', 'SER_05', 'SER_06', 'SER_10', 'SER_12',
  'SEM-002', 'SEM-003'
)
group by codigo_sap;
