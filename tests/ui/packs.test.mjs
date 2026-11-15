// The admin corrects a subscription or removes one opened by mistake (v1.10).
// Replays what really happened: three presses of the "open" form gave a
// client 5 + 8 + 5 = 18 sessions; then two are removed and one is corrected.
import { test } from 'node:test'
import { demo, chromeMissing, sleep } from './demo.mjs'
import { checks } from '../lib/checks.mjs'

const T = { clients: 'מנויים', open: 'פתיחת המנוי', existing: 'מנויים קיימים', hint: 'לתיקון או מחיקה לוחצים על המנוי', edit: 'תיקון מנוי', save: 'שמירת התיקון',
  del: 'מחיקת המנוי', delYes: 'בטוחים? לחיצה נוספת תמחק את המנוי', saved: 'המנוי עודכן', deleted: 'המנוי נמחק', fresh: 'מנוי חדש', back: 'חזרה', cant: 'אי אפשר למחוק מנוי שכבר נוצלו ממנו שיעורים' }
const WHO = 'מאיה כהן'

test('admin: fix or remove a subscription', { skip: chromeMissing() ?? false }, async () => {
  const { ok, finish } = checks()
  const d = await demo()
  try {
    await d.open('#/admin', { lang: 'he' })
    // the sheet's own fields, in order: sessions, months | end date, price, note
    const setField = (i, v) => d.js(`const el = [...document.querySelectorAll('input')].filter((x) => x.offsetParent !== null && x.placeholder === '')[${i}]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true }))`)
    const fields = () => d.js(`return [...document.querySelectorAll('input')].filter((x) => x.offsetParent !== null && x.placeholder === '').map((x) => x.type + '=' + x.value).join(' | ')`)
    const rows = async () => (await d.js(`return ${d.btn('edit')}.filter((b) => b.innerText.includes('עד')).map((b) => b.innerText.replace(/\\n/g, ' | '))`)).map((r) => r.replace(/[⁦⁩]/g, ''))
    const tap = async (has) => { await d.js(`const b = ${d.btn('edit')}.filter((x) => x.innerText.includes('עד') && x.innerText.replace(/[\\u2066\\u2069]/g, '').includes(${JSON.stringify(has)})); b[0].click()`); await sleep(500) }
    const openClient = async () => { await d.nav(T.clients); await d.click(WHO, { wait: 700 }) }
    const balance = () => d.js(`const m = await import('/src/lib/api.ts'); return (await m.api.fetchClients()).find((c) => c.full_name === ${JSON.stringify(WHO)}).active_remaining`)

    await openClient()
    ok('the form at the top is labelled as a NEW subscription', (await d.text()).includes(T.fresh))
    const start = await balance()
    for (const [n, p] of [['5', '300'], ['8', '350'], ['5', '300']]) {
      await openClient(); await setField(0, n); await setField(2, p); await d.click(T.open, { wait: 700 })
    }
    ok('three presses of "open" opened three subscriptions: +18 sessions', await balance() === start + 18, `${start} -> ${await balance()}`)
    await openClient()
    const list = await rows()
    ok('the existing subscriptions are listed, tappable, with a hint', list.length >= 3 && (await d.text()).includes(T.hint) && (await d.text()).includes(T.existing), JSON.stringify(list))
    await d.js(`${d.btn('edit')}.filter((x) => x.innerText.includes('עד'))[0].scrollIntoView({ block: 'center' })`); await sleep(300)
    await d.shot('packs-1-list.png')

    await tap('5 · 300 ₪')
    let t = await d.text()
    ok('tapping one opens the correction view: used so far, a delete button', t.includes(T.edit) && t.includes('נוצלו 0 מתוך 5') && await d.count(T.del) === 1, t.slice(-300))
    const geo = await d.js(`const r = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)] }; return { save: r(${d.btn(T.save)}[0]), del: r(${d.btn(T.del)}[0]), over: document.documentElement.scrollWidth - document.documentElement.clientWidth }`)
    ok('buttons are big enough to tap and nothing overflows', geo.save[1] >= 44 && geo.del[1] >= 40 && geo.over === 0, JSON.stringify(geo))
    await d.shot('packs-2-edit.png')
    await d.click(T.del, { wait: 300 })
    ok('delete asks for a second tap first', await d.count(T.delYes) === 1 && await balance() === start + 18)
    await d.click(T.delYes, { wait: 700 })
    ok('deleted: back on the list, 5 sessions fewer', (await d.text()).includes(T.deleted) && await balance() === start + 13 && (await rows()).length === list.length - 1, `${await balance()}`)
    await tap('5 · 300 ₪'); await d.click(T.del, { wait: 200 }); await d.click(T.delYes, { wait: 700 })
    ok('the second extra one deleted: 8 new sessions left', await balance() === start + 8, await balance())

    await tap('8 · 350 ₪')
    ok('the fields carry the current values', /^text=8 \| date=\d{4}-\d{2}-\d{2} \| text=350 \| text=/.test(await fields()), await fields())
    await setField(2, '300'); await d.click(T.save, { wait: 700 })
    const now = await rows()
    ok('price corrected to 300; sessions unchanged; no new subscription', (await d.text()).includes(T.saved) && now.some((r) => r.includes('8 · 300 ₪')) && !now.some((r) => r.includes('350')) && await balance() === start + 8, JSON.stringify(now))

    // a subscription the client already trained on
    const used = await d.js(`const m = await import('/src/lib/api.ts'); const c = (await m.api.fetchClients()).find((x) => x.full_name === ${JSON.stringify(WHO)}); const p = (await m.api.fetchClientPacks(c.id)).find((x) => x.remaining < x.sessions_total); return p ? { total: p.sessions_total, used: p.sessions_total - p.remaining, price: p.price_ils } : null`)
    ok('the demo client has a subscription she already used', !!used && used.used >= 1, JSON.stringify(used))
    if (used) {
      await tap(`${used.total} · ${used.price} ₪`)
      t = await d.text()
      ok('a used one: no delete button, an explanation instead', t.includes(T.cant) && await d.count(T.del) === 0 && t.includes(`נוצלו ${used.used} מתוך ${used.total}`), t.slice(-300))
      if (used.used >= 2) {
        await setField(0, String(used.used - 1)); await d.click(T.save, { wait: 500 })
        ok('sessions below what was used: refused, with the number', (await d.text()).includes(`כבר נוצלו ${used.used} שיעורים`), (await d.text()).slice(-200))
      }
      await d.click(T.back, { wait: 400 })
      ok('"back" returns to the list without changes', (await d.text()).includes(T.existing) && await balance() === start + 8)
    }

    await d.open('#/admin', { lang: 'ar' })
    await d.nav('الاشتراكات'); await d.click(WHO, { wait: 700 })
    await d.js(`${d.btn('edit')}.filter((x) => x.innerText.includes('حتى'))[0].click()`); await sleep(500)
    t = await d.text()
    ok('Arabic: the correction view', t.includes('تعديل اشتراك') && t.includes('حفظ التعديل') && t.includes('ساري لتاريخ'), t.slice(-300))
    ok('no script errors', d.errors.length === 0, d.errors.join(' | '))
  } finally { d.stop() }
  finish()
})
