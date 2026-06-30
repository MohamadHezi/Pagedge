import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";

export function ExportDialog() {
  const { exportDialogOpen, setExportDialogOpen, selectedPdfId, pdfs } = useStore();

  const [includeHighlights, setIncludeHighlights] = useState(true);
  const [includeDrawings, setIncludeDrawings] = useState(true);
  const [includeTextBoxes, setIncludeTextBoxes] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    if (exportDialogOpen) {
      setResult(null);
      setExporting(false);
    }
  }, [exportDialogOpen]);

  useEffect(() => {
    if (!exportDialogOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExportDialogOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exportDialogOpen, setExportDialogOpen]);

  if (!exportDialogOpen || !selectedPdfId) return null;

  const currentPdf = pdfs.find((p) => p.id === selectedPdfId);
  const filename = currentPdf?.filename ?? "document.pdf";

  const handleExport = async () => {
    if (!selectedPdfId) return;
    setExporting(true);
    setResult(null);
    try {
      const outputPath = await invoke<string>("export_annotated_pdf", {
        pdfId: selectedPdfId,
        includeHighlights,
        includeDrawings,
        includeTextBoxes,
      });
      if (outputPath === "") {
        // Save dialog was cancelled
        setExportDialogOpen(false);
        return;
      }
      setResult({ ok: true, msg: outputPath });
      setTimeout(() => setExportDialogOpen(false), 3000);
    } catch (err) {
      setResult({ ok: false, msg: String(err) });
    } finally {
      setExporting(false);
    }
  };

  const handleReveal = async () => {
    if (result?.ok) {
      try {
        await invoke("reveal_in_folder", { path: result.msg });
      } catch {
        // ignore — file was still exported
      }
    }
  };

  const noneSelected = !includeHighlights && !includeDrawings && !includeTextBoxes;

  return (
    <div
      className="search-overlay"
      onMouseDown={() => !exporting && setExportDialogOpen(false)}
    >
      <div className="export-dialog" onMouseDown={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="export-dialog-header">
          <div className="export-dialog-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </div>
          <div>
            <div className="export-dialog-title">Export Annotated PDF</div>
            <div className="export-dialog-subtitle">{filename}</div>
          </div>
        </div>

        {/* Options */}
        <div className="export-dialog-options">
          <label className="export-option">
            <input
              type="checkbox"
              checked={includeHighlights}
              onChange={(e) => setIncludeHighlights(e.target.checked)}
              disabled={exporting}
            />
            <span className="export-option-dot" style={{ background: "var(--hl-yellow)" }} />
            <span>Highlights</span>
          </label>
          <label className="export-option">
            <input
              type="checkbox"
              checked={includeDrawings}
              onChange={(e) => setIncludeDrawings(e.target.checked)}
              disabled={exporting}
            />
            <span className="export-option-dot export-option-dot--stroke" />
            <span>Drawings</span>
          </label>
          <label className="export-option">
            <input
              type="checkbox"
              checked={includeTextBoxes}
              onChange={(e) => setIncludeTextBoxes(e.target.checked)}
              disabled={exporting}
            />
            <span className="export-option-dot export-option-dot--text">T</span>
            <span>Text Boxes</span>
          </label>
        </div>

        {/* Result message */}
        {result && (
          <div className={`export-result ${result.ok ? "export-result--ok" : "export-result--err"}`}>
            {result.ok ? (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span className="export-result-path">{result.msg}</span>
                <button className="export-reveal-btn" onClick={handleReveal} title="Show in folder">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                </button>
              </>
            ) : (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span>{result.msg}</span>
              </>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="export-dialog-footer">
          <button
            className="export-btn export-btn--cancel"
            onClick={() => setExportDialogOpen(false)}
            disabled={exporting}
          >
            Cancel
          </button>
          <button
            className="export-btn export-btn--primary"
            onClick={handleExport}
            disabled={exporting || noneSelected}
          >
            {exporting ? (
              <>
                <span className="export-spinner" />
                Exporting…
              </>
            ) : (
              "Export PDF"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
