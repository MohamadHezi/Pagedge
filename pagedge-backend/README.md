# pagedge-backend

Auth + quota API for Pagedge, deployed to Vercel independently of the
desktop app. Next.js App Router, API routes only — no frontend pages.

## One-time setup (manual — needs dashboard access)

1. Create a Supabase project at https://supabase.com/dashboard.
2. In the SQL editor, run `supabase/migrations/0001_profiles.sql`.
3. In Project Settings -> API, copy the Project URL, `anon` key, and
   `service_role` key into `.env.local` (see `.env.local.example`).
4. `pnpm install && pnpm dev` to run locally on port 3000.
5. Deploy: `vercel link` then `vercel deploy --prod`, setting the same
   three env vars as Vercel project environment variables (Production +
   Preview). The `service_role` key must stay server-side only — it is
   never exposed via `NEXT_PUBLIC_*`.

## Routes

- `POST /api/auth/signup` — `{ email, password }` -> `{ user_id, access_token, refresh_token }`
- `POST /api/auth/signin` — `{ email, password }` -> `{ user_id, access_token, refresh_token, tier }`
- `POST /api/auth/refresh` — `{ refresh_token }` -> `{ access_token, refresh_token }`
- `GET /api/auth/me` — `Authorization: Bearer <access_token>` -> `{ user_id, email, tier, ai_calls_this_month, calls_remaining }`

`calls_remaining` is `null` for `tier: 'pro'` (unlimited). For `free`,
it's `30 - ai_calls_this_month`, lazily reset to 0 the next time `/me`
is read after `ai_calls_reset_at` has passed.

Every protected route re-verifies the bearer token against Supabase Auth
(`supabase.auth.getUser(token)`) — it never trusts a client-asserted tier.
