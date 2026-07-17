import { invoke } from "@tauri-apps/api/core";

// The PDF viewer and the ingestion pipeline each independently load a
// document's full bytes on open (viewer: to render; ingestion: to extract
// text for search/chat). For a freshly-imported, not-yet-indexed PDF that's
// opened right away, both fire at once — doubling the disk read and IPC
// transfer of the same (potentially very large) file at the exact moment
// the user is waiting for it to open.
//
// This dedupes concurrent read_file calls for the same path: the first
// caller triggers the actual invoke, later callers arriving before it
// resolves get the same in-flight promise instead of starting their own.
// Each caller still gets its own independent copy of the bytes (see
// readPdfBytes below) — this only saves the expensive disk I/O + IPC
// transfer, not the parsed pdf.js document itself, so there's no shared
// PDFDocumentProxy lifecycle/cleanup ownership to get wrong.
const inFlightReads = new Map<string, Promise<ArrayBuffer>>();

function readFileDeduped(path: string): Promise<ArrayBuffer> {
  let pending = inFlightReads.get(path);
  if (!pending) {
    pending = invoke<ArrayBuffer>("read_file", { path }).finally(() => {
      inFlightReads.delete(path);
    });
    inFlightReads.set(path, pending);
  }
  return pending;
}

// Returns a fresh Uint8Array over its own copy of the bytes. Cloning (not
// just viewing the shared buffer) matters because pdf.js may transfer the
// buffer it's given to its internal worker, which would detach it out from
// under any other consumer still holding a view over the same buffer.
export async function readPdfBytes(path: string): Promise<Uint8Array> {
  const buf = await readFileDeduped(path);
  return new Uint8Array(buf.slice(0));
}
