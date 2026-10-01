-- ============================================================
-- RUDEEN PILATES — patch v1.1: plans catalogue + purchase requests
-- Run AFTER supabase_setup.sql. Safe to re-run.
--
-- The studio still takes money outside the app (Bit / cash). A client picks a
-- plan and sends a purchase request; the admin approves once paid, and the
-- approval itself opens the credit pack — one tap, no retyping numbers.
-- ============================================================

-- ---------- 0. studio contact for purchase messages ----------
alter table public.studio_settings add column if not exists whatsapp_phone text;

-- ---------- 1. plans (what is for sale) ----------
create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  sessions int not null check (sessions between 1 and 60),        -- same ceiling as admin_grant_pack
  valid_months int not null default 1 check (valid_months between 1 and 12),
  price_ils numeric(8,2) not null check (price_ils >= 0),
  payment_url text,                                                 -- optional Bit / PayBox / Grow link
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.plans enable row level security;
drop policy if exists "plans read" on public.plans;
create policy "plans read" on public.plans for select using (active or public.is_admin());
drop policy if exists "plans admin write" on public.plans;
create policy "plans admin write" on public.plans for all
  using (public.is_admin()) with check (public.is_admin());

-- ---------- 2. purchase requests ----------
-- Plan fields are SNAPSHOTTED onto the request: the admin can reprice a plan
-- tomorrow without changing what a client asked for today.
create table if not exists public.purchase_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  plan_id uuid references public.plans(id) on delete set null,
  plan_name text not null,
  sessions int not null,
  valid_months int not null,
  price_ils numeric(8,2) not null,
  status text not null default 'pending'
    check (status in ('pending','approved','declined','cancelled')),
  client_note text,
  admin_note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references public.profiles(id) on delete set null,
  pack_id uuid references public.credit_packs(id) on delete set null
);
create index if not exists idx_purchase_pending on public.purchase_requests(created_at) where status = 'pending';
alter table public.purchase_requests enable row level security;
drop policy if exists "requests own read" on public.purchase_requests;
create policy "requests own read" on public.purchase_requests for select
  using (user_id = auth.uid() or public.is_admin());
-- every write goes through the RPCs below
revoke insert, update, delete on public.purchase_requests from anon, authenticated;

-- Admin board with the client's name and phone. security_invoker: RLS on the
-- two tables decides who sees what (a client sees only their own rows).
drop view if exists public.purchase_board;
create view public.purchase_board with (security_invoker = on) as
select r.id, r.user_id, r.plan_id, r.plan_name, r.sessions, r.valid_months, r.price_ils,
       r.status, r.client_note, r.admin_note, r.created_at, r.decided_at,
       p.full_name as client_name, p.phone as client_phone
from public.purchase_requests r
left join public.profiles p on p.id = r.user_id;
revoke all on public.purchase_board from anon;
grant select on public.purchase_board to authenticated;

-- ---------- 3. RPCs ----------
create or replace function public.request_purchase(p_plan_id uuid, p_note text default null)
returns json language plpgsql security definer set search_path = public as $$
declare v_user uuid := auth.uid(); v_plan public.plans%rowtype; v_id uuid;
begin
  if v_user is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
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

create or replace function public.cancel_purchase_request(p_id uuid)
returns json language plpgsql security definer set search_path = public as $$
begin
  update public.purchase_requests
     set status = 'cancelled', decided_at = now()
   where id = p_id and user_id = auth.uid() and status = 'pending';
  if not found then return json_build_object('ok', false, 'error', 'not_found_or_not_yours'); end if;
  return json_build_object('ok', true);
end $$;
revoke execute on function public.cancel_purchase_request(uuid) from anon;

-- Approve = open the pack from the snapshot, in one transaction with the
-- status change, so a request can never be approved twice or approved
-- without a pack.
create or replace function public.admin_decide_purchase(p_id uuid, p_approve boolean, p_note text default null)
returns json language plpgsql security definer set search_path = public as $$
declare v_req public.purchase_requests%rowtype; v_pack uuid; v_from date := public.studio_today();
begin
  if not public.is_admin() then return json_build_object('ok', false, 'error', 'not_admin'); end if;
  select * into v_req from public.purchase_requests where id = p_id for update;
  if not found then return json_build_object('ok', false, 'error', 'request_not_found'); end if;
  if v_req.status <> 'pending' then return json_build_object('ok', false, 'error', 'request_not_pending'); end if;

  if p_approve then
    insert into public.credit_packs
      (user_id, sessions_total, valid_from, valid_until, price_ils, note, granted_by)
    values
      (v_req.user_id, v_req.sessions, v_from,
       (v_from + make_interval(months => v_req.valid_months))::date - 1,
       v_req.price_ils, v_req.plan_name, auth.uid())
    returning id into v_pack;
  end if;

  update public.purchase_requests
     set status = case when p_approve then 'approved' else 'declined' end,
         decided_at = now(), decided_by = auth.uid(),
         admin_note = nullif(btrim(coalesce(p_note, '')), ''), pack_id = v_pack
   where id = p_id;
  return json_build_object('ok', true, 'pack_id', v_pack);
end $$;
revoke execute on function public.admin_decide_purchase(uuid, boolean, text) from anon;

-- ---------- 4. realtime ----------
do $$ begin alter publication supabase_realtime add table public.purchase_requests;
exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.plans;
exception when duplicate_object then null; end $$;

-- ---------- 5. starter catalogue — EDIT in the admin app, מוצרים tab ----------
insert into public.plans (name, sessions, valid_months, price_ils, sort_order)
select * from (values
  ('שיעור בודד',          1, 1,  65, 1),
  ('כרטיסייה 4 שיעורים',  4, 1, 160, 2),
  ('כרטיסייה 8 שיעורים',  8, 1, 300, 3),
  ('כרטיסייה 12 שיעורים', 12, 1, 420, 4)
) v(name, sessions, valid_months, price_ils, sort_order)
where not exists (select 1 from public.plans);

notify pgrst, 'reload schema';
