import { useEffect, useState, useRef } from "react";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { IconRail } from "./components/IconRail";
import { LibrarySidebar } from "./components/LibrarySidebar";
import { MainArea } from "./components/MainArea";
import { RightPanel } from "./components/RightPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { SummaryPanel } from "./components/SummaryPanel";
import { SearchModal } from "./components/SearchModal";
import { ExportDialog } from "./components/ExportDialog";
import { ReviewMode } from "./components/ReviewMode";
import { AuthModal } from "./components/AuthModal";
import { PaywallModal } from "./components/PaywallModal";
import { useStore } from "./store";
import { checkForUpdates } from "./services/updateService";
import { resendConfirmation } from "./services/authService";
import "./App.css";

function App() {
  const {
    loadPdfs, loadAiSettings, selectedPdfId, setSearchModalOpen,
    initAuth, isAuthenticated, authLoading, user,
    refreshUserFromMe, closePaywall, completeEmailVerification,
    emailVerifyToastOpen, dismissEmailVerifyToast,
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
    loadAiSettings().catch(console.error);
    initAuth();
    checkForUpdates();
  }, [loadPdfs, loadAiSettings, initAuth]);

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
        if (accessToken && refreshToken) {
          completeEmailVerification(accessToken, refreshToken).then(() => {
            showAppToast('Email confirmed! Welcome to Pagedge.');
          });
        } else {
          refreshUserFromMe().then(() => {
            showAppToast('Email confirmed — you can now sign in.');
          });
        }
      }
    });
    return () => { unlistenPromise.then((unlisten) => unlisten()); };
  }, [refreshUserFromMe, closePaywall, completeEmailVerification]);

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

  if (!isAuthenticated) {
    return (
      <div className="app-shell">
        <AuthModal />
      </div>
    );
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
      <SearchModal />
      <ExportDialog />
      <ReviewMode />
      <PaywallModal />
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
