import { useState, FormEvent } from 'react';
import { signIn, signUp, getMe, resendConfirmation, AuthApiError } from '../services/authService';
import { useStore } from '../store';

type Mode = 'signin' | 'signup' | 'verify-email';

export function AuthModal() {
  const { setUser } = useStore();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSent, setResendSent] = useState(false);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError('');
    setResendSent(false);
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
    } catch {
      // The backend always returns 200, so a failure here is a network
      // error — surface the same generic copy used elsewhere.
      setError('Network error — check your connection and try again.');
    } finally {
      setResendLoading(false);
    }
  };

  return (
    <div className="auth-overlay">
      <div className="auth-modal">
        <div className="auth-brand">
          <span className="auth-brand-mark">Pagedge</span>
        </div>

        {mode === 'verify-email' ? (
          <div className="auth-verify">
            <p className="auth-verify-text">
              Check your inbox. We sent a confirmation link to <strong>{email.trim()}</strong>.
              Click it to activate your account.
            </p>

            {resendSent && <p className="settings-feedback settings-feedback--ok">Confirmation email sent.</p>}
            {error && <p className="settings-feedback settings-feedback--err">{error}</p>}

            <button
              type="button"
              className="auth-submit-btn"
              onClick={handleResend}
              disabled={resendLoading}
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
