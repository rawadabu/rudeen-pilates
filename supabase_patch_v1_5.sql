-- ============================================================
-- RUDEEN PILATES — patch v1.5: the studio runs its own timetable
-- Run AFTER supabase_patch_v1_4.sql. Safe to re-run.
--
-- 1. Weekly schedule editor: admin_save_template replaces the standing week
--    (days, hours, length, capacity, type) and moves the coming weeks onto it.
--    Classes somebody already booked never change or disappear by themselves.
-- 2. Edit one class: admin_update_class changes a single class's date, time,
--    length, capacity or type. Booked clients get a 'class_moved'
--    notification when the date or time changes.
-- 3. Book a client from the admin: admin_book_client spends a credit from
--    the client's pack, like booking in the app. (Creating the client account
--    itself is the `admin-create-client` edge function: an auth user can only
--    be created with the service role, never from the browser.)
-- 4. One room: no two open classes may overlap in time.
-- ============================================================

-- ---------- 1. Where each class came from ----------
-- template_id: the weekly slot that generated it (null = a one-off).
-- detached: edited by hand, so the weekly schedule no longer manages it — but
-- template_id is kept, which stops the generator from re-creating that slot on
-- that date (a class moved from 18:00 to 18:30 must not get a new 18:00 twin).
alter table public.classes
  add column if not exists template_id uuid references public.class_template(id) on delete set null,
  add column if not exists detached boolean not null default false;
create index if not exists idx_classes_template on public.classes(template_id, class_date);

-- backfill once: a class sitting on a template slot came from it
update public.classes c
   set template_id = t.id
  from public.class_template t
 where c.template_id is null
   and t.weekday = extract(dow from c.class_date)::int
   and t.start_time = c.start_time;

-- ---------- 2. One room: overlap check ----------
-- Start time of an OPEN class on p_date whose time range intersects
-- [p_time, p_time + p_duration), ignoring p_exclude. null = room is free.
create or replace function public.class_overlap(
  p_date date, p_time time, p_duration int, p_exclude uuid default null
) returns time language sql stable set search_path = public as $$
  select c.start_time from public.classes c
  where c.class_date = p_date
    and c.status = 'open'
    and c.id is distinct from p_exclude
    and c.start_time < p_time + make_interval(mins => p_duration)
    and p_time < c.start_time + make_interval(mins => c.duration_min)
  order by c.start_time
  limit 1
$$;
revoke execute on function public.class_overlap(date, time, int, uuid) from public, anon, authenticated;

-- ---------- 3. Keep the coming weeks on the template ----------
-- Future classes only (not started yet), inside the generation window:
--   slot removed from the week, nobody ever booked  -> deleted
--   slot removed, only cancelled bookings           -> cancelled (history kept)
--   slot removed, somebody booked                   -> kept as a one-off
--   slot changed (length / capacity / type)         -> updated, unless booked
--   slot missing on a date                          -> created, unless the
--                                                      room is taken then
-- Hand-edited (detached) classes and one-offs are never touched.
create or replace function public.resync_classes(p_weeks int default null)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_weeks int; v_today date := public.studio_today(); v_now timestamp := public.studio_now();
  v_end date; v_removed int := 0; v_n int; v_updated int := 0; v_kept int := 0; v_added int := 0;
begin
  select coalesce(p_weeks, weeks_ahead) into v_weeks from public.studio_settings;
  v_weeks := least(greatest(coalesce(v_weeks, 5), 1), 12);
  v_end := v_today + v_weeks * 7;

  create temp table if not exists resync_c (id uuid primary key, gone boolean, has_rows boolean, has_live boolean, differs boolean) on commit drop;
  truncate resync_c;
  insert into resync_c
  select c.id,
         not coalesce(t.active, false) as gone,
         exists (select 1 from public.bookings b where b.class_id = c.id) as has_rows,
         exists (select 1 from public.bookings b where b.class_id = c.id and b.status <> 'cancelled') as has_live,
         coalesce(t.active, false) and (c.duration_min, c.capacity, c.label) is distinct from (t.duration_min, t.capacity, t.label) as differs
  from public.classes c
  left join public.class_template t on t.id = c.template_id
  where c.template_id is not null and not c.detached and c.status = 'open'
    and c.class_date between v_today and v_end
    and (c.class_date + c.start_time) > v_now;

  delete from public.classes where id in (select id from resync_c where gone and not has_rows);
  get diagnostics v_n = row_count; v_removed := v_n;
  update public.classes set status = 'cancelled'
   where id in (select id from resync_c where gone and has_rows and not has_live);
  get diagnostics v_n = row_count; v_removed := v_removed + v_n;
  update public.classes set detached = true
   where id in (select id from resync_c where gone and has_live);
  get diagnostics v_n = row_count; v_kept := v_n;

  update public.classes c
     set duration_min = t.duration_min, capacity = t.capacity, label = t.label
    from public.class_template t
   where t.id = c.template_id and c.id in (select id from resync_c where differs and not has_live);
  get diagnostics v_n = row_count; v_updated := v_n;
  select v_kept + count(*) into v_kept from resync_c where differs and has_live;

  -- one slot at a time, so a slot inserted here is seen by the overlap check
  -- of the next one (two template rows that overlap cannot both land)
  declare r record;
  begin
    for r in
      select d::date as d, t.id as tid, t.start_time, t.duration_min, t.capacity, t.label
      from generate_series(v_today, v_end, interval '1 day') d
      join public.class_template t on t.active and t.weekday = extract(dow from d)::int
      where (d::date + t.start_time) > v_now
        and not exists (select 1 from public.classes x where x.template_id = t.id and x.class_date = d::date)
      order by 1, t.start_time
    loop
      if public.class_overlap(r.d, r.start_time, r.duration_min) is null then
        insert into public.classes (class_date, start_time, duration_min, capacity, label, template_id)
        values (r.d, r.start_time, r.duration_min, r.capacity, r.label, r.tid)
        on conflict (class_date, start_time) do nothing;
        get diagnostics v_n = row_count; v_added := v_added + v_n;
      end if;
    end loop;
  end;

  return json_build_object('ok', true, 'added', v_added, 'removed', v_removed,
                           'updated', v_updated, 'kept_booked', v_kept);
end $$;
revoke execute on function public.resync_classes(int) from public, anon, authenticated;

-- The nightly job keeps calling generate_classes(); it now resyncs, so moved
-- and hand-edited classes are respected there too.
create or replace function public.generate_classes(p_weeks int default null)
returns int language plpgsql security definer set search_path = public as $$
begin
  return coalesce((public.resync_classes(p_weeks)->>'added')::int, 0);
end $$;
revoke execute on function public.generate_classes(int) from public, anon, authenticated;

-- ---------- 4. The weekly schedule editor ----------
-- p_rows: [{weekday 0-6, time "HH:MM", duration, capacity, label}]. Rows are
-- matched on weekday+time: same slot keeps its id (and its classes), a slot
-- left out is switched off (active = false), a new one is added.
create or replace function public.admin_save_template(p_rows jsonb)
returns json language plpgsql security definer set search_path = public as $$
declare v_bad text;
begin
  if not public.is_admin() then return json_build_object('ok', false, 'error', 'not_admin'); end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 80 then
    return json_build_object('ok', false, 'error', 'invalid_input');
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) e
              where coalesce(e->>'weekday', '') !~ '^[0-6]$'
                 or coalesce(e->>'time', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
                 or coalesce(e->>'duration', '') !~ '^[0-9]{2,3}$'
                 or coalesce(e->>'capacity', '') !~ '^[0-9]{1,2}$'
                 or (e->>'duration')::int not between 15 and 180
                 or (e->>'capacity')::int not between 1 and 30
                 or length(coalesce(e->>'label', '')) > 40) then
    return json_build_object('ok', false, 'error', 'invalid_input');
  end if;

  -- one room: two slots on the same weekday may not overlap
  with x as (
    select distinct on ((e->>'weekday')::int, (e->>'time')::time)
           (e->>'weekday')::int as wd, (e->>'time')::time as tm, (e->>'duration')::int as dur
    from jsonb_array_elements(p_rows) e
  )
  select to_char(b.tm, 'HH24:MI') into v_bad
  from x a join x b on a.wd = b.wd and a.tm < b.tm and b.tm < a.tm + make_interval(mins => a.dur)
  limit 1;
  if v_bad is not null then
    return json_build_object('ok', false, 'error', 'slots_overlap', 'time', v_bad);
  end if;

  update public.class_template t set active = false
   where t.active and not exists (
     select 1 from jsonb_array_elements(p_rows) e
     where (e->>'weekday')::int = t.weekday and (e->>'time')::time = t.start_time);

  insert into public.class_template (weekday, start_time, duration_min, capacity, label, active)
  select distinct on ((e->>'weekday')::int, (e->>'time')::time)
         (e->>'weekday')::int, (e->>'time')::time, (e->>'duration')::int, (e->>'capacity')::int,
         nullif(btrim(coalesce(e->>'label', '')), ''), true
  from jsonb_array_elements(p_rows) e
  on conflict (weekday, start_time) do update
     set duration_min = excluded.duration_min, capacity = excluded.capacity,
         label = excluded.label, active = true;

  return public.resync_classes();
end $$;
revoke execute on function public.admin_save_template(jsonb) from anon;

-- ---------- 5. One-off classes respect the room ----------
create or replace function public.admin_add_class(
  p_date date, p_time time, p_capacity int default null,
  p_label text default null, p_duration int default 55
) returns json language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_cap int; v_dur int := coalesce(p_duration, 55); v_clash time;
begin
  if not public.is_admin() then return json_build_object('ok', false, 'error', 'not_admin'); end if;
  if p_date is null or p_time is null then return json_build_object('ok', false, 'error', 'invalid_input'); end if;
  if p_date < public.studio_today() then return json_build_object('ok', false, 'error', 'date_in_past'); end if;
  if v_dur < 15 or v_dur > 180 then return json_build_object('ok', false, 'error', 'invalid_duration'); end if;

  select coalesce(p_capacity, default_capacity) into v_cap from public.studio_settings;
  if v_cap < 1 or v_cap > 30 then return json_build_object('ok', false, 'error', 'invalid_capacity'); end if;
  if exists (select 1 from public.classes where class_date = p_date and start_time = p_time and status = 'open') then
    return json_build_object('ok', false, 'error', 'class_exists');
  end if;
  v_clash := public.class_overlap(p_date, p_time, v_dur);
  if v_clash is not null then
    return json_build_object('ok', false, 'error', 'overlaps_class', 'time', to_char(v_clash, 'HH24:MI'));
  end if;

  -- a cancelled class at the same date+time is replaced (the unique key is
  -- on date+time); one with history is reopened rather than duplicated
  update public.classes
     set status = 'open', duration_min = v_dur, capacity = v_cap, label = p_label, detached = true
   where class_date = p_date and start_time = p_time and status = 'cancelled'
  returning id into v_id;
  if v_id is null then
    insert into public.classes (class_date, start_time, duration_min, capacity, label)
    values (p_date, p_time, v_dur, v_cap, p_label)
    returning id into v_id;
  end if;

  return json_build_object('ok', true, 'class_id', v_id);
exception when unique_violation then
  return json_build_object('ok', false, 'error', 'class_exists');
end $$;
revoke execute on function public.admin_add_class(date, time, int, text, int) from anon;

-- ---------- 6. Edit one class ----------
alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in (
  'announcement', 'purchase_approved', 'purchase_declined',
  'class_cancelled', 'booking_removed', 'pack_granted', 'class_moved'));

create or replace function public.admin_update_class(
  p_class_id uuid, p_date date, p_time time, p_duration int, p_capacity int, p_label text default null
) returns json language plpgsql security definer set search_path = public as $$
declare
  c public.classes%rowtype; v_taken int; v_clash time; v_moved boolean; v_notified int := 0;
  v_now timestamp := public.studio_now();
begin
  if not public.is_admin() then return json_build_object('ok', false, 'error', 'not_admin'); end if;
  if p_date is null or p_time is null then return json_build_object('ok', false, 'error', 'invalid_input'); end if;
  if p_duration is null or p_duration < 15 or p_duration > 180 then
    return json_build_object('ok', false, 'error', 'invalid_duration');
  end if;
  if p_capacity is null or p_capacity < 1 or p_capacity > 30 then
    return json_build_object('ok', false, 'error', 'invalid_capacity');
  end if;

  select * into c from public.classes where id = p_class_id for update;
  if not found then return json_build_object('ok', false, 'error', 'class_not_found'); end if;
  if c.status <> 'open' then return json_build_object('ok', false, 'error', 'class_cancelled'); end if;
  if (c.class_date + c.start_time) <= v_now then return json_build_object('ok', false, 'error', 'class_past'); end if;
  if (p_date + p_time) <= v_now then return json_build_object('ok', false, 'error', 'date_in_past'); end if;

  select count(*) into v_taken from public.bookings where class_id = p_class_id and status <> 'cancelled';
  if p_capacity < v_taken then
    return json_build_object('ok', false, 'error', 'capacity_below_booked', 'taken', v_taken);
  end if;
  if exists (select 1 from public.classes where class_date = p_date and start_time = p_time and id <> p_class_id) then
    return json_build_object('ok', false, 'error', 'class_exists');
  end if;
  v_clash := public.class_overlap(p_date, p_time, p_duration, p_class_id);
  if v_clash is not null then
    return json_build_object('ok', false, 'error', 'overlaps_class', 'time', to_char(v_clash, 'HH24:MI'));
  end if;

  v_moved := (p_date, p_time) is distinct from (c.class_date, c.start_time);
  update public.classes
     set class_date = p_date, start_time = p_time, duration_min = p_duration, capacity = p_capacity,
         label = nullif(btrim(coalesce(p_label, '')), ''),
         -- the weekly schedule stops managing a class edited by hand
         detached = detached or template_id is not null
   where id = p_class_id;

  if v_moved then
    perform public.notify_user(b.user_id, 'class_moved', jsonb_build_object(
      'old_date', c.class_date, 'old_time', c.start_time,
      'class_date', p_date, 'start_time', p_time, 'label', coalesce(nullif(btrim(coalesce(p_label, '')), ''), c.label)))
    from public.bookings b
    where b.class_id = p_class_id and b.status = 'booked' and b.user_id is not null;
    select count(*) into v_notified from public.bookings
     where class_id = p_class_id and status = 'booked' and user_id is not null;
  end if;

  return json_build_object('ok', true, 'moved', v_moved, 'notified', v_notified);
exception when unique_violation then
  return json_build_object('ok', false, 'error', 'class_exists');
end $$;
revoke execute on function public.admin_update_class(uuid, date, time, int, int, text) from anon;

-- ---------- 7. Book a client into a class from the admin ----------
-- Same rules as book_class (capacity under the class lock, one spot per
-- person, credit from the pack that expires soonest), with the client chosen
-- by the studio. No health-form gate: the studio is booking her in person.
create or replace function public.admin_book_client(p_class_id uuid, p_user_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_cap int; v_status text; v_date date; v_time time; v_taken int; v_pack uuid; v_id uuid;
  v_now timestamp := public.studio_now();
begin
  if not public.is_admin() then return json_build_object('ok', false, 'error', 'not_admin'); end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    return json_build_object('ok', false, 'error', 'client_not_found');
  end if;

  -- LOCK ORDER as in book_class: the class row, then the client's packs
  select capacity, status, class_date, start_time into v_cap, v_status, v_date, v_time
  from public.classes where id = p_class_id for update;
  if not found then return json_build_object('ok', false, 'error', 'class_not_found'); end if;
  if v_status <> 'open' then return json_build_object('ok', false, 'error', 'class_cancelled'); end if;
  if (v_date + v_time) < v_now then return json_build_object('ok', false, 'error', 'class_past'); end if;
  if exists (select 1 from public.bookings
             where class_id = p_class_id and user_id = p_user_id and status <> 'cancelled') then
    return json_build_object('ok', false, 'error', 'already_booked');
  end if;
  select count(*) into v_taken from public.bookings where class_id = p_class_id and status <> 'cancelled';
  if v_taken >= v_cap then return json_build_object('ok', false, 'error', 'class_full'); end if;

  perform 1 from public.credit_packs where user_id = p_user_id for update;
  select p.id into v_pack
  from public.credit_packs p
  where p.user_id = p_user_id
    and p.valid_from <= v_now::date and p.valid_until >= v_now::date
    and p.sessions_total > (select count(*) from public.bookings b where b.pack_id = p.id and b.consumes_credit)
  order by p.valid_until, p.created_at
  limit 1;
  if v_pack is null then return json_build_object('ok', false, 'error', 'no_credits'); end if;

  insert into public.bookings (class_id, user_id, pack_id)
  values (p_class_id, p_user_id, v_pack)
  returning id into v_id;
  return json_build_object('ok', true, 'booking_id', v_id);
exception when unique_violation then
  return json_build_object('ok', false, 'error', 'already_booked');
end $$;
revoke execute on function public.admin_book_client(uuid, uuid) from anon;

-- ---------- 8. Bring the coming weeks in line now ----------
do $$
declare r json;
begin
  r := public.resync_classes();
  raise notice 'v1.5 resync: %', r;
end $$;

notify pgrst, 'reload schema';
