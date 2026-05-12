use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkSummary {
    pub entries: Vec<WalkEntry>,
    pub truncated: bool,
    pub visited_dirs: usize,
    pub ignored_dirs: usize,
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

#[derive(Debug)]
struct WalkState {
    entries: Vec<WalkEntry>,
    truncated: bool,
    visited_dirs: usize,
    ignored_dirs: usize,
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
        seen_dirs: HashSet::new(),
        max_entries: options.max_entries,
    };

    walk_dir(&root, Path::new(""), &mut state)?;

    Ok(WalkSummary {
        entries: state.entries,
        truncated: state.truncated,
        visited_dirs: state.visited_dirs,
        ignored_dirs: state.ignored_dirs,
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
        Err(_) => return Ok(()),
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
}
