pub mod commands;

use commands::{
    add_drawing, add_flashcard, add_highlight, add_pdf, add_text_box, create_dir_if_not_exists,
    create_note, delete_chunks_for_pdf, delete_drawing, delete_flashcard, delete_highlight,
    delete_note, delete_pdf, delete_text_box, export_annotated_pdf, extract_pdf_text,
    get_all_chunks, get_all_flashcards, get_app_data_dir, get_chunks_for_pdf, get_drawings,
    get_flashcards, get_highlights, get_notes, get_outline, get_pdfs, get_setting, get_text_boxes,
    open_file_dialog, read_file, rename_pdf, reveal_in_folder, set_setting, store_chunks,
    store_outline, update_drawing_points, update_flashcard_review, update_last_opened,
    update_note, update_pdf_ingestion_status, update_text_box,
};
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Windows/Linux register the pagedge:// scheme via the installer in
            // production, but `cargo tauri dev` builds skip that step — this
            // registers it at runtime so deep links work in development too.
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }

            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;

            let db_path = app_data_dir.join("pagedge.db");
            let conn = rusqlite::Connection::open(&db_path)
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;

            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS folders (
                    id         TEXT PRIMARY KEY,
                    name       TEXT NOT NULL,
                    parent_id  TEXT,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS pdfs (
                    id          TEXT PRIMARY KEY,
                    filename    TEXT NOT NULL,
                    filepath    TEXT NOT NULL UNIQUE,
                    folder_id   TEXT,
                    page_count  INTEGER,
                    pages_read  INTEGER DEFAULT 0,
                    ingested_at TEXT,
                    last_opened TEXT,
                    FOREIGN KEY (folder_id) REFERENCES folders(id)
                );

                CREATE TABLE IF NOT EXISTS highlights (
                    id            TEXT PRIMARY KEY,
                    pdf_id        TEXT NOT NULL,
                    page          INTEGER NOT NULL,
                    color         TEXT NOT NULL,
                    selected_text TEXT NOT NULL,
                    position_x    REAL NOT NULL,
                    position_y    REAL NOT NULL,
                    position_w    REAL NOT NULL,
                    position_h    REAL NOT NULL,
                    note          TEXT,
                    created_at    TEXT NOT NULL,
                    rects         TEXT,
                    FOREIGN KEY (pdf_id) REFERENCES pdfs(id)
                );

                CREATE TABLE IF NOT EXISTS notes (
                    id               TEXT PRIMARY KEY,
                    title            TEXT NOT NULL DEFAULT 'Untitled',
                    content_markdown TEXT NOT NULL DEFAULT '',
                    folder_id        TEXT,
                    source_pdf_id    TEXT,
                    source_page      INTEGER,
                    tags             TEXT NOT NULL DEFAULT '[]',
                    created_at       TEXT NOT NULL,
                    updated_at       TEXT NOT NULL,
                    FOREIGN KEY (folder_id)     REFERENCES folders(id),
                    FOREIGN KEY (source_pdf_id) REFERENCES pdfs(id)
                );

                CREATE TABLE IF NOT EXISTS chunks (
                    id          TEXT PRIMARY KEY,
                    source_type TEXT NOT NULL DEFAULT 'pdf',
                    source_id   TEXT NOT NULL,
                    chunk_index INTEGER NOT NULL,
                    page        INTEGER NOT NULL,
                    content     TEXT NOT NULL,
                    embedding   BLOB,
                    created_at  TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id);

                CREATE TABLE IF NOT EXISTS settings (
                    key   TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS drawings (
                    id           TEXT PRIMARY KEY,
                    pdf_id       TEXT NOT NULL,
                    page         INTEGER NOT NULL,
                    tool_type    TEXT NOT NULL,
                    color        TEXT NOT NULL,
                    stroke_width REAL NOT NULL DEFAULT 2.0,
                    points       TEXT NOT NULL,
                    created_at   TEXT NOT NULL,
                    FOREIGN KEY (pdf_id) REFERENCES pdfs(id)
                );

                CREATE INDEX IF NOT EXISTS idx_drawings_pdf ON drawings(pdf_id, page);

                CREATE TABLE IF NOT EXISTS text_boxes (
                    id         TEXT PRIMARY KEY,
                    pdf_id     TEXT NOT NULL,
                    page       INTEGER NOT NULL,
                    content    TEXT NOT NULL DEFAULT '',
                    position_x REAL NOT NULL,
                    position_y REAL NOT NULL,
                    width      REAL NOT NULL,
                    height     REAL NOT NULL,
                    font_size  REAL NOT NULL DEFAULT 14,
                    color      TEXT NOT NULL DEFAULT '#eee0d2',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY (pdf_id) REFERENCES pdfs(id)
                );

                CREATE INDEX IF NOT EXISTS idx_text_boxes_pdf ON text_boxes(pdf_id, page);

                CREATE TABLE IF NOT EXISTS flashcards (
                    id                  TEXT PRIMARY KEY,
                    source_highlight_id TEXT NOT NULL,
                    pdf_id              TEXT NOT NULL,
                    page                INTEGER NOT NULL,
                    front               TEXT NOT NULL,
                    back                TEXT NOT NULL,
                    interval            REAL NOT NULL DEFAULT 0,
                    ease_factor         REAL NOT NULL DEFAULT 2.5,
                    repetitions         INTEGER NOT NULL DEFAULT 0,
                    next_review         TEXT NOT NULL,
                    created_at          TEXT NOT NULL,
                    FOREIGN KEY (pdf_id) REFERENCES pdfs(id),
                    FOREIGN KEY (source_highlight_id) REFERENCES highlights(id)
                );

                CREATE INDEX IF NOT EXISTS idx_flashcards_pdf ON flashcards(pdf_id);
                CREATE INDEX IF NOT EXISTS idx_flashcards_review ON flashcards(next_review);

                CREATE TABLE IF NOT EXISTS outline_items (
                    id          TEXT PRIMARY KEY,
                    pdf_id      TEXT NOT NULL,
                    parent_id   TEXT,
                    title       TEXT NOT NULL,
                    page        INTEGER NOT NULL,
                    order_index INTEGER NOT NULL,
                    source      TEXT NOT NULL,
                    created_at  TEXT NOT NULL,
                    FOREIGN KEY (pdf_id) REFERENCES pdfs(id)
                );

                CREATE INDEX IF NOT EXISTS idx_outline_pdf ON outline_items(pdf_id);",
            )
            .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;

            // Settings defaults — INSERT OR IGNORE so user edits survive restarts
            let _ = conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('ai_provider', 'ollama')", []);
            let _ = conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('ai_model', 'llama3.2')", []);
            let _ = conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('ai_base_url', 'http://localhost:11434/v1')", []);
            let _ = conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('ai_api_key', '')", []);
            let _ = conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('ai_use_custom_provider', 'false')", []);

            // Column migrations — silently no-op if column already exists
            let _ = conn.execute("ALTER TABLE highlights ADD COLUMN rects TEXT", []);
            let _ = conn.execute("ALTER TABLE pdfs ADD COLUMN chunk_count INTEGER DEFAULT 0", []);

            // ── Deduplication migration ───────────────────────────────────────────
            // Root cause: CREATE TABLE IF NOT EXISTS never modifies existing tables,
            // so databases created before the UNIQUE constraint was added to the
            // filepath column have no uniqueness enforcement. INSERT OR IGNORE is a
            // no-op on those old rows, producing a fresh UUID-keyed row each import.
            //
            // Fix: for each filepath with > 1 row, keep the earliest (lowest rowid),
            // reassign all highlights / notes / chunk references to the kept id, delete
            // the surplus rows, then create a named UNIQUE INDEX that works on both old
            // and new schemas. All steps use let _ so a failure never blocks startup.
            {
                let dup_paths: Vec<String> = {
                    match conn.prepare(
                        "SELECT filepath FROM pdfs GROUP BY filepath HAVING COUNT(*) > 1",
                    ) {
                        Ok(mut stmt) => stmt
                            .query_map([], |r| r.get(0))
                            .map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
                            .unwrap_or_default(),
                        Err(_) => vec![],
                    }
                };

                for path in dup_paths {
                    // The canonical id: first imported (lowest SQLite rowid)
                    let keep_id: String = match conn.query_row(
                        "SELECT id FROM pdfs WHERE filepath = ?1 ORDER BY rowid ASC LIMIT 1",
                        rusqlite::params![path],
                        |r| r.get(0),
                    ) {
                        Ok(id) => id,
                        Err(_) => continue,
                    };

                    // Every other id for this filepath is surplus
                    let surplus_ids: Vec<String> = {
                        match conn.prepare(
                            "SELECT id FROM pdfs WHERE filepath = ?1 AND id != ?2",
                        ) {
                            Ok(mut stmt) => stmt
                                .query_map(rusqlite::params![path, keep_id], |r| r.get(0))
                                .map(|rows| rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
                                .unwrap_or_default(),
                            Err(_) => vec![],
                        }
                    };

                    for sid in surplus_ids {
                        // Reassign child-table references to the kept id
                        let _ = conn.execute(
                            "UPDATE highlights SET pdf_id = ?1 WHERE pdf_id = ?2",
                            rusqlite::params![keep_id, sid],
                        );
                        let _ = conn.execute(
                            "UPDATE notes SET source_pdf_id = ?1 WHERE source_pdf_id = ?2",
                            rusqlite::params![keep_id, sid],
                        );
                        // Discard surplus chunks — the kept id retains its own chunk set;
                        // re-ingestion is needed only if the kept id has chunk_count = 0.
                        let _ = conn.execute(
                            "DELETE FROM chunks WHERE source_id = ?1",
                            rusqlite::params![sid],
                        );
                        let _ = conn.execute(
                            "DELETE FROM drawings WHERE pdf_id = ?1",
                            rusqlite::params![sid],
                        );
                        let _ = conn.execute(
                            "DELETE FROM text_boxes WHERE pdf_id = ?1",
                            rusqlite::params![sid],
                        );
                        let _ = conn.execute(
                            "DELETE FROM pdfs WHERE id = ?1",
                            rusqlite::params![sid],
                        );
                    }
                }
            }

            // Create a named UNIQUE INDEX so future inserts are guarded even on
            // databases whose original CREATE TABLE lacked the column constraint.
            let _ = conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_pdfs_filepath ON pdfs(filepath)",
                [],
            );

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_file_dialog,
            read_file,
            get_app_data_dir,
            create_dir_if_not_exists,
            add_pdf,
            get_pdfs,
            delete_pdf,
            rename_pdf,
            update_last_opened,
            add_highlight,
            get_highlights,
            delete_highlight,
            create_note,
            get_notes,
            update_note,
            delete_note,
            extract_pdf_text,
            store_chunks,
            update_pdf_ingestion_status,
            delete_chunks_for_pdf,
            get_setting,
            set_setting,
            get_chunks_for_pdf,
            get_all_chunks,
            add_drawing,
            get_drawings,
            delete_drawing,
            update_drawing_points,
            add_text_box,
            get_text_boxes,
            update_text_box,
            delete_text_box,
            add_flashcard,
            get_flashcards,
            get_all_flashcards,
            delete_flashcard,
            update_flashcard_review,
            export_annotated_pdf,
            reveal_in_folder,
            store_outline,
            get_outline,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
