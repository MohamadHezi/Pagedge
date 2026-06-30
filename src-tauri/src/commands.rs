use chrono::Utc;
use lopdf;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
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
        conn.query_row(
            "SELECT id, filename, filepath, folder_id, page_count, pages_read, chunk_count, ingested_at, last_opened
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
                })
            },
        )
        .map_err(|e| e.to_string())?
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
        }
    };

    serde_json::to_string(&pdf).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_pdf(app: AppHandle, id: String) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    // Cascade in dependency order: child rows first, then the pdf row itself.
    conn.execute("DELETE FROM highlights WHERE pdf_id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM chunks WHERE source_id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM drawings WHERE pdf_id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM text_boxes WHERE pdf_id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    // Keep notes but sever the PDF reference so they survive as orphaned notes.
    conn.execute(
        "UPDATE notes SET source_pdf_id = NULL, source_page = NULL WHERE source_pdf_id = ?1",
        rusqlite::params![id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM pdfs WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
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
    };

    serde_json::to_string(&highlight).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_highlights(app: AppHandle, pdf_id: String) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, pdf_id, page, color, selected_text,
                    position_x, position_y, position_w, position_h,
                    note, created_at, rects
             FROM highlights
             WHERE pdf_id = ?1
             ORDER BY page ASC, position_y DESC",
        )
        .map_err(|e| e.to_string())?;

    let highlights: Vec<Highlight> = stmt
        .query_map(rusqlite::params![pdf_id], |row| {
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
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    serde_json::to_string(&highlights).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_highlight(app: AppHandle, id: String) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM highlights WHERE id = ?1",
        rusqlite::params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
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
    })
}

const NOTE_SELECT: &str =
    "SELECT id, title, content_markdown, folder_id, source_pdf_id, source_page,
            tags, created_at, updated_at FROM notes";

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
    };

    serde_json::to_string(&note).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_notes(app: AppHandle, pdf_id: Option<String>) -> Result<String, String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;

    let notes: Vec<Note> = if let Some(pid) = pdf_id {
        let mut stmt = conn
            .prepare(&format!(
                "{NOTE_SELECT} WHERE source_pdf_id = ?1 ORDER BY updated_at DESC"
            ))
            .map_err(|e| e.to_string())?;
        let rows: Vec<Note> = stmt
            .query_map(rusqlite::params![pid], row_to_note)
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        rows
    } else {
        let mut stmt = conn
            .prepare(&format!("{NOTE_SELECT} ORDER BY updated_at DESC"))
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
            updated_at       = ?4
         WHERE id = ?5",
        rusqlite::params![title, content_markdown, tags_json, now, id],
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
pub fn delete_note(app: AppHandle, id: String) -> Result<(), String> {
    let conn = Connection::open(db_path(&app)?).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM notes WHERE id = ?1", rusqlite::params![id])
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
            "SELECT id, filename, filepath, folder_id, page_count, pages_read, chunk_count, ingested_at, last_opened
             FROM pdfs ORDER BY ingested_at DESC",
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
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    serde_json::to_string(&pdfs).map_err(|e| e.to_string())
}
