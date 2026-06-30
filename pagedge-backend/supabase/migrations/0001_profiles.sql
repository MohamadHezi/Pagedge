-- Run this once in the Supabase SQL editor (or via `supabase db push`)
-- against a freshly created project.

CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'free',
  ai_calls_this_month INTEGER NOT NULL DEFAULT 0,
  ai_calls_reset_at TIMESTAMPTZ NOT NULL DEFAULT
    date_trunc('month', now()) + interval '1 month',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Users may read their own profile. All writes go through the service-role
-- key from API routes, so no insert/update policy is needed for clients.
CREATE POLICY "Users can read their own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

-- Auto-create a profile row whenever a new auth.users row appears (signup
-- via the admin client still fires this trigger).
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO profiles (id, email)
  VALUES (new.id, new.email);
  RETURN new;
END;
$$ language plpgsql security definer;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE handle_new_user();
