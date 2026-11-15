-- ============================================================
-- RUDEEN PILATES — patch v1.11: older functions are closed to visitors
-- Run AFTER supabase_patch_v1_10.sql. Safe to re-run. No change to the app.
--
-- Functions written before v1.6 end with `revoke execute … from anon`. That
-- never closed them: Postgres also grants every function to PUBLIC, and a
-- visitor who is not signed in is part of PUBLIC. So anybody holding the
-- site's public key could CALL the admin and account functions. Each one
-- checks the caller itself and answers "not_admin" / "not_authenticated", and
-- a test confirms nothing can be done through them — but the only thing
-- between a visitor and an admin action was that one check inside the
-- function. From v1.6 on, functions are closed one level earlier
-- (`revoke … from public, anon`); this brings the older ones in line.
--
-- After this patch a visitor's call to any of them is refused by the database
-- before the function runs (42501, permission denied). Signed-in clients and
-- the admin are not affected: they call as `authenticated`, which keeps (and
-- is explicitly given) the right. The functions themselves are not changed.
--
-- Left open, on purpose:
--   is_admin(), studio_now(), studio_today()  — used by the row-level rules
--       and the views, so every role that reads a table needs them; they
--       give nothing away (is_admin() answers false for a visitor);
--   handle_new_user(), push_webhook()         — trigger functions; Postgres
--       refuses to run a trigger function as a direct call.
-- ============================================================

do $$
declare r record;
begin
  for r in
    select format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as fn
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any (array[
         -- what only the studio's admin does
         'admin_add_class', 'admin_book_client', 'admin_book_guest', 'admin_cancel_booking', 'admin_cancel_class',
         'admin_decide_purchase', 'admin_grant_pack', 'admin_save_template', 'admin_set_attendance', 'admin_update_class',
         -- what a signed-in client does with their own account
         'book_class', 'cancel_my_booking', 'cancel_purchase_request', 'delete_my_account', 'delete_push_subscription',
         'request_purchase', 'save_push_subscription', 'submit_health_form'
       ])
  loop
    execute 'revoke execute on function ' || r.fn || ' from public, anon';
    execute 'grant execute on function ' || r.fn || ' to authenticated, service_role';
  end loop;
end $$;

notify pgrst, 'reload schema';

-- What a visitor can still call after this patch. Expected: the five named
-- above (is_admin, studio_now, studio_today, and the two trigger functions).
-- Anything marked NOT EXPECTED is a function this patch did not know about
-- (one that exists only in the live database): it is still open.
select p.proname as still_open_to_visitors,
       case when p.prorettype = 'trigger'::regtype then '2 trigger function: cannot be called directly'
            when p.proname in ('is_admin', 'studio_now', 'studio_today') then '1 kept open on purpose (row-level rules and views need it)'
            else '0 NOT EXPECTED — tell whoever wrote this patch' end as why
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and has_function_privilege('anon', p.oid, 'execute')
 order by 2, 1;
