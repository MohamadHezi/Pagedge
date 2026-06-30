import { NextRequest } from 'next/server';
import { supabaseAnon } from './supabase';

export class AuthError extends Error {}

// Verifies the bearer token against Supabase Auth (a real round-trip, not a
// local JWT decode) and returns the authenticated user. Never trust a
// tier/role claim sent from the client — this only proves *who* the caller
// is; callers must re-fetch tier from the profiles table.
export async function requireUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) throw new AuthError('Missing Authorization header');

  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error || !data.user) throw new AuthError('Invalid or expired token');

  return data.user;
}
