-- ============================================================
-- RUDEEN PILATES — patch v1.9: the studio sees who has notifications on
-- Run AFTER supabase_patch_v1_8.sql. Safe to re-run.
--
-- Reminders and announcements only pop up on a phone that allowed
-- notifications. The admin's client list gets a bell per client (on / off), so
-- the studio knows whom to ask. The app side of this patch also asks each
-- client right after a booking; that needs no SQL.
--
-- A phone that allowed notifications is a row in push_subscriptions. Those
-- rows stay private (address + keys of the device, owner-only by RLS): the
-- admin gets a NUMBER per client, nothing else.
-- ============================================================

-- How many devices this client registered. For the client themself and for
-- admins; anybody else gets no answer.
create or replace function public.push_device_count(p_user uuid)
returns int language sql stable security definer set search_path = public as $$
  select case
    when p_user is not null and (p_user = auth.uid() or public.is_admin())
      then (select count(*)::int from public.push_subscriptions s where s.user_id = p_user)
    else null
  end
$$;
revoke execute on function public.push_device_count(uuid) from public, anon;
grant execute on function public.push_device_count(uuid) to authenticated;

-- The admin's client list: the same view as patch v1.4, plus push_devices as
-- the last column (create or replace: no moment without the view, grants kept).
create or replace view public.client_directory
with (security_invoker = on) as
select p.id, p.full_name, p.phone, p.is_admin, p.created_at,
       coalesce((select sum(pb.remaining) from public.pack_balance pb
                 where pb.user_id = p.id and pb.is_active and pb.remaining > 0), 0) as active_remaining,
       (select min(pb.valid_until) from public.pack_balance pb
        where pb.user_id = p.id and pb.is_active and pb.remaining > 0) as next_expiry,
       h.flags as health_flags, h.submitted_at as health_form_at,
       public.push_device_count(p.id) as push_devices
from public.profiles p
left join lateral (
  select flags, submitted_at from public.health_forms hf
  where hf.user_id = p.id order by hf.submitted_at desc limit 1
) h on true;
revoke all on public.client_directory from anon;
grant select on public.client_directory to authenticated;

notify pgrst, 'reload schema';
