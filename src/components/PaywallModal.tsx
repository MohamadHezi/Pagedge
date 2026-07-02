import { useState } from 'react';
import { useStore } from '../store';
import { startProCheckout } from '../services/stripeService';
import { FREE_TIER_MONTHLY_CALLS } from '../services/aiService';

export function PaywallModal() {
  const { paywallOpen, paywallReason, closePaywall, user } = useStore();
  const [upgrading, setUpgrading] = useState(false);
  const [error, setError] = useState('');

  if (!paywallOpen || !paywallReason) return null;

  const handleUpgrade = async () => {
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
        <h2 className="paywall-title">
          {paywallReason === 'context_too_large' ? 'Document too large' : 'Monthly limit reached'}
        </h2>

        <p className="paywall-body">
          {paywallReason === 'context_too_large'
            ? 'This document is too large for the free plan. Upgrade to Pro for unlimited document size.'
            : `You've used all ${FREE_TIER_MONTHLY_CALLS} AI calls for this month. Upgrade to Pro for unlimited AI.`}
        </p>

        {paywallReason === 'quota_exceeded' && resetLabel && (
          <p className="paywall-reset-note">Resets on {resetLabel}</p>
        )}

        {error && <p className="settings-feedback settings-feedback--err">{error}</p>}

        <div className="paywall-actions">
          <button className="settings-btn settings-btn--primary paywall-upgrade-btn" onClick={handleUpgrade} disabled={upgrading}>
            {upgrading ? 'Opening checkout…' : 'Upgrade to Pro — $10/month'}
          </button>
          <button className="settings-btn settings-btn--ghost" onClick={closePaywall} disabled={upgrading}>
            Maybe later
          </button>
        </div>
      </div>
    </div>
  );
}
