pub mod language;
pub mod scanner;

use serde::Serialize;
use std::path::{Path, PathBuf};

/// A node in the workspace file tree, sent to the frontend for the
/// Explorer panel. Directories carry `children`; files carry `language`.
#[derive(Debug, Clone, Serialize)]
pub struct FileNode {
    pub path: String, // relative to workspace root, forward-slash separated
    pub name: String,
    pub is_dir: bool,
    pub language: Option<String>,
    pub children: Option<Vec<FileNode>>,
}

/// A single source file discovered during the scan, before parsing.
#[derive(Debug, Clone)]
pub struct DiscoveredFile {
    pub absolute_path: PathBuf,
    pub relative_path: String,
    pub language: Option<String>,
}

/// Windows APIs (the folder picker, and Rust's own `canonicalize`) often
/// hand back paths with the extended-length prefix (`\\?\C:\...` or
/// `\\?\UNC\server\share`). Regular file APIs accept those fine, but
/// cmd.exe refuses them as a current directory — it prints "UNC paths are
/// not supported" and silently drops to C:\Windows. Strip the prefix
/// anywhere the path can become a shell working directory.
pub fn strip_windows_extended_prefix(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest.to_string())
    } else {
        path.to_path_buf()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_windows_extended_prefix() {
        let prefixed = Path::new(r"\\?\C:\Users\mstfy\Projects");
        assert_eq!(
            strip_windows_extended_prefix(prefixed),
            PathBuf::from(r"C:\Users\mstfy\Projects")
        );
        let unc = Path::new(r"\\?\UNC\server\share");
        assert_eq!(strip_windows_extended_prefix(unc), PathBuf::from(r"\\server\share"));
        let plain = Path::new(r"C:\plain\path");
        assert_eq!(strip_windows_extended_prefix(plain), PathBuf::from(r"C:\plain\path"));
    }
}

/// Aggregate stats about a scan, shown in the Project Intelligence panel
/// and used to decide what (if anything) needs re-indexing.
#[derive(Debug, Clone, Serialize)]
pub struct ScanSummary {
    pub workspace_root: String,
    pub total_files: usize,
    pub total_dirs: usize,
    pub ignored_count: usize,
    pub by_language: std::collections::BTreeMap<String, usize>,
    pub duration_ms: u128,
}
