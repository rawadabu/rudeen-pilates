-- ============================================================
-- RUDEEN PILATES — patch v1.10: fix or remove a subscription
-- Run AFTER supabase_patch_v1_9.sql. Safe to re-run.
--
-- Until now the admin could only OPEN a subscription. A typo in the price or
-- the number of sessions could not be corrected, and trying again opened one
-- more subscription each time (a client ended up with 5 + 8 + 5 = 18
-- sessions). Now a subscription can be corrected, and one opened by mistake
-- can be removed.
--
-- Rules, enforced here and not only in the app:
--   * the number of sessions cannot go below what the client already used;
--   * a subscription the client already used cannot be removed (shorten it or
--     lower the sessions instead), so no booking is left without one;
--   * neither change sends the client anything: it is a correction.
-- ============================================================

-- Sessions of this pack already spent (bookings that count against it).
create or replace function public.pack_used(p_pack_id uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.bookings b where b.pack_id = p_pack_id and b.consumes_credit
$$;
revoke execute on function public.pack_used(uuid) from public, anon, authenticated;

-- ---------- correct a subscription ----------
create or replace function public.admin_update_pack(
  p_pack_id uuid, p_sessions int, p_valid_until date,
  p_price numeric default null, p_note text default null
) returns json language plpgsql security definer set search_path = public as $$
declare v_from date; v_used int;
begin
  if not public.is_admin() then return json_build_object('ok', false, 'error', 'not_admin'); end if;
  select valid_from into v_from from public.credit_packs where id = p_pack_id for update;
  if not found then return json_build_object('ok', false, 'error', 'pack_not_found'); end if;

  if p_sessions is null or p_sessions < 1 or p_sessions > 60 then
    return json_build_object('ok', false, 'error', 'invalid_sessions');
  end if;
  v_used := public.pack_used(p_pack_id);
  if p_sessions < v_used then
    return json_build_object('ok', false, 'error', 'sessions_below_used', 'taken', v_used);
  end if;
  if p_valid_until is null or p_valid_until < v_from then
    return json_build_object('ok', false, 'error', 'invalid_date');
  end if;
  if p_price is not null and (p_price < 0 or p_price > 99999) then
    return json_build_object('ok', false, 'error', 'invalid_price');
  end if;

  update public.credit_packs
     set sessions_total = p_sessions,
         valid_until = p_valid_until,
         price_ils = p_price,
         note = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_pack_id;
  return json_build_object('ok', true, 'pack_id', p_pack_id);
end $$;
revoke execute on function public.admin_update_pack(uuid, int, date, numeric, text) from public, anon;
grant execute on function public.admin_update_pack(uuid, int, date, numeric, text) to authenticated;

-- ---------- remove a subscription opened by mistake ----------
-- Only one nobody trained on. Bookings that were cancelled and handed back
-- stay as history; they simply stop pointing at a pack (the foreign key sets
-- pack_id to null).
create or replace function public.admin_delete_pack(p_pack_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare v_live int;
begin
  if not public.is_admin() then return json_build_object('ok', false, 'error', 'not_admin'); end if;
  perform 1 from public.credit_packs where id = p_pack_id for update;
  if not found then return json_build_object('ok', false, 'error', 'pack_not_found'); end if;

  select count(*) into v_live from public.bookings b
   where b.pack_id = p_pack_id and (b.consumes_credit or b.status <> 'cancelled');
  if v_live > 0 then
    return json_build_object('ok', false, 'error', 'pack_in_use', 'taken', v_live);
  end if;

  delete from public.credit_packs where id = p_pack_id;
  return json_build_object('ok', true);
end $$;
revoke execute on function public.admin_delete_pack(uuid) from public, anon;
grant execute on function public.admin_delete_pack(uuid) to authenticated;

notify pgrst, 'reload schema';
