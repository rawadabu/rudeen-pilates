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
