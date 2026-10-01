-- ============================================================
-- RUDEEN PILATES — full install for a NEW Supabase project (one paste)
--
-- Exactly supabase_setup.sql followed by supabase_patch_v1_1 … v1_5, in
-- order. Paste ALL of it into the SQL Editor of an EMPTY project and Run once.
-- (An existing project upgrades with the individual patch files instead.)
--
-- Not included, on purpose: supabase_push_setup.sql — it needs the push edge
-- function deployed and three placeholders filled in first.
-- ============================================================



-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>> supabase_setup.sql <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

-- ============================================================
-- RUDEEN PILATES — Supabase foundation (v1)
-- Paste into the Supabase SQL Editor and run once.
--
-- Group classes with a room capacity, monthly credit packs, phone OTP.
--
-- This schema deliberately starts where the previous studio app ended up after
-- twelve patches. Every "-- LESSON:" note below marks something that was a
-- production bug there and is prevented here by construction.
-- ============================================================

-- ---------- 0. SETTINGS ----------
create table public.studio_settings (
  id boolean primary key default true check (id),   -- single-row table
  cancel_cutoff_hours int not null default 12 check (cancel_cutoff_hours between 0 and 72),
  default_capacity int not null default 8 check (default_capacity between 1 and 30),
  weeks_ahead int not null default 5 check (weeks_ahead between 1 and 12)
);
insert into public.studio_settings (id) values (true);

-- ---------- 1. PEOPLE ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  phone text unique not null,
  full_name text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, phone) values (new.id, coalesce(new.phone, ''));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 2. THE WEEKLY TIMETABLE ----------
-- LESSON: the previous app hardcoded its open days and times in BOTH the SQL
-- generator and the frontend, so changing the timetable meant a code change and
-- an extra class could exist in the database yet never render. The pattern
-- lives in data here, and the UI renders whatever classes exist.
create table public.class_template (
  id uuid primary key default gen_random_uuid(),
  weekday int not null check (weekday between 0 and 6),   -- 0 = Sunday
  start_time time not null,
  duration_min int not null default 55 check (duration_min between 15 and 180),
  capacity int not null check (capacity between 1 and 30),
  label text,
  active boolean not null default true,
  unique (weekday, start_time)
);

-- ---------- 3. CLASSES ----------
-- One room: at most one class per date+time. Drop this constraint if a second
-- studio room is ever added.
create table public.classes (
  id uuid primary key default gen_random_uuid(),
  class_date date not null,
  start_time time not null,
  duration_min int not null default 55,
  capacity int not null check (capacity between 1 and 30),
  label text,
  status text not null default 'open' check (status in ('open','cancelled')),
  created_at timestamptz not null default now(),
  unique (class_date, start_time)
);
create index idx_classes_date on public.classes(class_date);

-- ---------- 4. CREDIT PACKS ----------
-- What the client paid for: e.g. 300 ILS -> 8 sessions, valid one month.
create table public.credit_packs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  sessions_total int not null check (sessions_total between 1 and 60),
  valid_from date not null,
  valid_until date not null,
  price_ils numeric(8,2),
  note text,
  granted_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check (valid_until >= valid_from)
);
create index idx_packs_user on public.credit_packs(user_id, valid_until);

-- ---------- 5. BOOKINGS ----------
-- LESSON: user_id is nullable from day one. It lets the studio enter a booking
-- taken over Instagram or at the door (no account), and lets an account be
-- deleted without destroying the class history.
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  pack_id uuid references public.credit_packs(id) on delete set null,
  guest_name text,
  guest_phone text,
  status text not null default 'booked'
    check (status in ('booked','cancelled','attended','no_show')),
  -- The credit ledger. Booking consumes; an EARLY cancel releases it; a late
  -- cancel leaves it consumed. Deriving the balance from this flag means the
  -- pack counter can never drift out of sync with reality.
  consumes_credit boolean not null default true,
  note text,
  confirm_token uuid not null default gen_random_uuid() unique,
  reminder_sent_at timestamptz,
  customer_response text check (customer_response in ('yes','no')),
  responded_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now()
);

-- One live booking per person per class. Capacity itself CANNOT be an index —
-- it is enforced under a row lock in book_class().
-- LESSON: the predicate is "not cancelled", not "booked". Attendance marking
-- moves a row to 'attended'/'no_show'; a 'booked'-only predicate would let the
-- same person book the class again and would free their seat after the fact.
create unique index one_booking_per_user_per_class
  on public.bookings(class_id, user_id)
  where status <> 'cancelled' and user_id is not null;

create index idx_bookings_class on public.bookings(class_id) where status <> 'cancelled';
create index idx_bookings_user on public.bookings(user_id);
create index idx_bookings_pack on public.bookings(pack_id) where consumes_credit;

-- ---------- 6. PUSH SUBSCRIPTIONS ----------
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

-- ============================================================
-- 7. HELPERS
-- ============================================================

-- LESSON: every date decision is anchored to studio time. Supabase runs UTC, so
-- bare current_date silently shifts the day between midnight and 03:00 local.
create or replace function public.studio_now()
returns timestamp language sql stable as
$$ select (now() at time zone 'Asia/Jerusalem') $$;

create or replace function public.studio_today()
returns date language sql stable as
$$ select (now() at time zone 'Asia/Jerusalem')::date $$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as
$$ select coalesce((select is_admin from public.profiles where id = auth.uid()), false) $$;

-- ============================================================
-- 8. VIEWS
-- ============================================================

-- Public schedule. Aggregate counts only — never a name, never a phone — so it
-- is safe for anyone to read before signing in.
create view public.class_availability
with (security_invoker = off) as
select c.id, c.class_date, c.start_time, c.duration_min, c.label, c.capacity,
       coalesce(b.taken, 0) as taken,
       greatest(c.capacity - coalesce(b.taken, 0), 0) as spots_left,
       (coalesce(b.taken, 0) >= c.capacity) as is_full
from public.classes c
left join (
  select class_id, count(*) as taken
  from public.bookings where status <> 'cancelled'
  group by class_id
) b on b.class_id = c.id
where c.status = 'open';

grant select on public.class_availability to anon, authenticated;

-- Remaining sessions per pack, derived rather than stored.
create view public.pack_balance
with (security_invoker = on) as
select p.id, p.user_id, p.sessions_total, p.valid_from, p.valid_until,
       p.price_ils, p.note, p.created_at,
       p.sessions_total - coalesce((
         select count(*) from public.bookings b
         where b.pack_id = p.id and b.consumes_credit
       ), 0) as remaining,
       (p.valid_until >= public.studio_today() and p.valid_from <= public.studio_today()) as is_active
from public.credit_packs p;

revoke all on public.pack_balance from anon;
grant select on public.pack_balance to authenticated;

-- Who is in each class. Admin-only via RLS on the underlying tables.
-- LESSON: security_invoker = on, and revoked from anon. The previous app leaked
-- every customer's name and phone through a definer view with default grants.
create view public.class_roster
with (security_invoker = on) as
select b.id as booking_id, b.class_id, c.class_date, c.start_time, c.label,
       coalesce(p.full_name, b.guest_name) as attendee_name,
       coalesce(p.phone, b.guest_phone)    as attendee_phone,
       b.status, b.note, b.confirm_token,
       b.reminder_sent_at, b.customer_response, b.responded_at,
       (b.user_id is null) as is_manual
from public.bookings b
join public.classes c on c.id = b.class_id
left join public.profiles p on p.id = b.user_id
where b.status <> 'cancelled';

revoke all on public.class_roster from anon;
grant select on public.class_roster to authenticated;

-- ============================================================
-- 9. ROW LEVEL SECURITY
-- ============================================================
alter table public.profiles          enable row level security;
alter table public.classes           enable row level security;
alter table public.class_template    enable row level security;
alter table public.credit_packs      enable row level security;
alter table public.bookings          enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.studio_settings   enable row level security;

create policy "own profile read"   on public.profiles for select using (id = auth.uid() or public.is_admin());
create policy "own profile update" on public.profiles for update using (id = auth.uid());

-- LESSON: an RLS policy restricts ROWS, never COLUMNS, and Supabase grants
-- `authenticated` full UPDATE on public tables by default. Without the two
-- lines below, any signed-in client could PATCH their own row with
-- {"is_admin": true} and take over the studio.
revoke update on public.profiles from anon, authenticated;
grant  update (full_name) on public.profiles to authenticated;

create policy "schedule public read" on public.classes for select using (true);
create policy "classes admin write"  on public.classes for all
  using (public.is_admin()) with check (public.is_admin());

create policy "template admin"       on public.class_template for all
  using (public.is_admin()) with check (public.is_admin());

create policy "settings read"        on public.studio_settings for select using (true);
create policy "settings admin write" on public.studio_settings for update
  using (public.is_admin()) with check (public.is_admin());

create policy "own packs read"       on public.credit_packs for select
  using (user_id = auth.uid() or public.is_admin());
create policy "packs admin write"    on public.credit_packs for all
  using (public.is_admin()) with check (public.is_admin());

create policy "own bookings read"    on public.bookings for select
  using (user_id = auth.uid() or public.is_admin());
create policy "bookings admin update" on public.bookings for update
  using (public.is_admin()) with check (public.is_admin());

create policy "own subs select" on public.push_subscriptions for select using (user_id = auth.uid());
create policy "own subs insert" on public.push_subscriptions for insert with check (user_id = auth.uid());
create policy "own subs update" on public.push_subscriptions for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own subs delete" on public.push_subscriptions for delete using (user_id = auth.uid());

-- ============================================================
-- 10. CLIENT DIRECTORY (admin) — who to grant a pack to
-- ============================================================
create view public.client_directory
with (security_invoker = on) as
select p.id, p.full_name, p.phone, p.is_admin, p.created_at,
       coalesce((select sum(pb.remaining) from public.pack_balance pb
                 where pb.user_id = p.id and pb.is_active and pb.remaining > 0), 0) as active_remaining,
       (select min(pb.valid_until) from public.pack_balance pb
        where pb.user_id = p.id and pb.is_active and pb.remaining > 0) as next_expiry
from public.profiles p;

revoke all on public.client_directory from anon;
grant select on public.client_directory to authenticated;

-- ============================================================
-- 11. BOOKING
-- ============================================================

-- Capacity and credits in one transaction.
--
-- LOCK ORDER: the class row first, then the caller's packs. Every writer takes
-- them in this order, which is what keeps two people racing for the last spot
-- (or one person double-tapping) from both succeeding.
create or replace function public.book_class(p_class_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_cap int; v_status text; v_date date; v_time time;
  v_taken int; v_pack uuid; v_id uuid;
  v_now timestamp := public.studio_now();
begin
  if v_user is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select capacity, status, class_date, start_time
    into v_cap, v_status, v_date, v_time
  from public.classes where id = p_class_id for update;

  if not found then return json_build_object('ok', false, 'error', 'class_not_found'); end if;
  if v_status <> 'open' then return json_build_object('ok', false, 'error', 'class_cancelled'); end if;
  if (v_date + v_time) < v_now then return json_build_object('ok', false, 'error', 'class_past'); end if;

  if exists (select 1 from public.bookings
             where class_id = p_class_id and user_id = v_user and status <> 'cancelled') then
    return json_build_object('ok', false, 'error', 'already_booked');
  end if;

  select count(*) into v_taken
  from public.bookings where class_id = p_class_id and status <> 'cancelled';

  if v_taken >= v_cap then
    return json_build_object('ok', false, 'error', 'class_full');
  end if;

  -- Serialise this client's own credit spending. Without it, two devices could
  -- each read the same last remaining session and both book.
  perform 1 from public.credit_packs where user_id = v_user for update;

  -- Spend from the pack that expires soonest, so credits are never stranded.
  select p.id into v_pack
  from public.credit_packs p
  where p.user_id = v_user
    and p.valid_from <= v_now::date
    and p.valid_until >= v_now::date
    and p.sessions_total > (select count(*) from public.bookings b
                            where b.pack_id = p.id and b.consumes_credit)
  order by p.valid_until, p.created_at
  limit 1;

  if v_pack is null then
    return json_build_object('ok', false, 'error', 'no_credits');
  end if;

  insert into public.bookings (class_id, user_id, pack_id)
  values (p_class_id, v_user, v_pack)
  returning id into v_id;

  return json_build_object('ok', true, 'booking_id', v_id, 'spots_left', v_cap - v_taken - 1);
exception when unique_violation then
  return json_build_object('ok', false, 'error', 'already_booked');
end $$;

-- Cancel my own spot. Early enough -> the session returns to the pack; too late
-- -> it is spent, because nobody else can fill the place at that point.
create or replace function public.cancel_my_booking(p_booking_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_when timestamp; v_cut int; v_early boolean;
  v_now timestamp := public.studio_now();
begin
  if v_user is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select (c.class_date + c.start_time) into v_when
  from public.bookings b join public.classes c on c.id = b.class_id
  where b.id = p_booking_id and b.user_id = v_user and b.status = 'booked';

  if not found then
    return json_build_object('ok', false, 'error', 'not_found_or_not_yours');
  end if;

  select cancel_cutoff_hours into v_cut from public.studio_settings;
  v_early := v_when - make_interval(hours => v_cut) > v_now;

  update public.bookings
     set status = 'cancelled',
         cancelled_at = now(),
         consumes_credit = not v_early
   where id = p_booking_id;

  return json_build_object('ok', true, 'refunded', v_early, 'cutoff_hours', v_cut);
end $$;

grant execute on function public.book_class(uuid) to authenticated;
grant execute on function public.cancel_my_booking(uuid) to authenticated;
revoke execute on function public.book_class(uuid) from anon;
revoke execute on function public.cancel_my_booking(uuid) from anon;

-- ============================================================
-- 12. ADMIN
-- ============================================================

-- Sell a pack: "300 ILS -> 8 sessions for 1 month".
create or replace function public.admin_grant_pack(
  p_user_id uuid, p_sessions int, p_months int default 1,
  p_price numeric default null, p_note text default null
) returns json language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_from date := public.studio_today();
begin
  if not public.is_admin() then return json_build_object('ok', false, 'error', 'not_admin'); end if;
  if p_sessions is null or p_sessions < 1 or p_sessions > 60 then
    return json_build_object('ok', false, 'error', 'invalid_sessions');
  end if;
  if p_months is null or p_months < 1 or p_months > 12 then
    return json_build_object('ok', false, 'error', 'invalid_months');
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    return json_build_object('ok', false, 'error', 'client_not_found');
  end if;

  insert into public.credit_packs
    (user_id, sessions_total, valid_from, valid_until, price_ils, note, granted_by)
  values
    (p_user_id, p_sessions, v_from,
     (v_from + make_interval(months => p_months))::date - 1,
     p_price, p_note, auth.uid())
  returning id into v_id;

  return json_build_object('ok', true, 'pack_id', v_id);
end $$;

-- Add a one-off class outside the weekly template.
create or replace function public.admin_add_class(
  p_date date, p_time time, p_capacity int default null,
  p_label text default null, p_duration int default 55
) returns json language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_cap int;
begin
  if not public.is_admin() then return json_build_object('ok', false, 'error', 'not_admin'); end if;
  if p_date is null or p_time is null then return json_build_object('ok', false, 'error', 'invalid_input'); end if;
  if p_date < public.studio_today() then return json_build_object('ok', false, 'error', 'date_in_past'); end if;

  select coalesce(p_capacity, default_capacity) into v_cap from public.studio_settings;
  if v_cap < 1 or v_cap > 30 then return json_build_object('ok', false, 'error', 'invalid_capacity'); end if;

  insert into public.classes (class_date, start_time, duration_min, capacity, label)
  values (p_date, p_time, coalesce(p_duration, 55), v_cap, p_label)
  returning id into v_id;

  return json_build_object('ok', true, 'class_id', v_id);
exception when unique_violation then
  return json_build_object('ok', false, 'error', 'class_exists');
end $$;

-- Call off a class: everyone gets their session back regardless of timing,
-- because the cancellation is the studio's, not theirs.
create or replace function public.admin_cancel_class(p_class_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare v_freed int;
begin
  if not public.is_admin() then return json_build_object('ok', false, 'error', 'not_admin'); end if;

  update public.bookings
     set status = 'cancelled', cancelled_at = now(), consumes_credit = false
   where class_id = p_class_id and status = 'booked';
  get diagnostics v_freed = row_count;

  update public.classes set status = 'cancelled' where id = p_class_id;
  if not found then return json_build_object('ok', false, 'error', 'class_not_found'); end if;

  return json_build_object('ok', true, 'refunded', v_freed);
end $$;

-- Remove one person from a class (they phoned, or did not pay).
create or replace function public.admin_cancel_booking(p_booking_id uuid, p_refund boolean default true)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return json_build_object('ok', false, 'error', 'not_admin'); end if;

  update public.bookings
     set status = 'cancelled', cancelled_at = now(), consumes_credit = not p_refund
   where id = p_booking_id and status <> 'cancelled';

  if not found then return json_build_object('ok', false, 'error', 'not_found_or_not_yours'); end if;
  return json_build_object('ok', true, 'refunded', p_refund);
end $$;

-- A booking taken at the door or over Instagram: no account, no credit pack.
create or replace function public.admin_book_guest(
  p_class_id uuid, p_name text, p_phone text default null, p_note text default null
) returns json language plpgsql security definer set search_path = public as $$
declare v_cap int; v_status text; v_taken int; v_id uuid;
begin
  if not public.is_admin() then return json_build_object('ok', false, 'error', 'not_admin'); end if;
  if p_name is null or length(btrim(p_name)) < 2 then
    return json_build_object('ok', false, 'error', 'invalid_name');
  end if;

  select capacity, status into v_cap, v_status
  from public.classes where id = p_class_id for update;
  if not found then return json_build_object('ok', false, 'error', 'class_not_found'); end if;
  if v_status <> 'open' then return json_build_object('ok', false, 'error', 'class_cancelled'); end if;

  select count(*) into v_taken from public.bookings where class_id = p_class_id and status <> 'cancelled';
  if v_taken >= v_cap then return json_build_object('ok', false, 'error', 'class_full'); end if;

  -- consumes_credit = false: there is no pack behind a guest booking, and a
  -- true value here would silently deduct from nobody.
  insert into public.bookings (class_id, user_id, pack_id, guest_name, guest_phone, note, consumes_credit)
  values (p_class_id, null, null, btrim(p_name),
          nullif(btrim(coalesce(p_phone, '')), ''), p_note, false)
  returning id into v_id;

  return json_build_object('ok', true, 'booking_id', v_id);
end $$;

create or replace function public.admin_set_attendance(p_booking_id uuid, p_status text)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then return json_build_object('ok', false, 'error', 'not_admin'); end if;
  if p_status not in ('booked','attended','no_show') then
    return json_build_object('ok', false, 'error', 'invalid_status');
  end if;
  update public.bookings set status = p_status where id = p_booking_id and status <> 'cancelled';
  if not found then return json_build_object('ok', false, 'error', 'not_found_or_not_yours'); end if;
  return json_build_object('ok', true);
end $$;

revoke execute on function public.admin_grant_pack(uuid, int, int, numeric, text) from anon;
revoke execute on function public.admin_add_class(date, time, int, text, int) from anon;
revoke execute on function public.admin_cancel_class(uuid) from anon;
revoke execute on function public.admin_cancel_booking(uuid, boolean) from anon;
revoke execute on function public.admin_book_guest(uuid, text, text, text) from anon;
revoke execute on function public.admin_set_attendance(uuid, text) from anon;

-- ============================================================
-- 13. SCHEDULE GENERATION
-- ============================================================
-- LESSON: revoked from PUBLIC, not just anon. Postgres grants EXECUTE on new
-- functions to PUBLIC by default, and a security-definer generator left open
-- lets anyone POST to /rpc/ and flood the table. The parameter is clamped too.
create or replace function public.generate_classes(p_weeks int default null)
returns int language plpgsql security definer set search_path = public as $$
declare v_count int; v_weeks int; v_today date := public.studio_today();
begin
  select coalesce(p_weeks, weeks_ahead) into v_weeks from public.studio_settings;
  v_weeks := least(greatest(v_weeks, 1), 12);

  insert into public.classes (class_date, start_time, duration_min, capacity, label)
  select d::date, t.start_time, t.duration_min, t.capacity, t.label
  from generate_series(v_today, v_today + (v_weeks * 7), interval '1 day') d
  -- extract(dow) is 0=Sunday, matching class_template.weekday. (isodow is
  -- 1=Mon..7=Sun — mixing the two silently shifts the whole timetable.)
  join public.class_template t on t.weekday = extract(dow from d)::int
  where t.active
  on conflict (class_date, start_time) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke execute on function public.generate_classes(int) from public, anon, authenticated;

-- ============================================================
-- 14. ACCOUNT DELETION (anonymising)
-- ============================================================
-- Personal data is destroyed; the studio's attendance history survives without
-- an owner. LESSON: both statements are scoped to FUTURE classes. An unscoped
-- version cancels every class the person ever attended and erases the history
-- it was meant to protect.
create or replace function public.delete_my_account()
returns json language plpgsql security definer set search_path = public as $$
declare v_user uuid := auth.uid(); v_now timestamp := public.studio_now(); v_freed int := 0;
begin
  if v_user is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  update public.bookings b
     set status = 'cancelled', cancelled_at = now(), consumes_credit = false
    from public.classes c
   where c.id = b.class_id
     and b.user_id = v_user
     and b.status = 'booked'
     and (c.class_date + c.start_time) >= v_now;
  get diagnostics v_freed = row_count;

  -- Free text and live links go from every booking they ever made; the class,
  -- date and attendance stay.
  update public.bookings
     set note = null, guest_name = null, guest_phone = null,
         confirm_token = gen_random_uuid(), customer_response = null
   where user_id = v_user;

  -- Cascades profiles, credit_packs and push_subscriptions; bookings.user_id
  -- becomes NULL via ON DELETE SET NULL.
  delete from auth.users where id = v_user;

  return json_build_object('ok', true, 'released', v_freed);
end $$;

revoke execute on function public.delete_my_account() from anon;
grant execute on function public.delete_my_account() to authenticated;

-- ============================================================
-- 15. REALTIME
-- ============================================================
-- LESSON: a fresh project publishes no tables, so postgres_changes
-- subscriptions connect happily and then never deliver an event.
do $$ begin alter publication supabase_realtime add table public.classes;
exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.bookings;
exception when duplicate_object then null; end $$;

-- ============================================================
-- 16. STARTER TIMETABLE  — EDIT THIS to match the real schedule
-- ============================================================
insert into public.class_template (weekday, start_time, capacity, label) values
  (0, '08:00', 8, 'Reformer'),   -- Sunday
  (0, '18:00', 8, 'Reformer'),
  (0, '19:15', 8, 'Mat'),
  (2, '08:00', 8, 'Reformer'),   -- Tuesday
  (2, '18:00', 8, 'Reformer'),
  (2, '19:15', 8, 'Mat'),
  (4, '08:00', 8, 'Reformer'),   -- Thursday
  (4, '18:00', 8, 'Reformer'),
  (4, '19:15', 8, 'Mat');

select public.generate_classes();

-- Roll the horizon forward daily. LESSON: a weekly cron leaves the last
-- visible week empty for days at a time; daily generation always stays ahead.
create extension if not exists pg_cron;
select cron.schedule('roll-classes-daily', '0 3 * * *', $$select public.generate_classes()$$);

notify pgrst, 'reload schema';



-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>> supabase_patch_v1_1.sql <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

-- ============================================================
-- RUDEEN PILATES — patch v1.1: plans catalogue + purchase requests
-- Run AFTER supabase_setup.sql. Safe to re-run.
--
-- The studio still takes money outside the app (Bit / cash). A client picks a
-- plan and sends a purchase request; the admin approves once paid, and the
-- approval itself opens the credit pack — one tap, no retyping numbers.
-- ============================================================

-- ---------- 0. studio contact for purchase messages ----------
alter table public.studio_settings add column if not exists whatsapp_phone text;

-- ---------- 1. plans (what is for sale) ----------
create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  sessions int not null check (sessions between 1 and 60),        -- same ceiling as admin_grant_pack
  valid_months int not null default 1 check (valid_months between 1 and 12),
  price_ils numeric(8,2) not null check (price_ils >= 0),
  payment_url text,                                                 -- optional Bit / PayBox / Grow link
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.plans enable row level security;
drop policy if exists "plans read" on public.plans;
create policy "plans read" on public.plans for select using (active or public.is_admin());
drop policy if exists "plans admin write" on public.plans;
create policy "plans admin write" on public.plans for all
  using (public.is_admin()) with check (public.is_admin());

-- ---------- 2. purchase requests ----------
-- Plan fields are SNAPSHOTTED onto the request: the admin can reprice a plan
-- tomorrow without changing what a client asked for today.
create table if not exists public.purchase_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  plan_id uuid references public.plans(id) on delete set null,
  plan_name text not null,
  sessions int not null,
  valid_months int not null,
  price_ils numeric(8,2) not null,
  status text not null default 'pending'
    check (status in ('pending','approved','declined','cancelled')),
  client_note text,
  admin_note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references public.profiles(id) on delete set null,
  pack_id uuid references public.credit_packs(id) on delete set null
);
create index if not exists idx_purchase_pending on public.purchase_requests(created_at) where status = 'pending';
alter table public.purchase_requests enable row level security;
drop policy if exists "requests own read" on public.purchase_requests;
create policy "requests own read" on public.purchase_requests for select
  using (user_id = auth.uid() or public.is_admin());
-- every write goes through the RPCs below
revoke insert, update, delete on public.purchase_requests from anon, authenticated;

-- Admin board with the client's name and phone. security_invoker: RLS on the
-- two tables decides who sees what (a client sees only their own rows).
drop view if exists public.purchase_board;
create view public.purchase_board with (security_invoker = on) as
select r.id, r.user_id, r.plan_id, r.plan_name, r.sessions, r.valid_months, r.price_ils,
       r.status, r.client_note, r.admin_note, r.created_at, r.decided_at,
       p.full_name as client_name, p.phone as client_phone
from public.purchase_requests r
left join public.profiles p on p.id = r.user_id;
revoke all on public.purchase_board from anon;
grant select on public.purchase_board to authenticated;

-- ---------- 3. RPCs ----------
create or replace function public.request_purchase(p_plan_id uuid, p_note text default null)
returns json language plpgsql security definer set search_path = public as $$
declare v_user uuid := auth.uid(); v_plan public.plans%rowtype; v_id uuid;
begin
  if v_user is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select * into v_plan from public.plans where id = p_plan_id and active;
  if not found then return json_build_object('ok', false, 'error', 'plan_not_found'); end if;
  if exists (select 1 from public.purchase_requests
              where user_id = v_user and plan_id = p_plan_id and status = 'pending') then
    return json_build_object('ok', false, 'error', 'request_pending');
  end if;

  insert into public.purchase_requests
    (user_id, plan_id, plan_name, sessions, valid_months, price_ils, client_note)
  values
    (v_user, v_plan.id, v_plan.name, v_plan.sessions, v_plan.valid_months, v_plan.price_ils,
     nullif(btrim(coalesce(p_note, '')), ''))
  returning id into v_id;
  return json_build_object('ok', true, 'request_id', v_id);
end $$;
revoke execute on function public.request_purchase(uuid, text) from anon;

create or replace function public.cancel_purchase_request(p_id uuid)
returns json language plpgsql security definer set search_path = public as $$
begin
  update public.purchase_requests
     set status = 'cancelled', decided_at = now()
   where id = p_id and user_id = auth.uid() and status = 'pending';
  if not found then return json_build_object('ok', false, 'error', 'not_found_or_not_yours'); end if;
  return json_build_object('ok', true);
end $$;
revoke execute on function public.cancel_purchase_request(uuid) from anon;

-- Approve = open the pack from the snapshot, in one transaction with the
-- status change, so a request can never be approved twice or approved
-- without a pack.
create or replace function public.admin_decide_purchase(p_id uuid, p_approve boolean, p_note text default null)
returns json language plpgsql security definer set search_path = public as $$
declare v_req public.purchase_requests%rowtype; v_pack uuid; v_from date := public.studio_today();
begin
  if not public.is_admin() then return json_build_object('ok', false, 'error', 'not_admin'); end if;
  select * into v_req from public.purchase_requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'request_not_found'); end if;
  if v_req.status <> 'pending' then return json_build_object('ok', false, 'error', 'request_not_pending'); end if;

  if p_approve then
    insert into public.credit_packs
      (user_id, sessions_total, valid_from, valid_until, price_ils, note, granted_by)
    values
      (v_req.user_id, v_req.sessions, v_from,
       (v_from + make_interval(months => v_req.valid_months))::date - 1,
       v_req.price_ils, v_req.plan_name, auth.uid())
    returning id into v_pack;
  end if;

  update public.purchase_requests
     set status = case when p_approve then 'approved' else 'declined' end,
         decided_at = now(), decided_by = auth.uid(),
         admin_note = nullif(btrim(coalesce(p_note, '')), ''), pack_id = v_pack
   where id = p_id;
  return json_build_object('ok', true, 'pack_id', v_pack);
end $$;
revoke execute on function public.admin_decide_purchase(uuid, boolean, text) from anon;

-- ---------- 4. realtime ----------
do $$ begin alter publication supabase_realtime add table public.purchase_requests;
exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.plans;
exception when duplicate_object then null; end $$;

-- ---------- 5. starter catalogue — EDIT in the admin app, מוצרים tab ----------
insert into public.plans (name, sessions, valid_months, price_ils, sort_order)
select * from (values
  ('שיעור בודד',          1, 1,  65, 1),
  ('כרטיסייה 4 שיעורים',  4, 1, 160, 2),
  ('כרטיסייה 8 שיעורים',  8, 1, 300, 3),
  ('כרטיסייה 12 שיעורים', 12, 1, 420, 4)
) v(name, sessions, valid_months, price_ils, sort_order)
where not exists (select 1 from public.plans);

notify pgrst, 'reload schema';



-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>> supabase_patch_v1_2.sql <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

-- ============================================================
-- RUDEEN PILATES — patch v1.2: notification center
-- Run AFTER supabase_patch_v1_1.sql. Safe to re-run.
--
-- One table, two kinds of row: user_id = NULL is an announcement everybody
-- sees; user_id set is personal. Rows store a `kind` and structured `data`,
-- never prose — the app renders the text in the reader's language.
-- "Seen" is a single timestamp on the profile, not a row per notification.
-- ============================================================

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,   -- NULL = everyone
  kind text not null check (kind in (
    'announcement', 'purchase_approved', 'purchase_declined',
    'class_cancelled', 'booking_removed', 'pack_granted')),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null
);
create index if not exists idx_notif_user on public.notifications(user_id, created_at desc);
create index if not exists idx_notif_broadcast on public.notifications(created_at desc) where user_id is null;

alter table public.notifications enable row level security;
drop policy if exists "notifications read" on public.notifications;
create policy "notifications read" on public.notifications for select
  using (user_id is null or user_id = auth.uid() or public.is_admin());
-- admins write announcements directly; personal rows come only from the RPCs
drop policy if exists "announcements admin insert" on public.notifications;
create policy "announcements admin insert" on public.notifications for insert
  with check (public.is_admin() and user_id is null and kind = 'announcement');
drop policy if exists "notifications admin delete" on public.notifications;
create policy "notifications admin delete" on public.notifications for delete
  using (public.is_admin());
revoke update on public.notifications from anon, authenticated;

alter table public.profiles add column if not exists notifications_seen_at timestamptz;
grant update (notifications_seen_at) on public.profiles to authenticated;

-- Internal helper. Revoked from everyone; the security-definer RPCs below run
-- as the owner and can still call it. A NULL user (guest booking) is a no-op.
create or replace function public.notify_user(p_user uuid, p_kind text, p_data jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, kind, data, created_by)
  select p_user, p_kind, coalesce(p_data, '{}'::jsonb), auth.uid()
  where p_user is not null;
$$;
revoke execute on function public.notify_user(uuid, text, jsonb) from public, anon, authenticated;

-- ---------- RPCs re-created with notifications ----------

create or replace function public.admin_grant_pack(
  p_user_id uuid, p_sessions int, p_months int default 1,
  p_price numeric default null, p_note text default null
) returns json language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_from date := public.studio_today(); v_until date;
begin
  if not public.is_admin() then return json_build_object('ok', false, 'error', 'not_admin'); end if;
  if p_sessions is null or p_sessions < 1 or p_sessions > 60 then
    return json_build_object('ok', false, 'error', 'invalid_sessions');
  end if;
  if p_months is null or p_months < 1 or p_months > 12 then
    return json_build_object('ok', false, 'error', 'invalid_months');
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    return json_build_object('ok', false, 'error', 'client_not_found');
  end if;

  v_until := (v_from + make_interval(months => p_months))::date - 1;
  insert into public.credit_packs
    (user_id, sessions_total, valid_from, valid_until, price_ils, note, granted_by)
  values (p_user_id, p_sessions, v_from, v_until, p_price, p_note, auth.uid())
  returning id into v_id;

  perform public.notify_user(p_user_id, 'pack_granted',
    jsonb_build_object('sessions', p_sessions, 'valid_until', v_until, 'note', p_note));
  return json_build_object('ok', true, 'pack_id', v_id);
end $$;

create or replace function public.admin_decide_purchase(p_id uuid, p_approve boolean, p_note text default null)
returns json language plpgsql security definer set search_path = public as $$
declare v_req public.purchase_requests%rowtype; v_pack uuid;
        v_from date := public.studio_today(); v_until date; v_note text;
begin
  if not public.is_admin() then return json_build_object('ok', false, 'error', 'not_admin'); end if;
  select * into v_req from public.purchase_requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'request_not_found'); end if;
  if v_req.status <> 'pending' then return json_build_object('ok', false, 'error', 'request_not_pending'); end if;
  v_note := nullif(btrim(coalesce(p_note, '')), '');

  if p_approve then
    v_until := (v_from + make_interval(months => v_req.valid_months))::date - 1;
    insert into public.credit_packs
      (user_id, sessions_total, valid_from, valid_until, price_ils, note, granted_by)
    values (v_req.user_id, v_req.sessions, v_from, v_until, v_req.price_ils, v_req.plan_name, auth.uid())
    returning id into v_pack;
  end if;

  update public.purchase_requests
     set status = case when p_approve then 'approved' else 'declined' end,
         decided_at = now(), decided_by = auth.uid(), admin_note = v_note, pack_id = v_pack
   where id = p_id;

  perform public.notify_user(v_req.user_id,
    case when p_approve then 'purchase_approved' else 'purchase_declined' end,
    jsonb_build_object('plan_name', v_req.plan_name, 'sessions', v_req.sessions,
                       'valid_until', v_until, 'admin_note', v_note));
  return json_build_object('ok', true, 'pack_id', v_pack);
end $$;

create or replace function public.admin_cancel_class(p_class_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare v_freed int; v_date date; v_time time; v_label text;
begin
  if not public.is_admin() then return json_build_object('ok', false, 'error', 'not_admin'); end if;
  select class_date, start_time, label into v_date, v_time, v_label from public.classes where id = p_class_id;
  if not found then return json_build_object('ok', false, 'error', 'class_not_found'); end if;

  -- tell every affected client, before the rows change
  perform public.notify_user(b.user_id, 'class_cancelled',
    jsonb_build_object('class_date', v_date, 'start_time', v_time, 'label', v_label, 'refunded', true))
  from public.bookings b
  where b.class_id = p_class_id and b.status = 'booked' and b.user_id is not null;

  update public.bookings
     set status = 'cancelled', cancelled_at = now(), consumes_credit = false
   where class_id = p_class_id and status = 'booked';
  get diagnostics v_freed = row_count;

  update public.classes set status = 'cancelled' where id = p_class_id;
  return json_build_object('ok', true, 'refunded', v_freed);
end $$;

create or replace function public.admin_cancel_booking(p_booking_id uuid, p_refund boolean default true)
returns json language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_date date; v_time time; v_label text;
begin
  if not public.is_admin() then return json_build_object('ok', false, 'error', 'not_admin'); end if;

  select b.user_id, c.class_date, c.start_time, c.label into v_user, v_date, v_time, v_label
    from public.bookings b join public.classes c on c.id = b.class_id
   where b.id = p_booking_id and b.status <> 'cancelled';
  if not found then return json_build_object('ok', false, 'error', 'not_found_or_not_yours'); end if;

  update public.bookings
     set status = 'cancelled', cancelled_at = now(), consumes_credit = not p_refund
   where id = p_booking_id;

  perform public.notify_user(v_user, 'booking_removed',
    jsonb_build_object('class_date', v_date, 'start_time', v_time, 'label', v_label, 'refunded', p_refund));
  return json_build_object('ok', true, 'refunded', p_refund);
end $$;

do $$ begin alter publication supabase_realtime add table public.notifications;
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';



-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>> supabase_patch_v1_3.sql <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

-- ============================================================
-- RUDEEN PILATES — patch v1.3: push for clients (web + native)
-- Run AFTER supabase_patch_v1_2.sql. Safe to re-run.
--
-- One table for every device: kind 'web' rows carry a VAPID endpoint + keys;
-- 'apns' / 'fcm' rows carry the native token in `endpoint` as
-- '<kind>:<token>' with the key columns NULL. `lang` is the language the
-- push copy is rendered in for that device.
-- ============================================================

alter table public.push_subscriptions
  add column if not exists kind text not null default 'web' check (kind in ('web', 'apns', 'fcm')),
  add column if not exists lang text not null default 'he' check (lang in ('he', 'ar')),
  add column if not exists updated_at timestamptz not null default now();
alter table public.push_subscriptions alter column p256dh drop not null;
alter table public.push_subscriptions alter column auth drop not null;

-- A device belongs to whoever is signed in on it NOW. A plain upsert cannot
-- move a row between users under RLS, so the write goes through a definer RPC.
create or replace function public.save_push_subscription(
  p_endpoint text, p_kind text, p_p256dh text, p_auth text, p_lang text
) returns json language plpgsql security definer set search_path = public as $$
declare v_user uuid := auth.uid();
begin
  if v_user is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if p_kind not in ('web', 'apns', 'fcm') or p_endpoint is null or length(p_endpoint) < 8 then
    return json_build_object('ok', false, 'error', 'invalid_input');
  end if;
  insert into public.push_subscriptions (user_id, endpoint, kind, p256dh, auth, lang)
  values (v_user, p_endpoint, p_kind, p_p256dh, p_auth,
          case when p_lang in ('he', 'ar') then p_lang else 'he' end)
  on conflict (endpoint) do update
    set user_id = v_user, kind = excluded.kind, p256dh = excluded.p256dh,
        auth = excluded.auth, lang = excluded.lang, updated_at = now();
  return json_build_object('ok', true);
end $$;
revoke execute on function public.save_push_subscription(text, text, text, text, text) from anon;

-- Called on sign-out so the next person on this phone does not get the
-- previous person's notifications.
create or replace function public.delete_push_subscription(p_endpoint text)
returns json language plpgsql security definer set search_path = public as $$
begin
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
  return json_build_object('ok', true);
end $$;
revoke execute on function public.delete_push_subscription(text) from anon;

notify pgrst, 'reload schema';



-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>> supabase_patch_v1_4.sql <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

-- ============================================================
-- RUDEEN PILATES — patch v1.4: health questionnaire + signed declaration
-- Run AFTER supabase_patch_v1_3.sql. Safe to re-run.
--
-- Health data. Rules that follow from that:
--   * its own table, readable only by the client who wrote it and admins
--   * submissions are IMMUTABLE — a client "updates" by submitting again, the
--     latest row is the active one, history stays
--   * inserted only through an RPC (validated, user_id forced to auth.uid())
--   * cascades away with the profile on account deletion
--   * the declaration is a condition of training: book_class refuses until a
--     form exists, so the rule cannot be bypassed by skipping the UI
-- ============================================================

alter table public.profiles add column if not exists health_form_at timestamptz;

create table if not exists public.health_forms (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  form_version int not null default 1,
  lang text not null default 'he' check (lang in ('he', 'ar')),   -- the language the client read the declaration in
  answers jsonb not null,
  flags text[] not null default '{}',                            -- computed summary for the admin marker
  consent_name text not null,
  signature_png text,                                             -- data URL of the drawn signature
  submitted_at timestamptz not null default now()
);
create index if not exists idx_health_user on public.health_forms(user_id, submitted_at desc);
alter table public.health_forms enable row level security;
drop policy if exists "health own read" on public.health_forms;
create policy "health own read" on public.health_forms for select
  using (user_id = auth.uid() or public.is_admin());
revoke insert, update, delete on public.health_forms from anon, authenticated;

create or replace function public.submit_health_form(
  p_answers jsonb, p_flags text[], p_consent_name text, p_signature_png text, p_lang text
) returns json language plpgsql security definer set search_path = public as $$
declare v_user uuid := auth.uid(); v_id uuid;
begin
  if v_user is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    return json_build_object('ok', false, 'error', 'invalid_input');
  end if;
  if p_consent_name is null or length(btrim(p_consent_name)) < 2 then
    return json_build_object('ok', false, 'error', 'invalid_name');
  end if;
  if p_signature_png is null or p_signature_png not like 'data:image/png;base64,%' or length(p_signature_png) > 300000 then
    return json_build_object('ok', false, 'error', 'invalid_input');
  end if;

  insert into public.health_forms (user_id, lang, answers, flags, consent_name, signature_png)
  values (v_user, case when p_lang in ('he', 'ar') then p_lang else 'he' end,
          p_answers, coalesce(p_flags, '{}'), btrim(p_consent_name), p_signature_png)
  returning id into v_id;
  update public.profiles set health_form_at = now() where id = v_user;
  return json_build_object('ok', true, 'form_id', v_id);
end $$;
revoke execute on function public.submit_health_form(jsonb, text[], text, text, text) from anon;

-- ---------- booking requires a declaration on file ----------
create or replace function public.book_class(p_class_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_cap int; v_status text; v_date date; v_time time;
  v_taken int; v_pack uuid; v_id uuid;
  v_now timestamp := public.studio_now();
begin
  if v_user is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  -- LESSON-free but deliberate: the health declaration is a condition of
  -- training, so the rule lives here, not only in the UI.
  if not exists (select 1 from public.health_forms where user_id = v_user) then
    return json_build_object('ok', false, 'error', 'health_form_required');
  end if;

  select capacity, status, class_date, start_time
    into v_cap, v_status, v_date, v_time
  from public.classes where id = p_class_id for update;

  if not found then return json_build_object('ok', false, 'error', 'class_not_found'); end if;
  if v_status <> 'open' then return json_build_object('ok', false, 'error', 'class_cancelled'); end if;
  if (v_date + v_time) < v_now then return json_build_object('ok', false, 'error', 'class_past'); end if;

  if exists (select 1 from public.bookings
             where class_id = p_class_id and user_id = v_user and status <> 'cancelled') then
    return json_build_object('ok', false, 'error', 'already_booked');
  end if;

  select count(*) into v_taken
  from public.bookings where class_id = p_class_id and status <> 'cancelled';

  if v_taken >= v_cap then
    return json_build_object('ok', false, 'error', 'class_full');
  end if;

  -- Serialise this client's own credit spending. Without it, two devices could
  -- each read the same last remaining session and both book.
  perform 1 from public.credit_packs where user_id = v_user for update;

  -- Spend from the pack that expires soonest, so credits are never stranded.
  select p.id into v_pack
  from public.credit_packs p
  where p.user_id = v_user
    and p.valid_from <= v_now::date
    and p.valid_until >= v_now::date
    and p.sessions_total > (select count(*) from public.bookings b
                            where b.pack_id = p.id and b.consumes_credit)
  order by p.valid_until, p.created_at
  limit 1;

  if v_pack is null then
    return json_build_object('ok', false, 'error', 'no_credits');
  end if;

  insert into public.bookings (class_id, user_id, pack_id)
  values (p_class_id, v_user, v_pack)
  returning id into v_id;

  return json_build_object('ok', true, 'booking_id', v_id, 'spots_left', v_cap - v_taken - 1);
exception when unique_violation then
  return json_build_object('ok', false, 'error', 'already_booked');
end $$;

-- ---------- admin views carry the health marker ----------
-- Column lists change, so drop + create (and re-apply the grants: a fresh
-- view picks up Supabase's default grant to anon).
drop view if exists public.class_roster;
create view public.class_roster
with (security_invoker = on) as
select b.id as booking_id, b.class_id, c.class_date, c.start_time, c.label,
       coalesce(p.full_name, b.guest_name) as attendee_name,
       coalesce(p.phone, b.guest_phone)    as attendee_phone,
       b.status, b.note, b.confirm_token,
       b.reminder_sent_at, b.customer_response, b.responded_at,
       (b.user_id is null) as is_manual,
       b.user_id,
       h.flags as health_flags, h.submitted_at as health_form_at
from public.bookings b
join public.classes c on c.id = b.class_id
left join public.profiles p on p.id = b.user_id
left join lateral (
  select flags, submitted_at from public.health_forms hf
  where hf.user_id = b.user_id order by hf.submitted_at desc limit 1
) h on true
where b.status <> 'cancelled';
revoke all on public.class_roster from anon;
grant select on public.class_roster to authenticated;

drop view if exists public.client_directory;
create view public.client_directory
with (security_invoker = on) as
select p.id, p.full_name, p.phone, p.is_admin, p.created_at,
       coalesce((select sum(pb.remaining) from public.pack_balance pb
                 where pb.user_id = p.id and pb.is_active and pb.remaining > 0), 0) as active_remaining,
       (select min(pb.valid_until) from public.pack_balance pb
        where pb.user_id = p.id and pb.is_active and pb.remaining > 0) as next_expiry,
       h.flags as health_flags, h.submitted_at as health_form_at
from public.profiles p
left join lateral (
  select flags, submitted_at from public.health_forms hf
  where hf.user_id = p.id order by hf.submitted_at desc limit 1
) h on true;
revoke all on public.client_directory from anon;
grant select on public.client_directory to authenticated;

notify pgrst, 'reload schema';



-- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>> supabase_patch_v1_5.sql <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

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

