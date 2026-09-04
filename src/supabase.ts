import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set — see .env.example')
}

/**
 * The only Supabase client that exists in the browser, and it holds the anon key.
 *
 * That key is published — it is in this bundle, readable by anyone who opens dev
 * tools, and that is its design. It identifies the project; it authorises nothing.
 * Everything this client is allowed to see is decided by the row-level security
 * policies in supabase/migrations/0001_schema_and_policies.sql, evaluated against
 * the signed-in user's JWT. The service-role key, which does bypass those policies,
 * never reaches this file or anything it imports.
 */
export const supabase = createClient(url, anonKey)
