-- ============================================================
-- RUDEEN PILATES — who is an admin, by phone. Safe to re-run.
--
-- A profile row only exists after someone's first sign-in, so promoting by
-- UPDATE alone depends on timing. This keeps an allowlist instead: listed
-- phones are admins now if they already signed in, and the moment their
-- profile is created otherwise. To add an admin later, add a phone below and
-- run the file again. (Removing a phone here does NOT demote anyone — use
-- `update public.profiles set is_admin = false where phone = '972…';`.)
--
-- Phones are stored as Supabase Auth stores them: 972…, no '+', no leading 0.
-- ============================================================

create table if not exists public.admin_phones (phone text primary key check (phone ~ '^972[0-9]{8,9}$'));
alter table public.admin_phones enable row level security;   -- no policies: the API cannot see it
revoke all on public.admin_phones from anon, authenticated;

insert into public.admin_phones (phone) values
  ('972522427059'),   -- 052-2427059
  ('972503337328')    -- 050-3337328
on conflict (phone) do nothing;

create or replace function public.promote_listed_admin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.admin_phones a where a.phone = ltrim(new.phone, '+')) then
    new.is_admin := true;
  end if;
  return new;
end $$;
revoke execute on function public.promote_listed_admin() from public, anon, authenticated;

drop trigger if exists promote_listed_admin on public.profiles;
create trigger promote_listed_admin
  before insert on public.profiles
  for each row execute function public.promote_listed_admin();

-- already signed in
update public.profiles set is_admin = true
 where not is_admin and ltrim(phone, '+') in (select phone from public.admin_phones);

-- who is an admin now (empty until they sign in — that is fine)
select phone, full_name, is_admin from public.profiles where is_admin;
