import { open } from '@tauri-apps/plugin-shell';
import { API_BASE_URL, loadSession } from './authService';

async function authedPost<T>(path: string): Promise<T> {
  const session = await loadSession();
  if (!session) throw new Error('Not authenticated');

  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data as T;
}

// Opens the Stripe Checkout page for the Pro subscription in the user's
// default browser. Stripe redirects back to pagedge://stripe-success or
// pagedge://stripe-cancel once the flow completes.
export async function startProCheckout(): Promise<void> {
  const { checkout_url } = await authedPost<{ checkout_url: string }>('/stripe/create-checkout');
  await open(checkout_url);
}

// Opens the Stripe Customer Portal (manage/cancel subscription) in the
// user's default browser.
export async function openBillingPortal(): Promise<void> {
  const { portal_url } = await authedPost<{ portal_url: string }>('/stripe/portal');
  await open(portal_url);
}
