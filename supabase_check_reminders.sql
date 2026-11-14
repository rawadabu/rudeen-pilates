-- RUDEEN PILATES — why did a class reminder not arrive?
-- Read-only: changes nothing. Paste into the SQL Editor, Run, and read the
-- rows top to bottom. No names or phone numbers in the result.
--
--   reminder job        must say "*/5 * * * * · active"
--   reminder function   must say "two reminders"
--   job run             the last runs of the job; "failed" + a message = the cause
--   reminders sent      how many went out so far, and when the last one did
--   class               every class of the last 3 days and the next day:
--                       booked = people booked through an account,
--                       with a phone = of those, how many have notifications on,
--                       hour sent / half sent = reminders handed to the sender
--   push answer         what the sender answered, newest first
--                       (the database keeps these for a few hours only)
with j as (
  select jobid, schedule, active from cron.job where jobname = 'class-reminders'
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
    from (select * from cron.job_run_details where jobid in (select jobid from j) order by start_time desc limit 4) r
  union all
  select 50, 'job runs, last 24 hours',
         count(*) || ' runs · ' || count(*) filter (where status <> 'succeeded') || ' not succeeded'
    from cron.job_run_details
   where jobid in (select jobid from j) and start_time > now() - interval '24 hours'
  union all
  select 60, 'reminders sent so far',
         'hour: ' || count(push_reminded_at)
         || ' (last ' || coalesce(to_char(max(push_reminded_at) at time zone 'Asia/Jerusalem', 'DD-MM HH24:MI'), 'never') || ')'
         || ' · half hour: ' || count(push_reminded_30_at)
         || ' (last ' || coalesce(to_char(max(push_reminded_30_at) at time zone 'Asia/Jerusalem', 'DD-MM HH24:MI'), 'never') || ')'
    from public.bookings
  union all
  select 61, 'phones with notifications on',
         count(*) || ' devices of ' || count(distinct user_id) || ' people · '
         || coalesce((select string_agg(kind || ' ' || c, ', ') from (select kind, count(*) c from public.push_subscriptions group by kind) k), 'none')
    from public.push_subscriptions
  union all
  select 70 + row_number() over (order by c.class_date desc, c.start_time desc), 'class',
         to_char(c.class_date + c.start_time, 'Dy DD-MM HH24:MI') || ' · ' || c.status
         || ' · booked ' || count(b.id) filter (where b.status = 'booked' and b.user_id is not null)
         || ' · with a phone ' || count(distinct b.user_id) filter (
              where b.status = 'booked' and exists (select 1 from public.push_subscriptions s where s.user_id = b.user_id))
         || ' · hour sent ' || count(b.push_reminded_at)
         || ' · half sent ' || count(b.push_reminded_30_at)
         || ' · newest booking ' || coalesce(to_char(max(b.created_at) filter (where b.status = 'booked') at time zone 'Asia/Jerusalem', 'DD-MM HH24:MI'), '-')
    from public.classes c
    left join public.bookings b on b.class_id = c.id
   where (c.class_date + c.start_time) between public.studio_now() - interval '3 days' and public.studio_now() + interval '1 day'
   group by c.id
  union all
  select 500 + row_number() over (order by x.created desc), 'push answer',
         to_char(x.created at time zone 'Asia/Jerusalem', 'DD-MM HH24:MI') || ' · ' || coalesce(x.status_code::text, 'no answer')
         || ' · ' || left(coalesce(x.content, x.error_msg, ''), 170)
    from (select * from net._http_response order by created desc limit 12) x
)
select what, value from lines order by n;
