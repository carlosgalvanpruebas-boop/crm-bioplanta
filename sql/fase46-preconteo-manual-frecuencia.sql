-- Fase 46 (21-sep-2026) — Preconteo de inventario (2.8): asignación manual
-- de grupo a contar + frecuencia configurable (semanal o diaria) del
-- sorteo automático.
--
-- Ejecutar una sola vez en el SQL Editor de Supabase.

-- 1) Frecuencia del sorteo automático, configurable por sede.
create table if not exists preconteo_config (
  sede text primary key check (sede in ('Chigorodó', 'Belén de Bajirá')),
  frecuencia text not null default 'semanal' check (frecuencia in ('semanal', 'diario')),
  actualizado_por uuid references perfiles(id),
  actualizado_en timestamptz default now()
);

insert into preconteo_config (sede, frecuencia) values
  ('Chigorodó', 'semanal'),
  ('Belén de Bajirá', 'semanal')
on conflict (sede) do nothing;

alter table preconteo_config enable row level security;

drop policy if exists preconteo_config_select on preconteo_config;
create policy preconteo_config_select on preconteo_config
  for select
  using (true); -- cualquier persona autenticada del CRM puede consultar la frecuencia vigente

drop policy if exists preconteo_config_write on preconteo_config;
create policy preconteo_config_write on preconteo_config
  for all
  using (tiene_permiso(2::smallint, 'parcial') or es_super_admin())
  with check (tiene_permiso(2::smallint, 'parcial') or es_super_admin());

-- 2) Distinguir sorteos automáticos de asignaciones manuales en la tabla
--    que ya existe desde la Fase 5c/5d — aditivo, no toca filas existentes
--    más allá de rellenarles el valor por defecto.
alter table sorteos_preconteo add column if not exists origen text default 'automatico' check (origen in ('automatico', 'manual'));
alter table sorteos_preconteo add column if not exists asignado_por uuid references perfiles(id);
update sorteos_preconteo set origen = 'automatico' where origen is null;

-- 3) Permite a Módulo 2 (cualquier nivel) o Super Admin insertar una
--    asignación manual — puramente aditiva, NO reemplaza ninguna policy de
--    insert que ya exista (Fase 5d: Módulo 2 completo; Fase 15a: Módulo 1),
--    solo agrega un caso más que ya estaba cubierto para Módulo 2 completo
--    pero ahora también cubre Módulo 2 parcial.
drop policy if exists sorteos_preconteo_insert_manual on sorteos_preconteo;
create policy sorteos_preconteo_insert_manual on sorteos_preconteo
  for insert
  with check (tiene_permiso(2::smallint, 'parcial') or es_super_admin());

-- Verificación: no debería dar error; confirma que las columnas y la tabla
-- nueva quedaron bien.
select sede, frecuencia from preconteo_config order by sede;
select origen, count(*) from sorteos_preconteo group by origen;
