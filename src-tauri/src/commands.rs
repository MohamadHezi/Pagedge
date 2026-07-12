use chrono::Utc;
use lopdf;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize)]
pub struct Pdf {
    pub id: String,
    pub filename: String,
    pub filepath: String,
    pub folder_id: Option<String>,
    pub page_count: Option<i64>,
    pub pages_read: i64,
    pub chunk_count: Option<i64>,
    pub ingested_at: Option<String>,
    pub last_opened: Option<String>,
    pub content_hash: Option<String>,
    pub is_pinned: bool,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub order_index: i64,
    pub created_at: String,
    pub is_pinned: bool,
}

fn db_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("pagedge.db"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_file_dialog(app: AppHandle) -> Result<Vec<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let files = app
        .dialog()
        .file()
        .add_filter("PDF Files", &["pdf"])
        .blocking_pick_files();

    match files {
        Some(paths) => Ok(paths.iter().map(|p| p.to_string()).collect()),
        None => Ok(vec![]),
    }
}

#[tauri::command]
pub fn read_file(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_app_data_dir(app: AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_dir_if_not_exists(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_pdf(app: AppHandle, filepath: String) -> Result<String, String> {
    let filename = std::path::Path::new(&filepath)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown.pdf")
        .to_string();

    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;

    let new_id = Uuid::new_v4().to_string();
    let ingested_at = Utc::now().to_rfc3339();

    let rows_changed = conn
        .execute(
            "INSERT OR IGNORE INTO pdfs
             (id, filename, filepath, folder_id, page_count, pages_read, chunk_count, ingested_at, last_opened)
             VALUES (?1, ?2, ?3, NULL, NULL, 0, 0, ?4, NULL)",
            rusqlite::params![new_id, filename, filepath, ingested_at],
        )
        .map_err(|e| e.to_string())?;

    // rows_changed == 0 means filepath already existed; fetch and return the
    // existing row so the frontend can deduplicate by id.
    let pdf = if rows_changed == 0 {
        let mut pdf = conn.query_row(
            "SELECT id, filename, filepath, folder_id, page_count, pages_read, chunk_count, ingested_at, last_opened, content_hash, is_pinned, deleted_at
             FROM pdfs WHERE filepath = ?1",
            rusqlite::params![filepath],
            |row| {
                Ok(Pdf {
                    id: row.get(0)?,
                    filename: row.get(1)?,
                    filepath: row.get(2)?,
                    folder_id: row.get(3)?,
                    page_count: row.get(4)?,
                    pages_read: row.get(5)?,
                    chunk_count: row.get(6)?,
                    ingested_at: row.get(7)?,
                    last_opened: row.get(8)?,
                    content_hash: row.get(9)?,
                    is_pinned: row.get::<_, i64>(10)? != 0,
                    deleted_at: row.get(11)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;

        // Re-importing a file whose row is currently trashed should un-trash it
        // rather than leave an invisible zombie row that never shows in the Library.
        if pdf.deleted_at.is_some() {
            conn.execute(
                "UPDATE pdfs SET deleted_at = NULL WHERE id = ?1",
                rusqlite::params![pdf.id],
            )
            .map_err(|e| e.to_string())?;
            pdf.deleted_at = None;
        }

        pdf
    } else {
        Pdf {
            id: new_id,
            filename,
            filepath,
            folder_id: None,
            page_count: None,
            pages_read: 0,
            chunk_count: Some(0),
            ingested_at: Some(ingested_at),
            last_opened: None,
            content_hash: None,
            is_pinned: false,
            deleted_at: None,
        }
    };

    serde_json::to_string(&pdf).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_pdf(app: AppHandle, id: String) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    // Cascade in dependency order: child rows first, then the pdf row itself.
    // flashcards.source_highlight_id FKs into highlights(id), so flashcards must
    // be deleted before highlights or the FK constraint fails on this delete.
    conn.execute("DELETE FROM flashcards WHERE pdf_id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM highlights WHERE pdf_id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM chunks WHERE source_id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM drawings WHERE pdf_id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM text_boxes WHERE pdf_id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM outline_items WHERE pdf_id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    // Notes are hard-deleted like every other child row — a local, no-tombstone
    // delete that is never pushed to the server, so synced copies on other
    // devices survive and re-importing the same file re-pulls them.
    conn.execute("DELETE FROM notes WHERE source_pdf_id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM pdfs WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn trash_pdf(app: AppHandle, id: String) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE pdfs SET deleted_at = ?1 WHERE id = ?2",
        rusqlite::params![now, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn restore_pdf(app: AppHandle, id: String) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE pdfs SET deleted_at = NULL WHERE id = ?1",
        rusqlite::params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_trashed_pdfs(app: AppHandle) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, filename, filepath, folder_id, page_count, pages_read, chunk_count, ingested_at, last_opened, content_hash, is_pinned, deleted_at
             FROM pdfs WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let pdfs: Vec<Pdf> = stmt
        .query_map([], |row| {
            Ok(Pdf {
                id: row.get(0)?,
                filename: row.get(1)?,
                filepath: row.get(2)?,
                folder_id: row.get(3)?,
                page_count: row.get(4)?,
                pages_read: row.get(5)?,
                chunk_count: row.get(6)?,
                ingested_at: row.get(7)?,
                last_opened: row.get(8)?,
                content_hash: row.get(9)?,
                is_pinned: row.get::<_, i64>(10)? != 0,
                deleted_at: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    serde_json::to_string(&pdfs).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_pdf(app: AppHandle, id: String, filename: String) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE pdfs SET filename = ?1 WHERE id = ?2",
        rusqlite::params![filename, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn update_last_opened(app: AppHandle, id: String) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE pdfs SET last_opened = ?1 WHERE id = ?2",
        rusqlite::params![now, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// Streams the file in fixed-size chunks rather than reading it fully into
// memory first — PDFs can be large and this runs on every import.
fn hash_file_sha256(filepath: &str) -> Result<String, String> {
    let mut file = std::fs::File::open(filepath).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[tauri::command]
pub fn update_pdf_content_hash(app: AppHandle, id: String, filepath: String) -> Result<String, String> {
    let content_hash = hash_file_sha256(&filepath)?;
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE pdfs SET content_hash = ?1 WHERE id = ?2",
        rusqlite::params![content_hash, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(content_hash)
}

// ── Sync: pending PDF annotations ───────────────────────────────────────────
// Local cache of "another device has already synced highlights/notes/
// flashcards for this exact PDF (by content_hash), but this device doesn't
// have the file yet (or just added it)." Populated opportunistically by
// syncService.ts's pull cycle (see PENDING_SELECT usage below) and consumed
// by the "N highlights available from another device" import prompt.

#[derive(Debug, Serialize, Deserialize)]
pub struct PendingPdfAnnotation {
    pub content_hash: String,
    pub pdf_display_name: String,
    pub highlight_count: i64,
    pub note_count: i64,
    pub flashcard_count: i64,
    pub fetched_at: String,
    pub payload_json: Option<String>,
}

const PENDING_SELECT: &str = "SELECT content_hash, pdf_display_name, highlight_count, note_count, \
    flashcard_count, fetched_at, payload_json FROM pending_pdf_annotations";

fn row_to_pending(row: &rusqlite::Row<'_>) -> rusqlite::Result<PendingPdfAnnotation> {
    Ok(PendingPdfAnnotation {
        content_hash: row.get(0)?,
        pdf_display_name: row.get(1)?,
        highlight_count: row.get(2)?,
        note_count: row.get(3)?,
        flashcard_count: row.get(4)?,
        fetched_at: row.get(5)?,
        payload_json: row.get(6)?,
    })
}

#[tauri::command]
pub fn upsert_pending_pdf_annotation(
    app: AppHandle,
    content_hash: String,
    pdf_display_name: String,
    highlight_count: i64,
    note_count: i64,
    flashcard_count: i64,
    payload_json: Option<String>,
) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let fetched_at = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO pending_pdf_annotations
            (content_hash, pdf_display_name, highlight_count, note_count, flashcard_count, fetched_at, payload_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(content_hash) DO UPDATE SET
            pdf_display_name = excluded.pdf_display_name,
            highlight_count  = excluded.highlight_count,
            note_count       = excluded.note_count,
            flashcard_count  = excluded.flashcard_count,
            fetched_at       = excluded.fetched_at,
            payload_json     = excluded.payload_json",
        rusqlite::params![
            content_hash, pdf_display_name, highlight_count, note_count, flashcard_count, fetched_at, payload_json
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_pending_pdf_annotation(app: AppHandle, content_hash: String) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let row: Option<PendingPdfAnnotation> = conn
        .query_row(
            &format!("{PENDING_SELECT} WHERE content_hash = ?1"),
            rusqlite::params![content_hash],
            row_to_pending,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    serde_json::to_string(&row).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_all_pending_pdf_annotations(app: AppHandle) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(PENDING_SELECT).map_err(|e| e.to_string())?;
    let rows: Vec<PendingPdfAnnotation> = stmt
        .query_map([], row_to_pending)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    serde_json::to_string(&rows).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_pending_pdf_annotation(app: AppHandle, content_hash: String) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM pending_pdf_annotations WHERE content_hash = ?1",
        rusqlite::params![content_hash],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Deserialize)]
struct MaterializeHighlight {
    id: String,
    page: i64,
    color: String,
    selected_text: String,
    position_x: f64,
    position_y: f64,
    position_w: f64,
    position_h: f64,
    rects_json: Option<String>,
    note: Option<String>,
    updated_at: Option<String>,
    #[serde(default)]
    deleted_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MaterializeNote {
    id: String,
    title: Option<String>,
    content_markdown: Option<String>,
    source_page: Option<i64>,
    tags: Option<serde_json::Value>,
    updated_at: Option<String>,
    #[serde(default)]
    deleted_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MaterializeFlashcard {
    id: String,
    source_highlight_id: String,
    page: i64,
    front: String,
    back: String,
    // Defaulted so payloads cached before the SRS→confidence migration
    // (which carry interval/ease_factor/repetitions/next_review instead)
    // still deserialize — serde ignores their unknown old fields.
    #[serde(default)]
    confidence_level: i64,
    #[serde(default)]
    last_reviewed_at: Option<String>,
    updated_at: Option<String>,
    #[serde(default)]
    deleted_at: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct MaterializePayload {
    #[serde(default)]
    highlights: Vec<MaterializeHighlight>,
    #[serde(default)]
    notes: Vec<MaterializeNote>,
    #[serde(default)]
    flashcards: Vec<MaterializeFlashcard>,
}

#[derive(Debug, Serialize)]
pub struct MaterializeResult {
    pub highlights: Vec<Highlight>,
    pub notes: Vec<Note>,
    pub flashcards: Vec<Flashcard>,
}

// Reads the cached payload_json for content_hash, inserts each non-deleted
// row into the local highlights/notes/flashcards tables scoped to pdf_id
// (reusing the server's own row id, so a later push recognizes these as
// already-synced rather than re-creating them), then clears the pending
// row. INSERT OR IGNORE guards against double-materialization (e.g. a
// duplicate click) leaving no trace beyond a no-op.
#[tauri::command]
pub fn materialize_pending_pdf_annotations(
    app: AppHandle,
    content_hash: String,
    pdf_id: String,
) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;

    let payload_json: Option<String> = conn
        .query_row(
            "SELECT payload_json FROM pending_pdf_annotations WHERE content_hash = ?1",
            rusqlite::params![content_hash],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();

    let payload: MaterializePayload = match payload_json {
        Some(s) => serde_json::from_str(&s).map_err(|e| e.to_string())?,
        None => MaterializePayload::default(),
    };

    let mut created_highlights: Vec<Highlight> = Vec::new();
    for h in payload.highlights.into_iter().filter(|h| h.deleted_at.is_none()) {
        let created_at = h.updated_at.clone().unwrap_or_else(|| Utc::now().to_rfc3339());
        conn.execute(
            "INSERT OR IGNORE INTO highlights
             (id, pdf_id, page, color, selected_text, position_x, position_y, position_w, position_h, note, created_at, rects)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            rusqlite::params![
                h.id, pdf_id, h.page, h.color, h.selected_text,
                h.position_x, h.position_y, h.position_w, h.position_h,
                h.note, created_at, h.rects_json,
            ],
        )
        .map_err(|e| e.to_string())?;

        created_highlights.push(Highlight {
            id: h.id,
            pdf_id: pdf_id.clone(),
            page: h.page,
            color: h.color,
            selected_text: h.selected_text,
            position_x: h.position_x,
            position_y: h.position_y,
            position_w: h.position_w,
            position_h: h.position_h,
            note: h.note,
            created_at,
            rects: h.rects_json.as_deref().and_then(|s| serde_json::from_str(s).ok()),
            updated_at: None,
            deleted_at: None,
        });
    }

    let mut created_notes: Vec<Note> = Vec::new();
    for n in payload.notes.into_iter().filter(|n| n.deleted_at.is_none()) {
        let updated_at = n.updated_at.clone().unwrap_or_else(|| Utc::now().to_rfc3339());
        let title = n.title.unwrap_or_else(|| "Untitled".to_string());
        let content_markdown = n.content_markdown.unwrap_or_default();
        let tags_vec: Vec<String> = n.tags.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
        let tags_json = serde_json::to_string(&tags_vec).map_err(|e| e.to_string())?;

        conn.execute(
            "INSERT OR IGNORE INTO notes
             (id, title, content_markdown, folder_id, source_pdf_id, source_page, tags, created_at, updated_at)
             VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?7)",
            rusqlite::params![n.id, title, content_markdown, pdf_id, n.source_page, tags_json, updated_at],
        )
        .map_err(|e| e.to_string())?;

        created_notes.push(Note {
            id: n.id,
            title,
            content_markdown,
            folder_id: None,
            source_pdf_id: Some(pdf_id.clone()),
            source_page: n.source_page,
            tags: tags_vec,
            created_at: updated_at.clone(),
            updated_at,
            deleted_at: None,
            sketch_data: None,
        });
    }

    let mut created_flashcards: Vec<Flashcard> = Vec::new();
    for f in payload.flashcards.into_iter().filter(|f| f.deleted_at.is_none()) {
        let updated_at = f.updated_at.clone().unwrap_or_else(|| Utc::now().to_rfc3339());
        conn.execute(
            "INSERT OR IGNORE INTO flashcards
             (id, source_highlight_id, pdf_id, page, front, back, confidence_level, last_reviewed_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            rusqlite::params![
                f.id, f.source_highlight_id, pdf_id, f.page, f.front, f.back,
                f.confidence_level, f.last_reviewed_at, updated_at,
            ],
        )
        .map_err(|e| e.to_string())?;

        created_flashcards.push(Flashcard {
            id: f.id,
            source_highlight_id: Some(f.source_highlight_id),
            pdf_id: Some(pdf_id.clone()),
            page: Some(f.page),
            front: f.front,
            back: f.back,
            deck_id: None,
            confidence_level: f.confidence_level,
            last_reviewed_at: f.last_reviewed_at,
            created_at: updated_at.clone(),
            updated_at,
            deleted_at: None,
        });
    }

    conn.execute(
        "DELETE FROM pending_pdf_annotations WHERE content_hash = ?1",
        rusqlite::params![content_hash],
    )
    .map_err(|e| e.to_string())?;

    serde_json::to_string(&MaterializeResult {
        highlights: created_highlights,
        notes: created_notes,
        flashcards: created_flashcards,
    })
    .map_err(|e| e.to_string())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HlRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Highlight {
    pub id: String,
    pub pdf_id: String,
    pub page: i64,
    pub color: String,
    pub selected_text: String,
    pub position_x: f64,
    pub position_y: f64,
    pub position_w: f64,
    pub position_h: f64,
    pub rects: Option<Vec<HlRect>>,
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
    pub deleted_at: Option<String>,
}

const HIGHLIGHT_SELECT: &str =
    "SELECT id, pdf_id, page, color, selected_text,
            position_x, position_y, position_w, position_h,
            note, created_at, rects, updated_at, deleted_at
     FROM highlights";

fn row_to_highlight(row: &rusqlite::Row<'_>) -> rusqlite::Result<Highlight> {
    let rects_str: Option<String> = row.get(11)?;
    Ok(Highlight {
        id: row.get(0)?,
        pdf_id: row.get(1)?,
        page: row.get(2)?,
        color: row.get(3)?,
        selected_text: row.get(4)?,
        position_x: row.get(5)?,
        position_y: row.get(6)?,
        position_w: row.get(7)?,
        position_h: row.get(8)?,
        note: row.get(9)?,
        created_at: row.get(10)?,
        rects: rects_str.and_then(|s| serde_json::from_str(&s).ok()),
        updated_at: row.get(12)?,
        deleted_at: row.get(13)?,
    })
}

#[tauri::command]
pub fn add_highlight(
    app: AppHandle,
    pdf_id: String,
    page: i64,
    color: String,
    selected_text: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    rects: Option<String>,
) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    let created_at = Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO highlights
         (id, pdf_id, page, color, selected_text, position_x, position_y, position_w, position_h, note, created_at, rects)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10, ?11)",
        rusqlite::params![id, pdf_id, page, color, selected_text, x, y, w, h, created_at, rects],
    )
    .map_err(|e| e.to_string())?;

    let rects_vec: Option<Vec<HlRect>> = rects
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());

    let highlight = Highlight {
        id,
        pdf_id,
        page,
        color,
        selected_text,
        position_x: x,
        position_y: y,
        position_w: w,
        position_h: h,
        rects: rects_vec,
        note: None,
        created_at,
        updated_at: None,
        deleted_at: None,
    };

    serde_json::to_string(&highlight).map_err(|e| e.to_string())
}

// Lets sync callers check whether a highlight row exists locally before
// upserting a flashcard that references it via source_highlight_id — the
// FK constraint offers no graceful failure mode, so this avoids the sync
// pull crashing/retrying forever on a flashcard whose parent highlight was
// permanently deleted server-side (or lost locally to a stale pull cursor).
#[tauri::command]
pub fn highlight_exists(app: AppHandle, id: String) -> Result<bool, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT 1 FROM highlights WHERE id = ?1",
        rusqlite::params![id],
        |_| Ok(()),
    )
    .optional()
    .map(|r| r.is_some())
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_highlights(app: AppHandle, pdf_id: String, include_deleted: Option<bool>) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let where_clause = if include_deleted.unwrap_or(false) {
        "WHERE pdf_id = ?1"
    } else {
        "WHERE pdf_id = ?1 AND deleted_at IS NULL"
    };

    let mut stmt = conn
        .prepare(&format!("{HIGHLIGHT_SELECT} {where_clause} ORDER BY page ASC, position_y DESC"))
        .map_err(|e| e.to_string())?;

    let highlights: Vec<Highlight> = stmt
        .query_map(rusqlite::params![pdf_id], row_to_highlight)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    serde_json::to_string(&highlights).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_highlights_by_color(app: AppHandle, color: String) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(&format!(
            "{HIGHLIGHT_SELECT} WHERE color = ?1 AND deleted_at IS NULL ORDER BY pdf_id, page ASC"
        ))
        .map_err(|e| e.to_string())?;

    let highlights: Vec<Highlight> = stmt
        .query_map(rusqlite::params![color], row_to_highlight)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    serde_json::to_string(&highlights).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_all_highlights(app: AppHandle) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(&format!(
            "{HIGHLIGHT_SELECT} WHERE deleted_at IS NULL ORDER BY pdf_id, page ASC, position_y DESC"
        ))
        .map_err(|e| e.to_string())?;

    let highlights: Vec<Highlight> = stmt
        .query_map([], row_to_highlight)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    serde_json::to_string(&highlights).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_highlight(app: AppHandle, id: String) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE highlights SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
        rusqlite::params![now, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn update_highlight(
    app: AppHandle,
    id: String,
    page: Option<i64>,
    color: Option<String>,
    selected_text: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    w: Option<f64>,
    h: Option<f64>,
    note: Option<String>,
    rects: Option<String>,
) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE highlights SET
            page          = COALESCE(?1, page),
            color         = COALESCE(?2, color),
            selected_text = COALESCE(?3, selected_text),
            position_x    = COALESCE(?4, position_x),
            position_y    = COALESCE(?5, position_y),
            position_w    = COALESCE(?6, position_w),
            position_h    = COALESCE(?7, position_h),
            note          = COALESCE(?8, note),
            rects         = COALESCE(?9, rects)
         WHERE id = ?10",
        rusqlite::params![page, color, selected_text, x, y, w, h, note, rects, id],
    )
    .map_err(|e| e.to_string())?;

    let highlight = conn
        .query_row(&format!("{HIGHLIGHT_SELECT} WHERE id = ?1"), rusqlite::params![id], row_to_highlight)
        .map_err(|e| e.to_string())?;

    serde_json::to_string(&highlight).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_highlight(
    app: AppHandle,
    id: String,
    pdf_id: String,
    page: i64,
    color: String,
    selected_text: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    note: Option<String>,
    rects: Option<String>,
    created_at: String,
) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;

    // Preserve the local row's original created_at if it already exists —
    // a server echo shouldn't reset the local creation timestamp.
    let existing_created_at: Option<String> = conn
        .query_row(
            "SELECT created_at FROM highlights WHERE id = ?1",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let created_at = existing_created_at.unwrap_or(created_at);

    conn.execute(
        "INSERT INTO highlights
         (id, pdf_id, page, color, selected_text, position_x, position_y, position_w, position_h, note, created_at, rects)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET
            pdf_id        = excluded.pdf_id,
            page          = excluded.page,
            color         = excluded.color,
            selected_text = excluded.selected_text,
            position_x    = excluded.position_x,
            position_y    = excluded.position_y,
            position_w    = excluded.position_w,
            position_h    = excluded.position_h,
            note          = excluded.note,
            rects         = excluded.rects",
        rusqlite::params![id, pdf_id, page, color, selected_text, x, y, w, h, note, created_at, rects],
    )
    .map_err(|e| e.to_string())?;

    let highlight = conn
        .query_row(&format!("{HIGHLIGHT_SELECT} WHERE id = ?1"), rusqlite::params![id], row_to_highlight)
        .map_err(|e| e.to_string())?;

    serde_json::to_string(&highlight).map_err(|e| e.to_string())
}

// ── Notes ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub content_markdown: String,
    pub folder_id: Option<String>,
    pub source_pdf_id: Option<String>,
    pub source_page: Option<i64>,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub sketch_data: Option<String>,
}

fn row_to_note(row: &rusqlite::Row<'_>) -> rusqlite::Result<Note> {
    let tags_str: String = row.get(6)?;
    Ok(Note {
        id: row.get(0)?,
        title: row.get(1)?,
        content_markdown: row.get(2)?,
        folder_id: row.get(3)?,
        source_pdf_id: row.get(4)?,
        source_page: row.get(5)?,
        tags: serde_json::from_str(&tags_str).unwrap_or_default(),
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        deleted_at: row.get(9)?,
        sketch_data: row.get(10)?,
    })
}

const NOTE_SELECT: &str =
    "SELECT id, title, content_markdown, folder_id, source_pdf_id, source_page,
            tags, created_at, updated_at, deleted_at, sketch_data FROM notes";

#[tauri::command]
pub fn create_note(
    app: AppHandle,
    title: Option<String>,
    source_pdf_id: Option<String>,
    source_page: Option<i64>,
) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let title = title.unwrap_or_else(|| "Untitled".to_string());

    conn.execute(
        "INSERT INTO notes
         (id, title, content_markdown, folder_id, source_pdf_id, source_page, tags, created_at, updated_at)
         VALUES (?1, ?2, '', NULL, ?3, ?4, '[]', ?5, ?5)",
        rusqlite::params![id, title, source_pdf_id, source_page, now],
    )
    .map_err(|e| e.to_string())?;

    let note = Note {
        id,
        title,
        content_markdown: String::new(),
        folder_id: None,
        source_pdf_id,
        source_page,
        tags: vec![],
        created_at: now.clone(),
        updated_at: now,
        deleted_at: None,
        sketch_data: None,
    };

    serde_json::to_string(&note).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_notes(app: AppHandle, pdf_id: Option<String>, include_deleted: Option<bool>) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let include_deleted = include_deleted.unwrap_or(false);

    let notes: Vec<Note> = if let Some(pid) = pdf_id {
        let where_clause = if include_deleted {
            "WHERE source_pdf_id = ?1"
        } else {
            "WHERE source_pdf_id = ?1 AND deleted_at IS NULL"
        };
        let mut stmt = conn
            .prepare(&format!("{NOTE_SELECT} {where_clause} ORDER BY updated_at DESC"))
            .map_err(|e| e.to_string())?;
        let rows: Vec<Note> = stmt
            .query_map(rusqlite::params![pid], row_to_note)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        rows
    } else {
        let where_clause = if include_deleted { "" } else { "WHERE deleted_at IS NULL" };
        let mut stmt = conn
            .prepare(&format!("{NOTE_SELECT} {where_clause} ORDER BY updated_at DESC"))
            .map_err(|e| e.to_string())?;
        let rows: Vec<Note> = stmt
            .query_map([], row_to_note)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };

    serde_json::to_string(&notes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_note(
    app: AppHandle,
    id: String,
    title: Option<String>,
    content_markdown: Option<String>,
    tags: Option<Vec<String>>,
    sketch_data: Option<String>,
) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    let tags_json = tags
        .as_ref()
        .map(|t| serde_json::to_string(t))
        .transpose()
        .map_err(|e: serde_json::Error| e.to_string())?;

    conn.execute(
        "UPDATE notes SET
            title            = COALESCE(?1, title),
            content_markdown = COALESCE(?2, content_markdown),
            tags             = COALESCE(?3, tags),
            sketch_data      = COALESCE(?4, sketch_data),
            updated_at       = ?5
         WHERE id = ?6",
        rusqlite::params![title, content_markdown, tags_json, sketch_data, now, id],
    )
    .map_err(|e| e.to_string())?;

    let note = conn
        .query_row(
            &format!("{NOTE_SELECT} WHERE id = ?1"),
            rusqlite::params![id],
            row_to_note,
        )
        .map_err(|e| e.to_string())?;

    serde_json::to_string(&note).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_note(
    app: AppHandle,
    id: String,
    title: String,
    content_markdown: String,
    source_pdf_id: Option<String>,
    source_page: Option<i64>,
    tags: Vec<String>,
    updated_at: String,
) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let tags_json = serde_json::to_string(&tags).map_err(|e| e.to_string())?;

    let existing_created_at: Option<String> = conn
        .query_row(
            "SELECT created_at FROM notes WHERE id = ?1",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let created_at = existing_created_at.unwrap_or_else(|| updated_at.clone());

    conn.execute(
        "INSERT INTO notes (id, title, content_markdown, folder_id, source_pdf_id, source_page, tags, created_at, updated_at)
         VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
            title             = excluded.title,
            content_markdown  = excluded.content_markdown,
            source_pdf_id     = excluded.source_pdf_id,
            source_page       = excluded.source_page,
            tags              = excluded.tags,
            updated_at        = excluded.updated_at",
        rusqlite::params![id, title, content_markdown, source_pdf_id, source_page, tags_json, created_at, updated_at],
    )
    .map_err(|e| e.to_string())?;

    let note = conn
        .query_row(&format!("{NOTE_SELECT} WHERE id = ?1"), rusqlite::params![id], row_to_note)
        .map_err(|e| e.to_string())?;

    serde_json::to_string(&note).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_note(app: AppHandle, id: String) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE notes SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
        rusqlite::params![now, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Ingestion pipeline ────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct PageText {
    pub page: i64,
    pub text: String,
}

#[tauri::command]
pub fn extract_pdf_text(filepath: String) -> Result<String, String> {
    let doc = lopdf::Document::load(&filepath).map_err(|e| e.to_string())?;
    let pages = doc.get_pages();
    let mut result: Vec<PageText> = Vec::with_capacity(pages.len());

    for (page_num, _) in &pages {
        let text = doc
            .extract_text(&[*page_num])
            .unwrap_or_default()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        result.push(PageText {
            page: *page_num as i64,
            text,
        });
    }

    serde_json::to_string(&result).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChunkInput {
    pub id: String,
    pub source_id: String,
    pub chunk_index: i64,
    pub page: i64,
    pub content: String,
    pub embedding: Vec<f32>,
}

#[tauri::command]
pub fn store_chunks(app: AppHandle, chunks: Vec<ChunkInput>) -> Result<(), String> {
    let mut conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for chunk in &chunks {
        let embedding_bytes: Vec<u8> = chunk
            .embedding
            .iter()
            .flat_map(|f| f.to_le_bytes())
            .collect();
        tx.execute(
            "INSERT OR REPLACE INTO chunks
             (id, source_type, source_id, chunk_index, page, content, embedding, created_at)
             VALUES (?1, 'pdf', ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                chunk.id,
                chunk.source_id,
                chunk.chunk_index,
                chunk.page,
                chunk.content,
                embedding_bytes,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn update_pdf_ingestion_status(
    app: AppHandle,
    pdf_id: String,
    chunk_count: i64,
) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE pdfs SET chunk_count = ?1, ingested_at = ?2 WHERE id = ?3",
        rusqlite::params![chunk_count, now, pdf_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_chunks_for_pdf(app: AppHandle, pdf_id: String) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM chunks WHERE source_id = ?1",
        rusqlite::params![pdf_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Settings ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_setting(app: AppHandle, key: String) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let val: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            rusqlite::params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(val.unwrap_or_default())
}

#[tauri::command]
pub fn set_setting(app: AppHandle, key: String, value: String) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        rusqlite::params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Drawings ──────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct Drawing {
    pub id: String,
    pub pdf_id: String,
    pub page: i64,
    pub tool_type: String,
    pub color: String,
    pub stroke_width: f64,
    pub points: String, // JSON array of {x,y} in PDF point space
    pub created_at: String,
}

#[tauri::command]
pub fn add_drawing(
    app: AppHandle,
    pdf_id: String,
    page: i64,
    tool_type: String,
    color: String,
    stroke_width: f64,
    points: String,
) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    let created_at = Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO drawings (id, pdf_id, page, tool_type, color, stroke_width, points, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![id, pdf_id, page, tool_type, color, stroke_width, points, created_at],
    )
    .map_err(|e| e.to_string())?;

    let drawing = Drawing { id, pdf_id, page, tool_type, color, stroke_width, points, created_at };
    serde_json::to_string(&drawing).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_drawings(app: AppHandle, pdf_id: String) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, pdf_id, page, tool_type, color, stroke_width, points, created_at
             FROM drawings WHERE pdf_id = ?1 ORDER BY page ASC, created_at ASC",
        )
        .map_err(|e| e.to_string())?;

    let drawings: Vec<Drawing> = stmt
        .query_map(rusqlite::params![pdf_id], |row| {
            Ok(Drawing {
                id:           row.get(0)?,
                pdf_id:       row.get(1)?,
                page:         row.get(2)?,
                tool_type:    row.get(3)?,
                color:        row.get(4)?,
                stroke_width: row.get(5)?,
                points:       row.get(6)?,
                created_at:   row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    serde_json::to_string(&drawings).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_drawing(app: AppHandle, id: String) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM drawings WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn update_drawing_points(app: AppHandle, id: String, points: String) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE drawings SET points = ?1 WHERE id = ?2",
        rusqlite::params![points, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Text boxes ────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct TextBox {
    pub id: String,
    pub pdf_id: String,
    pub page: i64,
    pub content: String,
    pub position_x: f64,
    pub position_y: f64,
    pub width: f64,
    pub height: f64,
    pub font_size: f64,
    pub color: String,
    pub created_at: String,
    pub updated_at: String,
}

fn row_to_text_box(row: &rusqlite::Row<'_>) -> rusqlite::Result<TextBox> {
    Ok(TextBox {
        id:         row.get(0)?,
        pdf_id:     row.get(1)?,
        page:       row.get(2)?,
        content:    row.get(3)?,
        position_x: row.get(4)?,
        position_y: row.get(5)?,
        width:      row.get(6)?,
        height:     row.get(7)?,
        font_size:  row.get(8)?,
        color:      row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

const TB_SELECT: &str =
    "SELECT id, pdf_id, page, content, position_x, position_y, width, height, font_size, color, created_at, updated_at FROM text_boxes";

#[tauri::command]
pub fn add_text_box(
    app: AppHandle,
    pdf_id: String,
    page: i64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    font_size: f64,
    color: String,
) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO text_boxes (id, pdf_id, page, content, position_x, position_y, width, height, font_size, color, created_at, updated_at)
         VALUES (?1, ?2, ?3, '', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        rusqlite::params![id, pdf_id, page, x, y, width, height, font_size, color, now],
    )
    .map_err(|e| e.to_string())?;

    let tb = TextBox { id, pdf_id, page, content: String::new(), position_x: x, position_y: y, width, height, font_size, color, created_at: now.clone(), updated_at: now };
    serde_json::to_string(&tb).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_text_boxes(app: AppHandle, pdf_id: String) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!("{TB_SELECT} WHERE pdf_id = ?1 ORDER BY page ASC, created_at ASC"))
        .map_err(|e| e.to_string())?;
    let boxes: Vec<TextBox> = stmt
        .query_map(rusqlite::params![pdf_id], row_to_text_box)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    serde_json::to_string(&boxes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_text_box(
    app: AppHandle,
    id: String,
    content: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
    font_size: Option<f64>,
    color: Option<String>,
) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE text_boxes SET
            content    = COALESCE(?1, content),
            position_x = COALESCE(?2, position_x),
            position_y = COALESCE(?3, position_y),
            width      = COALESCE(?4, width),
            height     = COALESCE(?5, height),
            font_size  = COALESCE(?6, font_size),
            color      = COALESCE(?7, color),
            updated_at = ?8
         WHERE id = ?9",
        rusqlite::params![content, x, y, width, height, font_size, color, now, id],
    )
    .map_err(|e| e.to_string())?;
    let tb = conn
        .query_row(&format!("{TB_SELECT} WHERE id = ?1"), rusqlite::params![id], row_to_text_box)
        .map_err(|e| e.to_string())?;
    serde_json::to_string(&tb).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_text_box(app: AppHandle, id: String) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM text_boxes WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Flashcards ───────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct Flashcard {
    pub id: String,
    // Nullable since custom (user-authored) cards have no source highlight,
    // PDF, or page. AI-generated cards always carry all three.
    pub source_highlight_id: Option<String>,
    pub pdf_id: Option<String>,
    pub page: Option<i64>,
    pub front: String,
    pub back: String,
    pub deck_id: Option<String>,
    pub confidence_level: i64,
    pub last_reviewed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

fn row_to_flashcard(row: &rusqlite::Row<'_>) -> rusqlite::Result<Flashcard> {
    Ok(Flashcard {
        id:                  row.get(0)?,
        source_highlight_id: row.get(1)?,
        pdf_id:              row.get(2)?,
        page:                row.get(3)?,
        front:               row.get(4)?,
        back:                row.get(5)?,
        confidence_level:    row.get(6)?,
        last_reviewed_at:    row.get(7)?,
        created_at:          row.get(8)?,
        updated_at:          row.get(9)?,
        deleted_at:          row.get(10)?,
        deck_id:             row.get(11)?,
    })
}

const FC_SELECT: &str =
    "SELECT id, source_highlight_id, pdf_id, page, front, back, confidence_level, last_reviewed_at, created_at, updated_at, deleted_at, deck_id FROM flashcards";

#[tauri::command]
pub fn add_flashcard(
    app: AppHandle,
    source_highlight_id: String,
    pdf_id: String,
    page: i64,
    front: String,
    back: String,
) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO flashcards (id, source_highlight_id, pdf_id, page, front, back, confidence_level, last_reviewed_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, NULL, ?7, ?7)",
        rusqlite::params![id, source_highlight_id, pdf_id, page, front, back, now],
    )
    .map_err(|e| e.to_string())?;

    let card = Flashcard {
        id,
        source_highlight_id: Some(source_highlight_id),
        pdf_id: Some(pdf_id),
        page: Some(page),
        front, back, deck_id: None,
        confidence_level: 0, last_reviewed_at: None,
        created_at: now.clone(), updated_at: now,
        deleted_at: None,
    };
    serde_json::to_string(&card).map_err(|e| e.to_string())
}

// Custom (user-authored) card: no source highlight, no PDF, no page —
// it lives only in the deck it was created in (or unfiled).
#[tauri::command]
pub fn add_custom_flashcard(
    app: AppHandle,
    front: String,
    back: String,
    deck_id: Option<String>,
) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO flashcards (id, source_highlight_id, pdf_id, page, front, back, deck_id, confidence_level, last_reviewed_at, created_at, updated_at)
         VALUES (?1, NULL, NULL, NULL, ?2, ?3, ?4, 0, NULL, ?5, ?5)",
        rusqlite::params![id, front, back, deck_id, now],
    )
    .map_err(|e| e.to_string())?;

    let card = Flashcard {
        id,
        source_highlight_id: None,
        pdf_id: None,
        page: None,
        front, back, deck_id,
        confidence_level: 0, last_reviewed_at: None,
        created_at: now.clone(), updated_at: now,
        deleted_at: None,
    };
    serde_json::to_string(&card).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_flashcards(app: AppHandle, pdf_id: String, include_deleted: Option<bool>) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let where_clause = if include_deleted.unwrap_or(false) {
        "WHERE pdf_id = ?1"
    } else {
        "WHERE pdf_id = ?1 AND deleted_at IS NULL"
    };
    let mut stmt = conn
        .prepare(&format!("{FC_SELECT} {where_clause} ORDER BY page ASC, created_at ASC"))
        .map_err(|e| e.to_string())?;
    let cards: Vec<Flashcard> = stmt
        .query_map(rusqlite::params![pdf_id], row_to_flashcard)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    serde_json::to_string(&cards).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_all_flashcards(app: AppHandle) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!("{FC_SELECT} WHERE deleted_at IS NULL ORDER BY confidence_level ASC, created_at ASC"))
        .map_err(|e| e.to_string())?;
    let cards: Vec<Flashcard> = stmt
        .query_map([], row_to_flashcard)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    serde_json::to_string(&cards).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_flashcard(app: AppHandle, id: String) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE flashcards SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
        rusqlite::params![now, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn update_flashcard_review(
    app: AppHandle,
    id: String,
    confidence_level: i64,
) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE flashcards SET
            confidence_level = ?1,
            last_reviewed_at = ?2,
            updated_at       = ?2
         WHERE id = ?3",
        rusqlite::params![confidence_level, now, id],
    )
    .map_err(|e| e.to_string())?;
    let card = conn
        .query_row(&format!("{FC_SELECT} WHERE id = ?1"), rusqlite::params![id], row_to_flashcard)
        .map_err(|e| e.to_string())?;
    serde_json::to_string(&card).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_flashcard_fields(
    app: AppHandle,
    id: String,
    front: Option<String>,
    back: Option<String>,
) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE flashcards SET
            front      = COALESCE(?1, front),
            back       = COALESCE(?2, back),
            updated_at = ?3
         WHERE id = ?4",
        rusqlite::params![front, back, now, id],
    )
    .map_err(|e| e.to_string())?;
    let card = conn
        .query_row(&format!("{FC_SELECT} WHERE id = ?1"), rusqlite::params![id], row_to_flashcard)
        .map_err(|e| e.to_string())?;
    serde_json::to_string(&card).map_err(|e| e.to_string())
}

// Deck assignment is separate from update_flashcard_fields because COALESCE
// can't distinguish "leave unchanged" from "set to NULL (unfile)". Deck
// membership is local-only metadata, so updated_at is deliberately not
// bumped — a deck move must never look like a content change to sync.
#[tauri::command]
pub fn assign_flashcard_deck(
    app: AppHandle,
    id: String,
    deck_id: Option<String>,
) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE flashcards SET deck_id = ?1 WHERE id = ?2",
        rusqlite::params![deck_id, id],
    )
    .map_err(|e| e.to_string())?;
    let card = conn
        .query_row(&format!("{FC_SELECT} WHERE id = ?1"), rusqlite::params![id], row_to_flashcard)
        .map_err(|e| e.to_string())?;
    serde_json::to_string(&card).map_err(|e| e.to_string())
}

// ── Decks (local-only, not synced) ───────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct Deck {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

fn row_to_deck(row: &rusqlite::Row<'_>) -> rusqlite::Result<Deck> {
    Ok(Deck {
        id:         row.get(0)?,
        name:       row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
    })
}

#[tauri::command]
pub fn create_deck(app: AppHandle, name: String) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO decks (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        rusqlite::params![id, name, now],
    )
    .map_err(|e| e.to_string())?;
    let deck = Deck { id, name, created_at: now.clone(), updated_at: now };
    serde_json::to_string(&deck).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_decks(app: AppHandle) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, created_at, updated_at FROM decks ORDER BY created_at ASC")
        .map_err(|e| e.to_string())?;
    let decks: Vec<Deck> = stmt
        .query_map([], row_to_deck)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    serde_json::to_string(&decks).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_deck(app: AppHandle, id: String, name: String) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE decks SET name = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![name, now, id],
    )
    .map_err(|e| e.to_string())?;
    let deck = conn
        .query_row(
            "SELECT id, name, created_at, updated_at FROM decks WHERE id = ?1",
            rusqlite::params![id],
            row_to_deck,
        )
        .map_err(|e| e.to_string())?;
    serde_json::to_string(&deck).map_err(|e| e.to_string())
}

// Deleting a deck un-files its cards (deck_id → NULL); it never deletes them.
#[tauri::command]
pub fn delete_deck(app: AppHandle, id: String) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    conn.execute("UPDATE flashcards SET deck_id = NULL WHERE deck_id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM decks WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn upsert_flashcard(
    app: AppHandle,
    id: String,
    source_highlight_id: String,
    pdf_id: String,
    page: i64,
    front: String,
    back: String,
    confidence_level: i64,
    last_reviewed_at: Option<String>,
    created_at: String,
    updated_at: String,
) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;

    let existing_created_at: Option<String> = conn
        .query_row(
            "SELECT created_at FROM flashcards WHERE id = ?1",
            rusqlite::params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let created_at = existing_created_at.unwrap_or(created_at);

    conn.execute(
        "INSERT INTO flashcards (id, source_highlight_id, pdf_id, page, front, back, confidence_level, last_reviewed_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
            source_highlight_id = excluded.source_highlight_id,
            pdf_id               = excluded.pdf_id,
            page                 = excluded.page,
            front                = excluded.front,
            back                 = excluded.back,
            confidence_level     = excluded.confidence_level,
            last_reviewed_at     = excluded.last_reviewed_at,
            updated_at           = excluded.updated_at",
        rusqlite::params![id, source_highlight_id, pdf_id, page, front, back, confidence_level, last_reviewed_at, created_at, updated_at],
    )
    .map_err(|e| e.to_string())?;

    let card = conn
        .query_row(&format!("{FC_SELECT} WHERE id = ?1"), rusqlite::params![id], row_to_flashcard)
        .map_err(|e| e.to_string())?;

    serde_json::to_string(&card).map_err(|e| e.to_string())
}

// ── Export annotated PDF ─────────────────────────────────────────────────────

#[derive(Debug, serde::Deserialize)]
struct ExportDrawPoint {
    x: f64,
    y: f64,
}

// lopdf 0.34 uses Object::Real(f32) — this wrapper casts for us
#[inline]
fn rf(v: f64) -> lopdf::Object {
    lopdf::Object::Real(v as f32)
}

fn highlight_color_pdf(key: &str) -> (f64, f64, f64) {
    // Keep in sync with src/constants/highlights.ts
    match key {
        "yellow" => (1.0, 0.839, 0.039),   // #FFD60A
        "blue"   => (0.302, 0.651, 1.0),    // #4DA6FF
        "green"  => (0.204, 0.780, 0.349),  // #34C759
        "pink"   => (1.0, 0.420, 0.616),    // #FF6B9D
        _        => (1.0, 1.0, 0.0),
    }
}

fn hex_to_pdf_color(hex: &str) -> (f64, f64, f64) {
    let hex = hex.trim_start_matches('#');
    if hex.len() < 6 {
        return (1.0, 1.0, 1.0);
    }
    let r = u8::from_str_radix(&hex[0..2], 16).unwrap_or(255) as f64 / 255.0;
    let g = u8::from_str_radix(&hex[2..4], 16).unwrap_or(255) as f64 / 255.0;
    let b = u8::from_str_radix(&hex[4..6], 16).unwrap_or(255) as f64 / 255.0;
    (r, g, b)
}

fn get_page_existing_annots(doc: &lopdf::Document, page_id: lopdf::ObjectId) -> Vec<lopdf::Object> {
    let page_dict = match doc.objects.get(&page_id) {
        Some(lopdf::Object::Dictionary(d)) => d,
        _ => return vec![],
    };
    match page_dict.get(b"Annots") {
        Ok(lopdf::Object::Array(arr)) => arr.clone(),
        Ok(lopdf::Object::Reference(ref_id)) => {
            let ref_id = *ref_id;
            match doc.objects.get(&ref_id) {
                Some(lopdf::Object::Array(arr)) => arr.clone(),
                _ => vec![],
            }
        }
        _ => vec![],
    }
}

fn add_highlight_annot(doc: &mut lopdf::Document, hl: &Highlight) -> lopdf::ObjectId {
    let rects: Vec<HlRect> = match &hl.rects {
        Some(r) if !r.is_empty() => r.clone(),
        _ => vec![HlRect {
            x: hl.position_x,
            y: hl.position_y,
            w: hl.position_w,
            h: hl.position_h,
        }],
    };

    let min_x = rects.iter().map(|r| r.x).fold(f64::INFINITY, f64::min);
    let min_y = rects.iter().map(|r| r.y).fold(f64::INFINITY, f64::min);
    let max_x = rects.iter().map(|r| r.x + r.w).fold(f64::NEG_INFINITY, f64::max);
    let max_y = rects.iter().map(|r| r.y + r.h).fold(f64::NEG_INFINITY, f64::max);

    let (cr, cg, cb) = highlight_color_pdf(&hl.color);

    // QuadPoints: 8 values per rect — upper-left, upper-right, lower-left, lower-right
    let mut quad_pts: Vec<lopdf::Object> = Vec::with_capacity(rects.len() * 8);
    for r in &rects {
        quad_pts.push(rf(r.x));
        quad_pts.push(rf(r.y + r.h));
        quad_pts.push(rf(r.x + r.w));
        quad_pts.push(rf(r.y + r.h));
        quad_pts.push(rf(r.x));
        quad_pts.push(rf(r.y));
        quad_pts.push(rf(r.x + r.w));
        quad_pts.push(rf(r.y));
    }

    let mut dict = lopdf::Dictionary::new();
    dict.set(b"Type".to_vec(),       lopdf::Object::Name(b"Annot".to_vec()));
    dict.set(b"Subtype".to_vec(),    lopdf::Object::Name(b"Highlight".to_vec()));
    dict.set(b"Rect".to_vec(),       lopdf::Object::Array(vec![rf(min_x), rf(min_y), rf(max_x), rf(max_y)]));
    dict.set(b"QuadPoints".to_vec(), lopdf::Object::Array(quad_pts));
    dict.set(b"C".to_vec(),          lopdf::Object::Array(vec![rf(cr), rf(cg), rf(cb)]));
    dict.set(b"CA".to_vec(),         lopdf::Object::Real(0.4_f32));
    dict.set(b"F".to_vec(),          lopdf::Object::Integer(4));

    doc.add_object(lopdf::Object::Dictionary(dict))
}

fn make_bs_dict(stroke_width: f64) -> lopdf::Dictionary {
    let mut bs = lopdf::Dictionary::new();
    bs.set(b"Type".to_vec(), lopdf::Object::Name(b"Border".to_vec()));
    bs.set(b"S".to_vec(),    lopdf::Object::Name(b"S".to_vec()));
    bs.set(b"W".to_vec(),    lopdf::Object::Real(stroke_width as f32));
    bs
}

fn add_drawing_annot(doc: &mut lopdf::Document, drawing: &Drawing) -> Option<lopdf::ObjectId> {
    let points: Vec<ExportDrawPoint> = serde_json::from_str(&drawing.points).ok()?;
    if points.is_empty() {
        return None;
    }
    let (cr, cg, cb) = hex_to_pdf_color(&drawing.color);
    let sw = drawing.stroke_width;
    let bs = make_bs_dict(sw);
    let color_arr = lopdf::Object::Array(vec![rf(cr), rf(cg), rf(cb)]);

    let annot_id = match drawing.tool_type.as_str() {
        "pen" => {
            let min_x = points.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
            let min_y = points.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
            let max_x = points.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max);
            let max_y = points.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max);

            let ink_stroke: Vec<lopdf::Object> = points
                .iter()
                .flat_map(|p| [rf(p.x), rf(p.y)])
                .collect();

            let mut dict = lopdf::Dictionary::new();
            dict.set(b"Type".to_vec(),    lopdf::Object::Name(b"Annot".to_vec()));
            dict.set(b"Subtype".to_vec(), lopdf::Object::Name(b"Ink".to_vec()));
            dict.set(b"Rect".to_vec(),    lopdf::Object::Array(vec![
                rf(min_x - sw), rf(min_y - sw), rf(max_x + sw), rf(max_y + sw),
            ]));
            dict.set(b"InkList".to_vec(), lopdf::Object::Array(vec![
                lopdf::Object::Array(ink_stroke),
            ]));
            dict.set(b"C".to_vec(),  color_arr);
            dict.set(b"BS".to_vec(), lopdf::Object::Dictionary(bs));
            dict.set(b"F".to_vec(),  lopdf::Object::Integer(4));
            doc.add_object(lopdf::Object::Dictionary(dict))
        }
        "arrow" => {
            let p0 = &points[0];
            let p1 = &points[points.len() - 1];
            let pad = sw * 5.0;

            let mut dict = lopdf::Dictionary::new();
            dict.set(b"Type".to_vec(),    lopdf::Object::Name(b"Annot".to_vec()));
            dict.set(b"Subtype".to_vec(), lopdf::Object::Name(b"Line".to_vec()));
            dict.set(b"Rect".to_vec(),    lopdf::Object::Array(vec![
                rf(p0.x.min(p1.x) - pad), rf(p0.y.min(p1.y) - pad),
                rf(p0.x.max(p1.x) + pad), rf(p0.y.max(p1.y) + pad),
            ]));
            dict.set(b"L".to_vec(), lopdf::Object::Array(vec![
                rf(p0.x), rf(p0.y), rf(p1.x), rf(p1.y),
            ]));
            dict.set(b"LE".to_vec(), lopdf::Object::Array(vec![
                lopdf::Object::Name(b"None".to_vec()),
                lopdf::Object::Name(b"OpenArrow".to_vec()),
            ]));
            dict.set(b"C".to_vec(),  color_arr);
            dict.set(b"BS".to_vec(), lopdf::Object::Dictionary(bs));
            dict.set(b"F".to_vec(),  lopdf::Object::Integer(4));
            doc.add_object(lopdf::Object::Dictionary(dict))
        }
        "rectangle" => {
            let p0 = &points[0];
            let p1 = &points[points.len() - 1];

            let mut dict = lopdf::Dictionary::new();
            dict.set(b"Type".to_vec(),    lopdf::Object::Name(b"Annot".to_vec()));
            dict.set(b"Subtype".to_vec(), lopdf::Object::Name(b"Square".to_vec()));
            dict.set(b"Rect".to_vec(),    lopdf::Object::Array(vec![
                rf(p0.x.min(p1.x)), rf(p0.y.min(p1.y)),
                rf(p0.x.max(p1.x)), rf(p0.y.max(p1.y)),
            ]));
            dict.set(b"C".to_vec(),  color_arr);
            dict.set(b"BS".to_vec(), lopdf::Object::Dictionary(bs));
            dict.set(b"F".to_vec(),  lopdf::Object::Integer(4));
            doc.add_object(lopdf::Object::Dictionary(dict))
        }
        "circle" => {
            let p0 = &points[0];
            let p1 = &points[points.len() - 1];

            let mut dict = lopdf::Dictionary::new();
            dict.set(b"Type".to_vec(),    lopdf::Object::Name(b"Annot".to_vec()));
            dict.set(b"Subtype".to_vec(), lopdf::Object::Name(b"Circle".to_vec()));
            dict.set(b"Rect".to_vec(),    lopdf::Object::Array(vec![
                rf(p0.x.min(p1.x)), rf(p0.y.min(p1.y)),
                rf(p0.x.max(p1.x)), rf(p0.y.max(p1.y)),
            ]));
            dict.set(b"C".to_vec(),  color_arr);
            dict.set(b"BS".to_vec(), lopdf::Object::Dictionary(bs));
            dict.set(b"F".to_vec(),  lopdf::Object::Integer(4));
            doc.add_object(lopdf::Object::Dictionary(dict))
        }
        _ => return None,
    };

    Some(annot_id)
}

// Escape a string for use inside a PDF literal string (parentheses).
fn pdf_escape_text(s: &str) -> String {
    let mut out = String::new();
    for ch in s.chars() {
        match ch {
            '(' => out.push_str("\\("),
            ')' => out.push_str("\\)"),
            '\\' => out.push_str("\\\\"),
            c if c as u32 >= 0x20 && c as u32 <= 0x7E => out.push(c),
            c if c as u32 >= 0xA0 && c as u32 <= 0xFF => {
                // Latin-1 supplement: octal-escape for WinAnsiEncoding
                out.push_str(&format!("\\{:03o}", c as u32));
            }
            _ => {} // skip control chars / non-Latin-1
        }
    }
    out
}

// Build PDF content stream bytes that draw all text boxes for one page.
// Uses BT/ET text operators so the text is permanently visible (not interactive).
fn build_text_box_content(tbs: &[&TextBox]) -> Vec<u8> {
    let mut content: Vec<u8> = Vec::new();
    for tb in tbs {
        if tb.content.is_empty() {
            continue;
        }
        let (cr, cg, cb) = hex_to_pdf_color(&tb.color);
        let font_size = tb.font_size;
        let line_height = font_size * 1.3;
        // First text baseline sits near the top of the box (cap-height approximation).
        let first_y = tb.position_y + tb.height - font_size * 0.85;
        let first_x = tb.position_x + 2.0;
        let lines: Vec<&str> = tb.content.lines().collect();
        let header = format!(
            "q\nBT\n/Helv {:.1} Tf\n{:.4} {:.4} {:.4} rg\n{:.4} {:.4} Td\n",
            font_size, cr, cg, cb, first_x, first_y
        );
        content.extend_from_slice(header.as_bytes());
        for (i, line) in lines.iter().enumerate() {
            if i > 0 {
                content.extend_from_slice(
                    format!("0 {:.4} Td\n", -line_height).as_bytes(),
                );
            }
            content.extend_from_slice(
                format!("({}) Tj\n", pdf_escape_text(line)).as_bytes(),
            );
        }
        content.extend_from_slice(b"ET\nQ\n");
    }
    content
}

// Walk the page tree upward to find and clone the /Resources dict.
// Handles both inline dicts and indirect references, plus inherited resources.
fn get_page_resources_cloned(
    doc: &lopdf::Document,
    page_id: lopdf::ObjectId,
) -> lopdf::Dictionary {
    let mut id = page_id;
    loop {
        match doc.objects.get(&id) {
            Some(lopdf::Object::Dictionary(d)) => {
                match d.get(b"Resources") {
                    Ok(lopdf::Object::Dictionary(r)) => return r.clone(),
                    Ok(lopdf::Object::Reference(r)) => {
                        let rid = *r;
                        if let Some(lopdf::Object::Dictionary(rd)) = doc.objects.get(&rid) {
                            return rd.clone();
                        }
                    }
                    _ => {}
                }
                match d.get(b"Parent") {
                    Ok(lopdf::Object::Reference(p)) => id = *p,
                    _ => return lopdf::Dictionary::new(),
                }
            }
            _ => return lopdf::Dictionary::new(),
        }
    }
}

// Flatten text boxes for one page directly into the page content stream.
// Appends a new stream with PDF text operators and declares /Helv in /Resources/Font.
fn flatten_text_boxes_to_page(
    doc: &mut lopdf::Document,
    page_id: lopdf::ObjectId,
    tbs: &[&TextBox],
) {
    let content_bytes = build_text_box_content(tbs);
    if content_bytes.is_empty() {
        return;
    }

    // Clone page resources (resolves inheritance) — borrow ends before any mutation below.
    let mut resources = get_page_resources_cloned(doc, page_id);

    // Build the Helvetica Type1 font entry and merge it into /Resources/Font.
    let mut helv_dict = lopdf::Dictionary::new();
    helv_dict.set(b"Type".to_vec(), lopdf::Object::Name(b"Font".to_vec()));
    helv_dict.set(b"Subtype".to_vec(), lopdf::Object::Name(b"Type1".to_vec()));
    helv_dict.set(b"BaseFont".to_vec(), lopdf::Object::Name(b"Helvetica".to_vec()));
    helv_dict.set(b"Encoding".to_vec(), lopdf::Object::Name(b"WinAnsiEncoding".to_vec()));

    let mut font_dict: lopdf::Dictionary = match resources.get(b"Font") {
        Ok(lopdf::Object::Dictionary(fd)) => fd.clone(),
        Ok(lopdf::Object::Reference(r)) => {
            let rid = *r;
            match doc.objects.get(&rid) {
                Some(lopdf::Object::Dictionary(fd)) => fd.clone(),
                _ => lopdf::Dictionary::new(),
            }
        }
        _ => lopdf::Dictionary::new(),
    };
    font_dict.set(b"Helv".to_vec(), lopdf::Object::Dictionary(helv_dict));
    resources.set(b"Font".to_vec(), lopdf::Object::Dictionary(font_dict));

    // Add the text content as a new indirect stream object.
    let mut stream_dict = lopdf::Dictionary::new();
    stream_dict.set(
        b"Length".to_vec(),
        lopdf::Object::Integer(content_bytes.len() as i64),
    );
    let stream_id = doc.add_object(lopdf::Object::Stream(lopdf::Stream::new(
        stream_dict,
        content_bytes,
    )));

    // Clone existing /Contents refs before taking the mutable borrow below.
    let existing: Vec<lopdf::Object> = match doc.objects.get(&page_id) {
        Some(lopdf::Object::Dictionary(pd)) => match pd.get(b"Contents") {
            Ok(lopdf::Object::Reference(r)) => vec![lopdf::Object::Reference(*r)],
            Ok(lopdf::Object::Array(arr)) => arr.clone(),
            _ => vec![],
        },
        _ => return,
    };

    let mut new_contents = existing;
    new_contents.push(lopdf::Object::Reference(stream_id));

    // Write updated Resources + Contents back to the page dict in one pass.
    if let Some(lopdf::Object::Dictionary(ref mut pd)) = doc.objects.get_mut(&page_id) {
        pd.set(b"Resources".to_vec(), lopdf::Object::Dictionary(resources));
        pd.set(b"Contents".to_vec(), lopdf::Object::Array(new_contents));
    }
}

// Generic "save arbitrary text/JSON to disk" command — reusable beyond the
// library export feature it was introduced for.
#[tauri::command]
pub fn save_text_file(
    app: AppHandle,
    default_filename: String,
    content: String,
    filter_label: Option<String>,
    filter_ext: Option<String>,
) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    // Defaults preserve the original JSON-only behavior for existing callers
    // (e.g. SettingsPanel's library export) that don't pass these params.
    let label = filter_label.unwrap_or_else(|| "JSON Files".to_string());
    let ext = filter_ext.unwrap_or_else(|| "json".to_string());

    let save_fp = app
        .dialog()
        .file()
        .add_filter(&label, &[ext.as_str()])
        .set_file_name(&default_filename)
        .blocking_save_file();

    let output_path = match save_fp {
        Some(fp) => fp.to_string(),
        None => return Ok(String::new()), // user cancelled
    };

    std::fs::write(&output_path, content).map_err(|e| e.to_string())?;
    Ok(output_path)
}

// Generic "save arbitrary binary data to disk" command. Introduced for the
// standalone-note "Export to PDF" feature: jsPDF builds the PDF entirely in
// the frontend (no source PDF file to stamp annotations onto, unlike
// export_annotated_pdf below), so the finished bytes are handed to Rust just
// to drive a native Save-As dialog and write them — a Tauri webview's
// browser-style `<a download>` click does not reliably surface a save
// prompt or write to disk the way it would in an actual browser tab.
#[tauri::command]
pub fn save_binary_file(app: AppHandle, default_filename: String, bytes: Vec<u8>) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    let save_fp = app
        .dialog()
        .file()
        .add_filter("PDF Files", &["pdf"])
        .set_file_name(&default_filename)
        .blocking_save_file();

    let output_path = match save_fp {
        Some(fp) => fp.to_string(),
        None => return Ok(String::new()), // user cancelled
    };

    std::fs::write(&output_path, &bytes).map_err(|e| e.to_string())?;
    Ok(output_path)
}

#[tauri::command]
pub fn export_annotated_pdf(
    app: AppHandle,
    pdf_id: String,
    include_highlights: bool,
    include_drawings: bool,
    include_text_boxes: bool,
) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    let db = db_path(&app)?;
    let conn = Connection::open(&db).map_err(|e| e.to_string())?;

    // Load PDF record
    let (filepath, filename): (String, String) = conn
        .query_row(
            "SELECT filepath, filename FROM pdfs WHERE id = ?1",
            rusqlite::params![pdf_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?;

    // Build default output filename from stem
    let stem = std::path::Path::new(&filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document");
    let default_name = format!("{}-annotated.pdf", stem);

    // Open native save dialog
    let save_fp = app
        .dialog()
        .file()
        .add_filter("PDF Files", &["pdf"])
        .set_file_name(&default_name)
        .blocking_save_file();

    let output_path = match save_fp {
        Some(fp) => fp.to_string(),
        None => return Ok(String::new()), // user cancelled
    };

    // Load annotations from DB — collect before stmt drops to satisfy borrow checker
    let highlights: Vec<Highlight> = if include_highlights {
        let mut stmt = conn
            .prepare(&format!("{HIGHLIGHT_SELECT} WHERE pdf_id = ?1 AND deleted_at IS NULL"))
            .map_err(|e| e.to_string())?;
        let v: Vec<Highlight> = stmt
            .query_map(rusqlite::params![pdf_id], row_to_highlight)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        v
    } else {
        vec![]
    };

    let drawings: Vec<Drawing> = if include_drawings {
        let mut stmt = conn
            .prepare(
                "SELECT id, pdf_id, page, tool_type, color, stroke_width, points, created_at
                 FROM drawings WHERE pdf_id = ?1",
            )
            .map_err(|e| e.to_string())?;
        let v: Vec<Drawing> = stmt
            .query_map(rusqlite::params![pdf_id], |row| {
                Ok(Drawing {
                    id:           row.get(0)?,
                    pdf_id:       row.get(1)?,
                    page:         row.get(2)?,
                    tool_type:    row.get(3)?,
                    color:        row.get(4)?,
                    stroke_width: row.get(5)?,
                    points:       row.get(6)?,
                    created_at:   row.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        v
    } else {
        vec![]
    };

    let text_boxes: Vec<TextBox> = if include_text_boxes {
        let mut stmt = conn
            .prepare(&format!("{TB_SELECT} WHERE pdf_id = ?1"))
            .map_err(|e| e.to_string())?;
        let v: Vec<TextBox> = stmt
            .query_map(rusqlite::params![pdf_id], row_to_text_box)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        v
    } else {
        vec![]
    };

    // Load source PDF
    let mut doc = lopdf::Document::load(&filepath).map_err(|e| e.to_string())?;

    // Stamp annotations page by page
    let pages = doc.get_pages();
    for (page_num, page_id) in pages {
        let page_num_i64 = page_num as i64;
        let mut new_annot_ids: Vec<lopdf::ObjectId> = Vec::new();

        for hl in highlights.iter().filter(|h| h.page == page_num_i64) {
            new_annot_ids.push(add_highlight_annot(&mut doc, hl));
        }
        for drawing in drawings.iter().filter(|d| d.page == page_num_i64) {
            if let Some(id) = add_drawing_annot(&mut doc, drawing) {
                new_annot_ids.push(id);
            }
        }
        if !new_annot_ids.is_empty() {
            let mut annots = get_page_existing_annots(&doc, page_id);
            for id in new_annot_ids {
                annots.push(lopdf::Object::Reference(id));
            }
            if let Some(lopdf::Object::Dictionary(ref mut page_dict)) =
                doc.objects.get_mut(&page_id)
            {
                page_dict.set(b"Annots".to_vec(), lopdf::Object::Array(annots));
            }
        }

        // Text boxes are flattened into the page content stream (not annotation objects)
        // so they render as permanent visible text in all standard PDF viewers.
        let page_tbs: Vec<&TextBox> = text_boxes
            .iter()
            .filter(|t| t.page == page_num_i64)
            .collect();
        if !page_tbs.is_empty() {
            flatten_text_boxes_to_page(&mut doc, page_id, &page_tbs);
        }
    }

    // Write to output path (original file is never modified)
    doc.save(&output_path).map_err(|e| e.to_string())?;

    Ok(output_path)
}

#[tauri::command]
pub fn reveal_in_folder(path: String) -> Result<(), String> {
    reveal_path(&path).map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
fn reveal_path(path: &str) -> std::io::Result<()> {
    std::process::Command::new("explorer.exe")
        .arg(format!("/select,{}", path))
        .spawn()
        .map(|_| ())
}

#[cfg(target_os = "macos")]
fn reveal_path(path: &str) -> std::io::Result<()> {
    std::process::Command::new("open")
        .args(["-R", path])
        .spawn()
        .map(|_| ())
}

#[cfg(target_os = "linux")]
fn reveal_path(path: &str) -> std::io::Result<()> {
    let dir = std::path::Path::new(path)
        .parent()
        .unwrap_or(std::path::Path::new("/"))
        .to_string_lossy()
        .into_owned();
    std::process::Command::new("xdg-open").arg(&dir).spawn().map(|_| ())
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn reveal_path(_path: &str) -> std::io::Result<()> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "unsupported OS"))
}

// ── Context retrieval ─────────────────────────────────────────────────────────

#[derive(Serialize)]
struct StoredChunk {
    chunk_index: i64,
    page: i64,
    content: String,
}

/// Full chunk row including raw embedding bytes — used by the search modal.
#[derive(Serialize)]
pub struct ChunkResult {
    pub id: String,
    pub source_id: String,
    pub page: i64,
    pub content: String,
    pub embedding: Vec<u8>,
}

#[tauri::command]
pub fn get_all_chunks(app: AppHandle) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, source_id, page, content, embedding \
             FROM chunks ORDER BY source_id, chunk_index",
        )
        .map_err(|e| e.to_string())?;

    let chunks: Vec<ChunkResult> = stmt
        .query_map([], |row| {
            Ok(ChunkResult {
                id:        row.get(0)?,
                source_id: row.get(1)?,
                page:      row.get(2)?,
                content:   row.get(3)?,
                embedding: row.get::<_, Option<Vec<u8>>>(4)?.unwrap_or_default(),
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    serde_json::to_string(&chunks).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_chunks_for_pdf(app: AppHandle, pdf_id: String) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT chunk_index, page, content FROM chunks WHERE source_id = ?1 ORDER BY chunk_index",
        )
        .map_err(|e| e.to_string())?;

    let chunks: Vec<StoredChunk> = stmt
        .query_map(rusqlite::params![pdf_id], |row| {
            Ok(StoredChunk {
                chunk_index: row.get(0)?,
                page: row.get(1)?,
                content: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    serde_json::to_string(&chunks).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_pdfs(app: AppHandle) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, filename, filepath, folder_id, page_count, pages_read, chunk_count, ingested_at, last_opened, content_hash, is_pinned, deleted_at
             FROM pdfs WHERE deleted_at IS NULL ORDER BY ingested_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let pdfs: Vec<Pdf> = stmt
        .query_map([], |row| {
            Ok(Pdf {
                id: row.get(0)?,
                filename: row.get(1)?,
                filepath: row.get(2)?,
                folder_id: row.get(3)?,
                page_count: row.get(4)?,
                pages_read: row.get(5)?,
                chunk_count: row.get(6)?,
                ingested_at: row.get(7)?,
                last_opened: row.get(8)?,
                content_hash: row.get(9)?,
                is_pinned: row.get::<_, i64>(10)? != 0,
                deleted_at: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    serde_json::to_string(&pdfs).map_err(|e| e.to_string())
}

// ── Outline ──────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct OutlineItem {
    pub id: String,
    pub pdf_id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub page: i64,
    pub order_index: i64,
    pub source: String,
    pub created_at: String,
}

fn row_to_outline_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<OutlineItem> {
    Ok(OutlineItem {
        id:          row.get(0)?,
        pdf_id:      row.get(1)?,
        parent_id:   row.get(2)?,
        title:       row.get(3)?,
        page:        row.get(4)?,
        order_index: row.get(5)?,
        source:      row.get(6)?,
        created_at:  row.get(7)?,
    })
}

const OUTLINE_SELECT: &str =
    "SELECT id, pdf_id, parent_id, title, page, order_index, source, created_at FROM outline_items";

#[derive(Debug, Serialize, Deserialize)]
pub struct OutlineItemInput {
    pub id: String,
    pub pdf_id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub page: i64,
    pub order_index: i64,
    pub source: String,
}

#[tauri::command]
pub fn store_outline(
    app: AppHandle,
    pdf_id: String,
    items: Vec<OutlineItemInput>,
) -> Result<(), String> {
    let mut conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM outline_items WHERE pdf_id = ?1",
        rusqlite::params![pdf_id],
    )
    .map_err(|e| e.to_string())?;
    for item in &items {
        tx.execute(
            "INSERT INTO outline_items (id, pdf_id, parent_id, title, page, order_index, source, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                item.id,
                item.pdf_id,
                item.parent_id,
                item.title,
                item.page,
                item.order_index,
                item.source,
                now
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_outline(app: AppHandle, pdf_id: String) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!("{OUTLINE_SELECT} WHERE pdf_id = ?1 ORDER BY order_index ASC"))
        .map_err(|e| e.to_string())?;
    let items: Vec<OutlineItem> = stmt
        .query_map(rusqlite::params![pdf_id], row_to_outline_item)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    serde_json::to_string(&items).map_err(|e| e.to_string())
}

// ── Collections (folders) + Pinned ──────────────────────────────────────────

fn row_to_folder(row: &rusqlite::Row<'_>) -> rusqlite::Result<Folder> {
    Ok(Folder {
        id: row.get(0)?,
        name: row.get(1)?,
        parent_id: row.get(2)?,
        order_index: row.get(3)?,
        created_at: row.get(4)?,
        is_pinned: row.get::<_, i64>(5)? != 0,
    })
}

const FOLDER_SELECT: &str = "SELECT id, name, parent_id, order_index, created_at, is_pinned FROM folders";

#[tauri::command]
pub fn create_folder(app: AppHandle, name: String, parent_id: Option<String>) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    let created_at = Utc::now().to_rfc3339();
    let next_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(order_index) + 1, 0) FROM folders WHERE parent_id IS ?1",
            rusqlite::params![parent_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    conn.execute(
        "INSERT INTO folders (id, name, parent_id, order_index, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![id, name, parent_id, next_order, created_at],
    )
    .map_err(|e| e.to_string())?;

    let folder = Folder { id, name, parent_id, order_index: next_order, created_at, is_pinned: false };
    serde_json::to_string(&folder).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_folders(app: AppHandle) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!("{FOLDER_SELECT} ORDER BY parent_id, order_index ASC"))
        .map_err(|e| e.to_string())?;
    let folders: Vec<Folder> = stmt
        .query_map([], row_to_folder)
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    serde_json::to_string(&folders).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_folder(app: AppHandle, id: String, name: String) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE folders SET name = ?1 WHERE id = ?2",
        rusqlite::params![name, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// Deletes a collection along with all of its (recursive) sub-collections.
// PDFs that belonged to any of the deleted folders are kept — only their
// folder_id is cleared — so removing a collection never deletes a document.
#[tauri::command]
pub fn delete_folder(app: AppHandle, id: String) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;

    let mut ids = vec![id.clone()];
    let mut frontier = vec![id];
    while !frontier.is_empty() {
        let mut next = vec![];
        for parent in &frontier {
            let mut stmt = conn
                .prepare("SELECT id FROM folders WHERE parent_id = ?1")
                .map_err(|e| e.to_string())?;
            let children: Vec<String> = stmt
                .query_map(rusqlite::params![parent], |row| row.get(0))
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            next.extend(children);
        }
        ids.extend(next.clone());
        frontier = next;
    }

    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    conn.execute(
        &format!("UPDATE pdfs SET folder_id = NULL WHERE folder_id IN ({placeholders})"),
        rusqlite::params_from_iter(ids.iter()),
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        &format!("DELETE FROM folders WHERE id IN ({placeholders})"),
        rusqlite::params_from_iter(ids.iter()),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// Persists a full sibling order in one call — the frontend recomputes the
// dragged-to order client-side and sends the whole list back, rather than
// this command reasoning about drag deltas itself.
#[tauri::command]
pub fn reorder_folders(app: AppHandle, ordered_ids: Vec<String>) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    for (index, folder_id) in ordered_ids.iter().enumerate() {
        conn.execute(
            "UPDATE folders SET order_index = ?1 WHERE id = ?2",
            rusqlite::params![index as i64, folder_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Re-parents a folder (drag-and-drop into a different folder, or back out to
// root). Rejects moves that would create a cycle by walking up from the
// requested new parent — if that walk ever reaches folder_id itself, the
// target is folder_id's own descendant (or folder_id itself) and the move
// is invalid.
#[tauri::command]
pub fn move_folder_to_parent(app: AppHandle, folder_id: String, parent_id: Option<String>) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;

    let mut current = parent_id.clone();
    while let Some(cur) = current {
        if cur == folder_id {
            return Err("cannot move a folder into its own descendant".to_string());
        }
        current = conn
            .query_row(
                "SELECT parent_id FROM folders WHERE id = ?1",
                rusqlite::params![cur],
                |row| row.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten();
    }

    let next_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(order_index) + 1, 0) FROM folders WHERE parent_id IS ?1",
            rusqlite::params![parent_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    conn.execute(
        "UPDATE folders SET parent_id = ?1, order_index = ?2 WHERE id = ?3",
        rusqlite::params![parent_id, next_order, folder_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn move_pdf_to_folder(app: AppHandle, pdf_id: String, folder_id: Option<String>) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE pdfs SET folder_id = ?1 WHERE id = ?2",
        rusqlite::params![folder_id, pdf_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_pdf_pinned(app: AppHandle, pdf_id: String, pinned: bool) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE pdfs SET is_pinned = ?1 WHERE id = ?2",
        rusqlite::params![pinned as i64, pdf_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_folder_pinned(app: AppHandle, folder_id: String, pinned: bool) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE folders SET is_pinned = ?1 WHERE id = ?2",
        rusqlite::params![pinned as i64, folder_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
