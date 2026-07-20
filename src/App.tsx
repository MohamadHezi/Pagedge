import { useEffect, useState, useRef } from "react";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { IconRail } from "./components/IconRail";
import { LibrarySidebar } from "./components/LibrarySidebar";
import { MainArea } from "./components/MainArea";
import { RightPanel } from "./components/RightPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { SummaryPanel } from "./components/SummaryPanel";
import { StudyGuidePanel } from "./components/StudyGuidePanel";
import { ComparePanel } from "./components/ComparePanel";
import { SearchModal } from "./components/SearchModal";
import { ExportDialog } from "./components/ExportDialog";
import { ReviewMode } from "./components/ReviewMode";
import { AuthModal } from "./components/AuthModal";
import { PaywallModal } from "./components/PaywallModal";
import { FeedbackButton } from "./components/FeedbackButton";
import { FeedbackModal } from "./components/FeedbackModal";
import { useStore } from "./store";
import { checkForUpdates } from "./services/updateService";
import { resendConfirmation } from "./services/authService";
import { pullAllOnForeground, refreshRemoteOnlyPdfs } from "./services/syncService";
import "./App.css";

// Persisted (survives app restarts, unlike a ref) so that if the deep-link
// plugin ever replays the same startup URL on a later, ordinary launch —
// a known platform quirk — an already-consumed confirmation token is not
// reprocessed and re-thrown as a stale "Invalid or expired token" error.
const PROCESSED_AUTH_TOKEN_KEY = 'pagedge_last_processed_auth_token';
const PROCESSED_RESET_TOKEN_KEY = 'pagedge_last_processed_reset_token';

function App() {
  const {
    loadPdfs, loadAiSettings, loadUiPrefs, selectedPdfId, setSearchModalOpen,
    initAuth, authLoading, user,
    refreshUserFromMe, closePaywall, completeEmailVerification,
    emailVerifyToastOpen, dismissEmailVerifyToast,
    authPromptOpen, authPromptReason, requireAuth, setPasswordResetToken,
    loadFolders, loadLastSyncedAt,
  } = useStore();

  const [appToast, setAppToast] = useState<string | null>(null);
  const appToastTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const showAppToast = (msg: string) => {
    clearTimeout(appToastTimerRef.current);
    setAppToast(msg);
    appToastTimerRef.current = setTimeout(() => setAppToast(null), 3500);
  };

  useEffect(() => {
    loadPdfs().catch(console.error);
    loadFolders().catch(console.error);
    loadAiSettings().catch(console.error);
    loadUiPrefs().catch(console.error);
    initAuth();
    checkForUpdates();
    refreshRemoteOnlyPdfs().catch(console.error);
    loadLastSyncedAt().catch(console.error);
  }, [loadPdfs, loadFolders, loadAiSettings, loadUiPrefs, initAuth, loadLastSyncedAt]);

  // pagedge://stripe-success / pagedge://stripe-cancel — fired when Stripe
  // Checkout / the billing portal redirects back to the desktop app.
  // pagedge://auth/confirm — fired when Supabase's email confirmation link
  // redirects back. Supabase appends the minted access/refresh tokens as a
  // URL fragment (the same implicit-grant shape used for OAuth), so the
  // deep link itself carries everything needed to log the user in.
  useEffect(() => {
    const unlistenPromise = onOpenUrl((urls) => {
      const url = urls[0];
      if (!url) return;
      if (url.startsWith('pagedge://stripe-success')) {
        refreshUserFromMe().then(() => {
          showAppToast('Welcome to Pro! Unlimited AI is now active.');
          closePaywall();
        });
      } else if (url.startsWith('pagedge://stripe-cancel')) {
        showAppToast("No worries — you're still on the free plan.");
      } else if (url.startsWith('pagedge://auth/confirm')) {
        const hash = new URL(url).hash.replace(/^#/, '');
        const params = new URLSearchParams(hash);
        const accessToken = params.get('access_token');
        const refreshToken = params.get('refresh_token');

        // Only a URL that actually carries a token fragment means the app
        // was opened BY this deep link. A bare `pagedge://auth/confirm`
        // (e.g. a stale launch-arg replay with no fragment) is not that —
        // ignore it rather than guessing at a fallback action.
        if (!accessToken || !refreshToken) return;

        // The token is single-use / short-lived. If we've already consumed
        // this exact one (this session or a previous launch), don't process
        // it again — that would just reject with a stale "Invalid or
        // expired token" error every time the app starts.
        if (localStorage.getItem(PROCESSED_AUTH_TOKEN_KEY) === accessToken) return;
        localStorage.setItem(PROCESSED_AUTH_TOKEN_KEY, accessToken);

        completeEmailVerification(accessToken, refreshToken).then(() => {
          showAppToast('Email confirmed! Welcome to Pagedge.');
        });
      } else if (url.startsWith('pagedge://auth/reset')) {
        // Supabase's password-recovery redirect — same implicit-grant
        // fragment shape as auth/confirm, but this token is only used to
        // authorize a single password change (via reset-password below),
        // never saved as a session.
        const hash = new URL(url).hash.replace(/^#/, '');
        const params = new URLSearchParams(hash);
        const accessToken = params.get('access_token');
        if (!accessToken) return;

        if (localStorage.getItem(PROCESSED_RESET_TOKEN_KEY) === accessToken) return;
        localStorage.setItem(PROCESSED_RESET_TOKEN_KEY, accessToken);

        setPasswordResetToken(accessToken);
        requireAuth();
      }
    });
    return () => { unlistenPromise.then((unlisten) => unlisten()); };
  }, [refreshUserFromMe, closePaywall, completeEmailVerification, setPasswordResetToken, requireAuth]);

  // Sync pull whenever the app regains focus (switching back from another
  // window/app) — scoped per-PDF inside pullAllOnForeground itself.
  useEffect(() => {
    const onFocus = () => { pullAllOnForeground().catch(console.error); };
    const onVisibility = () => { if (document.visibilityState === 'visible') onFocus(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Launch splash lives in index.html (outside #root) so it paints before
  // the JS bundle loads. Fade it out once the startup session check
  // resolves, holding it on screen long enough that a fast resolve doesn't
  // read as a flicker. performance.now() is time since navigation start,
  // i.e. total time the splash has already been visible.
  useEffect(() => {
    if (authLoading) return;
    const splash = document.getElementById('splash');
    if (!splash) return;
    const dismiss = () => {
      splash.classList.add('splash-done');
      // Past the 340ms opacity/transform transition (0ms under reduced motion).
      window.setTimeout(() => splash.remove(), 450);
    };
    // Long enough for the full entrance choreography (~1.15s, see the
    // timeline comment in index.html) to land before the fade begins.
    const MIN_SPLASH_MS = 1200;
    const remaining = MIN_SPLASH_MS - performance.now();
    if (remaining > 0) {
      const t = window.setTimeout(dismiss, remaining);
      return () => window.clearTimeout(t);
    }
    dismiss();
  }, [authLoading]);

  // Ctrl+K / Cmd+K global shortcut to open search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setSearchModalOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setSearchModalOpen]);

  if (authLoading) {
    return <div className="app-shell auth-loading-shell" />;
  }

  return (
    <div className="app-shell">
      <div className="app-body">
        <IconRail />
        <LibrarySidebar />
        <MainArea />
        {selectedPdfId && <RightPanel />}
      </div>
      <SettingsPanel />
      <SummaryPanel />
      <StudyGuidePanel />
      <ComparePanel />
      <SearchModal />
      <ExportDialog />
      <ReviewMode />
      <PaywallModal />
      {authPromptOpen && <AuthModal reason={authPromptReason ?? undefined} />}
      <FeedbackButton />
      <FeedbackModal />
      {appToast && <div className="app-toast">{appToast}</div>}
      {emailVerifyToastOpen && user && (
        <div className="app-toast app-toast--action">
          <span>Please verify your email to use AI features. Check your inbox for a confirmation link.</span>
          <button
            type="button"
            className="app-toast-link"
            onClick={() => {
              resendConfirmation(user.email).catch(() => {});
              showAppToast('Confirmation email sent.');
              dismissEmailVerifyToast();
            }}
          >
            Resend confirmation
          </button>
          <button type="button" className="app-toast-dismiss" onClick={dismissEmailVerifyToast} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
    </div>
  );
}

export default App;
