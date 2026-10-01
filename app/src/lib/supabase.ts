import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** True when real Supabase credentials are present in .env.local */
export const isConfigured = !!(url && anonKey && url.startsWith('http'))

export const supabase: SupabaseClient | null = isConfigured
  ? createClient(url!, anonKey!)
  : null
