use crate::model::{ClassIr, FunctionIr, ModuleIr, ParamIr, SourceFile, SourceLineRange};
use anyhow::Result;
use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::Read;

static RUST_USE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);").unwrap());
static RUST_MOD_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;?").unwrap()
});
static TS_FROM_IMPORT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?m)^\s*import\s+.*?\s+from\s+['"]([^'"]+)['"]"#).unwrap());
static TS_SIDE_EFFECT_IMPORT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?m)^\s*import\s+['"]([^'"]+)['"]"#).unwrap());
static PY_IMPORT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)^\s*(?:from|import)\s+([A-Za-z0-9_./]+)").unwrap());
static GENERIC_IMPORT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?m)^\s*(?:import|require|include|#include|from)\s+([A-Za-z0-9_./:<>"'-]+)"#)
        .unwrap()
});
static RUST_CLASS_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?(struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)")
        .unwrap()
});
static RUST_IMPL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*impl(?:\s*<[^>]*>)?\s+([^{]+)").unwrap());
static GENERIC_CLASS_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*(?:pub\s+)?(?:abstract\s+)?(?:class|struct|trait|interface|enum)\s+([A-Za-z_][A-Za-z0-9_:]*)")
        .unwrap()
});
static RUST_FN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"^\s*(?:(?:pub(?:\([^)]*\))?|unsafe|async|const|extern(?:\s+"[^"]+")?)\s+)*fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>{}]*)?\(([^)]*)\)\s*(?:->\s*([^{;]+))?"#,
    )
    .unwrap()
});
static PY_FN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*(async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?")
        .unwrap()
});
static GENERIC_FN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*(?:pub\s+)?(?:async\s+)?(?:fn|func|function|def)\s+([A-Za-z_][A-Za-z0-9_:]*)\s*\(([^)]*)\)\s*(?:->\s*([^{;]+))?")
        .unwrap()
});
static C_LIKE_FN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*[A-Za-z_][A-Za-z0-9_<>\s:*&]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{")
        .unwrap()
});
static JS_ARROW_FN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(async\s+)?(?:\(([^)]*)\)|([A-Za-z_][A-Za-z0-9_]*))\s*=>")
        .unwrap()
});
static JS_DEFAULT_EXPORT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*export\s+default\s+(?:([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)|(?:function\s*)?\(([^)]*)\)|([A-Za-z_][A-Za-z0-9_]*))")
        .unwrap()
});
static JS_TOP_LEVEL_CONST_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=")
        .unwrap()
});
static CALL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b([A-Za-z_][A-Za-z0-9_:]*)\s*(?:::\s*<[^>\n]+>)?\s*\(").unwrap());
static MACRO_CALL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b([A-Za-z_][A-Za-z0-9_:]*)!\s*\(").unwrap());

const CALL_KEYWORDS: &[&str] = &[
    "if", "for", "while", "loop", "match", "switch", "catch", "function", "class", "typeof",
    "delete", "return", "throw", "new", "await", "import", "super", "sizeof", "Some", "None", "Ok",
    "Err",
];

struct LoadedSource {
    text: String,
    byte_size: u64,
    truncated: bool,
}

fn read_limited(file: &SourceFile, max_file_bytes: Option<u64>) -> Result<LoadedSource> {
    let limit = max_file_bytes.unwrap_or(u64::MAX);
    let metadata_len = std::fs::metadata(&file.absolute_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let mut handle = File::open(&file.absolute_path)?;
    let mut bytes = Vec::new();

    if limit == u64::MAX {
        handle.read_to_end(&mut bytes)?;
    } else {
        let mut limited = handle.take(limit.saturating_add(1));
        limited.read_to_end(&mut bytes)?;
        if bytes.len() as u64 > limit {
            bytes.truncate(limit as usize);
        }
    }

    let truncated = metadata_len > bytes.len() as u64;
    Ok(LoadedSource {
        byte_size: metadata_len.max(bytes.len() as u64),
        text: String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
    })
}

fn dedupe(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for value in values {
        let normalized = value.trim().to_string();
        if normalized.is_empty() || !seen.insert(normalized.clone()) {
            continue;
        }
        result.push(normalized);
    }
    result
}

fn parse_params(params: &str) -> Vec<ParamIr> {
    params
        .split(',')
        .filter_map(|raw| {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return None;
            }
            let without_self = trimmed.trim_start_matches("mut ").trim();
            let (name, annotation) = if let Some((name, ty)) = without_self.split_once(':') {
                (name.trim(), Some(ty.trim().to_string()))
            } else {
                (
                    without_self
                        .split_whitespace()
                        .last()
                        .unwrap_or(without_self)
                        .trim_matches('&'),
                    None,
                )
            };
            if name.is_empty() {
                return None;
            }
            Some(ParamIr {
                name: name.to_string(),
                annotation,
                default_value: None,
            })
        })
        .collect()
}

fn clean_return_type(value: &str) -> Option<String> {
    let cleaned = value
        .split('{')
        .next()
        .unwrap_or(value)
        .split(';')
        .next()
        .unwrap_or(value)
        .trim()
        .trim_end_matches("where")
        .trim()
        .to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

fn safe_symbol_name(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            out.push(ch);
        } else if !out.ends_with('_') {
            out.push('_');
        }
    }
    let out = out.trim_matches('_').to_string();
    if out.is_empty() {
        "anonymous".to_string()
    } else if out.chars().next().is_some_and(|ch| ch.is_ascii_digit()) {
        format!("_{}", out)
    } else {
        out
    }
}

fn block_end_line(lines: &[&str], start_index: usize) -> usize {
    let mut depth: isize = 0;
    let mut saw_open = false;

    for (index, line) in lines.iter().enumerate().skip(start_index) {
        for ch in line.chars() {
            match ch {
                '{' => {
                    depth += 1;
                    saw_open = true;
                }
                '}' if saw_open => {
                    depth -= 1;
                    if depth <= 0 {
                        return index + 1;
                    }
                }
                _ => {}
            }
        }

        if !saw_open && line.trim_end().ends_with(';') {
            return index + 1;
        }
    }

    start_index + 1
}

fn slice_lines(lines: &[&str], start_1_based: usize, end_1_based: usize) -> String {
    let start = start_1_based.saturating_sub(1);
    let end = end_1_based.min(lines.len());
    lines.get(start..end).unwrap_or_default().join("\n")
}

fn extract_calls(text: &str) -> Vec<String> {
    let keyword_set: HashSet<&str> = CALL_KEYWORDS.iter().copied().collect();
    let regular = CALL_RE.captures_iter(text).filter_map(|cap| {
        let name = cap.get(1)?.as_str().trim_matches(':').to_string();
        (!keyword_set.contains(name.as_str())).then_some(name)
    });
    let macros = MACRO_CALL_RE.captures_iter(text).filter_map(|cap| {
        let name = cap.get(1)?.as_str().to_string();
        (!keyword_set.contains(name.as_str())).then_some(format!("{}!", name))
    });
    dedupe(regular.chain(macros))
}

fn extract_imports(language: &str, text: &str) -> Vec<String> {
    let mut imports = Vec::new();
    if language == "rust" {
        imports.extend(
            RUST_USE_RE
                .captures_iter(text)
                .filter_map(|cap| cap.get(1).map(|m| m.as_str().trim().to_string())),
        );
        imports.extend(
            RUST_MOD_RE
                .captures_iter(text)
                .filter_map(|cap| cap.get(1).map(|m| format!("mod:{}", m.as_str().trim()))),
        );
    } else if matches!(language, "typescript" | "tsx" | "javascript") {
        imports.extend(
            TS_FROM_IMPORT_RE
                .captures_iter(text)
                .filter_map(|cap| cap.get(1).map(|m| m.as_str().trim().to_string())),
        );
        imports.extend(
            TS_SIDE_EFFECT_IMPORT_RE
                .captures_iter(text)
                .filter_map(|cap| cap.get(1).map(|m| m.as_str().trim().to_string())),
        );
    } else if language == "python" {
        imports.extend(
            PY_IMPORT_RE
                .captures_iter(text)
                .filter_map(|cap| cap.get(1).map(|m| m.as_str().trim().to_string())),
        );
    } else {
        imports.extend(GENERIC_IMPORT_RE.captures_iter(text).filter_map(|cap| {
            cap.get(1).map(|m| {
                m.as_str()
                    .trim()
                    .trim_matches(['"', '\'', '<', '>'])
                    .to_string()
            })
        }));
    }
    dedupe(imports)
}

fn impl_name(raw: &str) -> String {
    let mut target = raw.trim();
    if let Some((_, after_for)) = target.rsplit_once(" for ") {
        target = after_for.trim();
    }
    target = target
        .split("where")
        .next()
        .unwrap_or(target)
        .trim()
        .trim_end_matches('{')
        .trim();
    format!("impl_{}", safe_symbol_name(target))
}

fn extract_classes(language: &str, module_id: &str, lines: &[&str]) -> Vec<ClassIr> {
    let mut classes_by_name: BTreeMap<String, ClassIr> = BTreeMap::new();

    for (index, line) in lines.iter().enumerate() {
        let line_no = index + 1;
        let class_name = if language == "rust" {
            if let Some(cap) = RUST_CLASS_RE.captures(line) {
                cap.get(2).map(|m| m.as_str().to_string())
            } else {
                RUST_IMPL_RE.captures(line).and_then(|cap| {
                    let raw = cap.get(1)?.as_str();
                    (!raw.contains(';')).then_some(impl_name(raw))
                })
            }
        } else {
            GENERIC_CLASS_RE
                .captures(line)
                .and_then(|cap| cap.get(1).map(|m| m.as_str().to_string()))
        };

        let Some(name) = class_name else {
            continue;
        };
        let qualified_name = format!("{module_id}::{name}");
        let source_lines = SourceLineRange {
            start: line_no,
            end: block_end_line(lines, index),
        };
        classes_by_name
            .entry(qualified_name.clone())
            .or_insert_with(|| ClassIr {
                name,
                qualified_name,
                bases: Vec::new(),
                depends_on: Vec::new(),
                methods: Vec::new(),
                exported: true,
                source_lines,
                origin_path: None,
            });
    }

    classes_by_name.into_values().collect()
}

fn owner_class_for_line(classes: &[ClassIr], line: usize) -> Option<usize> {
    classes
        .iter()
        .enumerate()
        .filter(|(_, class)| class.source_lines.start <= line && line <= class.source_lines.end)
        .max_by_key(|(_, class)| class.source_lines.start)
        .map(|(index, _)| index)
}

fn function_match<'a>(
    language: &str,
    line: &'a str,
) -> Option<(&'a str, &'a str, Option<&'a str>, bool)> {
    if language == "rust" {
        return RUST_FN_RE.captures(line).and_then(|cap| {
            Some((
                cap.get(1)?.as_str(),
                cap.get(2).map(|m| m.as_str()).unwrap_or(""),
                cap.get(3).map(|m| m.as_str()),
                line.contains("async "),
            ))
        });
    }

    if language == "python" {
        return PY_FN_RE.captures(line).and_then(|cap| {
            Some((
                cap.get(2)?.as_str(),
                cap.get(3).map(|m| m.as_str()).unwrap_or(""),
                cap.get(4).map(|m| m.as_str()),
                cap.get(1).is_some(),
            ))
        });
    }

    GENERIC_FN_RE
        .captures(line)
        .and_then(|cap| {
            Some((
                cap.get(1)?.as_str(),
                cap.get(2).map(|m| m.as_str()).unwrap_or(""),
                cap.get(3).map(|m| m.as_str()),
                line.contains("async "),
            ))
        })
        .or_else(|| {
            JS_ARROW_FN_RE.captures(line).and_then(|cap| {
                let name = cap.get(1)?.as_str();
                let params = cap.get(3).or_else(|| cap.get(4)).map(|m| m.as_str()).unwrap_or("");
                Some((name, params, None, line.contains("async ")))
            })
        })
        .or_else(|| {
            JS_DEFAULT_EXPORT_RE.captures(line).and_then(|cap| {
                let name = cap.get(1).or_else(|| cap.get(4)).map(|m| m.as_str()).unwrap_or("default");
                let params = cap.get(2).or_else(|| cap.get(3)).map(|m| m.as_str()).unwrap_or("");
                Some((name, params, None, false))
            })
        })
        .or_else(|| {
            JS_TOP_LEVEL_CONST_RE.captures(line).and_then(|cap| {
                let name = cap.get(1)?.as_str();
                Some((name, "", None, false))
            })
        })
        .or_else(|| {
            C_LIKE_FN_RE.captures(line).and_then(|cap| {
                Some((
                    cap.get(1)?.as_str(),
                    cap.get(2).map(|m| m.as_str()).unwrap_or(""),
                    None,
                    false,
                ))
            })
        })
}

fn extract_functions_and_methods(
    language: &str,
    module_id: &str,
    lines: &[&str],
    classes: &mut [ClassIr],
) -> Vec<FunctionIr> {
    let mut top_level = Vec::new();
    let mut seen = HashSet::new();

    for (index, line) in lines.iter().enumerate() {
        let Some((name, params_text, returns, is_async)) = function_match(language, line) else {
            continue;
        };
        let line_no = index + 1;
        let end_line = block_end_line(lines, index);
        let body_text = slice_lines(lines, line_no, end_line);
        let owner_index = owner_class_for_line(classes, line_no);
        let (kind, qualified_name) = if let Some(owner_index) = owner_index {
            (
                "method".to_string(),
                format!("{}.{}", classes[owner_index].qualified_name, name),
            )
        } else {
            ("function".to_string(), format!("{module_id}::{name}"))
        };
        if !seen.insert(qualified_name.clone()) {
            continue;
        }

        let function = FunctionIr {
            kind,
            name: name.to_string(),
            qualified_name,
            params: parse_params(params_text),
            returns: returns.and_then(clean_return_type),
            decorators: Vec::new(),
            calls: extract_calls(&body_text),
            awaits: Vec::new(),
            raises: Vec::new(),
            is_async,
            is_public: !name.starts_with('_'),
            exported: !name.starts_with('_'),
            source_lines: SourceLineRange {
                start: line_no,
                end: end_line,
            },
            origin_path: None,
        };

        if let Some(owner_index) = owner_index {
            classes[owner_index].methods.push(function);
        } else {
            top_level.push(function);
        }
    }

    top_level
}

pub fn parse_source_file(file: &SourceFile, max_file_bytes: Option<u64>) -> ModuleIr {
    match read_limited(file, max_file_bytes) {
        Ok(source) => parse_loaded_source(file, source),
        Err(error) => ModuleIr {
            module_id: file.relative_path.clone(),
            source_path: file.absolute_path.to_string_lossy().to_string(),
            relative_path: file.relative_path.clone(),
            origin_path: None,
            origin_start_character: None,
            origin_start_line: None,
            language: file.language.clone(),
            parse_mode: "read-error".to_string(),
            imports: Vec::new(),
            import_stubs: Vec::new(),
            exports: Vec::new(),
            classes: Vec::new(),
            functions: Vec::new(),
            notes: Vec::new(),
            errors: vec![format!("read error: {error}")],
            source_bytes: 0,
            line_count: 0,
            truncated: false,
        },
    }
}

fn parse_loaded_source(file: &SourceFile, source: LoadedSource) -> ModuleIr {
    let module_id = file.relative_path.clone();
    let lines: Vec<&str> = source.text.lines().collect();
    let imports = extract_imports(&file.language, &source.text);
    let mut classes = extract_classes(&file.language, &module_id, &lines);
    let functions = extract_functions_and_methods(&file.language, &module_id, &lines, &mut classes);
    let exports = dedupe(
        classes
            .iter()
            .map(|class| class.name.clone())
            .chain(functions.iter().map(|function| function.name.clone())),
    );
    let parse_mode = if source.truncated {
        format!("rs-pattern-{}-truncated", file.language)
    } else {
        format!("rs-pattern-{}", file.language)
    };

    let mut module = ModuleIr {
        module_id,
        source_path: file.absolute_path.to_string_lossy().to_string(),
        relative_path: file.relative_path.clone(),
        origin_path: None,
        origin_start_character: None,
        origin_start_line: None,
        language: file.language.clone(),
        parse_mode,
        imports,
        import_stubs: Vec::new(),
        exports,
        classes,
        functions,
        notes: vec!["indexed by code-index-rs heuristic parser".to_string()],
        errors: Vec::new(),
        source_bytes: source.byte_size,
        line_count: source.text.split('\n').count(),
        truncated: source.truncated,
    };
    merge_duplicate_impl_classes(&mut module);
    module
}

pub fn language_counts(modules: &[ModuleIr]) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for module in modules {
        *counts.entry(module.language.clone()).or_insert(0) += 1;
    }
    counts
}

pub fn parse_mode_counts(modules: &[ModuleIr]) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for module in modules {
        *counts.entry(module.parse_mode.clone()).or_insert(0) += 1;
    }
    counts
}

pub fn method_count(module: &ModuleIr) -> usize {
    module.classes.iter().map(|class| class.methods.len()).sum()
}

pub fn merge_duplicate_impl_classes(module: &mut ModuleIr) {
    let mut merged: HashMap<String, ClassIr> = HashMap::new();
    for class in std::mem::take(&mut module.classes) {
        merged
            .entry(class.qualified_name.clone())
            .and_modify(|existing| {
                existing.methods.extend(class.methods.clone());
                existing.source_lines.end = existing.source_lines.end.max(class.source_lines.end);
            })
            .or_insert(class);
    }
    let mut classes: Vec<ClassIr> = merged.into_values().collect();
    classes.sort_by(|left, right| {
        left.source_lines
            .start
            .cmp(&right.source_lines.start)
            .then_with(|| left.name.cmp(&right.name))
    });
    module.classes = classes;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn parses_rust_impl_methods_and_top_level_functions() {
        let file = SourceFile {
            absolute_path: PathBuf::from("/repo/src/lib.rs"),
            relative_path: "src/lib.rs".to_string(),
            language: "rust".to_string(),
        };
        let source = LoadedSource {
            text: r#"
use crate::thing::Thing;

pub struct Widget {
    value: usize,
}

impl Widget {
    pub fn new(value: usize) -> Self {
        Self { value }
    }

    fn value(&self) -> usize {
        self.value
    }
}

pub fn make() -> Widget {
    Widget::new(1)
}
"#
            .to_string(),
            byte_size: 1,
            truncated: false,
        };

        let module = parse_loaded_source(&file, source);
        assert_eq!(module.imports, vec!["crate::thing::Thing"]);
        assert!(
            module
                .functions
                .iter()
                .any(|function| function.name == "make")
        );
        let impl_class = module
            .classes
            .iter()
            .find(|class| class.name == "impl_Widget")
            .expect("impl class");
        assert!(impl_class.methods.iter().any(|method| method.name == "new"));
        assert!(
            impl_class
                .methods
                .iter()
                .any(|method| method.name == "value")
        );
    }
}
