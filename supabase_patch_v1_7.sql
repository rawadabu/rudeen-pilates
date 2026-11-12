-- ============================================================
-- RUDEEN PILATES — patch v1.7: cancel a whole day
-- Run AFTER supabase_patch_v1_6.sql. Safe to re-run.
--
-- The trainer is ill, or the studio is closed for a day: one button in the
-- admin (schedule → the day's title) cancels every class of that day that has
-- not started yet. It does exactly what cancelling them one by one does:
-- every booked client gets the session back and a notice (and a push, where
-- push is set up). A class that already started is left alone, so nobody is
-- handed back a session they trained in.
--
-- 1. cancel_class_refund(): the one place a class is cancelled.
-- 2. admin_cancel_class(): unchanged for the app (same call, same answer).
-- 3. admin_cancel_day(): new.
-- 4. push_webhook(): the trainer is no longer sent "X cancelled, the place is
--    free again" once per client for a class she cancelled herself.
-- ============================================================

-- ---------- 1. Cancel one class and hand the sessions back ----------
-- Internal: the two admin functions below call it after checking who asks.
-- Returns how many bookings were handed back, or null when there is no such class.
create or replace function public.cancel_class_refund(p_class_id uuid)
returns int language plpgsql security definer set search_path = public as $$
declare v_freed int; v_date date; v_time time; v_label text;
begin
  select class_date, start_time, label into v_date, v_time, v_label
    from public.classes where id = p_class_id for update;
  if not found then return null; end if;

  -- the class first: the push trigger on bookings (push_webhook, below) reads
  -- it to tell "the studio cancelled the class" from "a client cancelled"
  update public.classes set status = 'cancelled' where id = p_class_id;

  -- tell every affected client, before the rows change
  perform public.notify_user(b.user_id, 'class_cancelled',
    jsonb_build_object('class_date', v_date, 'start_time', v_time, 'label', v_label, 'refunded', true))
  from public.bookings b
  where b.class_id = p_class_id and b.status = 'booked' and b.user_id is not null;

  update public.bookings
     set status = 'cancelled', cancelled_at = now(), consumes_credit = false
   where class_id = p_class_id and status = 'booked';
  get diagnostics v_freed = row_count;
  return v_freed;
end $$;
revoke execute on function public.cancel_class_refund(uuid) from public, anon, authenticated;

-- ---------- 2. One class (as before) ----------
create or replace function public.admin_cancel_class(p_class_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare v_freed int;
begin
  if not public.is_admin() then return json_build_object('ok', false, 'error', 'not_admin'); end if;
  v_freed := public.cancel_class_refund(p_class_id);
  if v_freed is null then return json_build_object('ok', false, 'error', 'class_not_found'); end if;
  return json_build_object('ok', true, 'refunded', v_freed);
end $$;
revoke execute on function public.admin_cancel_class(uuid) from anon;

-- ---------- 3. The whole day ----------
-- Only classes that are still open and have not started (studio time, never
-- UTC). Answers how many classes were cancelled and how many bookings were
-- handed back (guests included; they hold no session to return).
create or replace function public.admin_cancel_day(p_date date)
returns json language plpgsql security definer set search_path = public as $$
declare r record; v_classes int := 0; v_freed int := 0; v_now timestamp := public.studio_now();
begin
  if not public.is_admin() then return json_build_object('ok', false, 'error', 'not_admin'); end if;
  if p_date is null then return json_build_object('ok', false, 'error', 'invalid_input'); end if;

  for r in
    select c.id
      from public.classes c
     where c.class_date = p_date
       and c.status = 'open'
       and (c.class_date + c.start_time) > v_now
     order by c.start_time
       for update
  loop
    v_freed := v_freed + coalesce(public.cancel_class_refund(r.id), 0);
    v_classes := v_classes + 1;
  end loop;

  if v_classes = 0 then return json_build_object('ok', false, 'error', 'no_classes_to_cancel'); end if;
  return json_build_object('ok', true, 'classes', v_classes, 'bookings', v_freed);
end $$;
revoke execute on function public.admin_cancel_day(date) from public, anon;
grant execute on function public.admin_cancel_day(date) to authenticated;

-- ---------- 4. Push: no "a client cancelled" for a class the studio cancelled ----------
-- The same function as in supabase_push_setup.sql, plus the one check marked
-- v1.7. Without push it is simply never called (no trigger points at it).
create or replace function public.push_webhook()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_body jsonb;
begin
  if tg_table_name = 'bookings' then
    if tg_op = 'INSERT' then
      v_body := jsonb_build_object('event', 'booking_created', 'booking_id', new.id);
    elsif new.status = 'cancelled' and old.status <> 'cancelled' then
      -- v1.7: the booking went because its class was cancelled. The trainer did
      -- that herself; a day with 30 bookings used to buzz her phone 30 times
      -- with "the place is free again", which was not even true.
      if exists (select 1 from public.classes c where c.id = new.class_id and c.status <> 'open') then
        return new;
      end if;
      v_body := jsonb_build_object('event', 'booking_cancelled', 'booking_id', new.id);
    else
      return new;   -- attendance marking, reminder flags: not events
    end if;
  elsif tg_table_name = 'purchase_requests' then
    v_body := jsonb_build_object('event', 'purchase_request', 'request_id', new.id);
  elsif tg_table_name = 'notifications' then
    v_body := jsonb_build_object('event', 'notification', 'notification_id', new.id);
  else
    return new;
  end if;

  perform public.push_send(v_body);
  return new;
exception when others then
  -- a notification failure must never break the write that caused it
  return new;
end $$;

notify pgrst, 'reload schema';
