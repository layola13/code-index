use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub const CODE_INDEX_ARTIFACT_VERSION: u32 = 3;

#[derive(Clone, Debug)]
pub struct SourceFile {
    pub absolute_path: PathBuf,
    pub relative_path: String,
    pub language: String,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct SourceLineRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ParamIr {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotation: Option<String>,
    #[serde(rename = "defaultValue", skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FunctionIr {
    pub kind: String,
    pub name: String,
    #[serde(rename = "qualifiedName")]
    pub qualified_name: String,
    pub params: Vec<ParamIr>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub returns: Option<String>,
    pub decorators: Vec<String>,
    pub calls: Vec<String>,
    pub awaits: Vec<String>,
    pub raises: Vec<String>,
    #[serde(rename = "isAsync")]
    pub is_async: bool,
    #[serde(rename = "isPublic")]
    pub is_public: bool,
    pub exported: bool,
    #[serde(rename = "sourceLines")]
    pub source_lines: SourceLineRange,
    #[serde(rename = "originPath", skip_serializing_if = "Option::is_none")]
    pub origin_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ClassIr {
    pub name: String,
    #[serde(rename = "qualifiedName")]
    pub qualified_name: String,
    pub bases: Vec<String>,
    #[serde(rename = "dependsOn")]
    pub depends_on: Vec<String>,
    pub methods: Vec<FunctionIr>,
    pub exported: bool,
    #[serde(rename = "sourceLines")]
    pub source_lines: SourceLineRange,
    #[serde(rename = "originPath", skip_serializing_if = "Option::is_none")]
    pub origin_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModuleIr {
    #[serde(rename = "moduleId")]
    pub module_id: String,
    #[serde(rename = "sourcePath")]
    pub source_path: String,
    #[serde(rename = "relativePath")]
    pub relative_path: String,
    #[serde(rename = "originPath", skip_serializing_if = "Option::is_none")]
    pub origin_path: Option<String>,
    #[serde(
        rename = "originStartCharacter",
        skip_serializing_if = "Option::is_none"
    )]
    pub origin_start_character: Option<usize>,
    #[serde(rename = "originStartLine", skip_serializing_if = "Option::is_none")]
    pub origin_start_line: Option<usize>,
    pub language: String,
    #[serde(rename = "parseMode")]
    pub parse_mode: String,
    pub imports: Vec<String>,
    #[serde(rename = "importStubs")]
    pub import_stubs: Vec<String>,
    pub exports: Vec<String>,
    pub classes: Vec<ClassIr>,
    pub functions: Vec<FunctionIr>,
    pub notes: Vec<String>,
    pub errors: Vec<String>,
    #[serde(rename = "sourceBytes")]
    pub source_bytes: u64,
    #[serde(rename = "lineCount")]
    pub line_count: usize,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeIr {
    pub edge_id: String,
    pub kind: String,
    pub source: String,
    pub target: String,
    pub source_file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_symbol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_start: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_end: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_file: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeIndexManifest {
    pub artifact_version: u32,
    pub root_dir: String,
    pub output_dir: String,
    pub created_at: String,
    pub module_count: usize,
    pub class_count: usize,
    pub function_count: usize,
    pub method_count: usize,
    pub edge_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_limit: Option<usize>,
    pub file_limit_reached: bool,
    pub truncated_count: usize,
    pub languages: BTreeMap<String, usize>,
    pub parse_modes: BTreeMap<String, usize>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ModuleRecord<'a> {
    pub module_id: &'a str,
    pub path: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_start_character: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_start_line: Option<usize>,
    pub lang: &'a str,
    pub imports_count: usize,
    pub classes_count: usize,
    pub functions_count: usize,
    pub methods_count: usize,
    pub parse_mode: &'a str,
    pub truncated: bool,
    pub notes: &'a [String],
    pub errors: &'a [String],
}

#[derive(Clone, Debug, Serialize)]
pub struct SymbolRecord {
    pub symbol_id: String,
    pub module_id: String,
    pub kind: String,
    pub qualified_name: String,
    pub signature: String,
    pub source_lines: SourceLineRange,
}
