use crate::model::{
    CODE_INDEX_ARTIFACT_VERSION, CodeIndexManifest, EdgeIr, ModuleIr, ModuleRecord, SymbolRecord,
};
use crate::parser::{language_counts, method_count, parse_mode_counts};
use anyhow::{Context, Result};
use chrono::Utc;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::Path;

fn edge_id(index: usize) -> String {
    format!("edge-{index:06}")
}

fn function_signature(function: &crate::model::FunctionIr) -> String {
    let params = function
        .params
        .iter()
        .map(|param| {
            if let Some(annotation) = &param.annotation {
                format!("{}: {}", param.name, annotation)
            } else {
                param.name.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    if let Some(returns) = &function.returns {
        format!("{}({params}) -> {returns}", function.name)
    } else {
        format!("{}({params})", function.name)
    }
}

fn module_aliases(path: &str) -> Vec<String> {
    let without_ext = path
        .strip_suffix(".rs")
        .or_else(|| path.strip_suffix(".ts"))
        .or_else(|| path.strip_suffix(".tsx"))
        .or_else(|| path.strip_suffix(".js"))
        .or_else(|| path.strip_suffix(".py"))
        .unwrap_or(path);
    let mut aliases = vec![path.to_string(), without_ext.to_string()];
    if let Some(dir) = without_ext.strip_suffix("/mod") {
        aliases.push(dir.to_string());
    }
    aliases
}

fn build_module_alias_map(modules: &[ModuleIr]) -> HashMap<String, String> {
    let mut aliases = HashMap::new();
    for module in modules {
        for alias in module_aliases(&module.relative_path) {
            aliases
                .entry(alias)
                .or_insert_with(|| module.relative_path.clone());
        }
    }
    aliases
}

fn current_dir(path: &str) -> &str {
    path.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("")
}

fn normalize_path(path: &str) -> String {
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

fn resolve_import_path(
    importer_path: &str,
    specifier: &str,
    alias_map: &HashMap<String, String>,
) -> Option<String> {
    let specifier = specifier.trim();
    if specifier.is_empty() {
        return None;
    }

    let mut candidates = Vec::new();
    if let Some(module_name) = specifier.strip_prefix("mod:") {
        let base = current_dir(importer_path);
        let joined = if base.is_empty() {
            module_name.to_string()
        } else {
            format!("{base}/{module_name}")
        };
        candidates.push(joined);
    } else if let Some(rest) = specifier.strip_prefix("crate::") {
        candidates.push(rest.replace("::", "/"));
    } else if let Some(rest) = specifier.strip_prefix("self::") {
        let base = current_dir(importer_path);
        let joined = if base.is_empty() {
            rest.replace("::", "/")
        } else {
            format!("{base}/{}", rest.replace("::", "/"))
        };
        candidates.push(joined);
    } else if let Some(rest) = specifier.strip_prefix("super::") {
        let base = current_dir(current_dir(importer_path));
        let joined = if base.is_empty() {
            rest.replace("::", "/")
        } else {
            format!("{base}/{}", rest.replace("::", "/"))
        };
        candidates.push(joined);
    } else if specifier.starts_with('.') {
        let base = current_dir(importer_path);
        candidates.push(normalize_path(&format!("{base}/{specifier}")));
    } else if !specifier.contains('{') {
        candidates.push(specifier.replace("::", "/"));
    }

    for candidate in candidates {
        let normalized = normalize_path(&candidate);
        let variants = [
            normalized.clone(),
            format!("{normalized}.rs"),
            format!("{normalized}/mod.rs"),
            format!("{normalized}.ts"),
            format!("{normalized}.tsx"),
            format!("{normalized}.js"),
            format!("{normalized}.py"),
        ];
        for variant in variants {
            if let Some(path) = alias_map.get(&variant) {
                return Some(path.clone());
            }
        }
    }

    None
}

fn build_symbol_path_index(
    modules: &[ModuleIr],
) -> (HashMap<String, String>, HashMap<String, String>) {
    let mut exact = HashMap::new();
    let mut local_candidates: HashMap<String, Option<String>> = HashMap::new();
    for module in modules {
        for class in &module.classes {
            exact.insert(class.qualified_name.clone(), module.relative_path.clone());
            add_local_candidate(&mut local_candidates, &class.name, &module.relative_path);
            for method in &class.methods {
                exact.insert(method.qualified_name.clone(), module.relative_path.clone());
                add_local_candidate(&mut local_candidates, &method.name, &module.relative_path);
            }
        }
        for function in &module.functions {
            exact.insert(
                function.qualified_name.clone(),
                module.relative_path.clone(),
            );
            add_local_candidate(&mut local_candidates, &function.name, &module.relative_path);
        }
    }
    let local = local_candidates
        .into_iter()
        .filter_map(|(name, path)| path.map(|path| (name, path)))
        .collect();
    (exact, local)
}

fn add_local_candidate(index: &mut HashMap<String, Option<String>>, name: &str, path: &str) {
    match index.get_mut(name) {
        None => {
            index.insert(name.to_string(), Some(path.to_string()));
        }
        Some(current) if current.as_deref() != Some(path) => {
            *current = None;
        }
        _ => {}
    }
}

pub fn build_edges(modules: &[ModuleIr]) -> Vec<EdgeIr> {
    let alias_map = build_module_alias_map(modules);
    let (exact_symbols, local_symbols) = build_symbol_path_index(modules);
    let mut edges = Vec::new();

    for module in modules {
        for imported in &module.imports {
            let target_file = resolve_import_path(&module.relative_path, imported, &alias_map);
            edges.push(EdgeIr {
                edge_id: edge_id(edges.len() + 1),
                kind: "imports".to_string(),
                source: module.module_id.clone(),
                target: imported.clone(),
                source_file: module.relative_path.clone(),
                source_symbol: None,
                line_start: None,
                line_end: None,
                target_file,
            });
        }

        for class in &module.classes {
            for base in &class.bases {
                edges.push(EdgeIr {
                    edge_id: edge_id(edges.len() + 1),
                    kind: "inherits".to_string(),
                    source: class.qualified_name.clone(),
                    target: base.clone(),
                    source_file: module.relative_path.clone(),
                    source_symbol: Some(class.qualified_name.clone()),
                    line_start: Some(class.source_lines.start),
                    line_end: Some(class.source_lines.end),
                    target_file: exact_symbols
                        .get(base)
                        .or_else(|| local_symbols.get(base))
                        .cloned(),
                });
            }
            for method in &class.methods {
                for call in &method.calls {
                    edges.push(EdgeIr {
                        edge_id: edge_id(edges.len() + 1),
                        kind: "calls".to_string(),
                        source: method.qualified_name.clone(),
                        target: call.clone(),
                        source_file: module.relative_path.clone(),
                        source_symbol: Some(method.qualified_name.clone()),
                        line_start: Some(method.source_lines.start),
                        line_end: Some(method.source_lines.end),
                        target_file: exact_symbols
                            .get(call)
                            .or_else(|| local_symbols.get(call))
                            .cloned(),
                    });
                }
            }
        }

        for function in &module.functions {
            for call in &function.calls {
                edges.push(EdgeIr {
                    edge_id: edge_id(edges.len() + 1),
                    kind: "calls".to_string(),
                    source: function.qualified_name.clone(),
                    target: call.clone(),
                    source_file: module.relative_path.clone(),
                    source_symbol: Some(function.qualified_name.clone()),
                    line_start: Some(function.source_lines.start),
                    line_end: Some(function.source_lines.end),
                    target_file: exact_symbols
                        .get(call)
                        .or_else(|| local_symbols.get(call))
                        .cloned(),
                });
            }
        }
    }

    edges
}

pub fn build_manifest(
    root_dir: &Path,
    output_dir: &Path,
    modules: &[ModuleIr],
    edges: &[EdgeIr],
    max_files: Option<usize>,
    file_limit_reached: bool,
) -> CodeIndexManifest {
    CodeIndexManifest {
        artifact_version: CODE_INDEX_ARTIFACT_VERSION,
        root_dir: root_dir.to_string_lossy().to_string(),
        output_dir: output_dir.to_string_lossy().to_string(),
        created_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        module_count: modules.len(),
        class_count: modules.iter().map(|module| module.classes.len()).sum(),
        function_count: modules.iter().map(|module| module.functions.len()).sum(),
        method_count: modules.iter().map(method_count).sum(),
        edge_count: edges.len(),
        file_limit: max_files,
        file_limit_reached,
        truncated_count: modules.iter().filter(|module| module.truncated).count(),
        languages: language_counts(modules),
        parse_modes: parse_mode_counts(modules),
    }
}

fn methods_count(module: &ModuleIr) -> usize {
    method_count(module)
}

fn render_summary(manifest: &CodeIndexManifest, modules: &[ModuleIr], output_dir: &Path) -> String {
    let mut largest: Vec<&ModuleIr> = modules.iter().collect();
    largest.sort_by_key(|module| {
        std::cmp::Reverse(module.classes.len() + module.functions.len() + methods_count(module))
    });
    largest.truncate(20);

    let mut lines = vec![
        "# Code Index Summary".to_string(),
        String::new(),
        format!("- root: {}", manifest.root_dir),
        format!("- output: {}", output_dir.display()),
        format!("- modules: {}", manifest.module_count),
        format!("- classes: {}", manifest.class_count),
        format!("- functions: {}", manifest.function_count),
        format!("- methods: {}", manifest.method_count),
        format!("- edges: {}", manifest.edge_count),
        format!(
            "- file_limit: {}",
            manifest
                .file_limit
                .map(|value| value.to_string())
                .unwrap_or_else(|| "none".to_string())
        ),
        format!(
            "- file_limit_reached: {}",
            if manifest.file_limit_reached {
                "yes"
            } else {
                "no"
            }
        ),
        format!("- truncated_files: {}", manifest.truncated_count),
        String::new(),
        "## Languages".to_string(),
    ];
    for (language, count) in &manifest.languages {
        lines.push(format!("- {language}: {count}"));
    }
    lines.push(String::new());
    lines.push("## Parse Modes".to_string());
    for (mode, count) in &manifest.parse_modes {
        lines.push(format!("- {mode}: {count}"));
    }
    lines.push(String::new());
    lines.push("## Largest Modules".to_string());
    lines.push("| Module | Classes | Functions | Methods | Imports | Parse mode |".to_string());
    lines.push("| --- | ---: | ---: | ---: | ---: | --- |".to_string());
    for module in largest {
        lines.push(format!(
            "| {} | {} | {} | {} | {} | {} |",
            module.relative_path.replace('|', "\\|"),
            module.classes.len(),
            module.functions.len(),
            methods_count(module),
            module.imports.len(),
            module.parse_mode
        ));
    }

    let failed: Vec<&ModuleIr> = modules
        .iter()
        .filter(|module| !module.errors.is_empty())
        .take(20)
        .collect();
    if !failed.is_empty() {
        lines.push(String::new());
        lines.push("## Parse Errors".to_string());
        for module in failed {
            lines.push(format!(
                "- {}: {}",
                module.relative_path,
                module.errors.join("; ")
            ));
        }
    }

    lines.join("\n") + "\n"
}

fn escape_dot(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', " ")
        .replace('\r', "")
}

fn render_architecture_dot(edges: &[EdgeIr]) -> String {
    let file_edges: Vec<(&str, &str)> = edges
        .iter()
        .filter(|edge| edge.kind == "imports")
        .filter_map(|edge| {
            edge.target_file
                .as_deref()
                .map(|target| (edge.source_file.as_str(), target))
        })
        .filter(|(source, target)| source != target)
        .collect();

    let mut nodes = BTreeMap::new();
    for (source, target) in &file_edges {
        if !nodes.contains_key(*source) {
            let id = format!("n{}", nodes.len());
            nodes.insert((*source).to_string(), id);
        }
        if !nodes.contains_key(*target) {
            let id = format!("n{}", nodes.len());
            nodes.insert((*target).to_string(), id);
        }
    }

    let mut lines = vec!["digraph{".to_string()];
    for (path, id) in &nodes {
        lines.push(format!("{id}[label=\"{}\"]", escape_dot(path)));
    }

    let mut seen = HashSet::new();
    for (source, target) in file_edges {
        if !seen.insert((source.to_string(), target.to_string())) {
            continue;
        }
        if let (Some(source_id), Some(target_id)) = (nodes.get(source), nodes.get(target)) {
            lines.push(format!("{source_id}->{target_id}"));
        }
    }
    lines.push("}".to_string());
    lines.join("\n") + "\n"
}

fn skeleton_relative_path(relative_path: &str) -> String {
    let path = Path::new(relative_path);
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy())
        .unwrap_or_else(|| "module".into());
    if let Some(parent) = path.parent() {
        let parent = parent.to_string_lossy().replace('\\', "/");
        if parent.is_empty() {
            format!("{stem}.py")
        } else {
            format!("{parent}/{stem}.py")
        }
    } else {
        format!("{stem}.py")
    }
}

fn safe_python_identifier(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            out.push(ch);
        } else if !out.ends_with('_') {
            out.push('_');
        }
    }
    let mut out = out.trim_matches('_').to_string();
    if out.is_empty() {
        out = "symbol".to_string();
    }
    if out.chars().next().is_some_and(|ch| ch.is_ascii_digit()) {
        out.insert(0, '_');
    }
    out
}

fn write_skeletons(output_dir: &Path, modules: &[ModuleIr]) -> Result<()> {
    let skeleton_dir = output_dir.join("skeleton");
    fs::create_dir_all(&skeleton_dir)?;
    for module in modules {
        let relative = skeleton_relative_path(&module.relative_path);
        let target = skeleton_dir.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut lines = Vec::new();
        lines.push(format!("# source: {}", module.relative_path));
        lines.push(format!("# language: {}", module.language));
        lines.push(String::new());
        for import in &module.imports {
            lines.push(format!("# import {}", import));
        }
        if !module.imports.is_empty() {
            lines.push(String::new());
        }
        for class in &module.classes {
            lines.push(format!("class {}:", safe_python_identifier(&class.name)));
            if class.methods.is_empty() {
                lines.push("    pass".to_string());
            } else {
                for method in &class.methods {
                    lines.push(format!(
                        "    def {}({}): ...",
                        safe_python_identifier(&method.name),
                        method
                            .params
                            .iter()
                            .map(|param| safe_python_identifier(&param.name))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }
            }
            lines.push(String::new());
        }
        for function in &module.functions {
            lines.push(format!(
                "def {}({}): ...",
                safe_python_identifier(&function.name),
                function
                    .params
                    .iter()
                    .map(|param| safe_python_identifier(&param.name))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if module.classes.is_empty() && module.functions.is_empty() {
            lines.push("# no indexed symbols".to_string());
        }
        fs::write(target, lines.join("\n") + "\n")?;
    }
    Ok(())
}

fn write_json_line<T: serde::Serialize>(writer: &mut BufWriter<File>, value: &T) -> Result<()> {
    serde_json::to_writer(&mut *writer, value)?;
    writer.write_all(b"\n")?;
    Ok(())
}

fn write_modules_jsonl(path: &Path, modules: &[ModuleIr]) -> Result<()> {
    let mut writer = BufWriter::new(File::create(path)?);
    for module in modules {
        let record = ModuleRecord {
            module_id: &module.module_id,
            path: &module.relative_path,
            origin_path: module.origin_path.as_deref(),
            origin_start_character: module.origin_start_character,
            origin_start_line: module.origin_start_line,
            lang: &module.language,
            imports_count: module.imports.len(),
            classes_count: module.classes.len(),
            functions_count: module.functions.len(),
            methods_count: methods_count(module),
            parse_mode: &module.parse_mode,
            truncated: module.truncated,
            notes: &module.notes,
            errors: &module.errors,
        };
        write_json_line(&mut writer, &record)?;
    }
    Ok(())
}

fn write_symbols_jsonl(path: &Path, modules: &[ModuleIr]) -> Result<()> {
    let mut writer = BufWriter::new(File::create(path)?);
    for module in modules {
        for class in &module.classes {
            write_json_line(
                &mut writer,
                &SymbolRecord {
                    symbol_id: format!("{}::class:{}", module.module_id, class.name),
                    module_id: module.module_id.clone(),
                    kind: "class".to_string(),
                    qualified_name: class.qualified_name.clone(),
                    signature: if class.bases.is_empty() {
                        format!("class {}", class.name)
                    } else {
                        format!("class {}({})", class.name, class.bases.join(", "))
                    },
                    source_lines: class.source_lines,
                },
            )?;
            for method in &class.methods {
                write_json_line(
                    &mut writer,
                    &SymbolRecord {
                        symbol_id: format!(
                            "{}::method:{}.{}",
                            module.module_id, class.name, method.name
                        ),
                        module_id: module.module_id.clone(),
                        kind: "method".to_string(),
                        qualified_name: method.qualified_name.clone(),
                        signature: function_signature(method),
                        source_lines: method.source_lines,
                    },
                )?;
            }
        }
        for function in &module.functions {
            write_json_line(
                &mut writer,
                &SymbolRecord {
                    symbol_id: format!("{}::function:{}", module.module_id, function.name),
                    module_id: module.module_id.clone(),
                    kind: "function".to_string(),
                    qualified_name: function.qualified_name.clone(),
                    signature: function_signature(function),
                    source_lines: function.source_lines,
                },
            )?;
        }
    }
    Ok(())
}

fn write_index_py(output_dir: &Path, modules: &[ModuleIr], edges: &[EdgeIr]) -> Result<()> {
    let mut dir_counts: BTreeMap<String, usize> = BTreeMap::new();
    for module in modules {
        let dir = module
            .relative_path
            .rsplit_once('/')
            .map(|(dir, _)| dir)
            .unwrap_or(".");
        *dir_counts.entry(dir.to_string()).or_insert(0) += 1;
    }
    let mut top_dirs: Vec<_> = dir_counts.into_iter().collect();
    top_dirs.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
    top_dirs.truncate(30);

    let mut call_counts: HashMap<String, usize> = HashMap::new();
    for edge in edges.iter().filter(|edge| edge.kind == "calls") {
        *call_counts.entry(edge.target.clone()).or_insert(0) += 1;
    }
    let mut top_calls: Vec<_> = call_counts.into_iter().collect();
    top_calls.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
    top_calls.truncate(30);

    let mut lines = vec![
        "# __index__.py  (auto-generated navigation bus)".to_string(),
        "from __future__ import annotations".to_string(),
        "from typing import Dict, List".to_string(),
        String::new(),
        "ENTRY_POINTS: Dict[str, str] = {}".to_string(),
        String::new(),
        "TOP_DIRECTORIES: Dict[str, int] = {".to_string(),
    ];
    for (dir, count) in top_dirs {
        lines.push(format!("    '{}': {},", dir.replace('\'', "\\'"), count));
    }
    lines.push("}".to_string());
    lines.push(String::new());
    lines.push("HIGH_PRIORITY_SYMBOLS: Dict[str, int] = {".to_string());
    for (symbol, count) in top_calls {
        lines.push(format!("    '{}': {},", symbol.replace('\'', "\\'"), count));
    }
    lines.push("}".to_string());
    lines.push(String::new());
    lines.push("def hot_symbols(n: int = 10) -> List[str]:".to_string());
    lines.push("    return list(HIGH_PRIORITY_SYMBOLS)[:n]".to_string());
    lines.push(String::new());
    lines.push("def module_count(dir_path: str) -> int:".to_string());
    lines.push("    return TOP_DIRECTORIES.get(dir_path, 0)".to_string());
    lines.push(String::new());
    lines.push("def directory_overview() -> Dict[str, int]:".to_string());
    lines.push("    return dict(TOP_DIRECTORIES)".to_string());
    lines.push(String::new());
    fs::write(output_dir.join("__index__.py"), lines.join("\n"))?;
    Ok(())
}

pub fn write_index(
    root_dir: &Path,
    output_dir: &Path,
    modules: &[ModuleIr],
    edges: &[EdgeIr],
    manifest: &CodeIndexManifest,
) -> Result<()> {
    let index_dir = output_dir.join("index");
    fs::create_dir_all(&index_dir)
        .with_context(|| format!("failed to create {}", index_dir.display()))?;
    fs::create_dir_all(output_dir.join("skeleton"))?;

    fs::write(
        index_dir.join("manifest.json"),
        serde_json::to_string_pretty(manifest)? + "\n",
    )?;
    write_modules_jsonl(&index_dir.join("modules.jsonl"), modules)?;
    write_symbols_jsonl(&index_dir.join("symbols.jsonl"), modules)?;
    {
        let mut writer = BufWriter::new(File::create(index_dir.join("edges.jsonl"))?);
        for edge in edges {
            write_json_line(&mut writer, edge)?;
        }
    }
    fs::write(
        index_dir.join("summary.md"),
        render_summary(manifest, modules, output_dir),
    )?;
    fs::write(
        index_dir.join("architecture.dot"),
        render_architecture_dot(edges),
    )?;
    write_skeletons(output_dir, modules)?;
    write_index_py(output_dir, modules, edges)?;

    let skill_dir = output_dir.join("skills");
    fs::create_dir_all(&skill_dir)?;
    fs::write(
        skill_dir.join("code-index-rs.md"),
        format!(
            "# code-index-rs\n\nGenerated for `{}`.\n\nUse `index/summary.md`, `index/modules.jsonl`, `index/symbols.jsonl`, and `skeleton/` as the navigation map.\n",
            root_dir.display()
        ),
    )?;

    Ok(())
}
