pub mod language;
pub mod scanner;

use anyhow::{bail, Result};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};

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

/// Resolves a workspace-relative path against the workspace root, refusing
/// anything that would escape it.
///
/// Both the editor and the agent hand us paths that are *supposed* to be
/// relative to the open workspace, but nothing upstream guarantees it: a
/// crafted `../../../../etc/passwd`, an absolute `C:\Windows\...`, or a
/// symlink pointing outside the root would all reach files the workspace
/// never contained. `Path::join` alone doesn't help — it happily replaces
/// the base when the right-hand side is absolute.
///
/// Absolute paths and `..` components are rejected outright. When the
/// target already exists we additionally check that its canonical location
/// is still inside the (canonical) root, which catches symlink/junction
/// escapes. A brand-new file can't be checked that way, but the component
/// checks above already bound it to a path strictly under the root.
pub fn resolve_workspace_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let rel = Path::new(relative);
    if rel.is_absolute() {
        bail!("path must be relative to the workspace");
    }

    let mut candidate = root.to_path_buf();
    for component in rel.components() {
        match component {
            Component::Normal(part) => candidate.push(part),
            Component::CurDir => {}
            Component::ParentDir => bail!("path may not escape the workspace"),
            Component::RootDir | Component::Prefix(_) => {
                bail!("path must be relative to the workspace")
            }
        }
    }

    if let Ok(canonical) = candidate.canonicalize() {
        if let Ok(root_canonical) = root.canonicalize() {
            if !canonical.starts_with(&root_canonical) {
                bail!("path may not escape the workspace");
            }
        }
    }

    Ok(candidate)
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

    #[test]
    fn resolve_allows_nested_relative_paths() {
        let root = Path::new("/tmp/ws");
        let mut expected = root.to_path_buf();
        expected.push("src");
        expected.push("lib");
        expected.push("main.rs");
        assert_eq!(
            resolve_workspace_path(root, "src/lib/main.rs").unwrap(),
            expected
        );

        let mut collapsed = root.to_path_buf();
        collapsed.push("src");
        collapsed.push("main.rs");
        assert_eq!(
            resolve_workspace_path(root, "./src/./main.rs").unwrap(),
            collapsed
        );
    }

    #[test]
    fn resolve_rejects_traversal() {
        let root = Path::new("/tmp/ws");
        assert!(resolve_workspace_path(root, "../secret").is_err());
        assert!(resolve_workspace_path(root, "src/../../secret").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn resolve_rejects_absolute_paths() {
        let root = Path::new(r"C:\ws");
        assert!(resolve_workspace_path(root, r"C:\Windows\System32\drivers\etc\hosts").is_err());
        assert!(resolve_workspace_path(root, r"\Windows\win.ini").is_err());
    }

    #[cfg(not(windows))]
    #[test]
    fn resolve_rejects_absolute_paths() {
        let root = Path::new("/tmp/ws");
        assert!(resolve_workspace_path(root, "/etc/passwd").is_err());
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
