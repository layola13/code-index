use crate::model::{ClassIr, FieldIr, FunctionIr, ModuleIr, ParamIr, SourceFile, SourceLineRange};
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
static RUST_PUB_DECL_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?m)^\s*pub(?:\([^)]*\))?\s+(?:const|static|type)\s+([A-Za-z_][A-Za-z0-9_]*)")
        .unwrap()
});
static RUST_MACRO_NAME_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?macro_rules!\s*([A-Za-z_][A-Za-z0-9_]*)").unwrap()
});
static TS_FROM_IMPORT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?m)^\s*import\s+.*?\s+from\s+['"]([^'"]+)['"]"#).unwrap());
static TS_SIDE_EFFECT_IMPORT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?m)^\s*import\s+['"]([^'"]+)['"]"#).unwrap());
static TS_EXPORT_FROM_IMPORT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?m)^\s*export\s+(?:type\s+)?\{[^}]*\}\s+from\s+['"]([^'"]+)['"]"#).unwrap()
});
static TS_EXPORT_DECL_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?m)^\s*export\s+(?:type\s+)?\{\s*([^}]+)\}\s*(?:from\s+['"][^'"]+['"])?\s*;?"#)
        .unwrap()
});
static PY_IMPORT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)^\s*(?:from|import)\s+([A-Za-z0-9_./]+)").unwrap());
static PY_FN_NAME_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)").unwrap());
static PY_CLASS_NAME_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)").unwrap());
static PY_STRING_NAME_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"['\"]([A-Za-z_][A-Za-z0-9_]*)['\"]"#).unwrap());
static SHELL_SOURCE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)^\s*(?:source|\.)\s+([^\s;]+)").unwrap());
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
    Regex::new(r"^\s*(?:(?:pub|export|declare|default|abstract)\s+)*(?:class|struct|trait|interface|enum)\s+([A-Za-z_][A-Za-z0-9_:]*)")
        .unwrap()
});
static TS_CLASS_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"^\s*(?:(?:export|declare|default|abstract)\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:extends\s+([^\{]+?))?(?:\s+implements\s+([^\{]+?))?\s*(?:\{|$)",
    )
    .unwrap()
});
static TS_INTERFACE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"^\s*(?:(?:export|declare|default)\s+)*interface\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:extends\s+([^\{]+?))?\s*(?:\{|$)",
    )
    .unwrap()
});
static TS_ENUM_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*(?:(?:export|declare|const)\s+)*enum\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\{|$)")
        .unwrap()
});
static TS_TYPE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*(?:(?:export|declare|default)\s+)*type\s+([A-Za-z_][A-Za-z0-9_]*)\s*=")
        .unwrap()
});
static TS_EXPORT_NAME_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?m)^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:class|interface|enum|type|function|const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)",
    )
    .unwrap()
});
static PY_FN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*(async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?")
        .unwrap()
});
static GENERIC_FN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*(?:(?:pub|export|declare|default|async|unsafe|static)\s+)*(?:fn|func|function|def)\s+([A-Za-z_][A-Za-z0-9_:]*)\s*\(([^)]*)\)\s*(?:->\s*([^{;]+))?")
        .unwrap()
});
static SHELL_FN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*([^)]*)\s*\))?\s*\{")
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
static JS_TOP_LEVEL_CONST_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=").unwrap());
static JS_COMMONJS_EXPORT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*(?:module\.exports\.|exports\.)([A-Za-z_][A-Za-z0-9_]*)\s*=").unwrap()
});
static JS_OBJECT_KEY_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:").unwrap());
static C_DEFINE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)").unwrap());
static SHELL_ASSIGN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*(?:export\s+)?(?:declare\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:.*)$").unwrap()
});
static SHELL_EXPORT_NAME_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*(?:export|readonly)\s+([A-Za-z_][A-Za-z0-9_]*)(?:=.*)?$").unwrap()
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

fn split_top_level_commas(value: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0usize;
    let mut round_depth = 0usize;
    let mut square_depth = 0usize;
    let mut brace_depth = 0usize;
    let mut angle_depth = 0usize;
    let mut quote = None::<char>;
    let mut escaped = false;

    for (index, ch) in value.char_indices() {
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == active_quote {
                quote = None;
            }
            continue;
        }

        match ch {
            '\'' | '"' => quote = Some(ch),
            '(' => round_depth += 1,
            ')' => round_depth = round_depth.saturating_sub(1),
            '[' => square_depth += 1,
            ']' => square_depth = square_depth.saturating_sub(1),
            '{' => brace_depth += 1,
            '}' => brace_depth = brace_depth.saturating_sub(1),
            '<' => angle_depth += 1,
            '>' => angle_depth = angle_depth.saturating_sub(1),
            ',' if round_depth == 0
                && square_depth == 0
                && brace_depth == 0
                && angle_depth == 0 =>
            {
                parts.push(&value[start..index]);
                start = index + ch.len_utf8();
            }
            _ => {}
        }
    }
    parts.push(&value[start..]);
    parts
}

fn split_top_level_default(value: &str) -> Option<(&str, &str)> {
    let mut round_depth = 0usize;
    let mut square_depth = 0usize;
    let mut brace_depth = 0usize;
    let mut angle_depth = 0usize;
    let mut quote = None::<char>;
    let mut escaped = false;

    for (index, ch) in value.char_indices() {
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == active_quote {
                quote = None;
            }
            continue;
        }
        match ch {
            '\'' | '"' => quote = Some(ch),
            '(' => round_depth += 1,
            ')' => round_depth = round_depth.saturating_sub(1),
            '[' => square_depth += 1,
            ']' => square_depth = square_depth.saturating_sub(1),
            '{' => brace_depth += 1,
            '}' => brace_depth = brace_depth.saturating_sub(1),
            '<' => angle_depth += 1,
            '>' => angle_depth = angle_depth.saturating_sub(1),
            '=' if round_depth == 0
                && square_depth == 0
                && brace_depth == 0
                && angle_depth == 0
                && value.as_bytes().get(index + 1) != Some(&b'>') =>
            {
                return Some((&value[..index], &value[index + 1..]));
            }
            _ => {}
        }
    }
    None
}

fn strip_leading_rust_attributes(mut value: &str) -> &str {
    loop {
        let trimmed = value.trim_start();
        if !trimmed.starts_with("#[") {
            return trimmed;
        }

        let mut depth = 0usize;
        let mut end = None;
        for (index, ch) in trimmed.char_indices().skip(1) {
            match ch {
                '[' => depth += 1,
                ']' => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        end = Some(index + ch.len_utf8());
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(end) = end else {
            return trimmed;
        };
        value = &trimmed[end..];
    }
}

fn strip_rust_visibility(value: &str) -> (bool, &str) {
    let trimmed = value.trim_start();
    let Some(rest) = trimmed.strip_prefix("pub") else {
        return (false, trimmed);
    };
    let next = rest.chars().next();
    if next.is_none() || next.is_some_and(|ch| ch.is_ascii_whitespace()) {
        return (true, rest.trim_start());
    }
    if next == Some('(')
        && let Some(close) = rest.find(')')
    {
        return (true, rest[close + 1..].trim_start());
    }
    (false, trimmed)
}

fn clean_rust_field_segment(value: &str) -> String {
    value
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty()
                || trimmed.starts_with("//")
                || trimmed.starts_with("/*")
                || (trimmed.starts_with('*')
                    && !trimmed.starts_with("*const")
                    && !trimmed.starts_with("*mut"))
            {
                return None;
            }
            Some(trimmed.split("//").next().unwrap_or(trimmed).trim())
        })
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_named_rust_field(value: &str) -> Option<FieldIr> {
    let cleaned = clean_rust_field_segment(value);
    let without_attributes = strip_leading_rust_attributes(&cleaned);
    let (is_public, declaration) = strip_rust_visibility(without_attributes);
    let (raw_name, raw_type) = declaration.split_once(':')?;
    let raw_name = raw_name.trim();
    let name = raw_name.strip_prefix("r#").unwrap_or(raw_name);
    if first_identifier(name).as_deref() != Some(name) {
        return None;
    }
    let annotation = raw_type.trim().trim_end_matches(',').trim();
    if annotation.is_empty() {
        return None;
    }
    Some(FieldIr {
        name: name.to_string(),
        annotation: Some(annotation.to_string()),
        default_value: None,
        is_public,
    })
}

fn parse_tuple_rust_field(value: &str, index: usize) -> Option<FieldIr> {
    let cleaned = clean_rust_field_segment(value);
    let without_attributes = strip_leading_rust_attributes(&cleaned);
    let (is_public, annotation) = strip_rust_visibility(without_attributes);
    let annotation = annotation.trim().trim_end_matches(',').trim();
    if annotation.is_empty() {
        return None;
    }
    Some(FieldIr {
        name: format!("_{index}"),
        annotation: Some(annotation.to_string()),
        default_value: None,
        is_public,
    })
}

fn extract_rust_struct_fields(lines: &[&str], start_index: usize, end_line: usize) -> Vec<FieldIr> {
    let declaration = slice_lines(lines, start_index + 1, end_line);
    if let Some(open) = declaration.find('{')
        && let Some(close) = declaration.rfind('}')
        && open < close
    {
        return split_top_level_commas(&declaration[open + 1..close])
            .into_iter()
            .filter_map(parse_named_rust_field)
            .collect();
    }

    let Some(struct_index) = declaration.find("struct") else {
        return Vec::new();
    };
    let after_struct = &declaration[struct_index + "struct".len()..];
    let Some(open) = after_struct.find('(') else {
        return Vec::new();
    };
    let Some(close) = after_struct.rfind(')') else {
        return Vec::new();
    };
    if open >= close {
        return Vec::new();
    }
    split_top_level_commas(&after_struct[open + 1..close])
        .into_iter()
        .enumerate()
        .filter_map(|(index, field)| parse_tuple_rust_field(field, index))
        .collect()
}

fn parse_params(params: &str) -> Vec<ParamIr> {
    split_top_level_commas(params)
        .into_iter()
        .filter_map(|raw| {
            let trimmed = raw.trim();
            if trimmed.is_empty() || matches!(trimmed, "*" | "/" | "...") {
                return None;
            }
            let (declaration, default_value) = split_top_level_default(trimmed)
                .map(|(declaration, value)| (declaration.trim(), Some(value.trim().to_string())))
                .unwrap_or((trimmed, None));
            let without_self = declaration.trim_start_matches("mut ").trim();
            let (name, annotation) = if let Some((name, ty)) = without_self.split_once(':') {
                (name.trim(), Some(ty.trim().to_string()))
            } else {
                (
                    without_self
                        .split_whitespace()
                        .last()
                        .unwrap_or(without_self)
                        .trim_matches(['&', '*']),
                    None,
                )
            };
            let name = name.trim_matches(['&', '*']);
            if name.is_empty() {
                return None;
            }
            Some(ParamIr {
                name: name.to_string(),
                annotation,
                default_value,
            })
        })
        .collect()
}

fn matching_delimiter(value: &str, start: usize, open: char, close: char) -> Option<usize> {
    let mut depth = 0usize;
    let mut quote = None::<char>;
    let mut escaped = false;
    for (offset, ch) in value[start..].char_indices() {
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == active_quote {
                quote = None;
            }
            continue;
        }
        match ch {
            '\'' | '"' => quote = Some(ch),
            current if current == open => depth += 1,
            current if current == close => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(start + offset);
                }
            }
            _ => {}
        }
    }
    None
}

fn parse_rust_function_signature(value: &str) -> Option<(String, String, Option<String>, bool)> {
    let trimmed = value.trim_start();
    if trimmed.starts_with("//") || trimmed.starts_with("use ") {
        return None;
    }
    let fn_index = trimmed.find("fn ")?;
    let prefix = &trimmed[..fn_index];
    if prefix.chars().any(|ch| {
        !(ch.is_ascii_alphanumeric() || ch.is_ascii_whitespace() || "_()\"'".contains(ch))
    }) {
        return None;
    }
    let is_async = prefix.split_whitespace().any(|token| token == "async");
    let after_fn = &trimmed[fn_index + 3..];
    let raw_after_fn = after_fn.trim_start();
    let name = first_identifier(raw_after_fn)?;
    let raw_name_len = name.len() + usize::from(raw_after_fn.starts_with("r#")) * 2;
    let mut cursor = raw_name_len;
    let bytes = raw_after_fn.as_bytes();
    while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
        cursor += 1;
    }
    if bytes.get(cursor) == Some(&b'<') {
        cursor = matching_delimiter(raw_after_fn, cursor, '<', '>')? + 1;
        while bytes.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
    }
    if bytes.get(cursor) != Some(&b'(') {
        return None;
    }
    let params_end = matching_delimiter(raw_after_fn, cursor, '(', ')')?;
    let params = raw_after_fn[cursor + 1..params_end].trim().to_string();
    let rest = raw_after_fn[params_end + 1..].trim_start();
    let returns = rest.strip_prefix("->").and_then(|return_text| {
        let return_text = return_text.trim_start();
        let mut end = return_text.len();
        for marker in [" where ", "{", ";"] {
            if let Some(index) = return_text.find(marker) {
                end = end.min(index);
            }
        }
        clean_return_type(return_text[..end].trim())
    });
    Some((name, params, returns, is_async))
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

fn first_identifier(value: &str) -> Option<String> {
    let value = value
        .trim_start()
        .strip_prefix("r#")
        .unwrap_or(value.trim_start());
    let mut chars = value.chars();
    let first = chars.next()?;
    if !(first == '_' || first.is_ascii_alphabetic()) {
        return None;
    }

    let mut name = String::from(first);
    for ch in chars {
        if ch == '_' || ch.is_ascii_alphanumeric() {
            name.push(ch);
        } else {
            break;
        }
    }
    Some(name)
}

fn strip_rust_modifiers(mut value: &str) -> &str {
    loop {
        let trimmed = value.trim_start();
        if let Some(rest) = trimmed.strip_prefix("pub") {
            let next = rest.chars().next();
            if next.is_none() || next.is_some_and(|ch| ch.is_ascii_whitespace()) {
                value = rest;
                continue;
            }
            if next == Some('(')
                && let Some(close) = rest.find(')')
            {
                value = &rest[close + 1..];
                continue;
            }
        }

        let mut stripped = false;
        for modifier in ["unsafe", "async"] {
            if let Some(rest) = trimmed.strip_prefix(modifier)
                && rest
                    .chars()
                    .next()
                    .is_none_or(|ch| ch.is_ascii_whitespace())
            {
                value = rest;
                stripped = true;
                break;
            }
        }
        if stripped {
            continue;
        }

        if let Some(rest) = trimmed.strip_prefix("extern")
            && rest
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_whitespace())
        {
            let rest = rest.trim_start();
            if rest.starts_with('"')
                && let Some(close) = rest[1..].find('"')
            {
                value = &rest[close + 2..];
                continue;
            }
        }

        return trimmed;
    }
}

fn rust_declaration_name(line: &str, keyword: &str) -> Option<String> {
    let rest = strip_rust_modifiers(line).strip_prefix(keyword)?;
    let boundary = rest.chars().next();
    if boundary.is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
        return None;
    }
    first_identifier(rest)
}

fn extract_rust_navigation_names(text: &str) -> Vec<String> {
    let mut names = Vec::new();

    for cap in RUST_MOD_RE.captures_iter(text) {
        if let Some(name) = cap.get(1) {
            names.push(name.as_str().to_string());
        }
    }
    names.extend(
        RUST_MACRO_NAME_RE
            .captures_iter(text)
            .filter_map(|cap| cap.get(1).map(|value| value.as_str().to_string())),
    );

    for line in text.lines() {
        for keyword in ["const", "static", "type", "struct", "enum", "trait"] {
            if let Some(name) = rust_declaration_name(line, keyword) {
                names.push(name);
                break;
            }
        }
        if let Some(name) = strip_rust_modifiers(line)
            .strip_prefix("extern crate")
            .and_then(first_identifier)
        {
            names.push(name);
        }
    }

    dedupe(names)
}

fn python_import_item_names(value: &str) -> Vec<String> {
    value
        .replace(['(', ')'], " ")
        .split(',')
        .filter_map(|item| {
            let item = item.split('#').next().unwrap_or(item).trim();
            if item.is_empty() || item == "*" {
                return None;
            }
            let item = item
                .split_once(" as ")
                .map(|(_, alias)| alias.trim())
                .unwrap_or(item);
            let leaf = item.rsplit('.').next().unwrap_or(item);
            first_identifier(leaf)
        })
        .collect()
}

fn python_assignment_name(value: &str) -> Option<String> {
    let value = value.trim();
    if value.starts_with('@')
        || [
            "if ",
            "elif ",
            "else:",
            "for ",
            "while ",
            "with ",
            "try:",
            "except",
            "finally:",
            "return ",
            "raise ",
            "assert ",
            "del ",
            "global ",
            "nonlocal ",
            "import ",
            "from ",
        ]
        .iter()
        .any(|prefix| value.starts_with(prefix))
    {
        return None;
    }
    let (left, _) = value.split_once('=')?;
    if left.contains("==") || left.contains(":=") {
        return None;
    }
    let left = left.split(':').next().unwrap_or(left).trim();
    let name = first_identifier(left)?;
    (left == name).then_some(name)
}

fn extract_python_navigation_names(text: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut pending_from_import = None::<String>;
    let mut in_all = false;

    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(pending) = pending_from_import.as_mut() {
            pending.push(' ');
            pending.push_str(trimmed);
            if trimmed.contains(')') {
                names.extend(python_import_item_names(pending));
                pending_from_import = None;
            }
            continue;
        }

        if let Some(rest) = trimmed.strip_prefix("from ")
            && let Some((_, imported)) = rest.split_once(" import ")
        {
            if imported.contains('(') && !imported.contains(')') {
                pending_from_import = Some(imported.to_string());
            } else {
                names.extend(python_import_item_names(imported));
            }
        } else if let Some(rest) = trimmed.strip_prefix("import ") {
            names.extend(python_import_item_names(rest));
        }

        if let Some(cap) = PY_FN_NAME_RE.captures(line)
            && let Some(name) = cap.get(1)
        {
            names.push(name.as_str().to_string());
        }
        if let Some(cap) = PY_CLASS_NAME_RE.captures(line)
            && let Some(name) = cap.get(1)
        {
            names.push(name.as_str().to_string());
        }

        if line.trim_start() == line
            && let Some(name) = python_assignment_name(trimmed)
        {
            names.push(name);
        }

        if trimmed.starts_with("__all__") {
            in_all = !trimmed.contains(']');
        }
        if in_all || trimmed.starts_with("__all__") {
            names.extend(
                PY_STRING_NAME_RE
                    .captures_iter(trimmed)
                    .filter_map(|cap| cap.get(1).map(|value| value.as_str().to_string())),
            );
        }
        if in_all && trimmed.contains(']') {
            in_all = false;
        }
    }

    dedupe(names)
}

fn extract_javascript_navigation_names(text: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut in_module_exports = false;

    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(cap) = JS_COMMONJS_EXPORT_RE.captures(line)
            && let Some(name) = cap.get(1)
        {
            names.push(name.as_str().to_string());
        }
        if trimmed.starts_with("module.exports") {
            names.push("__module_exports__".to_string());
            in_module_exports = trimmed.contains('{') && !trimmed.contains("};");
            continue;
        }
        if in_module_exports {
            if trimmed.starts_with('}') {
                in_module_exports = false;
            } else if let Some(cap) = JS_OBJECT_KEY_RE.captures(line)
                && let Some(name) = cap.get(1)
            {
                names.push(name.as_str().to_string());
            }
        }
        if let Some(cap) = JS_TOP_LEVEL_CONST_RE.captures(line)
            && let Some(name) = cap.get(1)
        {
            names.push(name.as_str().to_string());
        }
        for keyword in ["let", "var"] {
            if let Some(name) = rust_declaration_name(trimmed, keyword) {
                names.push(name);
            }
        }
    }

    dedupe(names)
}

fn extract_c_navigation_names(text: &str) -> Vec<String> {
    let mut names = C_DEFINE_RE
        .captures_iter(text)
        .filter_map(|cap| cap.get(1).map(|value| value.as_str().to_string()))
        .collect::<Vec<_>>();
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("typedef ")
            && let Some(name) = rest
                .trim_end_matches(';')
                .split_whitespace()
                .last()
                .and_then(first_identifier)
        {
            names.push(name);
        }
    }
    dedupe(names)
}

fn extract_navigation_names(language: &str, text: &str) -> Vec<String> {
    match language {
        "rust" => extract_rust_navigation_names(text),
        "python" => extract_python_navigation_names(text),
        "javascript" | "typescript" | "tsx" => extract_javascript_navigation_names(text),
        "c" | "cpp" => extract_c_navigation_names(text),
        "shell" | "generic" if looks_like_shell(text) => extract_shell_exports(text),
        _ => Vec::new(),
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

fn python_block_end_line(lines: &[&str], start_index: usize) -> usize {
    let Some(start_line) = lines.get(start_index) else {
        return start_index + 1;
    };
    let base_indent = start_line
        .chars()
        .take_while(|ch| ch.is_ascii_whitespace())
        .map(|ch| if ch == '\t' { 4 } else { 1 })
        .sum::<usize>();
    let mut signature_end = start_index;
    let mut depth = 0usize;
    let mut closed_params = false;
    'signature: for (index, line) in lines.iter().enumerate().skip(start_index) {
        for ch in line.chars() {
            match ch {
                '(' => depth = depth.saturating_add(1),
                ')' => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        closed_params = true;
                    }
                }
                ':' if closed_params && depth == 0 => {
                    signature_end = index;
                    break 'signature;
                }
                _ => {}
            }
        }
        signature_end = index;
    }

    let mut end = signature_end + 1;
    for (index, line) in lines.iter().enumerate().skip(signature_end + 1) {
        if line.trim().is_empty() {
            end = index + 1;
            continue;
        }
        let indent = line
            .chars()
            .take_while(|ch| ch.is_ascii_whitespace())
            .map(|ch| if ch == '\t' { 4 } else { 1 })
            .sum::<usize>();
        if indent <= base_indent {
            break;
        }
        end = index + 1;
    }
    end
}

fn function_body_text(
    language: &str,
    lines: &[&str],
    start_line: usize,
    end_line: usize,
) -> String {
    let raw = slice_lines(lines, start_line, end_line);
    match language {
        "python" => {
            let mut depth = 0usize;
            let mut closed_params = false;
            let mut body_start = None;
            for (index, ch) in raw.char_indices() {
                match ch {
                    '(' => depth = depth.saturating_add(1),
                    ')' => {
                        depth = depth.saturating_sub(1);
                        if depth == 0 {
                            closed_params = true;
                        }
                    }
                    ':' if closed_params && depth == 0 => {
                        body_start = Some(index + ch.len_utf8());
                        break;
                    }
                    _ => {}
                }
            }
            body_start
                .map(|index| raw[index..].to_string())
                .unwrap_or(raw)
        }
        _ => raw
            .find('{')
            .map(|index| raw[index + 1..].to_string())
            .unwrap_or(raw),
    }
}

fn looks_like_shell(text: &str) -> bool {
    let first_non_empty = text.lines().map(str::trim).find(|line| !line.is_empty());
    if first_non_empty.is_some_and(|line| {
        line.starts_with("#!")
            && (line.contains("/sh")
                || line.contains("bash")
                || line.contains("zsh")
                || line.contains("ksh"))
    }) {
        return true;
    }

    text.lines().any(|line| {
        let trimmed = line.trim();
        matches!(
            trimmed,
            "set -e" | "set -u" | "set -euo pipefail" | "set -euxo pipefail" | "set -o pipefail"
        ) || trimmed.starts_with("set -euo")
            || trimmed.starts_with("set -eux")
    })
}

fn split_reference_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|item| item.trim().trim_end_matches('{').trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

fn extract_shell_exports(text: &str) -> Vec<String> {
    const SHELL_KEYWORDS: &[&str] = &[
        "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac",
        "in", "function", "return", "exit", "local", "declare", "export", "readonly", "set",
        "unset",
    ];

    let mut names = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        if let Some(cap) = SHELL_ASSIGN_RE.captures(line)
            && let Some(name) = cap.get(1).map(|value| value.as_str())
            && !SHELL_KEYWORDS.contains(&name)
        {
            names.push(name.to_string());
            continue;
        }

        if let Some(cap) = SHELL_EXPORT_NAME_RE.captures(line)
            && let Some(name) = cap.get(1).map(|value| value.as_str())
            && !SHELL_KEYWORDS.contains(&name)
        {
            names.push(name.to_string());
        }
    }
    dedupe(names)
}

fn extract_rust_exports(text: &str) -> Vec<String> {
    let mut exports = Vec::new();

    for line in text.lines() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with("pub ") && !trimmed.starts_with("pub(") {
            continue;
        }

        if let Some(cap) = RUST_MOD_RE.captures(line)
            && let Some(name) = cap.get(1)
        {
            exports.push(name.as_str().to_string());
        }

        if let Some(cap) = RUST_USE_RE.captures(line)
            && let Some(path) = cap.get(1)
        {
            let path = path.as_str().trim();
            if let Some((_, items)) = path.split_once('{') {
                exports.extend(items.trim_end_matches('}').split(',').filter_map(|item| {
                    let item = item.trim();
                    if item.is_empty() || item == "self" || item == "*" {
                        return None;
                    }
                    let exported = item
                        .split_once(" as ")
                        .map(|(_, alias)| alias.trim())
                        .unwrap_or(item);
                    Some(exported.trim_matches(':').to_string())
                }));
            } else {
                let exported = path
                    .split_once(" as ")
                    .map(|(_, alias)| alias.trim())
                    .unwrap_or_else(|| path.rsplit("::").next().unwrap_or(path).trim());
                if exported != "*" && !exported.is_empty() {
                    exports.push(exported.to_string());
                }
            }
        }
    }

    exports.extend(
        RUST_PUB_DECL_RE
            .captures_iter(text)
            .filter_map(|cap| cap.get(1).map(|value| value.as_str().to_string())),
    );
    dedupe(exports)
}

fn extract_explicit_exports(
    language: &str,
    text: &str,
    classes: &[ClassIr],
    functions: &[FunctionIr],
) -> Vec<String> {
    let mut exports = classes
        .iter()
        .map(|class| class.name.clone())
        .chain(functions.iter().map(|function| function.name.clone()))
        .collect::<Vec<_>>();

    if language == "rust" {
        exports.extend(extract_rust_exports(text));
    } else if matches!(language, "typescript" | "tsx" | "javascript") {
        exports.extend(
            TS_EXPORT_NAME_RE
                .captures_iter(text)
                .filter_map(|cap| cap.get(1).map(|value| value.as_str().to_string())),
        );
        for cap in TS_EXPORT_DECL_RE.captures_iter(text) {
            let Some(items) = cap.get(1).map(|value| value.as_str()) else {
                continue;
            };
            exports.extend(items.split(',').filter_map(|item| {
                let item = item.trim();
                if item.is_empty() {
                    return None;
                }
                let item = item.strip_prefix("type ").unwrap_or(item).trim();
                let exported = item
                    .split_once(" as ")
                    .map(|(_, alias)| alias.trim())
                    .unwrap_or(item);
                (!exported.is_empty()).then_some(exported.to_string())
            }));
        }
    } else if (language == "generic" || language == "shell") && looks_like_shell(text) {
        exports.extend(extract_shell_exports(text));
    }

    exports.extend(extract_navigation_names(language, text));

    dedupe(exports)
}

fn extract_calls(language: &str, text: &str) -> Vec<String> {
    let keyword_set: HashSet<&str> = CALL_KEYWORDS.iter().copied().collect();
    let regular = CALL_RE.captures_iter(text).filter_map(|cap| {
        let name = cap.get(1)?.as_str().trim_matches(':').to_string();
        (!keyword_set.contains(name.as_str())).then_some(name)
    });
    let macros = MACRO_CALL_RE.captures_iter(text).filter_map(|cap| {
        let name = cap.get(1)?.as_str().to_string();
        (!keyword_set.contains(name.as_str())).then_some(format!("{}!", name))
    });
    let mut calls = dedupe(regular.chain(macros));
    if language == "shell" || looks_like_shell(text) {
        calls.extend(extract_shell_calls(text));
    }
    dedupe(calls)
}

fn extract_shell_calls(text: &str) -> Vec<String> {
    const KEYWORDS: &[&str] = &[
        "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac",
        "in", "function", "select", "time", "coproc", "return", "exit", "break", "continue",
        "shift", "local", "declare", "export", "readonly", "set", "unset", "read", "mapfile",
        "source",
    ];
    const WRAPPERS: &[&str] = &["command", "exec", "builtin", "env", "sudo"];

    let mut calls = Vec::new();
    for line in text.lines() {
        let mut value = line.trim();
        if value.is_empty() || value.starts_with('#') {
            continue;
        }
        if SHELL_FN_RE.is_match(line) {
            continue;
        }
        if let Some(comment) = value.find(" #") {
            value = &value[..comment];
        }
        if value.ends_with('{') || value == "}" || value == ";;" {
            continue;
        }

        let mut token = value
            .split_whitespace()
            .find(|part| !part.starts_with('-'))
            .unwrap_or_default()
            .trim_matches(['"', '\'', '(', ')', ';']);
        while WRAPPERS.contains(&token) {
            let Some((_, rest)) = value.split_once(token) else {
                break;
            };
            token = rest
                .split_whitespace()
                .find(|part| !part.starts_with('-'))
                .unwrap_or_default()
                .trim_matches(['"', '\'', '(', ')', ';']);
        }

        if token.is_empty()
            || KEYWORDS.contains(&token)
            || token.starts_with('$')
            || token.contains('=')
            || token.contains('/')
            || token.chars().all(|ch| ch == '_' || ch.is_ascii_uppercase())
            || !token
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
            || token.chars().next().is_some_and(|ch| ch.is_ascii_digit())
        {
            continue;
        }
        calls.push(token.to_string());
    }
    dedupe(calls)
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
        imports.extend(
            TS_EXPORT_FROM_IMPORT_RE
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
        if (language == "generic" || language == "shell") && looks_like_shell(text) {
            imports.extend(
                SHELL_SOURCE_RE
                    .captures_iter(text)
                    .filter_map(|cap| cap.get(1).map(|m| m.as_str().trim().to_string())),
            );
        }
    }
    dedupe(imports)
}

fn rust_impl_header(lines: &[&str], start_index: usize) -> Option<String> {
    let first = strip_rust_modifiers(lines.get(start_index)?);
    if !first.starts_with("impl") {
        return None;
    }

    let mut header = first.to_string();
    let max_index = (start_index + 32).min(lines.len().saturating_sub(1));
    for line in lines.iter().take(max_index + 1).skip(start_index + 1) {
        if header.contains('{') || header.trim_end().ends_with(';') {
            break;
        }
        header.push(' ');
        header.push_str(line.trim());
    }
    RUST_IMPL_RE
        .captures(&header)
        .and_then(|cap| cap.get(1).map(|value| value.as_str().trim().to_string()))
}

fn rust_type_base_name(value: &str) -> Option<String> {
    let mut value = value.trim().trim_end_matches('{').trim();
    loop {
        let trimmed = value.trim_start();
        if let Some(rest) = trimmed.strip_prefix('&') {
            value = rest;
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix('*') {
            value = rest
                .trim_start()
                .strip_prefix("const ")
                .or_else(|| rest.trim_start().strip_prefix("mut "))
                .unwrap_or(rest);
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("mut ") {
            value = rest;
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("dyn ") {
            value = rest;
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix('!') {
            value = rest;
            continue;
        }
        if trimmed.starts_with('\'')
            && let Some((_, rest)) = trimmed.split_once(char::is_whitespace)
        {
            value = rest;
            continue;
        }
        value = trimmed;
        break;
    }

    let before_generics = value.split('<').next().unwrap_or(value).trim();
    let leaf = before_generics
        .trim_matches(['(', ')', '[', ']'])
        .rsplit("::")
        .next()
        .unwrap_or(before_generics)
        .trim();
    first_identifier(leaf)
}

fn rust_impl_target_and_bases(raw: &str) -> Option<(String, Vec<String>)> {
    let declaration = raw
        .split("where")
        .next()
        .unwrap_or(raw)
        .trim()
        .trim_end_matches('{')
        .trim();
    let (trait_name, target) = declaration
        .rsplit_once(" for ")
        .map(|(trait_name, target)| (Some(trait_name.trim()), target.trim()))
        .unwrap_or((None, declaration));
    let target_name = rust_type_base_name(target)?;
    let bases = trait_name
        .and_then(rust_type_base_name)
        .into_iter()
        .collect();
    Some((target_name, bases))
}

type ClassDeclaration = (String, Vec<String>, Vec<FieldIr>, Option<String>);

fn extract_classes(language: &str, module_id: &str, lines: &[&str]) -> Vec<ClassIr> {
    let mut classes_by_name: BTreeMap<String, ClassIr> = BTreeMap::new();

    for (index, line) in lines.iter().enumerate() {
        let line_no = index + 1;
        let declaration: Option<ClassDeclaration> = if language == "rust" {
            if let Some(cap) = RUST_CLASS_RE.captures(line) {
                cap.get(2).map(|name_match| {
                    let end_line = block_end_line(lines, index);
                    let fields = if cap.get(1).is_some_and(|kind| kind.as_str() == "struct") {
                        extract_rust_struct_fields(lines, index, end_line)
                    } else {
                        Vec::new()
                    };
                    (name_match.as_str().to_string(), Vec::new(), fields, None)
                })
            } else {
                rust_impl_header(lines, index).and_then(|raw| {
                    let (target, bases) = rust_impl_target_and_bases(&raw)?;
                    Some((
                        format!("impl_{}_at_{line_no}", safe_symbol_name(&target)),
                        bases,
                        Vec::new(),
                        Some(target),
                    ))
                })
            }
        } else if matches!(language, "typescript" | "tsx" | "javascript") {
            if let Some(cap) = TS_CLASS_RE.captures(line) {
                cap.get(1).map(|name_match| {
                    let mut bases = Vec::new();
                    if let Some(value) = cap.get(2) {
                        bases.extend(split_reference_list(value.as_str()));
                    }
                    if let Some(value) = cap.get(3) {
                        bases.extend(split_reference_list(value.as_str()));
                    }
                    (name_match.as_str().to_string(), bases, Vec::new(), None)
                })
            } else if let Some(cap) = TS_INTERFACE_RE.captures(line) {
                cap.get(1).map(|name_match| {
                    let bases = cap
                        .get(2)
                        .map(|value| split_reference_list(value.as_str()))
                        .unwrap_or_default();
                    (name_match.as_str().to_string(), bases, Vec::new(), None)
                })
            } else if let Some(cap) = TS_ENUM_RE.captures(line) {
                cap.get(1)
                    .map(|value| (value.as_str().to_string(), Vec::new(), Vec::new(), None))
            } else {
                TS_TYPE_RE.captures(line).and_then(|cap| {
                    cap.get(1)
                        .map(|value| (value.as_str().to_string(), Vec::new(), Vec::new(), None))
                })
            }
        } else {
            GENERIC_CLASS_RE.captures(line).and_then(|cap| {
                cap.get(1)
                    .map(|m| (m.as_str().to_string(), Vec::new(), Vec::new(), None))
            })
        };

        let Some((name, bases, fields, impl_target)) = declaration else {
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
                bases,
                depends_on: Vec::new(),
                fields,
                methods: Vec::new(),
                exported: true,
                source_lines,
                origin_path: None,
                impl_target,
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

    if matches!(language, "generic" | "shell")
        && let Some(cap) = SHELL_FN_RE.captures(line)
    {
        let name = cap.get(1)?.as_str();
        if !matches!(name, "if" | "for" | "while" | "until" | "case" | "select") {
            return Some((
                name,
                cap.get(2).map(|value| value.as_str()).unwrap_or(""),
                None,
                false,
            ));
        }
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
                let params = cap
                    .get(3)
                    .or_else(|| cap.get(4))
                    .map(|m| m.as_str())
                    .unwrap_or("");
                Some((name, params, None, line.contains("async ")))
            })
        })
        .or_else(|| {
            JS_DEFAULT_EXPORT_RE.captures(line).map(|cap| {
                let name = cap
                    .get(1)
                    .or_else(|| cap.get(4))
                    .map(|m| m.as_str())
                    .unwrap_or("default");
                let params = cap
                    .get(2)
                    .or_else(|| cap.get(3))
                    .map(|m| m.as_str())
                    .unwrap_or("");
                (name, params, None, false)
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

fn function_signature_text(
    language: &str,
    lines: &[&str],
    start_index: usize,
) -> Option<(String, String, Option<String>, bool)> {
    let first = *lines.get(start_index)?;
    if language == "rust" {
        if let Some(signature) = parse_rust_function_signature(first) {
            return Some(signature);
        }
        let trimmed = first.trim_start();
        if !trimmed.contains("fn ") || trimmed.starts_with("//") || trimmed.starts_with("use ") {
            return None;
        }

        let mut signature = first.trim().to_string();
        let max_index = (start_index + 32).min(lines.len().saturating_sub(1));
        for line in lines.iter().take(max_index + 1).skip(start_index + 1) {
            signature.push(' ');
            signature.push_str(line.trim());
            if signature.contains('{') || signature.trim_end().ends_with(';') {
                break;
            }
        }
        return parse_rust_function_signature(&signature);
    }

    if function_match(language, first).is_some() {
        return function_match(language, first).map(|(name, params, returns, is_async)| {
            (
                name.to_string(),
                params.to_string(),
                returns.map(str::to_string),
                is_async,
            )
        });
    }

    let trimmed = first.trim_start();
    let looks_like_start = match language {
        "python" => trimmed.starts_with("def ") || trimmed.starts_with("async def "),
        "generic" | "shell" => trimmed.starts_with("function ") || SHELL_FN_RE.is_match(first),
        "typescript" | "tsx" | "javascript" => {
            trimmed.contains("function ")
                || trimmed.contains("=>")
                || trimmed.starts_with("export default")
        }
        _ => trimmed.contains("fn ") || trimmed.contains("function "),
    };
    if !looks_like_start {
        return None;
    }

    let mut signature = first.trim().to_string();
    let max_index = (start_index + 32).min(lines.len().saturating_sub(1));
    for line in lines.iter().take(max_index + 1).skip(start_index + 1) {
        signature.push(' ');
        signature.push_str(line.trim());
        let has_open_brace = signature.contains('{');
        let has_python_terminator =
            language == "python" && signature.contains(')') && signature.trim_end().ends_with(':');
        let has_statement_terminator = signature.trim_end().ends_with(';');
        if has_open_brace || has_python_terminator || has_statement_terminator {
            break;
        }
    }
    function_match(language, &signature).map(|(name, params, returns, is_async)| {
        (
            name.to_string(),
            params.to_string(),
            returns.map(str::to_string),
            is_async,
        )
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

    for (index, _line) in lines.iter().enumerate() {
        let Some((name, params_text, returns, is_async)) =
            function_signature_text(language, lines, index)
        else {
            continue;
        };
        let line_no = index + 1;
        let end_line = if language == "python" {
            python_block_end_line(lines, index)
        } else {
            block_end_line(lines, index)
        };
        let body_text = function_body_text(language, lines, line_no, end_line);
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

        let params = parse_params(&params_text);
        let decorators = if language == "rust"
            && owner_index.is_some()
            && !params.iter().any(|param| param.name == "self")
        {
            vec!["staticmethod".to_string()]
        } else {
            Vec::new()
        };

        let function = FunctionIr {
            kind,
            name: name.to_string(),
            qualified_name,
            params,
            returns: returns.as_deref().and_then(clean_return_type),
            decorators,
            calls: extract_calls(language, &body_text)
                .into_iter()
                .filter(|call| call != &name)
                .collect(),
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
        exports: Vec::new(),
        classes,
        functions,
        notes: vec!["indexed by code-index-rs heuristic parser".to_string()],
        errors: Vec::new(),
        source_bytes: source.byte_size,
        line_count: source.text.split('\n').count(),
        truncated: source.truncated,
    };
    merge_duplicate_impl_classes(&mut module);
    module.exports = extract_explicit_exports(
        &file.language,
        &source.text,
        &module.classes,
        &module.functions,
    );
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

fn merge_class_contents(existing: &mut ClassIr, mut incoming: ClassIr) {
    existing.bases = dedupe(existing.bases.iter().cloned().chain(incoming.bases));
    existing.depends_on = dedupe(
        existing
            .depends_on
            .iter()
            .cloned()
            .chain(incoming.depends_on),
    );
    for field in incoming.fields.drain(..) {
        if !existing
            .fields
            .iter()
            .any(|current| current.name == field.name)
        {
            existing.fields.push(field);
        }
    }
    for method in incoming.methods.drain(..) {
        if !existing.methods.iter().any(|current| {
            current.name == method.name && current.source_lines.start == method.source_lines.start
        }) {
            existing.methods.push(method);
        }
    }
    existing
        .methods
        .sort_by_key(|method| (method.source_lines.start, method.name.clone()));
    existing.exported |= incoming.exported;
    existing.source_lines.start = existing.source_lines.start.min(incoming.source_lines.start);
    existing.source_lines.end = existing.source_lines.end.max(incoming.source_lines.end);
    existing.origin_path = existing.origin_path.clone().or(incoming.origin_path);
}

pub fn merge_duplicate_impl_classes(module: &mut ModuleIr) {
    let mut declarations = Vec::new();
    let mut impls = Vec::new();
    for class in std::mem::take(&mut module.classes) {
        if class.impl_target.is_some() {
            impls.push(class);
        } else {
            declarations.push(class);
        }
    }

    let mut merged: HashMap<String, ClassIr> = HashMap::new();
    for class in declarations {
        let key = class.qualified_name.clone();
        if let Some(existing) = merged.get_mut(&key) {
            merge_class_contents(existing, class);
        } else {
            merged.insert(key, class);
        }
    }

    for mut class in impls {
        let Some(target_name) = class.impl_target.take() else {
            continue;
        };
        let target_qualified_name = format!("{}::{}", module.module_id, target_name);
        class.name = target_name;
        class.qualified_name = target_qualified_name.clone();
        for method in &mut class.methods {
            method.qualified_name = format!("{}.{}", target_qualified_name, method.name);
        }
        if let Some(existing) = merged.get_mut(&target_qualified_name) {
            merge_class_contents(existing, class);
        } else {
            merged.insert(target_qualified_name, class);
        }
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
        let make = module
            .functions
            .iter()
            .find(|function| function.name == "make")
            .expect("make function");
        assert!(make.calls.iter().any(|call| call == "Widget::new"));
        assert!(!make.calls.iter().any(|call| call == "make"));
        let widget = module
            .classes
            .iter()
            .find(|class| class.name == "Widget")
            .expect("Widget class");
        assert_eq!(widget.fields.len(), 1);
        assert_eq!(widget.fields[0].name, "value");
        assert_eq!(widget.fields[0].annotation.as_deref(), Some("usize"));
        assert!(widget.methods.iter().any(|method| method.name == "new"));
        assert!(widget.methods.iter().any(|method| method.name == "value"));
        assert!(
            widget
                .methods
                .iter()
                .all(|method| method.qualified_name.contains("::Widget."))
        );
        assert!(
            module
                .classes
                .iter()
                .all(|class| !class.name.starts_with("impl_"))
        );
    }

    #[test]
    fn merges_multiple_and_trait_impls_and_parses_generic_methods() {
        let file = SourceFile {
            absolute_path: PathBuf::from("/repo/src/lib.rs"),
            relative_path: "src/lib.rs".to_string(),
            language: "rust".to_string(),
        };
        let source = LoadedSource {
            text: r#"
pub struct Boxed<T> {
    pub value: T,
    next: Option<Boxed<T>>,
}

impl<T> Boxed<T> {
    pub fn new(value: T) -> Self {
        Self { value, next: None }
    }
}

impl<T> Boxed<T> {
    pub async fn scope<U>(
        &self,
        future: impl Future<Output = Result<U, Error>>,
    ) -> Result<U, Error> {
        future.await
    }
}

impl<T> Drop for Boxed<T> {
    fn drop(&mut self) {}
}
"#
            .to_string(),
            byte_size: 1,
            truncated: false,
        };

        let module = parse_loaded_source(&file, source);
        assert_eq!(module.classes.len(), 1);
        let boxed = &module.classes[0];
        assert_eq!(boxed.name, "Boxed");
        assert_eq!(
            boxed
                .fields
                .iter()
                .map(|field| field.name.as_str())
                .collect::<Vec<_>>(),
            vec!["value", "next"]
        );
        assert!(boxed.bases.iter().any(|base| base == "Drop"));
        let scope = boxed
            .methods
            .iter()
            .find(|method| method.name == "scope")
            .expect("generic scope method");
        assert!(scope.is_async);
        assert_eq!(scope.params.len(), 2);
        assert_eq!(
            scope.params[1].annotation.as_deref(),
            Some("impl Future<Output = Result<U, Error>>")
        );
        assert_eq!(scope.returns.as_deref(), Some("Result<U, Error>"));
        assert!(boxed.methods.iter().any(|method| method.name == "drop"));
        assert!(boxed.methods.iter().any(|method| method.name == "new"));
        assert!(
            boxed
                .methods
                .iter()
                .find(|method| method.name == "new")
                .is_some_and(|method| method
                    .decorators
                    .iter()
                    .any(|decorator| decorator == "staticmethod"))
        );
        assert!(!module.exports.iter().any(|name| name.starts_with("impl_")));
    }

    #[test]
    fn parses_named_and_tuple_struct_fields() {
        let file = SourceFile {
            absolute_path: PathBuf::from("/repo/src/fields.rs"),
            relative_path: "src/fields.rs".to_string(),
            language: "rust".to_string(),
        };
        let source = LoadedSource {
            text: r#"
pub struct Pair(pub String, usize);

struct Config {
    pub(crate) path: std::path::PathBuf,
    values: Vec<Option<String>>,
}
"#
            .to_string(),
            byte_size: 1,
            truncated: false,
        };

        let module = parse_loaded_source(&file, source);
        let pair = module
            .classes
            .iter()
            .find(|class| class.name == "Pair")
            .expect("Pair class");
        assert_eq!(
            pair.fields
                .iter()
                .map(|field| (field.name.as_str(), field.annotation.as_deref()))
                .collect::<Vec<_>>(),
            vec![("_0", Some("String")), ("_1", Some("usize"))]
        );
        assert!(pair.fields[0].is_public);

        let config = module
            .classes
            .iter()
            .find(|class| class.name == "Config")
            .expect("Config class");
        assert_eq!(config.fields[0].name, "path");
        assert_eq!(
            config.fields[0].annotation.as_deref(),
            Some("std::path::PathBuf")
        );
        assert!(config.fields[0].is_public);
        assert_eq!(
            config.fields[1].annotation.as_deref(),
            Some("Vec<Option<String>>")
        );
    }

    #[test]
    fn parses_shell_functions_calls_and_variables() {
        let file = SourceFile {
            absolute_path: PathBuf::from("/repo/scripts/build.sh"),
            relative_path: "scripts/build.sh".to_string(),
            language: "shell".to_string(),
        };
        let source = LoadedSource {
            text: r#"#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
usage: build.sh
EOF
}

build() {
  usage
  printf '%s\n' "building"
}

target=""
export ARCHIVE_DIR="/tmp/archive"
"#
            .to_string(),
            byte_size: 1,
            truncated: false,
        };

        let module = parse_loaded_source(&file, source);
        assert_eq!(module.language, "shell");
        assert_eq!(module.parse_mode, "rs-pattern-shell");
        assert!(
            module
                .functions
                .iter()
                .any(|function| function.name == "usage")
        );
        let build = module
            .functions
            .iter()
            .find(|function| function.name == "build")
            .expect("build function");
        assert!(build.calls.iter().any(|call| call == "usage"));
        assert!(build.calls.iter().any(|call| call == "printf"));
        assert!(!build.calls.iter().any(|call| call == "build"));
        assert!(module.exports.iter().any(|name| name == "target"));
        assert!(module.exports.iter().any(|name| name == "ARCHIVE_DIR"));
    }

    #[test]
    fn parses_typescript_type_declarations_and_reexports() {
        let file = SourceFile {
            absolute_path: PathBuf::from("/repo/src/types.ts"),
            relative_path: "src/types.ts".to_string(),
            language: "typescript".to_string(),
        };
        let source = LoadedSource {
            text: r#"
import type { Base } from "./base";
export type ClientInfo = { name: string };
export interface Worker extends Base {
  run(): void;
}
export enum Mode { Fast, Safe }
export { External as PublicExternal } from "./external";
"#
            .to_string(),
            byte_size: 1,
            truncated: false,
        };

        let module = parse_loaded_source(&file, source);
        assert!(module.imports.iter().any(|path| path == "./base"));
        assert!(module.imports.iter().any(|path| path == "./external"));
        assert!(
            module
                .classes
                .iter()
                .any(|class| class.name == "ClientInfo")
        );
        assert!(module.classes.iter().any(|class| class.name == "Mode"));
        let worker = module
            .classes
            .iter()
            .find(|class| class.name == "Worker")
            .expect("Worker interface");
        assert_eq!(worker.bases, vec!["Base"]);
        assert!(module.exports.iter().any(|name| name == "ClientInfo"));
        assert!(module.exports.iter().any(|name| name == "PublicExternal"));
    }

    #[test]
    fn parses_rust_reexports_for_module_only_files() {
        let file = SourceFile {
            absolute_path: PathBuf::from("/repo/src/lib.rs"),
            relative_path: "src/lib.rs".to_string(),
            language: "rust".to_string(),
        };
        let source = LoadedSource {
            text: r#"
pub mod config;
pub use crate::config::{Config, Settings as PublicSettings};
pub type Result<T> = std::result::Result<T, Error>;
"#
            .to_string(),
            byte_size: 1,
            truncated: false,
        };

        let module = parse_loaded_source(&file, source);
        assert!(module.functions.is_empty());
        assert!(module.classes.is_empty());
        assert!(module.exports.iter().any(|name| name == "config"));
        assert!(module.exports.iter().any(|name| name == "Config"));
        assert!(module.exports.iter().any(|name| name == "PublicSettings"));
        assert!(module.exports.iter().any(|name| name == "Result"));
    }

    #[test]
    fn parses_multiline_rust_and_python_signatures_without_declaration_calls() {
        let rust_file = SourceFile {
            absolute_path: PathBuf::from("/repo/src/reader.rs"),
            relative_path: "src/reader.rs".to_string(),
            language: "rust".to_string(),
        };
        let rust_source = LoadedSource {
            text: r#"
pub async fn read_value(
    state: &State,
    source_id: SourceId,
) -> Result<Value, Error> {
    validate_state(state);
    Ok(load_value(source_id).await?)
}
"#
            .to_string(),
            byte_size: 1,
            truncated: false,
        };
        let rust_module = parse_loaded_source(&rust_file, rust_source);
        let rust_function = rust_module
            .functions
            .iter()
            .find(|function| function.name == "read_value")
            .expect("multiline Rust function");
        assert_eq!(rust_function.params.len(), 2);
        assert!(
            rust_function
                .calls
                .iter()
                .any(|call| call == "validate_state")
        );
        assert!(!rust_function.calls.iter().any(|call| call == "pub"));

        let python_file = SourceFile {
            absolute_path: PathBuf::from("/repo/src/retry.py"),
            relative_path: "src/retry.py".to_string(),
            language: "python".to_string(),
        };
        let python_source = LoadedSource {
            text: r#"
def retry(
    operation: Callable[[], object],
    *,
    attempts: int = 3,
) -> object:
    return invoke(operation, attempts)
"#
            .to_string(),
            byte_size: 1,
            truncated: false,
        };
        let python_module = parse_loaded_source(&python_file, python_source);
        let python_function = python_module
            .functions
            .iter()
            .find(|function| function.name == "retry")
            .expect("multiline Python function");
        assert_eq!(python_function.params.len(), 2);
        assert!(
            python_function
                .params
                .iter()
                .any(|param| param.name == "operation")
        );
        assert!(
            python_function.calls.iter().any(|call| call == "invoke"),
            "parsed function: {python_function:?}"
        );
    }
}
