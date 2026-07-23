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
        .or_else(|| path.strip_suffix(".sh"))
        .or_else(|| path.strip_suffix(".bash"))
        .or_else(|| path.strip_suffix(".zsh"))
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
            format!("{normalized}.sh"),
            format!("{normalized}.bash"),
            format!("{normalized}.zsh"),
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

fn skeleton_relative_path(relative_path: &str, used_paths: &mut HashSet<String>) -> String {
    let path = Path::new(relative_path);
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy())
        .unwrap_or_else(|| "module".into());
    let parent = path
        .parent()
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let candidate = if parent.is_empty() {
        format!("{stem}.py")
    } else {
        format!("{parent}/{stem}.py")
    };
    if used_paths.insert(candidate.clone()) {
        return candidate;
    }

    let base = path
        .file_name()
        .map(|name| name.to_string_lossy())
        .unwrap_or_else(|| "module".into());
    let suffix = base
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    let mut counter = 0usize;
    loop {
        let disambiguated_stem = if counter == 0 {
            format!("{stem}__{suffix}")
        } else {
            format!("{stem}__{suffix}_{counter}")
        };
        let disambiguated = if parent.is_empty() {
            format!("{disambiguated_stem}.py")
        } else {
            format!("{parent}/{disambiguated_stem}.py")
        };
        if used_paths.insert(disambiguated.clone()) {
            return disambiguated;
        }
        counter += 1;
    }
}

fn safe_python_identifier(value: &str) -> String {
    const PYTHON_KEYWORDS: &[&str] = &[
        "and", "as", "assert", "async", "await", "break", "case", "class", "continue", "def",
        "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in",
        "is", "lambda", "match", "nonlocal", "not", "or", "pass", "raise", "return", "try",
        "while", "with", "yield",
    ];
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            out.push(ch);
        } else if !out.ends_with('_') {
            out.push('_');
        }
    }
    if out.is_empty() {
        out = "symbol".to_string();
    }
    if out.chars().next().is_some_and(|ch| ch.is_ascii_digit()) {
        out.insert(0, '_');
    }
    if PYTHON_KEYWORDS.contains(&out.as_str()) {
        out.push('_');
    }
    out
}

fn render_call_target(value: &str) -> Option<String> {
    let normalized = value
        .trim()
        .trim_end_matches('!')
        .replace("::", ".")
        .replace('$', "_");
    if normalized.is_empty() {
        return None;
    }
    let segments = normalized
        .split('.')
        .filter(|segment| !segment.is_empty())
        .map(safe_python_identifier)
        .collect::<Vec<_>>();
    (!segments.is_empty()).then(|| format!("{}(...)", segments.join(".")))
}

fn split_type_arguments(value: &str) -> Option<(&str, &str)> {
    let open = value.find('<')?;
    let mut depth = 0usize;
    let mut close = None;
    for (index, ch) in value.char_indices().skip(open) {
        match ch {
            '<' => depth += 1,
            '>' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    close = Some(index);
                    break;
                }
            }
            _ => {}
        }
    }
    let close = close?;
    if !value[close + 1..].trim().is_empty() {
        return None;
    }
    Some((value[..open].trim(), &value[open + 1..close]))
}

fn render_rust_type(raw: &str) -> String {
    let mut value = raw.trim().trim_end_matches(',').trim();
    while let Some(rest) = value.strip_prefix('&') {
        value = rest.trim_start();
        if value.starts_with("'") {
            value = value
                .split_once(char::is_whitespace)
                .map(|(_, rest)| rest.trim_start())
                .unwrap_or(value);
        }
    }
    if let Some(rest) = value.strip_prefix("mut ") {
        value = rest.trim_start();
    }
    if let Some(rest) = value.strip_prefix("*const ") {
        value = rest.trim_start();
    } else if let Some(rest) = value.strip_prefix("*mut ") {
        value = rest.trim_start();
    }

    if value == "()" {
        return "None".to_string();
    }
    if let Some(inner) = value
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
    {
        let element = inner
            .split_once(';')
            .map(|(element, _)| element)
            .unwrap_or(inner);
        return format!("list[{}]", render_rust_type(element));
    }
    if value.starts_with('(') && value.ends_with(')') {
        let inner = &value[1..value.len() - 1];
        let args = inner
            .split(',')
            .map(render_rust_type)
            .filter(|value| value != "Any")
            .collect::<Vec<_>>();
        if !args.is_empty() {
            return format!("tuple[{}]", args.join(", "));
        }
    }

    if let Some((outer, arguments)) = split_type_arguments(value) {
        let outer_name = outer
            .rsplit("::")
            .next()
            .map(safe_python_identifier)
            .unwrap_or_else(|| "Any".to_string());
        let args = split_type_arguments_top_level(arguments)
            .into_iter()
            .map(render_rust_type)
            .collect::<Vec<_>>();
        return match outer_name.as_str() {
            "Vec" | "VecDeque" => format!(
                "list[{}]",
                args.first().cloned().unwrap_or_else(|| "Any".to_string())
            ),
            "HashSet" | "BTreeSet" => format!(
                "set[{}]",
                args.first().cloned().unwrap_or_else(|| "Any".to_string())
            ),
            "HashMap" | "BTreeMap" => format!(
                "dict[{}, {}]",
                args.first().cloned().unwrap_or_else(|| "Any".to_string()),
                args.get(1).cloned().unwrap_or_else(|| "Any".to_string())
            ),
            "Option" => format!(
                "{} | None",
                args.first().cloned().unwrap_or_else(|| "Any".to_string())
            ),
            "Result" => args.first().cloned().unwrap_or_else(|| "Any".to_string()),
            "Box" | "Arc" | "Rc" | "Pin" | "Cow" => {
                args.first().cloned().unwrap_or_else(|| "Any".to_string())
            }
            _ => {
                if args.iter().any(|arg| arg == "Any") {
                    "Any".to_string()
                } else {
                    format!("{}[{}]", outer_name, args.join(", "))
                }
            }
        };
    }

    let leaf = value
        .trim_start_matches("dyn ")
        .rsplit("::")
        .next()
        .unwrap_or(value)
        .trim();
    match leaf {
        "bool" => "bool".to_string(),
        "str" | "String" | "OsString" => "str".to_string(),
        "usize" | "isize" | "u8" | "u16" | "u32" | "u64" | "u128" | "i8" | "i16" | "i32"
        | "i64" | "i128" => "int".to_string(),
        "f32" | "f64" => "float".to_string(),
        "!" => "Any".to_string(),
        _ if leaf
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_') =>
        {
            safe_python_identifier(leaf)
        }
        _ => "Any".to_string(),
    }
}

fn split_type_arguments_top_level(value: &str) -> Vec<&str> {
    let mut result = Vec::new();
    let mut start = 0usize;
    let mut angle_depth = 0usize;
    let mut round_depth = 0usize;
    let mut square_depth = 0usize;
    for (index, ch) in value.char_indices() {
        match ch {
            '<' => angle_depth += 1,
            '>' => angle_depth = angle_depth.saturating_sub(1),
            '(' => round_depth += 1,
            ')' => round_depth = round_depth.saturating_sub(1),
            '[' => square_depth += 1,
            ']' => square_depth = square_depth.saturating_sub(1),
            ',' if angle_depth == 0 && round_depth == 0 && square_depth == 0 => {
                result.push(value[start..index].trim());
                start = index + 1;
            }
            _ => {}
        }
    }
    result.push(value[start..].trim());
    result.into_iter().filter(|part| !part.is_empty()).collect()
}

fn render_field(field: &crate::model::FieldIr, indent: &str) -> String {
    let annotation = field
        .annotation
        .as_deref()
        .map(render_rust_type)
        .unwrap_or_else(|| "Any".to_string());
    let comment = field
        .annotation
        .as_deref()
        .filter(|raw| annotation == "Any" && !raw.trim().is_empty())
        .map(|raw| format!("  # Rust type: {}", raw.replace('\n', " ")))
        .unwrap_or_default();
    format!(
        "{indent}{}: {} = ...{}",
        safe_python_identifier(&field.name),
        annotation,
        comment
    )
}

fn render_function_body(
    function: &crate::model::FunctionIr,
    indent: &str,
    inside_class: bool,
) -> Vec<String> {
    let body_indent = format!("{indent}    ");
    let mut lines = Vec::new();

    if inside_class && matches!(function.name.as_str(), "constructor" | "__init__") {
        for param in &function.params {
            if matches!(param.name.as_str(), "self" | "this" | "cls") {
                continue;
            }
            let name = safe_python_identifier(&param.name);
            lines.push(format!("{body_indent}self.{name} = {name}"));
        }
    }

    let await_targets = function
        .awaits
        .iter()
        .filter_map(|target| render_call_target(target))
        .collect::<Vec<_>>();
    for target in &await_targets {
        lines.push(format!("{body_indent}await {target}"));
    }

    let raise_targets = function
        .raises
        .iter()
        .filter_map(|target| render_call_target(target))
        .collect::<Vec<_>>();
    let raise_set = raise_targets.iter().collect::<HashSet<_>>();

    let mut call_targets = Vec::new();
    for target in &function.calls {
        if let Some(rendered) = render_call_target(target)
            && !await_targets.iter().any(|value| value == &rendered)
            && !raise_set.contains(&rendered)
            && !call_targets.contains(&rendered)
        {
            call_targets.push(rendered);
        }
    }
    for (index, target) in call_targets.iter().enumerate() {
        if function.returns.is_some() && index + 1 == call_targets.len() {
            lines.push(format!("{body_indent}return {target}"));
        } else {
            lines.push(format!("{body_indent}{target}"));
        }
    }
    for target in raise_targets {
        lines.push(format!("{body_indent}raise {target}"));
    }

    if lines.is_empty() {
        lines.push(format!("{body_indent}..."));
    }
    lines
}

fn render_function(
    function: &crate::model::FunctionIr,
    indent: &str,
    inside_class: bool,
) -> Vec<String> {
    let is_static = function
        .decorators
        .iter()
        .any(|decorator| decorator.trim_start_matches('@') == "staticmethod");
    let mut params = function
        .params
        .iter()
        .filter(|param| !matches!(param.name.as_str(), "self" | "this" | "cls"))
        .map(|param| safe_python_identifier(&param.name))
        .collect::<Vec<_>>();
    if inside_class && !is_static {
        params.insert(0, "self".to_string());
    }
    let prefix = if function.is_async { "async " } else { "" };
    let mut lines = Vec::new();
    if inside_class && is_static {
        lines.push(format!("{indent}@staticmethod"));
    }
    lines.push(format!(
        "{indent}{prefix}def {}({}):",
        safe_python_identifier(&function.name),
        params.join(", ")
    ));
    lines.extend(render_function_body(function, indent, inside_class));
    lines
}

fn python_literal<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

fn render_module_summary(module: &ModuleIr) -> Vec<String> {
    let mut lines = vec![
        "__module_summary__: Any = {".to_string(),
        format!("    \"source\": {},", python_literal(&module.relative_path)),
        format!("    \"language\": {},", python_literal(&module.language)),
        format!(
            "    \"parse_mode\": {},",
            python_literal(&module.parse_mode)
        ),
        format!("    \"source_lines\": {},", module.line_count),
        format!("    \"source_bytes\": {},", module.source_bytes),
        format!(
            "    \"truncated\": {},",
            if module.truncated { "True" } else { "False" }
        ),
        format!("    \"imports\": {},", python_literal(&module.imports)),
        format!("    \"exports\": {},", python_literal(&module.exports)),
    ];
    if !module.notes.is_empty() {
        lines.push(format!("    \"notes\": {},", python_literal(&module.notes)));
    }
    if !module.errors.is_empty() {
        lines.push(format!(
            "    \"errors\": {},",
            python_literal(&module.errors)
        ));
    }
    lines.push("}".to_string());
    lines
}

fn write_skeletons(output_dir: &Path, modules: &[ModuleIr]) -> Result<()> {
    let skeleton_dir = output_dir.join("skeleton");
    fs::create_dir_all(&skeleton_dir)?;
    let mut used_paths = HashSet::new();
    for module in modules {
        let relative = skeleton_relative_path(&module.relative_path, &mut used_paths);
        let target = skeleton_dir.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut lines = vec![
            "from __future__ import annotations".to_string(),
            "from typing import Any".to_string(),
            String::new(),
            format!("# source: {}", module.relative_path),
            format!("# language: {}", module.language),
            format!("# parse mode: {}", module.parse_mode),
            format!("# source lines: {}", module.line_count),
            String::new(),
        ];
        for import in &module.imports {
            lines.push(format!("# import {}", import));
        }
        if !module.imports.is_empty() {
            lines.push(String::new());
        }
        for class in &module.classes {
            let bases = class
                .bases
                .iter()
                .map(|base| safe_python_identifier(base))
                .filter(|base| !base.is_empty())
                .collect::<Vec<_>>();
            if bases.is_empty() {
                lines.push(format!("class {}:", safe_python_identifier(&class.name)));
            } else {
                lines.push(format!(
                    "class {}({}):",
                    safe_python_identifier(&class.name),
                    bases.join(", ")
                ));
            }
            let mut has_body = false;
            for field in &class.fields {
                lines.push(render_field(field, "    "));
                has_body = true;
            }
            if !class.fields.is_empty() && !class.methods.is_empty() {
                lines.push(String::new());
            }
            if class.methods.is_empty() && !has_body {
                lines.push("    ...".to_string());
            } else {
                for (index, method) in class.methods.iter().enumerate() {
                    if index > 0 && (class.fields.is_empty() || index > 0) {
                        lines.push(String::new());
                    }
                    lines.extend(render_function(method, "    ", true));
                }
            }
            lines.push(String::new());
        }
        for (index, function) in module.functions.iter().enumerate() {
            if index > 0 {
                lines.push(String::new());
            }
            lines.extend(render_function(function, "", false));
        }
        let represented = module
            .classes
            .iter()
            .map(|class| class.name.as_str())
            .chain(
                module
                    .classes
                    .iter()
                    .flat_map(|class| class.methods.iter().map(|method| method.name.as_str())),
            )
            .chain(
                module
                    .functions
                    .iter()
                    .map(|function| function.name.as_str()),
            )
            .collect::<HashSet<_>>();
        let extra_exports = module
            .exports
            .iter()
            .filter(|export| !represented.contains(export.as_str()))
            .map(|export| safe_python_identifier(export))
            .collect::<Vec<_>>();
        if !extra_exports.is_empty() {
            if !lines.last().is_some_and(|line| line.is_empty()) {
                lines.push(String::new());
            }
            for export in &extra_exports {
                lines.push(format!("{export}: Any = ..."));
            }
        }

        if module.classes.is_empty() && module.functions.is_empty() && extra_exports.is_empty() {
            for note in &module.notes {
                lines.push(format!("# note: {note}"));
            }
            for error in &module.errors {
                lines.push(format!("# error: {error}"));
            }
            if !lines.last().is_some_and(|line| line.is_empty()) {
                lines.push(String::new());
            }
            lines.extend(render_module_summary(module));
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ClassIr, FieldIr, FunctionIr, ParamIr, SourceLineRange};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn module(path: &str) -> ModuleIr {
        ModuleIr {
            module_id: path.to_string(),
            source_path: format!("/repo/{path}"),
            relative_path: path.to_string(),
            origin_path: None,
            origin_start_character: None,
            origin_start_line: None,
            language: "typescript".to_string(),
            parse_mode: "rs-pattern-typescript".to_string(),
            imports: Vec::new(),
            import_stubs: Vec::new(),
            exports: vec!["TypeOnly".to_string()],
            classes: Vec::new(),
            functions: Vec::new(),
            notes: Vec::new(),
            errors: Vec::new(),
            source_bytes: 10,
            line_count: 2,
            truncated: false,
        }
    }

    fn temp_dir() -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "code-index-rs-writer-test-{}-{nanos}",
            std::process::id()
        ))
    }

    #[test]
    fn disambiguates_same_stem_skeleton_paths_and_renders_exports() {
        let output_dir = temp_dir();
        fs::create_dir_all(&output_dir).expect("create test output");

        let modules = vec![module("src/types.rs"), module("src/types.ts")];
        write_skeletons(&output_dir, &modules).expect("write skeletons");

        let first = fs::read_to_string(output_dir.join("skeleton/src/types.py"))
            .expect("read first skeleton");
        let second = fs::read_to_string(output_dir.join("skeleton/src/types__types_ts.py"))
            .expect("read disambiguated skeleton");
        assert!(first.contains("# source: src/types.rs"));
        assert!(second.contains("# source: src/types.ts"));
        assert!(second.contains("TypeOnly: Any = ..."));

        fs::remove_dir_all(output_dir).expect("remove test output");
    }

    #[test]
    fn renders_calls_in_function_bodies() {
        let function = FunctionIr {
            kind: "function".to_string(),
            name: "build".to_string(),
            qualified_name: "scripts/build.sh::build".to_string(),
            params: vec![ParamIr {
                name: "target".to_string(),
                annotation: None,
                default_value: None,
            }],
            returns: Some("Result".to_string()),
            decorators: Vec::new(),
            calls: vec!["prepare".to_string(), "archive::write".to_string()],
            awaits: Vec::new(),
            raises: Vec::new(),
            is_async: false,
            is_public: true,
            exported: true,
            source_lines: SourceLineRange { start: 1, end: 4 },
            origin_path: None,
        };

        let rendered = render_function(&function, "", false).join("\n");
        assert!(rendered.contains("def build(target):"));
        assert!(rendered.contains("prepare(...)"));
        assert!(rendered.contains("return archive.write(...)"));
    }

    #[test]
    fn renders_metadata_summary_for_modules_without_declarations() {
        let output_dir = temp_dir();
        fs::create_dir_all(&output_dir).expect("create test output");

        let mut empty = module("src/empty.rs");
        empty.exports.clear();
        empty.imports = vec!["crate::runtime".to_string()];
        empty.notes = vec!["heuristic parser".to_string()];
        write_skeletons(&output_dir, &[empty]).expect("write skeleton");

        let skeleton = fs::read_to_string(output_dir.join("skeleton/src/empty.py"))
            .expect("read empty skeleton");
        assert!(skeleton.contains("__module_summary__: Any = {"));
        assert!(skeleton.contains("\"source\": \"src/empty.rs\""));
        assert!(skeleton.contains("\"imports\": [\"crate::runtime\"]"));
        assert!(!skeleton.contains("# no indexed symbols"));

        fs::remove_dir_all(output_dir).expect("remove test output");
    }

    #[test]
    fn renders_struct_fields_and_attached_impl_methods() {
        let output_dir = temp_dir();
        fs::create_dir_all(&output_dir).expect("create test output");

        let mut wine = module("src/wine.rs");
        wine.exports = vec!["Wine".to_string(), "new".to_string()];
        wine.classes = vec![ClassIr {
            name: "Wine".to_string(),
            qualified_name: "src/wine.rs::Wine".to_string(),
            bases: Vec::new(),
            depends_on: Vec::new(),
            fields: vec![
                FieldIr {
                    name: "prefix".to_string(),
                    annotation: Some("Option<TempDir>".to_string()),
                    default_value: None,
                    is_public: false,
                },
                FieldIr {
                    name: "ready".to_string(),
                    annotation: Some("bool".to_string()),
                    default_value: None,
                    is_public: true,
                },
            ],
            methods: vec![FunctionIr {
                kind: "method".to_string(),
                name: "new".to_string(),
                qualified_name: "src/wine.rs::Wine.new".to_string(),
                params: vec![ParamIr {
                    name: "prefix".to_string(),
                    annotation: Some("Option<TempDir>".to_string()),
                    default_value: None,
                }],
                returns: Some("Self".to_string()),
                decorators: vec!["staticmethod".to_string()],
                calls: Vec::new(),
                awaits: Vec::new(),
                raises: Vec::new(),
                is_async: false,
                is_public: true,
                exported: true,
                source_lines: SourceLineRange { start: 1, end: 5 },
                origin_path: None,
            }],
            exported: true,
            source_lines: SourceLineRange { start: 1, end: 10 },
            origin_path: None,
            impl_target: None,
        }];

        write_skeletons(&output_dir, &[wine]).expect("write skeleton");
        let skeleton =
            fs::read_to_string(output_dir.join("skeleton/src/wine.py")).expect("read skeleton");
        assert!(skeleton.contains("class Wine:"));
        assert!(skeleton.contains("prefix: TempDir | None = ..."));
        assert!(skeleton.contains("ready: bool = ..."));
        assert!(skeleton.contains("@staticmethod"));
        assert!(skeleton.contains("def new(prefix):"));
        assert!(!skeleton.contains("class impl_"));

        fs::remove_dir_all(output_dir).expect("remove test output");
    }
}
