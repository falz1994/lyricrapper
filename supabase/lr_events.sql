-- Analítica de Lyric Rapper en Supabase.
--
-- Pégalo en el SQL Editor del proyecto y ejecútalo una vez.
-- Es idempotente: puedes volver a lanzarlo sin romper nada.
--
-- Qué crea:
--   · public.lr_events       → una fila por evento (pageview, line_click…)
--   · public.lr_stats()      → agregados que consume /api/stats
--   · RLS activado          → el rol anon no lee ni escribe; sólo el
--                             service_role (que usan las funciones de Vercel).

create table if not exists public.lr_events (
  id         bigserial primary key,
  created_at timestamptz not null default now(),
  event      text not null,
  sid        text,
  path       text,
  track      text,
  line       int,
  ref        text,
  country    text,
  ua         text
);

create index if not exists lr_events_created_at_idx
  on public.lr_events (created_at desc);

create index if not exists lr_events_track_idx
  on public.lr_events (track, line);

alter table public.lr_events enable row level security;

-- Agregados para el panel (stats.html). security definer para poder leer
-- la tabla aunque el rol que llama no tenga permisos directos.
create or replace function public.lr_stats() returns jsonb
language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'ok', true,
    'total', (select count(*) from lr_events),
    'sessions', (select count(distinct sid) from lr_events),
    'events', coalesce((select jsonb_object_agg(event, n) from (
        select event, count(*) n from lr_events group by event order by n desc) t), '{}'::jsonb),
    'tracks', coalesce((select jsonb_object_agg(track, n) from (
        select track, count(*) n from lr_events
        where track is not null group by track order by n desc) t), '{}'::jsonb),
    'lines', coalesce((select jsonb_object_agg(k, n) from (
        select track || ':' || line as k, count(*) n from lr_events
        where track is not null and line is not null
        group by 1 order by n desc limit 50) t), '{}'::jsonb),
    'days', coalesce((select jsonb_object_agg(d, n) from (
        select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') d, count(*) n
        from lr_events group by 1 order by 1) t), '{}'::jsonb)
  );
$$;

revoke all on function public.lr_stats() from anon, authenticated;
