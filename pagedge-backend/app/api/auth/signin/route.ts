import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, supabaseAnon } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const email = body?.email?.trim();
  const password = body?.password;

  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 });
  }

  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 });
  }

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('tier')
    .eq('id', data.user.id)
    .single();

  return NextResponse.json({
    user_id: data.user.id,
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    tier: profile?.tier ?? 'free',
  });
}
