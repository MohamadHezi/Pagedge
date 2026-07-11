import type { Note } from "../types";

export function isStandaloneNote(note: Note): boolean {
  return note.source_pdf_id == null;
}
