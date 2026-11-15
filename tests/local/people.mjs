// The app's three kinds of caller, against the local copy, through the same
// library the app uses (supabase-js) and the same way in (a code by SMS —
// here the fixed test code from supabase/config.toml; nothing is sent).
import { createClient } from '@supabase/supabase-js'

const opts = { auth: { persistSession: false, autoRefreshToken: false } }
export const PHONES = { admin: '+972500000001', a: '+972500000002', b: '+972500000003' }

/** somebody who is not signed in: only the site's public key */
export const visitor = (s) => createClient(s.apiUrl, s.anonKey, opts)

/** signs in with the phone number (the first time this also creates the account, as in the app) */
export async function signIn(s, phone) {
  const client = createClient(s.apiUrl, s.anonKey, opts)
  const sent = await client.auth.signInWithOtp({ phone })
  if (sent.error) throw new Error(`could not ask for a code for ${phone}: ${sent.error.message}`)
  const r = await client.auth.verifyOtp({ phone, token: '123456', type: 'sms' })
  if (!r.data?.session) throw new Error(`could not sign in ${phone}: ${r.error?.message}`)
  return { client, id: r.data.user.id }
}
/** what a call came back with, in one shape: the function's own answer, or the API's refusal */
export const answer = (r) => (r.error ? { refused: r.error.code, status: r.status } : r.data)
