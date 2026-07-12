import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { useStore } from '../store';
import { startProCheckout, openBillingPortal } from '../services/stripeService';
import { FREE_TIER_MONTHLY_CALLS } from '../services/aiService';
import { FREE_TIER_PDF_LIMIT } from '../store';

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
type SettingsTab = 'account' | 'editor' | 'data';

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? '' : 's'} ago`;
}

export function SettingsPanel() {
  const {
    isAuthenticated, requireAuth,
    settingsPanelOpen, setSettingsPanelOpen,
    aiProvider, aiModel, aiBaseUrl, aiApiKey, aiUseCustomProvider,
    setAiSettings,
    editorFontSize, editorLineWrap, setUiPrefs,
    user, signOut, syncStatus, lastSyncedAt, pdfs,
  } = useStore();

  const [activeTab, setActiveTab] = useState<SettingsTab>('account');

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

  const [fontSize, setFontSize] = useState(editorFontSize);
  const [lineWrap, setLineWrap] = useState(editorLineWrap);

  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(console.error);
  }, []);

  useEffect(() => {
    if (!settingsPanelOpen) return;
    setActiveTab('account');
    setProvider(aiProvider);
    setModel(aiModel);
    setBaseUrl(aiBaseUrl);
    setApiKey(aiApiKey);
    setUseCustomProvider(aiUseCustomProvider);
    setTestState('idle');
    setTestError('');
    setFontSize(editorFontSize);
    setLineWrap(editorLineWrap);
    setExportResult(null);
    // Reset any unsaved live-preview CSS var back to the persisted value
    // so a prior unsaved drag doesn't leak into a fresh panel open.
    document.documentElement.style.setProperty('--note-font-size', `${editorFontSize}px`);
  }, [settingsPanelOpen, aiProvider, aiModel, aiBaseUrl, aiApiKey, aiUseCustomProvider, editorFontSize, editorLineWrap]);

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
        invoke('set_setting', { key: 'editor_font_size', value: String(fontSize) }),
        invoke('set_setting', { key: 'editor_line_wrap', value: String(lineWrap) }),
      ]);
      setAiSettings({ aiProvider: provider, aiModel: model, aiBaseUrl: baseUrl, aiApiKey: apiKey, aiUseCustomProvider: useCustomProvider });
      setUiPrefs({ editorFontSize: fontSize, editorLineWrap: lineWrap });
      setSettingsPanelOpen(false);
    } catch (err) {
      console.error('Failed to save settings:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleExportLibrary = async () => {
    setExporting(true);
    setExportResult(null);
    try {
      const [pdfsJson, notesJson, highlightsJson, flashcardsJson] = await Promise.all([
        invoke<string>('get_pdfs'),
        invoke<string>('get_notes', { pdfId: null, includeDeleted: false }),
        invoke<string>('get_all_highlights'),
        invoke<string>('get_all_flashcards'),
      ]);
      const payload = {
        exported_at: new Date().toISOString(),
        pdfs: JSON.parse(pdfsJson),
        notes: JSON.parse(notesJson),
        highlights: JSON.parse(highlightsJson),
        flashcards: JSON.parse(flashcardsJson),
      };
      const outputPath = await invoke<string>('save_text_file', {
        defaultFilename: 'pagedge-library-export.json',
        content: JSON.stringify(payload, null, 2),
      });
      if (outputPath === '') { setExporting(false); return; } // user cancelled
      setExportResult({ ok: true, msg: outputPath });
    } catch (err) {
      setExportResult({ ok: false, msg: err instanceof Error ? err.message : String(err) });
    } finally {
      setExporting(false);
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
    if (!isAuthenticated) return requireAuth('Sign in to manage your subscription', () => handleManageSubscription());
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
          <span className="settings-title">Settings</span>
          <button className="icon-btn" onClick={() => setSettingsPanelOpen(false)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="settings-tabs">
          <button className={`settings-tab${activeTab === 'account' ? ' settings-tab--active' : ''}`} onClick={() => setActiveTab('account')}>Account</button>
          <button className={`settings-tab${activeTab === 'editor' ? ' settings-tab--active' : ''}`} onClick={() => setActiveTab('editor')}>Editor</button>
          <button className={`settings-tab${activeTab === 'data' ? ' settings-tab--active' : ''}`} onClick={() => setActiveTab('data')}>Data</button>
        </div>

        <div className="settings-body">
          {activeTab === 'account' && (
          <>
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
              {user.tier === 'free' && (
                <div className="settings-account-row">
                  <span className={`settings-account-quota${pdfs.length >= FREE_TIER_PDF_LIMIT ? ' settings-account-quota--warn' : ''}`}>
                    {pdfs.length} / {FREE_TIER_PDF_LIMIT} PDFs in your library
                  </span>
                </div>
              )}
              <div className="settings-account-row">
                {user.tier === 'pro' ? (
                  <span className="settings-account-quota">
                    {syncStatus === 'syncing'
                      ? 'Backing up…'
                      : lastSyncedAt
                        ? `Backed up · synced ${formatRelativeTime(lastSyncedAt)}`
                        : 'Backup enabled — syncing shortly'}
                  </span>
                ) : (
                  <span className="settings-account-quota settings-account-quota--warn">
                    Not backed up — highlights, notes, and flashcards live only on this device
                  </span>
                )}
              </div>
              {billingError && <p className="settings-feedback settings-feedback--err">{billingError}</p>}
            </div>
          )}

          {isAuthenticated && (
          <>
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
          </>
          )}

          {!isAuthenticated && (
            <p className="settings-feedback">
              Sign in to configure AI provider settings.
            </p>
          )}
          </>
          )}

          {activeTab === 'editor' && (
            <div className="settings-tab-panel">
              <div className="settings-field">
                <label className="settings-label" htmlFor="editor-font-size">
                  Note editor font size — {fontSize}px
                </label>
                <input
                  id="editor-font-size"
                  className="settings-slider"
                  type="range"
                  min={11}
                  max={20}
                  step={1}
                  value={fontSize}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setFontSize(v);
                    document.documentElement.style.setProperty('--note-font-size', `${v}px`);
                  }}
                />
              </div>

              <div className="settings-field settings-field--row">
                <label className="settings-label" htmlFor="editor-line-wrap">Wrap long lines</label>
                <input
                  id="editor-line-wrap"
                  type="checkbox"
                  checked={lineWrap}
                  onChange={(e) => setLineWrap(e.target.checked)}
                />
              </div>

              <p className="settings-feedback">
                Applies to the notes markdown editor.
              </p>
            </div>
          )}

          {activeTab === 'data' && (
            <div className="settings-tab-panel">
              <button
                className="settings-btn settings-btn--ghost"
                onClick={handleExportLibrary}
                disabled={exporting}
              >
                {exporting ? 'Exporting…' : 'Export Library Data'}
              </button>
              <p className="settings-feedback">
                Exports all PDFs metadata, notes, highlights, and flashcards as a single JSON backup file.
              </p>
              {exportResult && (
                <p className={`settings-feedback ${exportResult.ok ? 'settings-feedback--ok' : 'settings-feedback--err'}`}>
                  {exportResult.ok ? `Saved to ${exportResult.msg}` : exportResult.msg}
                </p>
              )}
            </div>
          )}
        </div>

        {activeTab !== 'data' && (
          <div className="settings-footer">
            {activeTab === 'account' && isAuthenticated && useCustomProvider && (
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
        )}

        {appVersion && (
          <p className="settings-version">Pagedge v{appVersion}</p>
        )}

      </div>
    </div>
  );
}
