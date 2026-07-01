import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { useStore } from '../store';
import { startProCheckout, openBillingPortal } from '../services/stripeService';

const PROVIDER_URLS: Record<string, string> = {
  ollama:      'http://localhost:11434/v1',
  openai:      'https://api.openai.com/v1',
  groq:        'https://api.groq.com/openai/v1',
  gemini:      'https://generativelanguage.googleapis.com/v1beta/openai',
  openrouter:  'https://openrouter.ai/api/v1',
  anthropic:   'https://api.anthropic.com/v1',
};

const PROVIDERS = [
  { value: 'ollama',     label: 'Ollama (local)' },
  { value: 'openai',     label: 'OpenAI' },
  { value: 'groq',       label: 'Groq' },
  { value: 'gemini',     label: 'Gemini' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'anthropic',  label: 'Anthropic' },
];

type TestState = 'idle' | 'testing' | 'ok' | 'error';

const FREE_TIER_MONTHLY_CALLS = 30;

export function SettingsPanel() {
  const {
    settingsPanelOpen, setSettingsPanelOpen,
    aiProvider, aiModel, aiBaseUrl, aiApiKey, aiUseCustomProvider,
    setAiSettings,
    user, signOut,
  } = useStore();

  const [provider, setProvider] = useState(aiProvider);
  const [model, setModel]       = useState(aiModel);
  const [baseUrl, setBaseUrl]   = useState(aiBaseUrl);
  const [apiKey, setApiKey]     = useState(aiApiKey);
  const [useCustomProvider, setUseCustomProvider] = useState(aiUseCustomProvider);
  const [testState, setTestState] = useState<TestState>('idle');
  const [testError, setTestError] = useState('');
  const [saving, setSaving]     = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const [billingBusy, setBillingBusy] = useState(false);
  const [billingError, setBillingError] = useState('');

  useEffect(() => {
    getVersion().then(setAppVersion).catch(console.error);
  }, []);

  useEffect(() => {
    if (!settingsPanelOpen) return;
    setProvider(aiProvider);
    setModel(aiModel);
    setBaseUrl(aiBaseUrl);
    setApiKey(aiApiKey);
    setUseCustomProvider(aiUseCustomProvider);
    setTestState('idle');
    setTestError('');
  }, [settingsPanelOpen, aiProvider, aiModel, aiBaseUrl, aiApiKey, aiUseCustomProvider]);

  const handleProviderChange = (p: string) => {
    setProvider(p);
    if (PROVIDER_URLS[p]) setBaseUrl(PROVIDER_URLS[p]);
    setTestState('idle');
    setTestError('');
  };

  const handleTest = async () => {
    setTestState('testing');
    setTestError('');
    try {
      const auth = apiKey.trim() || 'ollama';
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${auth}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Say "OK" and nothing else.' },
          ],
          stream: false,
          max_tokens: 10,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      if (!data.choices?.[0]?.message?.content) throw new Error('Empty response');
      setTestState('ok');
    } catch (err) {
      setTestState('error');
      setTestError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await Promise.all([
        invoke('set_setting', { key: 'ai_provider', value: provider }),
        invoke('set_setting', { key: 'ai_model',    value: model    }),
        invoke('set_setting', { key: 'ai_base_url', value: baseUrl  }),
        invoke('set_setting', { key: 'ai_api_key',  value: apiKey   }),
        invoke('set_setting', { key: 'ai_use_custom_provider', value: String(useCustomProvider) }),
      ]);
      setAiSettings({ aiProvider: provider, aiModel: model, aiBaseUrl: baseUrl, aiApiKey: apiKey, aiUseCustomProvider: useCustomProvider });
      setSettingsPanelOpen(false);
    } catch (err) {
      console.error('Failed to save settings:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleUpgrade = async () => {
    setBillingError('');
    setBillingBusy(true);
    try {
      await startProCheckout();
    } catch (err) {
      setBillingError(err instanceof Error ? err.message : 'Failed to start checkout.');
    } finally {
      setBillingBusy(false);
    }
  };

  const handleManageSubscription = async () => {
    setBillingError('');
    setBillingBusy(true);
    try {
      await openBillingPortal();
    } catch (err) {
      setBillingError(err instanceof Error ? err.message : 'Failed to open billing portal.');
    } finally {
      setBillingBusy(false);
    }
  };

  if (!settingsPanelOpen) return null;

  return (
    <div className="settings-overlay" onMouseDown={() => setSettingsPanelOpen(false)}>
      <div className="settings-modal" onMouseDown={(e) => e.stopPropagation()}>

        <div className="settings-header">
          <span className="settings-title">AI Settings</span>
          <button className="icon-btn" onClick={() => setSettingsPanelOpen(false)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="settings-body">
          {user && (
            <div className="settings-account">
              <div className="settings-account-row">
                <span className="settings-account-email">{user.email}</span>
                <button className="settings-account-signout" onClick={() => signOut()}>
                  Sign out
                </button>
              </div>
              {user.tier === 'pro' ? (
                <div className="settings-account-row">
                  <span className="settings-account-quota">Pro Plan — Unlimited AI</span>
                  <button className="settings-account-signout" onClick={handleManageSubscription} disabled={billingBusy}>
                    Manage subscription
                  </button>
                </div>
              ) : (
                <div className="settings-account-row">
                  <span className="settings-account-quota">
                    Free Plan — {Math.max(0, FREE_TIER_MONTHLY_CALLS - (user.callsRemaining ?? FREE_TIER_MONTHLY_CALLS))} / {FREE_TIER_MONTHLY_CALLS} AI calls this month
                  </span>
                  <button className="settings-account-signout" onClick={handleUpgrade} disabled={billingBusy}>
                    Upgrade to Pro →
                  </button>
                </div>
              )}
              {billingError && <p className="settings-feedback settings-feedback--err">{billingError}</p>}
            </div>
          )}

          <div className="settings-field settings-field--row">
            <label className="settings-label" htmlFor="use-custom-provider">Use my own AI provider</label>
            <input
              id="use-custom-provider"
              type="checkbox"
              checked={useCustomProvider}
              onChange={(e) => setUseCustomProvider(e.target.checked)}
            />
          </div>

          {!useCustomProvider && (
            <p className="settings-feedback">
              AI calls route through Pagedge's built-in AI. Enable this to use your own Ollama or API-key-based provider instead.
            </p>
          )}

          {useCustomProvider && (
          <>
          <div className="settings-field">
            <label className="settings-label">Provider</label>
            <select
              className="settings-select"
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value)}
            >
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>

          <div className="settings-field">
            <label className="settings-label">Model</label>
            <input
              className="settings-input"
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="llama3.2"
              spellCheck={false}
            />
          </div>

          <div className="settings-field">
            <label className="settings-label">Base URL</label>
            <input
              className="settings-input"
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://localhost:11434/v1"
              spellCheck={false}
            />
          </div>

          <div className="settings-field">
            <label className="settings-label">API Key</label>
            <input
              className="settings-input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Leave empty for Ollama"
            />
          </div>

          {testState === 'ok' && (
            <p className="settings-feedback settings-feedback--ok">Connection successful</p>
          )}
          {testState === 'error' && (
            <p className="settings-feedback settings-feedback--err">{testError}</p>
          )}
          </>
          )}
        </div>

        <div className="settings-footer">
          {useCustomProvider && (
            <button
              className="settings-btn settings-btn--ghost"
              onClick={handleTest}
              disabled={testState === 'testing'}
            >
              {testState === 'testing' ? 'Testing…' : 'Test connection'}
            </button>
          )}
          <button
            className="settings-btn settings-btn--primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>

        {appVersion && (
          <p className="settings-version">Pagedge v{appVersion}</p>
        )}

      </div>
    </div>
  );
}
