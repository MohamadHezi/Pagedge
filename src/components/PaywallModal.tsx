import { useState } from 'react';
import { useStore } from '../store';
import { startProCheckout } from '../services/stripeService';
import { FREE_TIER_MONTHLY_CALLS } from '../services/aiService';
import type { PaywallReason } from '../store';

const PAYWALL_COPY: Record<PaywallReason, { title: string; body: string }> = {
  context_too_large: {
    title: 'Document too large',
    body: 'This document is too large for the free plan. Upgrade to Pro for unlimited document size.',
  },
  sync_requires_pro: {
    title: 'Sync is a Pro feature',
    body: 'Syncing your highlights, notes, and flashcards across devices is a Pro feature. Upgrade to Pro to keep everything in sync.',
  },
  quota_exceeded: {
    title: 'Monthly limit reached',
    body: `You've used all ${FREE_TIER_MONTHLY_CALLS} AI calls for this month. Upgrade to Pro for unlimited AI.`,
  },
  study_guide_requires_pro: {
    title: 'Study guides are a Pro feature',
    body: 'AI-generated study guides synthesize your highlights, notes, and flashcards into one document. Upgrade to Pro to generate them.',
  },
  compare_requires_pro: {
    title: 'Compare is a Pro feature',
    body: 'AI-powered document comparison finds agreements, differences, and unique points across two documents. Upgrade to Pro to use it.',
  },
  custom_provider_requires_pro: {
    title: 'Custom AI providers are a Pro feature',
    body: 'Using your own Ollama or API-key-based AI provider is a Pro feature. Upgrade to Pro to connect your own provider.',
  },
};

export function PaywallModal() {
  const { isAuthenticated, requireAuth, paywallOpen, paywallReason, closePaywall, user } = useStore();
  const [upgrading, setUpgrading] = useState(false);
  const [error, setError] = useState('');

  if (!paywallOpen || !paywallReason) return null;

  const handleUpgrade = async () => {
    if (!isAuthenticated) return requireAuth('Sign in to upgrade to Pro', () => handleUpgrade());
    setError('');
    setUpgrading(true);
    try {
      await startProCheckout();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start checkout.');
    } finally {
      setUpgrading(false);
    }
  };

  const resetLabel = user?.resetAt
    ? new Date(user.resetAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })
    : null;

  return (
    <div className="paywall-overlay" onMouseDown={closePaywall}>
      <div className="paywall-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="paywall-title">{PAYWALL_COPY[paywallReason].title}</h2>

        <p className="paywall-body">{PAYWALL_COPY[paywallReason].body}</p>

        {paywallReason === 'quota_exceeded' && resetLabel && (
          <p className="paywall-reset-note">Resets on {resetLabel}</p>
        )}

        {error && <p className="settings-feedback settings-feedback--err">{error}</p>}

        <div className="paywall-actions">
          <button className="settings-btn settings-btn--primary paywall-upgrade-btn" onClick={handleUpgrade} disabled={upgrading}>
            {upgrading ? 'Opening checkout…' : 'Upgrade to Pro — $5/month'}
          </button>
          <button className="settings-btn settings-btn--ghost" onClick={closePaywall} disabled={upgrading}>
            Maybe later
          </button>
        </div>
      </div>
    </div>
  );
}
