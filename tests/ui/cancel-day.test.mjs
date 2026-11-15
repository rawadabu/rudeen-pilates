// The admin cancels a whole day from the schedule (v1.7). Uses next week's
// first day, so every class on it is still ahead whatever the time is now.
import { test } from 'node:test'
import { demo, chromeMissing, sleep } from './demo.mjs'
import { checks } from '../lib/checks.mjs'

test('admin: cancel a whole day', { skip: chromeMissing() ?? false }, async () => {
  const { ok, finish } = checks()
  const d = await demo()
  try {
    await d.open('#/admin', { lang: 'he' })
    const T = { day: 'ביטול היום', yes: 'כן, לבטל את היום', back: 'חזרה', one: 'ביטול השיעור' }
    const state = `const m = await import('/src/lib/api.ts'); const c = await m.api.fetchClients(); return c.filter((x) => !x.is_admin).reduce((n, x) => n + x.active_remaining, 0)`
    await d.js(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'chevron_left').click()`); await sleep(900)
    const days = async () => d.js(`return ${d.btn(T.day)}.map((b) => b.parentElement.innerText.split('\\n')[0])`)
    const before = await days()
    ok('next week: every day with classes has a "cancel the day" button', before.length >= 2, JSON.stringify(before))
    const credits0 = await d.js(state)

    await d.js(`const b = ${d.btn(T.day)}[0]; b.scrollIntoView({ block: 'start' }); window.scrollBy(0, -120)`); await sleep(300)
    await d.shot('cancel-day-1-schedule.png')
    await d.click(T.day, { wait: 700 })
    const sheet = (await d.js(`return ${d.btn(T.yes)}[0].parentElement.innerText`)).replace(/[⁦⁩]/g, '')
    const m = sheet.match(/שיעורים לביטול: (\d+) · נרשמים: (\d+)/)
    ok('the sheet says what will go: how many classes, how many people', !!m && Number(m[1]) >= 1, sheet.slice(0, 200))
    ok('and that it cannot be undone and everybody gets the session back', sheet.includes('אי אפשר לבטל את הפעולה') && sheet.includes('מקבל את השיעור בחזרה'))
    const geo = await d.js(`const r = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)] }; return { yes: r(${d.btn(T.yes)}[0]), back: r(${d.btn(T.back)}[0]), over: document.documentElement.scrollWidth - document.documentElement.clientWidth }`)
    ok('both buttons are big enough to tap and nothing overflows', geo.yes[1] >= 44 && geo.back[1] >= 40 && geo.over === 0, JSON.stringify(geo))
    await d.shot('cancel-day-2-sheet.png')

    await d.click(T.back, { wait: 400 })
    ok('"back" cancels nothing', (await days()).length === before.length && await d.js(state) === credits0)

    await d.click(T.day, { wait: 700 }); await d.click(T.yes, { wait: 900 })
    const txt = await d.text()
    ok('confirmed: the app reports the classes and people from the server', new RegExp(`היום בוטל · שיעורים: ${m?.[1]} · קיבלו את השיעור בחזרה: ${m?.[2]}`).test(txt), txt.slice(-200))
    ok('that day is gone from the schedule, the other days stay', (await days()).length === before.length - 1 && !(await days()).includes(before[0]), JSON.stringify(await days()))
    ok(`the ${m?.[2]} sessions went back to the clients`, await d.js(state) === credits0 + Number(m?.[2] ?? 0), `${credits0} -> ${await d.js(state)}`)
    await d.shot('cancel-day-3-after.png')

    // the older button, one class, is still there
    await d.js(`const rows = [...document.querySelectorAll('button')].filter((b) => /[0-9][0-9]:[0-9][0-9]/.test(b.innerText) && /Reformer|Mat/.test(b.innerText)); rows[0].click()`); await sleep(700)
    ok('cancelling a single class is still offered inside the class', await d.count(T.one) === 1)

    // this week: days that are over have no button
    await d.open('#/admin', { lang: 'he' })
    const week = await d.js(`return { titles: [...document.querySelectorAll('div')].filter((x) => /^(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת) · /.test(x.innerText) && x.children.length === 0).length, buttons: ${d.btn(T.day)}.length }`)
    ok('this week: no more buttons than days', week.buttons <= week.titles, JSON.stringify(week))
    ok('no script errors', d.errors.length === 0, d.errors.join(' | '))
  } finally { d.stop() }
  finish()
})
