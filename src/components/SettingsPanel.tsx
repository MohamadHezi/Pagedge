import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { useStore } from '../store';

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
    aiProvider, aiModel, aiBaseUrl, aiApiKey,
    setAiSettings,
    user, signOut,
  } = useStore();

  const [provider, setProvider] = useState(aiProvider);
  const [model, setModel]       = useState(aiModel);
  const [baseUrl, setBaseUrl]   = useState(aiBaseUrl);
  const [apiKey, setApiKey]     = useState(aiApiKey);
  const [testState, setTestState] = useState<TestState>('idle');
  const [testError, setTestError] = useState('');
  const [saving, setSaving]     = useState(false);
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    getVersion().then(setAppVersion).catch(console.error);
  }, []);

  useEffect(() => {
    if (!settingsPanelOpen) return;
    setProvider(aiProvider);
    setModel(aiModel);
    setBaseUrl(aiBaseUrl);
    setApiKey(aiApiKey);
    setTestState('idle');
    setTestError('');
  }, [settingsPanelOpen, aiProvider, aiModel, aiBaseUrl, aiApiKey]);

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
      ]);
      setAiSettings({ aiProvider: provider, aiModel: model, aiBaseUrl: baseUrl, aiApiKey: apiKey });
      setSettingsPanelOpen(false);
    } catch (err) {
      console.error('Failed to save settings:', err);
    } finally {
      setSaving(false);
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
              {user.tier === 'free' && (
                <span className="settings-account-quota">
                  AI Calls: {Math.max(0, FREE_TIER_MONTHLY_CALLS - (user.callsRemaining ?? FREE_TIER_MONTHLY_CALLS))} / {FREE_TIER_MONTHLY_CALLS} this month
                </span>
              )}
            </div>
          )}

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
        </div>

        <div className="settings-footer">
          <button
            className="settings-btn settings-btn--ghost"
            onClick={handleTest}
            disabled={testState === 'testing'}
          >
            {testState === 'testing' ? 'Testing…' : 'Test connection'}
          </button>
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
