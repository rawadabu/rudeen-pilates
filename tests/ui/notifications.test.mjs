// Getting notifications switched on (v1.9): the question right after a
// booking, the way back through the phone's Settings for somebody who refused,
// and the bells in the admin's client list. What the phone answers is faked
// (window.__pushFake, dev server only) — the real prompt needs a real iPhone.
import { test } from 'node:test'
import { demo, chromeMissing, sleep } from './demo.mjs'
import { checks } from '../lib/checks.mjs'

const T = { home: 'الرئيسية', sched: 'الجدول', book: 'تسجيل', ask: 'تذكير قبل الحصة؟', yes: 'تفعيل الإشعارات', no: 'غير موافق', settings: 'فتح الإعدادات',
  off: 'الإشعارات مطفية', card: 'إشعارات على الهاتف', on: 'مفعّل ✓', booked: 'تسجّلتوا بالحصة!' }

test('client: asked after a booking, and the way back after refusing', { skip: chromeMissing() ?? false }, async () => {
  const { ok, finish } = checks()
  const d = await demo()
  // book the first bookable class of the last open day, through the real screens
  const bookOne = async () => {
    await d.nav(T.sched)
    await d.js(`const days = [...document.querySelectorAll('button')].filter((b) => /[0-9]/.test(b.innerText) && b.innerText.includes('chevron_left') && !b.innerText.includes(':')); days[days.length - 1].click()`); await sleep(600)
    const n = await d.js(`const b = ${d.btn(T.book)}.filter((x) => x.innerText.trim() === ${JSON.stringify(T.book)}); if (!b.length) return 0; b[0].click(); return b.length`)
    await sleep(900)
    return n
  }
  try {
    // --- A. notifications off, the person says yes
    await d.open('#/', { lang: 'ar', health: true, pushFake: { state: 'off', ios: true, grant: true } })
    let t = await d.text()
    ok('A the notifications card is the first thing on the home screen', t.includes(T.card) && await d.count('تفعيل') >= 1, t.slice(0, 300))
    ok('A a class could be booked', await bookOne() >= 1)
    t = await d.text()
    ok('A after the booking a sheet says "booked" and asks about a reminder', t.includes(T.ask) && t.includes(T.booked) && await d.count(T.yes) === 1, t.slice(-300))
    ok('A the decline button reads «غير موافق»', await d.count(T.no) === 1 && !t.includes('مش هلّق'))
    ok('A nothing lies on top of the main button', await d.js(`const b = ${d.btn(T.yes)}[0], r = b.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return el === b || b.contains(el)`))
    await d.shot('notifications-1-ask.png')
    await d.click(T.yes, { wait: 900 })
    t = await d.text()
    ok('A yes: the sheet closes and the app says notifications are on', !t.includes(T.ask) && t.includes(T.on), t.slice(-200))
    await d.nav(T.home)
    ok('A the home card is gone once they are on', !(await d.text()).includes(T.card))
    await bookOne()
    ok('A the next booking does not ask again', !(await d.text()).includes(T.ask))

    // --- B. the person refuses, then switches them on in the phone's Settings
    await d.open('#/', { lang: 'ar', health: true, pushFake: { state: 'off', ios: true, grant: false } })
    await bookOne(); await d.click(T.yes, { wait: 900 })
    t = await d.text()
    ok('B refused: the sheet stays and shows the way through Settings, with the steps', t.includes(T.off) && await d.count(T.settings) >= 1 && t.includes('السماح بالإشعارات'), t.slice(-400))
    await d.shot('notifications-2-refused.png')
    await d.click(T.settings, { last: true, wait: 300 })
    ok('B the Settings button does not navigate the app away', (await d.js(`return location.href`)).startsWith(d.site))
    await d.click(T.no, { wait: 400 }); await d.nav(T.home)
    t = await d.text()
    ok('B the home card now offers "open Settings" instead of "turn on"', t.includes(T.card) && t.includes('مطفية للتطبيق') && await d.count(T.settings) === 1, t.slice(0, 300))
    await bookOne()
    ok('B a second booking the same day does not ask again', await d.count(T.no) === 0)
    await d.nav(T.home)
    await d.awayAndBack()
    ok('B leaving and coming back with nothing changed: still off, the card stays', (await d.text()).includes(T.card) && await d.count(T.settings) === 1)
    // in the phone's Settings she switches notifications on, then returns to the app
    await d.awayAndBack(`window.__pushFake.state = 'off'; window.__pushFake.grant = true`)
    ok('B back from Settings: registered without another tap, the card is gone', !(await d.text()).includes(T.card))

    // --- C. "not agreeing", then the next day
    await d.open('#/', { lang: 'ar', health: true, pushFake: { state: 'off', ios: true, grant: true } })
    await bookOne(); await d.click(T.no, { wait: 400 }); await bookOne()
    ok('C declined: the next booking the same day does not ask', !(await d.text()).includes(T.ask))
    await d.js(`localStorage.setItem('push_ask_at', String(Date.now() - 21 * 3600000))`)
    await bookOne()
    ok('C a day later it asks again', (await d.text()).includes(T.ask))

    // --- D. a plain browser without push: booking still works, nothing is asked
    await d.open('#/', { lang: 'ar', health: true })
    await bookOne(); t = await d.text()
    ok('D without push support: booked, and no question', t.includes(T.booked) && !t.includes(T.ask), t.slice(-200))
    ok('no script errors', d.errors.length === 0, d.errors.join(' | '))
  } finally { d.stop() }
  finish()
})

test('admin: a bell per client, a count and a filter', { skip: chromeMissing() ?? false }, async () => {
  const { ok, finish } = checks()
  const d = await demo()
  try {
    await d.open('#/admin', { lang: 'ar' })
    await d.nav('الاشتراكات')
    const t = await d.text()
    ok('the count line', /الإشعارات مفعّلة عند [0-9]+ من [0-9]+/.test(t), t.slice(0, 400))
    const bells = await d.js(`return { on: document.querySelectorAll('[aria-label="الإشعارات مفعّلة"]').length, off: document.querySelectorAll('[aria-label="الإشعارات مطفية"]').length }`)
    ok('a bell for each of the 8 clients, none for the admin herself', bells.on + bells.off === 8 && bells.off >= 1, JSON.stringify(bells))
    await d.shot('notifications-3-admin-bells.png')
    await d.click('بدون إشعارات', { wait: 400 })
    const after = await d.js(`return { on: document.querySelectorAll('[aria-label="الإشعارات مفعّلة"]').length, off: document.querySelectorAll('[aria-label="الإشعارات مطفية"]').length, all: ${d.btn('كل المتدربات')}.length }`)
    ok('the filter shows only clients with notifications off, and can be undone', after.on === 0 && after.off === bells.off && after.all === 1, JSON.stringify(after))
    ok('no script errors', d.errors.length === 0, d.errors.join(' | '))
  } finally { d.stop() }
  finish()
})
