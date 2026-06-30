import { useEffect } from "react";
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
import { useStore } from "./store";
import { checkForUpdates } from "./services/updateService";
import "./App.css";

function App() {
  const {
    loadPdfs, loadAiSettings, selectedPdfId, setSearchModalOpen,
    initAuth, isAuthenticated, authLoading,
  } = useStore();

  useEffect(() => {
    loadPdfs().catch(console.error);
    loadAiSettings().catch(console.error);
    initAuth();
    checkForUpdates();
  }, [loadPdfs, loadAiSettings, initAuth]);

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
    </div>
  );
}

export default App;
