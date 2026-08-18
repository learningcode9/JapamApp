-- Home stats foundation. This migration adds no client wiring and returns no history rows.
-- The legacy map is intentionally private: it must be populated only by a trusted, reviewed
-- identity-reconciliation process after verifying the account link outside this RPC.

create schema if not exists private;
alter schema private owner to postgres;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create table if not exists private.legacy_user_id_map (
  legacy_user_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (btrim(source) <> ''),
  verified_at timestamptz not null default now(),
  check (btrim(legacy_user_id) <> '')
);

comment on table private.legacy_user_id_map is
  'Trusted, manually/reconciliation-populated aliases for pre-UUID app user IDs. Never populated from client input or unverified provider metadata.';

create index if not exists legacy_user_id_map_user_id_idx
  on private.legacy_user_id_map (user_id, legacy_user_id);

alter table private.legacy_user_id_map enable row level security;
revoke all on private.legacy_user_id_map from public, anon, authenticated;

-- These indexes support the server-side owner/tombstone scan without changing any existing UI
-- query or pagination behavior.
create index if not exists japam_history_user_id_created_at_id_idx
  on public.japam_history (user_id, created_at, id);

create index if not exists deleted_completions_user_id_completion_id_idx
  on public.deleted_completions (user_id, completion_id);

create or replace function private.get_home_stats_impl(
  p_japam_id uuid,
  p_today_start timestamptz,
  p_today_end timestamptz,
  p_device_timezone text
)
returns table (
  today_count bigint,
  today_malas bigint,
  day_streak integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_caller uuid := auth.uid();
  v_owner_ids text[];
  v_start_local timestamp without time zone;
  v_end_local timestamp without time zone;
  v_today_date date;
begin
  if v_caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if p_japam_id is null then
    raise exception 'p_japam_id is required' using errcode = '22004';
  end if;

  if p_today_start is null or p_today_end is null or p_device_timezone is null
     or btrim(p_device_timezone) = '' then
    raise exception 'valid today bounds and device timezone are required' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from pg_timezone_names
    where name = p_device_timezone
  ) then
    raise exception 'invalid device timezone' using errcode = '22023';
  end if;

  if p_today_start >= p_today_end then
    raise exception 'today bounds must be increasing' using errcode = '22023';
  end if;

  v_start_local := p_today_start at time zone p_device_timezone;
  v_end_local := p_today_end at time zone p_device_timezone;
  v_today_date := v_start_local::date;

  if p_today_start <> (v_today_date::timestamp at time zone p_device_timezone)
     or p_today_end <> ((v_today_date + 1)::timestamp at time zone p_device_timezone)
     or v_end_local <> (v_today_date + 1)::timestamp then
    raise exception 'today bounds must be consecutive local midnights' using errcode = '22023';
  end if;

  select array_agg(distinct owner_id order by owner_id)
    into v_owner_ids
  from (
    select v_caller::text as owner_id
    union
    select m.legacy_user_id
    from private.legacy_user_id_map m
    where m.user_id = v_caller
  ) caller_owners;

  if not exists (
    select 1
    from public.japams j
    where j.id = p_japam_id
      and j.archived_at is null
      and j.user_id = any(v_owner_ids)
  ) then
    raise exception 'Japam is not owned by the authenticated caller or is archived'
      using errcode = '42501';
  end if;

  return query
  with recursive
  active_japams as (
    select
      j.id,
      btrim(j.name) as name,
      count(*) over (partition by btrim(j.name)) as name_count,
      row_number() over (
        order by j.display_order nulls last, j.created_at asc, j.id asc
      ) = 1 as is_first
    from public.japams j
    where j.archived_at is null
      and j.user_id = any(v_owner_ids)
  ),
  selected_japam as (
    select a.*
    from active_japams a
    where a.id = p_japam_id
  ),
  history_candidates as (
    select
      h.id,
      h.created_at,
      h.user_id,
      h.japam_id,
      h.japam_name,
      h.malas,
      h.count,
      h.completion_id,
      coalesce(h.completion_id, '**row**:' || h.id::text) as completion_key
    from public.japam_history h
    where h.user_id = any(v_owner_ids)
      and not exists (
        select 1
        from public.deleted_completions dc
        where dc.completion_id = h.completion_id
          and dc.user_id = any(v_owner_ids)
      )
  ),
  deduped_history as (
    select hc.*,
      row_number() over (
        partition by hc.completion_key
        order by hc.created_at desc, hc.id desc
      ) as rn
    from history_candidates hc
  ),
  scoped_history as (
    select
      dh.created_at,
      case
        when coalesce(dh.count, 0) > 0 then dh.count::bigint
        when coalesce(dh.malas, 0) > 0 then dh.malas::bigint * 108
        else 0::bigint
      end as effective_count,
      (dh.created_at at time zone p_device_timezone)::date as local_day
    from deduped_history dh
    cross join selected_japam sj
    where dh.rn = 1
      and (
        dh.japam_id = sj.id
        or (
          dh.japam_id is null
          and btrim(coalesce(dh.japam_name, '')) <> ''
          and btrim(dh.japam_name) = sj.name
          and sj.name <> ''
          and sj.name_count = 1
        )
        or (
          dh.japam_id is null
          and btrim(coalesce(dh.japam_name, '')) = ''
          and sj.is_first
        )
      )
  ),
  active_days as (
    select distinct sh.local_day as day_key
    from scoped_history sh
    where sh.effective_count > 0
  ),
  streak_anchor as (
    select case
      when exists (select 1 from active_days where day_key = v_today_date)
        then v_today_date
      else v_today_date - 1
    end as day_key
    where exists (select 1 from active_days where day_key = v_today_date)
       or exists (select 1 from active_days where day_key = v_today_date - 1)
  ),
  streak_days(day_key) as (
    select sa.day_key
    from streak_anchor sa
    union all
    select sd.day_key - 1
    from streak_days sd
    join active_days ad on ad.day_key = sd.day_key - 1
  ),
  summary as (
    select coalesce(
      sum(sh.effective_count) filter (where sh.local_day = v_today_date), 0
    )::bigint as today_count
    from scoped_history sh
  )
  select
    s.today_count,
    floor(s.today_count::numeric / 108)::bigint,
    coalesce((select count(*)::integer from streak_days), 0)
  from summary s;
end;
$$;

comment on function private.get_home_stats_impl(uuid, timestamptz, timestamptz, text) is
  'Private bounded-response implementation for Home stats. It scans server-side and returns only one summary row; caller identity is auth.uid() plus private verified aliases.';

revoke all on function private.get_home_stats_impl(uuid, timestamptz, timestamptz, text) from public, anon;
grant execute on function private.get_home_stats_impl(uuid, timestamptz, timestamptz, text) to authenticated;

create or replace function public.get_home_stats(
  p_japam_id uuid,
  p_today_start timestamptz,
  p_today_end timestamptz,
  p_device_timezone text
)
returns table (
  today_count bigint,
  today_malas bigint,
  day_streak integer
)
language sql
security invoker
set search_path = pg_catalog, public, private
as $$
  select *
  from private.get_home_stats_impl(
    p_japam_id,
    p_today_start,
    p_today_end,
    p_device_timezone
  );
$$;

comment on function public.get_home_stats(uuid, timestamptz, timestamptz, text) is
  'Authenticated Home summary only: today count, today malas, and current day streak. No history rows are returned.';

revoke all on function public.get_home_stats(uuid, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.get_home_stats(uuid, timestamptz, timestamptz, text) to authenticated;
