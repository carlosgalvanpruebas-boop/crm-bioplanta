-- Fase 47 (21-sep-2026) — Negociaciones activas: nuevo apartado para dar
-- seguimiento a ventas en negociación (pipeline simple: Abierta / Ganada /
-- Perdida), visible para Mostrador y Administrativo/Gerencia.
--
-- Ejecutar una sola vez en el SQL Editor de Supabase.

-- 1) Tabla principal: una fila por negociación.
create table if not exists negociaciones (
  id uuid primary key default gen_random_uuid(),
  cliente text not null,
  cliente_nit text,
  sede text not null check (sede in ('Chigorodó', 'Belén de Bajirá')),
  producto_interes text,
  valor_estimado numeric,
  estado text not null default 'abierta' check (estado in ('abierta', 'ganada', 'perdida')),
  proxima_fecha_seguimiento date,
  responsable_perfil_id uuid references perfiles(id),
  responsable_nombre text,           -- foto del nombre al asignar (evita depender de un join a perfiles)
  creado_por uuid references perfiles(id),
  creado_por_nombre text,
  creado_en timestamptz default now(),
  actualizado_en timestamptz default now(),
  cerrada_en timestamptz,
  motivo_cierre text
);

create index if not exists negociaciones_estado_idx on negociaciones(estado);

alter table negociaciones enable row level security;

-- Mostrador (Módulo 1), Administrativo (Módulo 2) o Gerencia (Módulo 3),
-- con cualquier nivel de acceso (parcial o completo), o Super Admin:
-- todos pueden ver y gestionar las negociaciones. No se crea un módulo
-- nuevo en permisos_modulo para no obligar a reconfigurar el Panel de
-- Accesos de cada persona.
drop policy if exists negociaciones_select on negociaciones;
create policy negociaciones_select on negociaciones
  for select
  using (
    tiene_permiso(1::smallint, 'parcial') or
    tiene_permiso(2::smallint, 'parcial') or
    tiene_permiso(3::smallint, 'parcial') or
    es_super_admin()
  );

drop policy if exists negociaciones_write on negociaciones;
create policy negociaciones_write on negociaciones
  for all
  using (
    tiene_permiso(1::smallint, 'parcial') or
    tiene_permiso(2::smallint, 'parcial') or
    tiene_permiso(3::smallint, 'parcial') or
    es_super_admin()
  )
  with check (
    tiene_permiso(1::smallint, 'parcial') or
    tiene_permiso(2::smallint, 'parcial') or
    tiene_permiso(3::smallint, 'parcial') or
    es_super_admin()
  );

-- 2) Bitácora de seguimiento por negociación (notas de contacto/avance).
create table if not exists negociaciones_seguimientos (
  id uuid primary key default gen_random_uuid(),
  negociacion_id uuid not null references negociaciones(id) on delete cascade,
  nota text not null,
  creado_por uuid references perfiles(id),
  creado_por_nombre text,
  creado_en timestamptz default now()
);

create index if not exists negociaciones_seguimientos_neg_idx on negociaciones_seguimientos(negociacion_id);

alter table negociaciones_seguimientos enable row level security;

drop policy if exists negociaciones_seguimientos_select on negociaciones_seguimientos;
create policy negociaciones_seguimientos_select on negociaciones_seguimientos
  for select
  using (
    tiene_permiso(1::smallint, 'parcial') or
    tiene_permiso(2::smallint, 'parcial') or
    tiene_permiso(3::smallint, 'parcial') or
    es_super_admin()
  );

drop policy if exists negociaciones_seguimientos_write on negociaciones_seguimientos;
create policy negociaciones_seguimientos_write on negociaciones_seguimientos
  for all
  using (
    tiene_permiso(1::smallint, 'parcial') or
    tiene_permiso(2::smallint, 'parcial') or
    tiene_permiso(3::smallint, 'parcial') or
    es_super_admin()
  )
  with check (
    tiene_permiso(1::smallint, 'parcial') or
    tiene_permiso(2::smallint, 'parcial') or
    tiene_permiso(3::smallint, 'parcial') or
    es_super_admin()
  );

-- Verificación: no debería dar error; confirma que las dos tablas nuevas
-- quedaron bien.
select count(*) as negociaciones from negociaciones;
select count(*) as seguimientos from negociaciones_seguimientos;
