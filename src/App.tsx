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
import { useStore } from "./store";
import "./App.css";

function App() {
  const { loadPdfs, loadAiSettings, selectedPdfId, setSearchModalOpen } = useStore();

  useEffect(() => {
    loadPdfs().catch(console.error);
    loadAiSettings().catch(console.error);
  }, [loadPdfs, loadAiSettings]);

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
