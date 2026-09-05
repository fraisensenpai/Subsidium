use super::{language, DiscoveredFile, FileNode, ScanSummary};
use anyhow::{Context, Result};
use ignore::WalkBuilder;
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Instant;

/// Directories we skip even when a workspace has no .gitignore, or the
/// .gitignore doesn't happen to cover them. This list is not meant to be
/// exhaustive or final — extend it as new noisy ecosystems come up.
const ALWAYS_IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target", // Rust build output
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    "__pycache__",
    ".venv",
    "venv",
    ".mypy_cache",
    ".pytest_cache",
    ".idea",
    ".subsidium", // Subsidium's own index/metadata folder for this workspace
];

pub struct ScanResult {
    pub tree: FileNode,
    pub files: Vec<DiscoveredFile>,
    pub summary: ScanSummary,
}

pub fn scan(root: &Path) -> Result<ScanResult> {
    let started = Instant::now();
    let root = super::strip_windows_extended_prefix(
        &root
            .canonicalize()
            .with_context(|| format!("workspace root does not exist: {}", root.display()))?,
    );

    let mut total_files = 0usize;
    let mut total_dirs = 0usize;
    let mut ignored_count = 0usize;
    let mut by_language: BTreeMap<String, usize> = BTreeMap::new();
    let mut files: Vec<DiscoveredFile> = Vec::new();

    // relative dir path ("" for root) -> children discovered directly under it
    let mut children_by_parent: BTreeMap<String, Vec<FileNode>> = BTreeMap::new();

    let walker = WalkBuilder::new(&root)
        .hidden(false) // we decide hidden-dir handling ourselves below
        .git_ignore(true)
        .git_exclude(true)
        .git_global(false)
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                !ALWAYS_IGNORED_DIRS.contains(&name.as_ref())
            } else {
                true
            }
        })
        .build();

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                ignored_count += 1;
                continue;
            }
        };

        let path = entry.path();
        if path == root {
            continue; // root itself, handled separately below
        }

        let relative = path
            .strip_prefix(&root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");

        let parent_relative = match relative.rsplit_once('/') {
            Some((parent, _)) => parent.to_string(),
            None => String::new(),
        };

        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);

        if is_dir {
            total_dirs += 1;
            children_by_parent.entry(relative.clone()).or_default();
            children_by_parent
                .entry(parent_relative)
                .or_default()
                .push(FileNode {
                    path: relative,
                    name,
                    is_dir: true,
                    language: None,
                    children: None, // filled in during tree assembly
                });
        } else {
            total_files += 1;
            let lang = language::detect(path);
            if let Some(l) = &lang {
                *by_language.entry(l.clone()).or_insert(0) += 1;
            }

            files.push(DiscoveredFile {
                absolute_path: path.to_path_buf(),
                relative_path: relative.clone(),
                language: lang.clone(),
            });

            children_by_parent
                .entry(parent_relative)
                .or_default()
                .push(FileNode {
                    path: relative,
                    name,
                    is_dir: false,
                    language: lang,
                    children: None,
                });
        }
    }

    let tree = assemble_tree(&root, &mut children_by_parent);

    let summary = ScanSummary {
        workspace_root: root.to_string_lossy().to_string(),
        total_files,
        total_dirs,
        ignored_count,
        by_language,
        duration_ms: started.elapsed().as_millis(),
    };

    Ok(ScanResult {
        tree,
        files,
        summary,
    })
}

/// Recursively attaches children to each directory node, starting from the
/// synthetic root node. `children_by_parent` maps a directory's relative
/// path ("" for the workspace root) to the nodes directly inside it.
fn assemble_tree(root: &Path, children_by_parent: &mut BTreeMap<String, Vec<FileNode>>) -> FileNode {
    fn build(path_key: &str, map: &mut BTreeMap<String, Vec<FileNode>>) -> Vec<FileNode> {
        let mut nodes = map.remove(path_key).unwrap_or_default();
        for node in nodes.iter_mut() {
            if node.is_dir {
                node.children = Some(build(&node.path, map));
            }
        }
        // Directories first, then alphabetical — easier to scan visually.
        nodes.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
        nodes
    }

    let root_name = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| root.to_string_lossy().to_string());

    FileNode {
        path: String::new(),
        name: root_name,
        is_dir: true,
        language: None,
        children: Some(build("", children_by_parent)),
    }
}
