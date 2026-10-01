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
