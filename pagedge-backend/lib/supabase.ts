import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANON_KEY = process.env.SUPABASE_ANON_KEY!;

// Service-role client — bypasses RLS. Server-only, never expose to the
// client. Used for admin user creation and reading the profiles table.
export const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Anon client — used for the actual password/refresh grants and for
// verifying a bearer token server-side (getUser() round-trips to Supabase
// Auth, so a forged/expired JWT is rejected there, not trusted from the
// client).
export const supabaseAnon = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
