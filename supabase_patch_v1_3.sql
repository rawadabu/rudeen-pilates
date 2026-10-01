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
