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
