-- ============================================================
-- RUDEEN PILATES — patch v1.6: the studio opens subscriptions itself,
-- and a reminder an hour before class
-- Run AFTER supabase_patch_v1_5.sql. Safe to re-run.
--
-- 1. Purchase requests are OFF. Clients asked for a plan in the app, the
--    subscription was opened, and then they did not pay. The studio now opens
--    every subscription by hand once it has the money (admin → clients →
--    grant a pack: unchanged). The switch is
--    studio_settings.purchase_requests_enabled, default false: the app hides
--    the request button and request_purchase refuses while it is off.
--    To allow requests again:
--      update public.studio_settings set purchase_requests_enabled = true;
-- 2. A push reminder about an hour before class, to everyone booked on it:
--    send_class_reminders(), run by cron every 5 minutes. It hands each
--    reminder to push_send() from supabase_push_setup.sql; until that file has
--    been run it finds nothing to call and does nothing.
-- ============================================================

-- ---------- 1. Purchase requests: off unless the studio turns them on ----------
alter table public.studio_settings
  add column if not exists purchase_requests_enabled boolean not null default false;

create or replace function public.request_purchase(p_plan_id uuid, p_note text default null)
returns json language plpgsql security definer set search_path = public as $$
declare v_user uuid := auth.uid(); v_plan public.plans%rowtype; v_id uuid;
begin
  if v_user is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  -- v1.6: the server refuses too — an app that was open before the change
  -- still shows the button until it reloads
  if not coalesce((select purchase_requests_enabled from public.studio_settings), false) then
    return json_build_object('ok', false, 'error', 'requests_disabled');
  end if;
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

-- ---------- 2. A reminder an hour before class ----------
-- Its own column: reminder_sent_at belongs to the manual WhatsApp reminders.
alter table public.bookings
  add column if not exists push_reminded_at timestamptz;

-- Every booking whose class starts 50 to 60 minutes from now and has not been
-- reminded yet. Cron runs this every 5 minutes, so each booking is seen twice:
-- one missed run loses nothing, and push_reminded_at makes a second send
-- impossible. Class times are studio time (studio_now), never UTC.
create or replace function public.send_class_reminders()
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0; v_now timestamp := public.studio_now();
begin
  -- push is optional (supabase_push_setup.sql): without it there is nobody to hand this to
  if to_regprocedure('public.push_send(jsonb)') is null then return 0; end if;

  for r in
    select b.id
      from public.bookings b
      join public.classes c on c.id = b.class_id
     where b.status = 'booked'
       and b.user_id is not null
       and b.push_reminded_at is null
       and c.status = 'open'
       and (c.class_date + c.start_time) >  v_now + interval '50 minutes'
       and (c.class_date + c.start_time) <= v_now + interval '60 minutes'
       -- someone who booked a few minutes ago does not need telling
       and b.created_at < now() - interval '15 minutes'
     for update of b skip locked
  loop
    update public.bookings set push_reminded_at = now() where id = r.id;
    execute 'select public.push_send($1)'
      using jsonb_build_object('event', 'class_reminder', 'booking_id', r.id);
    n := n + 1;
  end loop;
  return n;
end $$;
-- only cron (the database owner) runs it
revoke execute on function public.send_class_reminders() from public, anon, authenticated;

create extension if not exists pg_cron;
do $$
begin
  perform cron.unschedule('class-reminders');
exception when others then
  null;   -- not scheduled yet
end $$;
select cron.schedule('class-reminders', '*/5 * * * *', $$select public.send_class_reminders()$$);

notify pgrst, 'reload schema';
