-- Fase 29a (13-sep-2026)
-- 1) Columna "sede" en ventas, calculada a partir del centro de costo real
--    de SAP (OcrCode). "Carepa" es el nombre antiguo de la sede de
--    Chigorodó antes del traslado (confirmado por Carlos) y se trata como
--    la misma sede -- ese mapeo ya lo hace api/cargar-ventas.js al cargar.
-- 2) Tabla presupuesto_venta: meta de venta mensual a NIVEL GENERAL de la
--    agrotienda (no por sede -- confirmado por Carlos), con el presupuesto
--    2026 ya cargado.
--
-- Ejecutar una sola vez en el SQL Editor de Supabase.

alter table ventas
  add column if not exists sede text check (sede in ('Chigorodó', 'Belén de Bajirá'));

create table if not exists presupuesto_venta (
  anio smallint not null,
  mes smallint not null check (mes between 1 and 12),
  monto numeric not null,
  actualizado_en timestamptz default now(),
  actualizado_por uuid references perfiles(id),
  primary key (anio, mes)
);

alter table presupuesto_venta enable row level security;

drop policy if exists presupuesto_venta_select on presupuesto_venta;
create policy presupuesto_venta_select on presupuesto_venta
  for select
  using (true); -- cualquier persona autenticada del CRM puede consultarlo (1.3 y 3.1)

drop policy if exists presupuesto_venta_write on presupuesto_venta;
create policy presupuesto_venta_write on presupuesto_venta
  for all
  using (tiene_permiso(3::smallint, 'completo') or es_super_admin())
  with check (tiene_permiso(3::smallint, 'completo') or es_super_admin());

-- Presupuesto 2026 (nivel general, dado por Carlos, 13-sep-2026)
insert into presupuesto_venta (anio, mes, monto) values
  (2026, 1,  400000000),
  (2026, 2,  550000000),
  (2026, 3,  550000000),
  (2026, 4,  800000000),
  (2026, 5,  750000000),
  (2026, 6,  500000000),
  (2026, 7,  550000000),
  (2026, 8,  850000000),
  (2026, 9,  850000000),
  (2026, 10, 900000000),
  (2026, 11, 850000000),
  (2026, 12, 850000000)
on conflict (anio, mes) do update set monto = excluded.monto, actualizado_en = now();
