import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin, supabaseAnon } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const email = body?.email?.trim();
  const password = body?.password;

  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password are required.' }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 });
  }

  const { data: created, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (createError) {
    const isDuplicate = /already.*registered|already.*exists/i.test(createError.message);
    return NextResponse.json(
      { error: isDuplicate ? 'An account with this email already exists.' : createError.message },
      { status: isDuplicate ? 409 : 400 }
    );
  }

  // admin.createUser doesn't return a session, so sign in immediately to
  // hand back usable tokens — signup should log the user in right away.
  const { data: signedIn, error: signInError } = await supabaseAnon.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError || !signedIn.session) {
    return NextResponse.json({ error: 'Account created, but sign-in failed. Please sign in.' }, { status: 500 });
  }

  return NextResponse.json({
    user_id: created.user!.id,
    access_token: signedIn.session.access_token,
    refresh_token: signedIn.session.refresh_token,
  });
}
