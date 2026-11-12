-- ============================================================
-- RUDEEN PILATES — patch v1.8: a second reminder, half an hour before class
-- Run AFTER supabase_patch_v1_7.sql. Safe to re-run.
--
-- v1.6 sends one push reminder about an hour before class. The studio wants
-- two: an hour before, and half an hour before. Same job, same rules, one more
-- window; each booking gets each reminder once.
--
-- The push function must know about the half-hour one to say "in half an
-- hour": deploy supabase/functions/push first, then run this. (An older
-- function still delivers it, but with the "in an hour" wording.)
-- ============================================================

-- Its own column, next to push_reminded_at (the hour-before one).
alter table public.bookings
  add column if not exists push_reminded_30_at timestamptz;

-- Every booking whose class starts 50–60 minutes from now (the hour reminder)
-- or 20–30 minutes from now (the half-hour reminder) and has not had that
-- reminder yet. Cron runs this every 5 minutes, so each booking is seen twice
-- per window: one missed run loses nothing, and the two columns make a second
-- send impossible. A class on a round time gets them exactly 60 and 30 minutes
-- before. Class times are studio time (studio_now), never UTC.
create or replace function public.send_class_reminders()
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0; v_now timestamp := public.studio_now();
begin
  -- push is optional (supabase_push_setup.sql): without it there is nobody to hand this to
  if to_regprocedure('public.push_send(jsonb)') is null then return 0; end if;

  for r in
    select b.id, w.mins
      from public.bookings b
      join public.classes c on c.id = b.class_id
     cross join (values (60), (30)) as w(mins)
     where b.status = 'booked'
       and b.user_id is not null
       and c.status = 'open'
       and (c.class_date + c.start_time) >  v_now + make_interval(mins => w.mins - 10)
       and (c.class_date + c.start_time) <= v_now + make_interval(mins => w.mins)
       and case w.mins when 60 then b.push_reminded_at else b.push_reminded_30_at end is null
       -- someone who booked a few minutes ago does not need telling
       and b.created_at < now() - interval '15 minutes'
     for update of b skip locked
  loop
    if r.mins = 60 then
      update public.bookings set push_reminded_at = now() where id = r.id;
    else
      update public.bookings set push_reminded_30_at = now() where id = r.id;
    end if;
    execute 'select public.push_send($1)'
      using jsonb_build_object('event', 'class_reminder', 'booking_id', r.id, 'minutes', r.mins);
    n := n + 1;
  end loop;
  return n;
end $$;
-- only cron (the database owner) runs it
revoke execute on function public.send_class_reminders() from public, anon, authenticated;

notify pgrst, 'reload schema';
