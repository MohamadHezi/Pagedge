import { NextRequest, NextResponse } from 'next/server';
import { supabaseAnon } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const refreshToken = body?.refresh_token;

  if (!refreshToken) {
    return NextResponse.json({ error: 'refresh_token is required.' }, { status: 400 });
  }

  const { data, error } = await supabaseAnon.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) {
    return NextResponse.json({ error: 'Refresh token is invalid or expired.' }, { status: 401 });
  }

  return NextResponse.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
}
