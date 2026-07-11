import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { NoteEditor } from "./RightPanel";
import { exportNoteToPdf } from "../lib/noteExport";

/** Full-page standalone-note workspace (Notebook/Canvas Document). Follows
 * the same center-panel "manager view" pattern as DeckManager/TrashView —
 * mounted by MainArea whenever noteWorkspaceOpen is true. */
export function NoteWorkspace() {
  const { selectedNoteId, standaloneNotes, loadStandaloneNotes, setNoteWorkspaceOpen } = useStore();
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    loadStandaloneNotes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const note = standaloneNotes.find((n) => n.id === selectedNoteId) ?? null;

  if (!note) {
    return (
      <div className="note-workspace note-workspace--empty">
        <p className="note-workspace-empty-text">Loading note…</p>
      </div>
    );
  }

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    setExportResult(null);
    try {
      const outputPath = await exportNoteToPdf(note);
      if (outputPath === "") return; // user cancelled the save dialog
      setExportResult({ ok: true, msg: outputPath });
      setTimeout(() => setExportResult(null), 4000);
    } catch (err) {
      console.error("Failed to export note to PDF:", err);
      setExportResult({ ok: false, msg: String(err) });
    } finally {
      setExporting(false);
    }
  };

  const handleReveal = async () => {
    if (!exportResult?.ok) return;
    try {
      await invoke("reveal_in_folder", { path: exportResult.msg });
    } catch {
      // ignore — file was still exported
    }
  };

  return (
    <div className="note-workspace">
      <NoteEditor
        note={note}
        onBack={() => setNoteWorkspaceOpen(false)}
        fullPage
        extraHeaderActions={
          <button className="nw-export-btn" title="Export to PDF" onClick={handleExport} disabled={exporting}>
            {exporting ? "Exporting…" : "Export to PDF"}
          </button>
        }
      />
      {exportResult && (
        <div className={`nw-export-toast${exportResult.ok ? "" : " nw-export-toast--err"}`}>
          {exportResult.ok ? (
            <>
              <span>Exported to {exportResult.msg}</span>
              <button className="nw-export-toast-action" onClick={handleReveal}>Show in folder</button>
            </>
          ) : (
            <span>Export failed: {exportResult.msg}</span>
          )}
        </div>
      )}
    </div>
  );
}
