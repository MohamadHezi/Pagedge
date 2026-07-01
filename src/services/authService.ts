import { load, Store } from '@tauri-apps/plugin-store';

// Override with VITE_PAGEDGE_API_URL for local backend dev
// (e.g. http://localhost:3000/api).
export const API_BASE_URL = import.meta.env.VITE_PAGEDGE_API_URL || 'https://pagedge-backend.vercel.app/api';

export interface StoredSession {
  access_token: string;
  refresh_token: string;
  user_id: string;
  email: string;
  tier: 'free' | 'pro';
}

export interface MeResponse {
  user_id: string;
  email: string;
  tier: 'free' | 'pro';
  ai_calls_this_month: number;
  calls_remaining: number | null;
  ai_calls_reset_at: string;
}

export class AuthApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// tauri-plugin-store writes plain JSON to the app data dir — adequate for
// a JWT pair with short-lived access tokens + revocable refresh tokens,
// but it is not OS-keychain-encrypted. Revisit with tauri-plugin-stronghold
// if that becomes a requirement.
const STORE_FILE = 'auth.json';
const SESSION_KEY = 'session';

let storeHandle: Store | null = null;
async function getStore(): Promise<Store> {
  if (!storeHandle) storeHandle = await load(STORE_FILE);
  return storeHandle;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new AuthApiError(data?.error || `Request failed (${res.status})`, res.status);
  }
  return data as T;
}

export async function loadSession(): Promise<StoredSession | null> {
  const store = await getStore();
  const session = await store.get<StoredSession>(SESSION_KEY);
  return session ?? null;
}

async function saveSession(session: StoredSession): Promise<void> {
  const store = await getStore();
  await store.set(SESSION_KEY, session);
  await store.save();
}

export async function clearSession(): Promise<void> {
  const store = await getStore();
  await store.delete(SESSION_KEY);
  await store.save();
}

export async function signUp(email: string, password: string): Promise<StoredSession> {
  const res = await request<{ user_id: string; access_token: string; refresh_token: string }>(
    '/auth/signup',
    { method: 'POST', body: JSON.stringify({ email, password }) }
  );
  const me = await getMe(res.access_token);
  const session: StoredSession = {
    access_token: res.access_token,
    refresh_token: res.refresh_token,
    user_id: res.user_id,
    email: me.email,
    tier: me.tier,
  };
  await saveSession(session);
  return session;
}

export async function signIn(email: string, password: string): Promise<StoredSession> {
  const res = await request<{
    user_id: string; access_token: string; refresh_token: string; tier: 'free' | 'pro';
  }>('/auth/signin', { method: 'POST', body: JSON.stringify({ email, password }) });
  const session: StoredSession = {
    access_token: res.access_token,
    refresh_token: res.refresh_token,
    user_id: res.user_id,
    email,
    tier: res.tier,
  };
  await saveSession(session);
  return session;
}

export async function getMe(accessToken: string): Promise<MeResponse> {
  return request<MeResponse>('/auth/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// Refreshes tokens and persists the updated session (carrying forward the
// previously known email/tier — callers should re-fetch /me afterward if
// they need fresh tier/quota numbers).
export async function refreshSession(current: StoredSession): Promise<StoredSession> {
  const res = await request<{ access_token: string; refresh_token: string }>('/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refresh_token: current.refresh_token }),
  });
  const session: StoredSession = { ...current, access_token: res.access_token, refresh_token: res.refresh_token };
  await saveSession(session);
  return session;
}

export async function signOut(): Promise<void> {
  await clearSession();
}

// Resolves the current session, refreshing once if /auth/me reports the
// access token expired (401). Returns null if there's no session, or if
// refresh also fails (caller should fall back to the auth modal).
export async function resolveSession(): Promise<{ session: StoredSession; me: MeResponse } | null> {
  let session = await loadSession();
  if (!session) return null;

  try {
    const me = await getMe(session.access_token);
    return { session, me };
  } catch (err) {
    if (!(err instanceof AuthApiError) || err.status !== 401) throw err;
  }

  try {
    session = await refreshSession(session);
    const me = await getMe(session.access_token);
    return { session, me };
  } catch {
    await clearSession();
    return null;
  }
}
