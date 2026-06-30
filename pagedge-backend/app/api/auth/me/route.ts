import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { requireUser, AuthError } from '@/lib/auth';

const FREE_TIER_MONTHLY_CALLS = 30;

export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireUser(req);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  const { data: profile, error } = await supabaseAdmin
    .from('profiles')
    .select('email, tier, ai_calls_this_month, ai_calls_reset_at')
    .eq('id', user.id)
    .single();

  if (error || !profile) {
    return NextResponse.json({ error: 'Profile not found.' }, { status: 404 });
  }

  let { ai_calls_this_month: callsThisMonth, ai_calls_reset_at: resetAt } = profile;

  // Lazy monthly reset: rather than a cron job, the count resets the next
  // time the profile is read after its reset_at has passed.
  if (new Date(resetAt) <= new Date()) {
    const nextReset = new Date();
    nextReset.setUTCMonth(nextReset.getUTCMonth() + 1, 1);
    nextReset.setUTCHours(0, 0, 0, 0);

    callsThisMonth = 0;
    resetAt = nextReset.toISOString();

    await supabaseAdmin
      .from('profiles')
      .update({ ai_calls_this_month: 0, ai_calls_reset_at: resetAt })
      .eq('id', user.id);
  }

  const callsRemaining = profile.tier === 'pro' ? null : Math.max(0, FREE_TIER_MONTHLY_CALLS - callsThisMonth);

  return NextResponse.json({
    user_id: user.id,
    email: profile.email,
    tier: profile.tier,
    ai_calls_this_month: callsThisMonth,
    calls_remaining: callsRemaining,
  });
}
