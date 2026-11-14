-- RUDEEN PILATES — why did a class reminder not arrive?
-- Read-only: changes nothing. Paste into the SQL Editor, Run, then
-- Export → "Copy as markdown" (or widen the value column) and read top to
-- bottom. No names or phone numbers in the result.
--
--   reminder job       must say "*/5 * * * * · active"
--   reminder function  must say "two reminders"
--   job run            the last runs of the job; "failed" + a message = the cause
--   1h / 30m sent      how many reminders went out so far, and when the last did
--   class              every class of the last 3 days and the next day:
--                        acct  = people on it through their own account
--                        hand  = people the studio added by hand (no account,
--                                so no phone to remind)
--                        phone = of acct, how many have notifications on
--                        late  = of acct, how many booked inside the last hour
--                        1h / 30m = reminders handed to the sender
--   reminder           the last reminders one by one, and how many phones that
--                      person has registered (0 = nothing could pop up)
--   push answer        what the sender answered, newest first (the database
--                      keeps these for a few hours only)
with j as (
  select jobid, schedule, active from cron.job where jobname = 'class-reminders'
),
live as (   -- bookings that hold a place: everything except cancelled
  select b.*, c.class_date + c.start_time as starts
    from public.bookings b join public.classes c on c.id = b.class_id
   where b.status <> 'cancelled'
),
sent as (   -- every reminder handed to the sender, one row each
  select push_reminded_at as at, '1h' as which, starts, user_id from live where push_reminded_at is not null
  union all
  select push_reminded_30_at, '30m', starts, user_id from live where push_reminded_30_at is not null
),
lines as (
  select 10::bigint as n, 'studio time now' as what, to_char(public.studio_now(), 'Dy DD-MM HH24:MI') as value
  union all
  select 20, 'reminder job',
         coalesce((select schedule || case when active then ' · active' else ' · NOT ACTIVE' end from j), 'NOT SCHEDULED')
  union all
  select 30, 'reminder function',
         coalesce((select case when prosrc like '%push_reminded_30_at%' then 'two reminders (v1.8)' else 'one reminder (old)' end
                     from pg_proc where proname = 'send_class_reminders' and pronamespace = 'public'::regnamespace), 'MISSING')
  union all
  select 31, 'sender in the database',
         case when to_regprocedure('public.push_send(jsonb)') is null then 'MISSING' else 'there' end
  union all
  select 40 + row_number() over (order by r.start_time desc), 'job run',
         to_char(r.start_time at time zone 'Asia/Jerusalem', 'DD-MM HH24:MI') || ' · ' || r.status || ' · ' || left(coalesce(r.return_message, ''), 140)
    from (select * from cron.job_run_details where jobid in (select jobid from j) order by start_time desc limit 3) r
  union all
  select 50, 'job runs, last 24 hours',
         count(*) || ' runs · ' || count(*) filter (where status <> 'succeeded') || ' not succeeded'
    from cron.job_run_details
   where jobid in (select jobid from j) and start_time > now() - interval '24 hours'
  union all
  select 60, '1h reminders sent',
         count(*) || ' · last ' || coalesce(to_char(max(at) at time zone 'Asia/Jerusalem', 'DD-MM HH24:MI'), 'never')
    from sent where which = '1h'
  union all
  select 61, '30m reminders sent',
         count(*) || ' · last ' || coalesce(to_char(max(at) at time zone 'Asia/Jerusalem', 'DD-MM HH24:MI'), 'never')
    from sent where which = '30m'
  union all
  select 62, 'phones with notifications on',
         count(*) || ' of ' || count(distinct user_id) || ' people · '
         || coalesce((select string_agg(kind || ' ' || c, ', ') from (select kind, count(*) c from public.push_subscriptions group by kind) k), 'none')
    from public.push_subscriptions
  union all
  select 70 + row_number() over (order by c.class_date desc, c.start_time desc), 'class',
         to_char(c.class_date + c.start_time, 'Dy DD-MM HH24:MI')
         || case when c.status <> 'open' then ' · ' || c.status else '' end
         || ' · acct ' || count(l.id) filter (where l.user_id is not null)
         || ' · hand ' || count(l.id) filter (where l.user_id is null)
         || ' · phone ' || count(distinct l.user_id) filter (
              where exists (select 1 from public.push_subscriptions s where s.user_id = l.user_id))
         || ' · late ' || count(l.id) filter (
              where l.user_id is not null and l.created_at > ((c.class_date + c.start_time) at time zone 'Asia/Jerusalem') - interval '75 minutes')
         || ' · 1h ' || count(l.push_reminded_at)
         || ' · 30m ' || count(l.push_reminded_30_at)
    from public.classes c
    left join live l on l.class_id = c.id
   where (c.class_date + c.start_time) between public.studio_now() - interval '3 days' and public.studio_now() + interval '1 day'
   group by c.id
  union all
  select 300 + row_number() over (order by s.at desc), 'reminder',
         to_char(s.at at time zone 'Asia/Jerusalem', 'DD-MM HH24:MI') || ' · ' || s.which
         || ' · class ' || to_char(s.starts, 'DD-MM HH24:MI')
         || ' · phones ' || (select count(*) from public.push_subscriptions p where p.user_id = s.user_id)
         || coalesce(' (' || (select string_agg(distinct p.kind, ', ') from public.push_subscriptions p where p.user_id = s.user_id) || ')', '')
    from (select * from sent order by at desc limit 10) s
  union all
  select 500 + row_number() over (order by x.created desc), 'push answer',
         to_char(x.created at time zone 'Asia/Jerusalem', 'DD-MM HH24:MI') || ' · ' || coalesce(x.status_code::text, 'no answer')
         || ' · ' || left(coalesce(x.content, x.error_msg, ''), 170)
    from (select * from net._http_response order by created desc limit 12) x
)
select what, value from lines order by n;
