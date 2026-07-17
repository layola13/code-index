use crate::model::SourceFile;
use anyhow::{Context, Result};
use ignore::{DirEntry, WalkBuilder, WalkState};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;

const DEFAULT_IGNORED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".idea",
    ".vscode",
    ".vs",
    ".cache",
    ".code_index",
    ".history",
    ".summarizer",
    ".usernotice",
    ".usernotic",
    ".venv",
    ".tox",
    "__pycache__",
    "node_modules",
    "vendor",
    "dist",
    "build",
    "coverage",
    "out",
    "target",
    "binaries",
    "intermediate",
    "saved",
    "deriveddatacache",
    "thirdparty",
    "third_party",
    "third-party",
    "cmakefiles",
    "cmake-build-debug",
    "cmake-build-release",
    "tmp",
    ".tmp",
];

pub fn default_ignored_dirs(extra: &[String]) -> HashSet<String> {
    DEFAULT_IGNORED_DIRS
        .iter()
        .map(|name| name.to_ascii_lowercase())
        .chain(extra.iter().map(|name| name.trim().to_ascii_lowercase()))
        .filter(|name| !name.is_empty())
        .collect()
}

pub fn language_for_path(path: &Path) -> Option<&'static str> {
    let name = path.file_name()?.to_string_lossy().to_ascii_lowercase();
    let mappings = [
        (".tsx", "tsx"),
        (".mts", "typescript"),
        (".cts", "typescript"),
        (".ts", "typescript"),
        (".jsx", "javascript"),
        (".mjs", "javascript"),
        (".cjs", "javascript"),
        (".js", "javascript"),
        (".py", "python"),
        (".ml", "ocaml"),
        (".mli", "ocaml"),
        (".go", "go"),
        (".rs", "rust"),
        (".sla", "rust"),
        (".java", "java"),
        (".hx", "haxe"),
        (".zig", "zig"),
        (".sa", "saasm"),
        (".sai", "saasm"),
        (".sal", "saasm"),
        (".cppm", "cpp"),
        (".hpp", "cpp"),
        (".cxx", "cpp"),
        (".hxx", "cpp"),
        (".c++", "cpp"),
        (".h++", "cpp"),
        (".ixx", "cpp"),
        (".mpp", "cpp"),
        (".ipp", "cpp"),
        (".inl", "cpp"),
        (".tpp", "cpp"),
        (".cpp", "cpp"),
        (".cc", "cpp"),
        (".hh", "cpp"),
        (".c", "c"),
        (".h", "c"),
        (".kt", "generic"),
        (".kts", "generic"),
        (".swift", "generic"),
        (".rb", "generic"),
        (".php", "generic"),
        (".cs", "generic"),
        (".lua", "generic"),
        (".bash", "generic"),
        (".zsh", "generic"),
        (".sh", "generic"),
    ];
    mappings
        .iter()
        .find_map(|(suffix, language)| name.ends_with(suffix).then_some(*language))
}

fn to_posix_relative(root: &Path, path: &Path) -> Result<String> {
    let relative = path.strip_prefix(root).with_context(|| {
        format!(
            "failed to strip root {} from {}",
            root.display(),
            path.display()
        )
    })?;
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

fn is_generated_index_dir(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == ".code_index" || lower.starts_with(".code_index_") || lower.starts_with(".index_")
}

fn should_skip_dir(entry: &DirEntry, output_dir: &Path, ignored_dirs: &HashSet<String>) -> bool {
    let path = entry.path();
    if path == output_dir || path.starts_with(output_dir) {
        return true;
    }

    let Some(name) = path.file_name().map(|name| name.to_string_lossy()) else {
        return false;
    };
    let lower = name.to_ascii_lowercase();
    is_generated_index_dir(&lower) || ignored_dirs.contains(&lower)
}

pub struct DiscoveryResult {
    pub files: Vec<SourceFile>,
    pub file_limit_reached: bool,
}

pub fn discover_source_files(
    root_dir: &Path,
    output_dir: &Path,
    workers: usize,
    ignored_dirs: &HashSet<String>,
    max_files: Option<usize>,
) -> Result<DiscoveryResult> {
    let (tx, rx) = mpsc::channel::<SourceFile>();
    let mut builder = WalkBuilder::new(root_dir);
    let root_for_filter = root_dir.to_path_buf();
    builder
        .threads(workers.max(1))
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .parents(true)
        .ignore(true)
        .filter_entry({
            let output_dir = output_dir.to_path_buf();
            let ignored_dirs = ignored_dirs.clone();
            move |entry| {
                if entry.path() == root_for_filter {
                    return true;
                }
                if entry.file_type().is_some_and(|ft| ft.is_dir()) {
                    !should_skip_dir(entry, &output_dir, &ignored_dirs)
                } else {
                    true
                }
            }
        });

    let walker = builder.build_parallel();
    walker.run(|| {
        let tx = tx.clone();
        let root_dir: PathBuf = root_dir.to_path_buf();
        Box::new(move |result| {
            let Ok(entry) = result else {
                return WalkState::Continue;
            };
            if !entry.file_type().is_some_and(|ft| ft.is_file()) {
                return WalkState::Continue;
            }
            let Some(language) = language_for_path(entry.path()) else {
                return WalkState::Continue;
            };
            let Ok(relative_path) = to_posix_relative(&root_dir, entry.path()) else {
                return WalkState::Continue;
            };
            let _ = tx.send(SourceFile {
                absolute_path: entry.path().to_path_buf(),
                relative_path,
                language: language.to_string(),
            });
            WalkState::Continue
        })
    });
    drop(tx);

    let mut files: Vec<SourceFile> = rx.into_iter().collect();
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    let file_limit_reached = max_files.is_some_and(|limit| files.len() > limit);
    if let Some(limit) = max_files {
        files.truncate(limit);
    }

    Ok(DiscoveryResult {
        files,
        file_limit_reached,
    })
}
