use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkSummary {
    pub entries: Vec<WalkEntry>,
    pub truncated: bool,
    pub visited_dirs: usize,
    pub ignored_dirs: usize,
    pub unreadable_dirs: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkEntry {
    pub relative_path: String,
    #[serde(rename = "type")]
    pub entry_type: WalkEntryType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WalkEntryType {
    Dir,
    File,
}

#[derive(Debug, Clone)]
pub struct WalkOptions {
    pub root: PathBuf,
    pub max_entries: usize,
}

impl WalkOptions {
    pub fn new(root: impl Into<PathBuf>, max_entries: usize) -> Self {
        Self {
            root: root.into(),
            max_entries,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SearchOptions {
    pub root: PathBuf,
    pub database: PathBuf,
    pub query: String,
    pub limit: usize,
    pub max_entries: usize,
    pub refresh_ttl_ms: u64,
}

impl SearchOptions {
    pub fn new(
        root: impl Into<PathBuf>,
        database: impl Into<PathBuf>,
        query: impl Into<String>,
        limit: usize,
        max_entries: usize,
        refresh_ttl_ms: u64,
    ) -> Self {
        Self {
            root: root.into(),
            database: database.into(),
            query: query.into(),
            limit,
            max_entries,
            refresh_ttl_ms,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSummary {
    pub entries: Vec<WalkEntry>,
    pub truncated: bool,
    pub visited_dirs: usize,
    pub ignored_dirs: usize,
    pub unreadable_dirs: usize,
    pub index_refreshed: bool,
    pub index_age_ms: u64,
    pub database_path: String,
}

#[derive(Debug)]
struct WalkState {
    entries: Vec<WalkEntry>,
    truncated: bool,
    visited_dirs: usize,
    ignored_dirs: usize,
    unreadable_dirs: usize,
    seen_dirs: HashSet<PathBuf>,
    max_entries: usize,
}

pub fn walk_city(options: &WalkOptions) -> io::Result<WalkSummary> {
    let root = options.root.canonicalize()?;
    let mut state = WalkState {
        entries: Vec::new(),
        truncated: false,
        visited_dirs: 0,
        ignored_dirs: 0,
        unreadable_dirs: 0,
        seen_dirs: HashSet::new(),
        max_entries: options.max_entries,
    };

    walk_dir(&root, Path::new(""), &mut state)?;

    Ok(WalkSummary {
        entries: state.entries,
        truncated: state.truncated,
        visited_dirs: state.visited_dirs,
        ignored_dirs: state.ignored_dirs,
        unreadable_dirs: state.unreadable_dirs,
    })
}

pub fn search_city(options: &SearchOptions) -> Result<SearchSummary, IndexError> {
    let root = options.root.canonicalize()?;
    if let Some(parent) = options.database.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut conn = rusqlite::Connection::open(&options.database)?;
    initialize_schema(&conn)?;

    let now = now_ms();
    let root_string = root.to_string_lossy().to_string();
    let stored_root = metadata_value(&conn, "root")?;
    let index_built = metadata_value(&conn, "index_built")?
        .map(|value| value == "true")
        .unwrap_or(false);
    let built_at = metadata_value(&conn, "built_at_ms")?
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let stale = stored_root.as_deref() != Some(root_string.as_str())
        || !index_built
        || built_at == 0
        || now.saturating_sub(built_at) > options.refresh_ttl_ms;

    let mut refreshed = false;
    let mut latest_walk = None;
    if stale {
        let walk = walk_city(&WalkOptions::new(&root, options.max_entries))?;
        rebuild_index(&mut conn, &root_string, now, &walk)?;
        refreshed = true;
        latest_walk = Some(walk);
    }

    let entries = search_entries(&conn, &options.query, options.limit)?;
    let index_age_ms = now_ms().saturating_sub(
        metadata_value(&conn, "built_at_ms")?
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(now),
    );
    let truncated = metadata_value(&conn, "truncated")?
        .map(|value| value == "true")
        .unwrap_or(false);
    let visited_dirs = latest_walk
        .as_ref()
        .map(|walk| walk.visited_dirs)
        .or_else(|| {
            metadata_value(&conn, "visited_dirs")
                .ok()
                .flatten()
                .and_then(|value| value.parse::<usize>().ok())
        })
        .unwrap_or(0);
    let ignored_dirs = latest_walk
        .as_ref()
        .map(|walk| walk.ignored_dirs)
        .or_else(|| {
            metadata_value(&conn, "ignored_dirs")
                .ok()
                .flatten()
                .and_then(|value| value.parse::<usize>().ok())
        })
        .unwrap_or(0);
    let unreadable_dirs = latest_walk
        .as_ref()
        .map(|walk| walk.unreadable_dirs)
        .or_else(|| {
            metadata_value(&conn, "unreadable_dirs")
                .ok()
                .flatten()
                .and_then(|value| value.parse::<usize>().ok())
        })
        .unwrap_or(0);

    Ok(SearchSummary {
        entries,
        truncated,
        visited_dirs,
        ignored_dirs,
        unreadable_dirs,
        index_refreshed: refreshed,
        index_age_ms,
        database_path: options.database.to_string_lossy().to_string(),
    })
}

fn walk_dir(dir: &Path, relative_dir: &Path, state: &mut WalkState) -> io::Result<()> {
    if state.truncated {
        return Ok(());
    }

    let canonical = dir.canonicalize()?;
    if !state.seen_dirs.insert(canonical) {
        return Ok(());
    }
    state.visited_dirs += 1;

    let mut dirs = Vec::new();
    let mut files = Vec::new();

    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => {
            state.unreadable_dirs += 1;
            return Ok(());
        }
    };

    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        if should_ignore(&name.to_string_lossy()) {
            if entry.path().metadata().map(|m| m.is_dir()).unwrap_or(false) {
                state.ignored_dirs += 1;
            }
            continue;
        }

        let path = entry.path();
        let relative_path = relative_dir.join(&name);
        let metadata = match path.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };

        if metadata.is_dir() {
            dirs.push((path, relative_path));
        } else if metadata.is_file() {
            files.push(relative_path);
        }
    }

    dirs.sort_by(|a, b| a.1.cmp(&b.1));
    files.sort();

    for (path, relative_path) in dirs {
        if !push_entry(state, relative_path.clone(), WalkEntryType::Dir) {
            return Ok(());
        }
        walk_dir(&path, &relative_path, state)?;
        if state.truncated {
            return Ok(());
        }
    }

    for relative_path in files {
        if !push_entry(state, relative_path, WalkEntryType::File) {
            return Ok(());
        }
    }

    Ok(())
}

fn push_entry(state: &mut WalkState, relative_path: PathBuf, entry_type: WalkEntryType) -> bool {
    if state.entries.len() >= state.max_entries {
        state.truncated = true;
        return false;
    }

    let relative_path = relative_path.to_string_lossy().replace('\\', "/");
    if !relative_path.is_empty() {
        state.entries.push(WalkEntry {
            relative_path,
            entry_type,
        });
    }
    true
}

fn should_ignore(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".felt"
            | "node_modules"
            | "__pycache__"
            | ".venv"
            | ".mystra-cache"
            | "dist"
            | "build"
            | "_build"
    )
}

#[derive(Debug)]
pub enum IndexError {
    Io(io::Error),
    Sql(rusqlite::Error),
}

impl std::fmt::Display for IndexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
            Self::Sql(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for IndexError {}

impl From<io::Error> for IndexError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<rusqlite::Error> for IndexError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sql(error)
    }
}

fn initialize_schema(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS entries (
            relative_path TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            name TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts
            USING fts5(relative_path, name, type UNINDEXED);
        ",
    )
}

fn metadata_value(conn: &rusqlite::Connection, key: &str) -> rusqlite::Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM metadata WHERE key = ?1")?;
    let mut rows = stmt.query([key])?;
    if let Some(row) = rows.next()? {
        Ok(Some(row.get(0)?))
    } else {
        Ok(None)
    }
}

fn rebuild_index(
    conn: &mut rusqlite::Connection,
    root: &str,
    built_at_ms: u64,
    walk: &WalkSummary,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM metadata", [])?;
    tx.execute("DELETE FROM entries", [])?;
    tx.execute("DELETE FROM entries_fts", [])?;

    {
        let mut insert_entry =
            tx.prepare("INSERT INTO entries(relative_path, type, name) VALUES (?1, ?2, ?3)")?;
        let mut insert_fts =
            tx.prepare("INSERT INTO entries_fts(relative_path, name, type) VALUES (?1, ?2, ?3)")?;
        for entry in &walk.entries {
            let entry_type = entry_type_str(entry.entry_type);
            let name = Path::new(&entry.relative_path)
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| entry.relative_path.clone());
            insert_entry.execute(rusqlite::params![&entry.relative_path, entry_type, &name])?;
            insert_fts.execute(rusqlite::params![&entry.relative_path, &name, entry_type])?;
        }
    }

    for (key, value) in [
        ("root", root.to_string()),
        ("index_built", "true".to_string()),
        ("built_at_ms", built_at_ms.to_string()),
        ("truncated", walk.truncated.to_string()),
        ("visited_dirs", walk.visited_dirs.to_string()),
        ("ignored_dirs", walk.ignored_dirs.to_string()),
        ("unreadable_dirs", walk.unreadable_dirs.to_string()),
    ] {
        tx.execute(
            "INSERT INTO metadata(key, value) VALUES (?1, ?2)",
            rusqlite::params![key, value],
        )?;
    }
    tx.commit()
}

fn search_entries(
    conn: &rusqlite::Connection,
    query: &str,
    limit: usize,
) -> rusqlite::Result<Vec<WalkEntry>> {
    if limit == 0 || query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let mut seen = HashSet::new();
    let mut entries = Vec::new();

    if let Some(fts_query) = fts_query(query) {
        let mut stmt = conn.prepare(
            "
            SELECT relative_path, type
            FROM entries_fts
            WHERE entries_fts MATCH ?1
            ORDER BY bm25(entries_fts)
            LIMIT ?2
            ",
        )?;
        let rows = stmt.query_map(
            rusqlite::params![fts_query, limit as i64],
            row_to_walk_entry,
        )?;
        for entry in rows {
            push_unique(&mut entries, &mut seen, entry?);
        }
    }

    if entries.len() < limit {
        let needle = query.to_lowercase();
        let mut stmt =
            conn.prepare("SELECT relative_path, type FROM entries ORDER BY relative_path")?;
        let rows = stmt.query_map([], row_to_walk_entry)?;
        for entry in rows {
            if entries.len() >= limit {
                break;
            }
            let entry = entry?;
            if seen.contains(&entry.relative_path) {
                continue;
            }
            let path = entry.relative_path.to_lowercase();
            let name = Path::new(&path)
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            if path.contains(&needle)
                || name.contains(&needle)
                || subsequence_match(&needle, &path)
                || subsequence_match(&needle, &name)
            {
                push_unique(&mut entries, &mut seen, entry);
            }
        }
    }

    Ok(entries)
}

fn row_to_walk_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<WalkEntry> {
    let relative_path: String = row.get(0)?;
    let entry_type: String = row.get(1)?;
    Ok(WalkEntry {
        relative_path,
        entry_type: if entry_type == "dir" {
            WalkEntryType::Dir
        } else {
            WalkEntryType::File
        },
    })
}

fn push_unique(entries: &mut Vec<WalkEntry>, seen: &mut HashSet<String>, entry: WalkEntry) {
    if seen.insert(entry.relative_path.clone()) {
        entries.push(entry);
    }
}

fn fts_query(query: &str) -> Option<String> {
    let tokens: Vec<String> = query
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(|token| format!("\"{}\"*", token.replace('"', "\"\"")))
        .collect();
    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" AND "))
    }
}

fn subsequence_match(needle: &str, haystack: &str) -> bool {
    let mut chars = needle.chars().filter(|ch| !ch.is_whitespace());
    let Some(mut current) = chars.next() else {
        return true;
    };
    for ch in haystack.chars() {
        if ch == current {
            if let Some(next) = chars.next() {
                current = next;
            } else {
                return true;
            }
        }
    }
    false
}

fn entry_type_str(entry_type: WalkEntryType) -> &'static str {
    match entry_type {
        WalkEntryType::Dir => "dir",
        WalkEntryType::File => "file",
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs::{create_dir_all, remove_dir_all, write},
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("portolan-index-{name}-{nonce}"))
    }

    fn write_test_file(path: &Path) {
        create_dir_all(path.parent().unwrap()).unwrap();
        write(path, "test").unwrap();
    }

    #[test]
    fn walks_files_and_dirs_in_stable_order() {
        let root = temp_root("stable");
        write_test_file(&root.join("src").join("Beta.ts"));
        write_test_file(&root.join("docs").join("Guide.md"));
        write_test_file(&root.join("src").join("Alpha.ts"));

        let summary = walk_city(&WalkOptions::new(&root, 20)).unwrap();
        let entries: Vec<_> = summary
            .entries
            .iter()
            .map(|entry| (entry.relative_path.as_str(), entry.entry_type))
            .collect();

        assert_eq!(
            entries,
            vec![
                ("docs", WalkEntryType::Dir),
                ("docs/Guide.md", WalkEntryType::File),
                ("src", WalkEntryType::Dir),
                ("src/Alpha.ts", WalkEntryType::File),
                ("src/Beta.ts", WalkEntryType::File),
            ]
        );
        assert!(!summary.truncated);

        remove_dir_all(root).unwrap();
    }

    #[test]
    fn prunes_heavyweight_directories() {
        let root = temp_root("prune");
        write_test_file(&root.join("node_modules").join("IgnoredWidget.ts"));
        write_test_file(&root.join(".mystra-cache").join("IgnoredArtifact.ts"));
        write_test_file(&root.join("src").join("RealWidget.ts"));

        let summary = walk_city(&WalkOptions::new(&root, 20)).unwrap();
        let paths: Vec<_> = summary
            .entries
            .iter()
            .map(|entry| entry.relative_path.as_str())
            .collect();

        assert!(!paths.contains(&"node_modules"));
        assert!(!paths.contains(&".mystra-cache"));
        assert!(paths.contains(&"src/RealWidget.ts"));
        assert_eq!(summary.ignored_dirs, 2);

        remove_dir_all(root).unwrap();
    }

    #[test]
    fn reports_truncation() {
        let root = temp_root("truncate");
        write_test_file(&root.join("a.txt"));
        write_test_file(&root.join("b.txt"));

        let summary = walk_city(&WalkOptions::new(&root, 1)).unwrap();

        assert_eq!(summary.entries.len(), 1);
        assert!(summary.truncated);

        remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn counts_unreadable_dirs_in_walk_summary() {
        use std::os::unix::fs::PermissionsExt;

        let root = temp_root("unreadable");
        create_dir_all(root.join("blocked")).unwrap();
        write_test_file(&root.join("accessible").join("ok.txt"));

        let blocked = root.join("blocked");
        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o000)).unwrap();

        let summary = walk_city(&WalkOptions::new(&root, 20)).unwrap();

        assert_eq!(summary.unreadable_dirs, 1);
        assert_eq!(summary.ignored_dirs, 0);
        assert!(summary
            .entries
            .iter()
            .any(|entry| entry.relative_path == "accessible"));
        assert!(summary
            .entries
            .iter()
            .any(|entry| entry.relative_path == "accessible/ok.txt"));

        fs::set_permissions(&blocked, fs::Permissions::from_mode(0o755)).unwrap();
        remove_dir_all(root).unwrap();
    }

    #[test]
    fn empty_city_index_is_stable_with_no_entries() {
        let root = temp_root("empty-index");
        create_dir_all(&root).unwrap();
        let db_root = temp_root("empty-index-db");
        let db = db_root.join("files.sqlite");

        let first =
            search_city(&SearchOptions::new(&root, &db, "anything", 10, 20, 60_000)).unwrap();
        let second =
            search_city(&SearchOptions::new(&root, &db, "anything", 10, 20, 60_000)).unwrap();

        assert!(first.index_refreshed);
        assert!(!second.index_refreshed);
        assert_eq!(first.entries.len(), 0);
        assert_eq!(second.entries.len(), 0);
        assert_eq!(second.unreadable_dirs, 0);

        remove_dir_all(root).unwrap();
        remove_dir_all(db_root).unwrap();
    }

    #[test]
    fn persists_search_index_between_queries() {
        let root = temp_root("sqlite");
        let db_root = temp_root("sqlite-db");
        let db = db_root.join("files.sqlite");
        write_test_file(&root.join("src").join("HttpApiFilesSearch.ts"));
        write_test_file(&root.join("src").join("KanbanModal.ts"));

        let first =
            search_city(&SearchOptions::new(&root, &db, "HttpApi", 10, 20, 60_000)).unwrap();
        let second =
            search_city(&SearchOptions::new(&root, &db, "Kanban", 10, 20, 60_000)).unwrap();

        assert!(first.index_refreshed);
        assert!(!second.index_refreshed);
        assert_eq!(first.entries[0].relative_path, "src/HttpApiFilesSearch.ts");
        assert_eq!(second.entries[0].relative_path, "src/KanbanModal.ts");

        remove_dir_all(root).unwrap();
        remove_dir_all(db_root).unwrap();
    }

    #[test]
    fn search_falls_back_to_subsequence_matching() {
        let root = temp_root("subsequence");
        let db_root = temp_root("subsequence-db");
        let db = db_root.join("files.sqlite");
        write_test_file(&root.join("src").join("HttpApiFilesSearch.ts"));

        let summary = search_city(&SearchOptions::new(&root, &db, "hafs", 10, 20, 60_000)).unwrap();

        assert_eq!(
            summary.entries[0].relative_path,
            "src/HttpApiFilesSearch.ts"
        );

        remove_dir_all(root).unwrap();
        remove_dir_all(db_root).unwrap();
    }
}
