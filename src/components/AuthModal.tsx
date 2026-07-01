import { useState, FormEvent } from 'react';
import { signIn, signUp, getMe, AuthApiError } from '../services/authService';
import { useStore } from '../store';

type Mode = 'signin' | 'signup';

export function AuthModal() {
  const { setUser } = useStore();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const switchMode = (next: Mode) => {
    setMode(next);
    setError('');
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
      const session = mode === 'signin'
        ? await signIn(email.trim(), password)
        : await signUp(email.trim(), password);
      const me = await getMe(session.access_token);
      setUser({ id: session.user_id, email: session.email, tier: session.tier, callsRemaining: me.calls_remaining, resetAt: me.ai_calls_reset_at });
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

  return (
    <div className="auth-overlay">
      <div className="auth-modal">
        <div className="auth-brand">
          <span className="auth-brand-mark">Pagedge</span>
        </div>

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
      </div>
    </div>
  );
}
