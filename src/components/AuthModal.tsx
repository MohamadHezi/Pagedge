import { useState, useEffect, FormEvent } from 'react';
import { signIn, signUp, getMe, resendConfirmation, AuthApiError } from '../services/authService';
import { useStore } from '../store';

type Mode = 'signin' | 'signup' | 'verify-email';

interface AuthModalProps {
  // Context for why the prompt was raised (e.g. "Sign in to chat with this
  // PDF"), shown above the tabs. Undefined shows the plain sign-in/create
  // account form with no extra banner.
  reason?: string;
}

export function AuthModal({ reason }: AuthModalProps) {
  const { setUser, authTokenError, clearAuthTokenError, dismissAuthPrompt, authPromptOnSuccess } = useStore();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSent, setResendSent] = useState(false);

  // A pagedge://auth/confirm deep link failed (stale/expired/already-used
  // token) — that error must only ever surface on the verify-email screen,
  // so force the modal there regardless of whatever tab the user had open.
  // It's never written into the signin/signup `error` state above.
  useEffect(() => {
    if (authTokenError) setMode('verify-email');
  }, [authTokenError]);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError('');
    setResendSent(false);
    clearAuthTokenError();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (mode === 'signup' && password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    setLoading(true);
    try {
      if (mode === 'signin') {
        const session = await signIn(email.trim(), password);
        const me = await getMe(session.access_token);
        setUser({ id: session.user_id, email: session.email, tier: session.tier, callsRemaining: me.calls_remaining, resetAt: me.ai_calls_reset_at });
        // Resume whatever gated action raised this overlay (if any), then
        // close it regardless — otherwise a successful sign-in here would
        // leave the form sitting on screen with no visible change.
        authPromptOnSuccess?.();
        dismissAuthPrompt();
      } else if (mode === 'signup') {
        // No tokens come back from signup — email verification is
        // required first, so show the "check your email" screen instead
        // of entering the app.
        await signUp(email.trim(), password);
        setMode('verify-email');
      }
    } catch (err) {
      if (err instanceof AuthApiError) {
        setError(err.message);
      } else if (err instanceof TypeError) {
        setError('Network error — check your connection and try again.');
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setResendLoading(true);
    setResendSent(false);
    try {
      await resendConfirmation(email.trim());
      setResendSent(true);
      clearAuthTokenError();
    } catch {
      // The backend always returns 200, so a failure here is a network
      // error — surface the same generic copy used elsewhere.
      setError('Network error — check your connection and try again.');
    } finally {
      setResendLoading(false);
    }
  };

  return (
    <div className="auth-overlay" onMouseDown={dismissAuthPrompt}>
      <div className="auth-modal" onMouseDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="auth-dismiss-x"
          onClick={dismissAuthPrompt}
          aria-label="Dismiss"
        >
          ×
        </button>

        <div className="auth-brand">
          <span className="auth-brand-mark">Pagedge</span>
        </div>

        {mode !== 'verify-email' && reason && (
          <p className="auth-reason-banner">{reason}</p>
        )}

        {mode === 'verify-email' ? (
          <div className="auth-verify">
            {authTokenError ? (
              <p className="auth-verify-text">
                That confirmation link is no longer valid — it may be expired or already used.
                {email.trim() ? ' Request a new one below, or sign in if your email is already confirmed.' : ' Please sign in, or request a new confirmation link if you haven’t confirmed yet.'}
              </p>
            ) : (
              <p className="auth-verify-text">
                Check your inbox. We sent a confirmation link to <strong>{email.trim()}</strong>.
                Click it to activate your account.
              </p>
            )}

            {resendSent && <p className="settings-feedback settings-feedback--ok">Confirmation email sent.</p>}
            {error && <p className="settings-feedback settings-feedback--err">{error}</p>}

            <button
              type="button"
              className="auth-submit-btn"
              onClick={handleResend}
              disabled={resendLoading || !email.trim()}
            >
              {resendLoading ? 'Sending…' : 'Resend confirmation email'}
            </button>

            <button type="button" className="auth-link-btn" onClick={() => switchMode('signin')}>
              Back to sign in
            </button>
          </div>
        ) : (
          <>
            <div className="auth-tabs">
              <button
                type="button"
                className={`auth-tab ${mode === 'signin' ? 'auth-tab--active' : ''}`}
                onClick={() => switchMode('signin')}
              >
                Sign In
              </button>
              <button
                type="button"
                className={`auth-tab ${mode === 'signup' ? 'auth-tab--active' : ''}`}
                onClick={() => switchMode('signup')}
              >
                Create Account
              </button>
            </div>

            <form className="auth-form" onSubmit={handleSubmit}>
              <div className="settings-field">
                <label className="settings-label">Email</label>
                <input
                  className="settings-input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  required
                  autoFocus
                />
              </div>

              <div className="settings-field">
                <label className="settings-label">Password</label>
                <input
                  className="settings-input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === 'signup' ? 'At least 8 characters' : '••••••••'}
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  minLength={mode === 'signup' ? 8 : undefined}
                  required
                />
              </div>

              {error && <p className="settings-feedback settings-feedback--err">{error}</p>}

              <button type="submit" className="auth-submit-btn" disabled={loading}>
                {loading
                  ? (mode === 'signin' ? 'Signing in…' : 'Creating account…')
                  : (mode === 'signin' ? 'Sign In' : 'Create Account')}
              </button>
            </form>

            <p className="auth-legal">
              By creating an account, you agree to our Terms of Service.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
