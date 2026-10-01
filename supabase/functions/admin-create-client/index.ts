// admin-create-client — the studio adds a client who has not signed up yet.
//
// An auth user can only be created with the service role, so this cannot be
// an RPC. The caller must be signed in AND an admin (checked here against
// profiles.is_admin, never trusted from the request body). The user is
// created phone-confirmed: when the client later signs in with that phone she
// lands in this same account, with the packs and bookings the studio gave her.
//
// Deploy:  supabase functions deploy admin-create-client
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided to every edge
// function automatically; nothing to configure. Or paste this file in the
// dashboard: Edge Functions → Deploy a new function → name admin-create-client.

import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  })
  // who is calling: their own access token, checked by Auth itself
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const { data: who } = jwt ? await admin.auth.getUser(jwt) : { data: null }
  if (!who?.user) return json({ ok: false, error: 'not_authenticated' }, 401)

  const { data: me } = await admin.from('profiles').select('is_admin').eq('id', who.user.id).maybeSingle()
  if (!me?.is_admin) return json({ ok: false, error: 'not_admin' }, 403)

  let body: { full_name?: string; phone?: string }
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, error: 'invalid_input' })
  }
  const name = (body.full_name ?? '').trim()
  const digits = (body.phone ?? '').replace(/\D/g, '')
  if (name.length < 2 || name.length > 80) return json({ ok: false, error: 'invalid_name' })
  // what the app's normalizePhone() produces: +972 and 8-9 digits
  if (!/^972\d{8,9}$/.test(digits)) return json({ ok: false, error: 'invalid_phone' })

  // profiles.phone holds what GoTrue stores in auth.users.phone: digits, no '+'
  const existing = async () =>
    (await admin.from('profiles').select('id').in('phone', [digits, '+' + digits]).limit(1).maybeSingle()).data
  const found = await existing()
  if (found) return json({ ok: false, error: 'client_exists', user_id: found.id })

  const { data: created, error } = await admin.auth.admin.createUser({
    phone: digits,
    phone_confirm: true,
    user_metadata: { full_name: name, created_by_studio: true },
  })
  if (error || !created?.user) {
    const again = await existing() // she signed up in the same moment
    if (again) return json({ ok: false, error: 'client_exists', user_id: again.id })
    return json({ ok: false, error: 'create_failed', detail: error?.message ?? null })
  }

  // handle_new_user() inserted the profile row; give it the name
  await admin.from('profiles').update({ full_name: name }).eq('id', created.user.id)
  return json({ ok: true, user_id: created.user.id })
})
