-- ============================================================
-- OPTIONAL: push notifications (admins AND clients)
-- Run this AFTER supabase_patch_v1_3.sql and AFTER the `push` edge function
-- is deployed. Replace the three placeholders first.
--
--   <PROJECT_REF>    Supabase → Project Settings → General → Reference ID
--   <ANON_KEY>       Supabase → Project Settings → API → anon public
--   <WEBHOOK_SECRET> any long random string; set the SAME value as a function
--                    secret named WEBHOOK_SECRET (Edge Functions → Secrets)
--
-- Who gets what:
--   bookings insert / status -> cancelled   -> every admin device
--   purchase_requests insert                -> every admin device
--   notifications insert                    -> the client's devices, or
--                                              everyone's for an announcement
-- ============================================================

create extension if not exists pg_net;

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

  perform net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <ANON_KEY>',
      'x-webhook-secret', '<WEBHOOK_SECRET>'
    ),
    body := v_body
  );
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
