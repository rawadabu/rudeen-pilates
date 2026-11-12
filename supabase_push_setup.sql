-- ============================================================
-- OPTIONAL: push notifications (admins AND clients)
-- Run this AFTER supabase_patch_v1_3.sql and AFTER the `push` edge function
-- is deployed. Replace the two placeholders first. Safe to re-run.
--
--   <PROJECT_REF>    Supabase → Project Settings → General → Reference ID
--   <WEBHOOK_SECRET> any long random string; set the SAME value as a function
--                    secret named WEBHOOK_SECRET (Edge Functions → Secrets)
--
-- The `push` function must have "Verify JWT" turned OFF (Edge Functions →
-- push → Details). The database calls it with the webhook secret only, and
-- the function checks that secret itself; with the new publishable keys there
-- is no JWT the database could send.
--
-- Who gets what:
--   bookings insert / status -> cancelled   -> every admin device
--   purchase_requests insert                -> every admin device
--   notifications insert                    -> the client's devices, or
--                                              everyone's for an announcement
--   a class in about an hour (patch v1.6)   -> the booked client's devices
-- ============================================================

create extension if not exists pg_net;

-- The one place that knows where the push function lives and its password.
-- Triggers and the reminder job hand it a JSON event; nothing else may call it.
create or replace function public.push_send(p_body jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', '<WEBHOOK_SECRET>'
    ),
    body := p_body
  );
exception when others then
  -- a notification failure must never break the write that caused it
  null;
end $$;
revoke execute on function public.push_send(jsonb) from public, anon, authenticated;

create or replace function public.push_webhook()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_body jsonb;
begin
  if tg_table_name = 'bookings' then
    if tg_op = 'INSERT' then
      v_body := jsonb_build_object('event', 'booking_created', 'booking_id', new.id);
    elsif new.status = 'cancelled' and old.status <> 'cancelled' then
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

drop trigger if exists booking_notify_insert on public.bookings;
drop trigger if exists booking_notify_cancel on public.bookings;
drop trigger if exists purchase_notify_insert on public.purchase_requests;
drop trigger if exists notification_push on public.notifications;

create trigger booking_notify_insert
  after insert on public.bookings
  for each row execute function public.push_webhook();
-- scoped OF status: an attendance change or a reminder timestamp must not fire
create trigger booking_notify_cancel
  after update of status on public.bookings
  for each row execute function public.push_webhook();
create trigger purchase_notify_insert
  after insert on public.purchase_requests
  for each row execute function public.push_webhook();
create trigger notification_push
  after insert on public.notifications
  for each row execute function public.push_webhook();

notify pgrst, 'reload schema';

-- ---------- check ----------
-- Asks the function which transports are set up. Nothing is sent to anybody.
select public.push_send('{"ping": true}'::jsonb);
-- Wait a few seconds, then run this line on its own:
--   select status_code, content::text from net._http_response order by created desc limit 1;
-- 200 with {"ok":true,"transports":{"web":"ok",...}} = working.
-- 401 = "Verify JWT" is still on for the function. 403 = the secret differs
-- from the function's WEBHOOK_SECRET. 404 = the function is not named `push`.
