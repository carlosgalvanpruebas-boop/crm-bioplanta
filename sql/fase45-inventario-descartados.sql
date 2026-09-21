-- Fase 45 (21-sep-2026) — "Descartar" productos de Seguimiento de inventario (1.5)
--
-- Carlos pidió poder quitar un producto de la lista de 1.5 (ej. uno agotado
-- que ya no se va a volver a pedir) sin borrarlo del inventario real —
-- "dejarse en otro repositorio por si cambiamos de idea". Esta tabla es ese
-- archivo: guarda qué productos están descartados, sin tocar `inventario`
-- para nada (la carga real de SAP sigue funcionando exactamente igual).
--
-- Ejecutar una sola vez en el SQL Editor de Supabase.

create table if not exists inventario_descartados (
  codigo_sap text primary key,
  producto text,
  categoria text,
  motivo text,
  descartado_por uuid references perfiles(id),
  descartado_por_nombre text,
  descartado_en timestamptz default now()
);

alter table inventario_descartados enable row level security;

-- Lectura: mismo criterio que `inventario` (Fase 11c) — cualquiera con
-- Módulo 1 o Módulo 2 (parcial o completo), o Super Admin.
drop policy if exists inventario_descartados_select on inventario_descartados;
create policy inventario_descartados_select on inventario_descartados
  for select
  using (
    tiene_permiso(1::smallint, 'parcial')
    or tiene_permiso(2::smallint, 'parcial')
    or es_super_admin()
  );

-- Escritura (descartar/restaurar): mismo criterio de lectura de esta pantalla
-- (Módulo 1 o 2, cualquier nivel, o Super Admin) — es una curación práctica
-- de la lista, no una decisión financiera reservada a Gerencia. Si Carlos
-- prefiere restringirla más adelante (ej. solo Módulo 2 completo), es un
-- cambio de una sola línea aquí.
drop policy if exists inventario_descartados_write on inventario_descartados;
create policy inventario_descartados_write on inventario_descartados
  for all
  using (
    tiene_permiso(1::smallint, 'parcial')
    or tiene_permiso(2::smallint, 'parcial')
    or es_super_admin()
  )
  with check (
    tiene_permiso(1::smallint, 'parcial')
    or tiene_permiso(2::smallint, 'parcial')
    or es_super_admin()
  );

-- Verificación: la tabla debe existir, vacía, con RLS activo.
select count(*) as filas from inventario_descartados;
