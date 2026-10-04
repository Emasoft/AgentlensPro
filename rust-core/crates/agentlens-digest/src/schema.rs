//! Manifest + JSON Schema → DuckDB table layout.
//!
//! Port of the LAYOUT of docs_dev/duckdb-native-ingest-proposal/setup_duckdb_native_v2.py
//! (one schema + one `events` table per producer, top-level payload properties as columns,
//! nested objects as STRUCT, arrays as LIST) minus its per-line validation rulings (owner
//! rulings D-C, D-E, D-F: no per-line processing, unknown keys ignored, only schema fields
//! parsed) and minus its recorded-at pointers (the spool line's `ts_ns` is the only clock).

use crate::Res;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;

/// Top-level payload property names the digest macros own.
const RESERVED_NAMES: [&str; 5] = ["ts_ns", "payload", "dg_path", "dg_ingest_id", "dg_ingested_at"];
const RESERVED_PREFIX: &str = "_meta_";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    producers: Vec<Entry>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    producer_type: String,
    source: String,
    topic: String,
    version: i64,
    claude_code_version: String,
    /// Spool directory name; several producers (topics) may share one spool.
    spool: String,
    /// ISO date from which this version is valid; null = since the beginning.
    valid_from: Option<String>,
    /// Schema file, relative to the manifest (an absolute path is used as is).
    schema: String,
    sha256: String,
}

#[derive(Debug, Clone)]
pub struct Column {
    pub name: String,
    pub ty: String,
    pub not_null: bool,
    /// `x-replaces`: the column of the previous version this one replaces.
    pub replaces: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Producer {
    pub producer_type: String,
    pub source: String,
    pub topic: String,
    pub version: i64,
    pub claude_code_version: String,
    pub spool: String,
    pub valid_from: Option<String>,
    pub schema_json: Value,
    pub sha256: String,
    pub duckdb_schema: String,
    pub columns: Vec<Column>,
}

pub fn qident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

pub fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Canonical JSON: sorted keys, compact separators, non-ASCII kept raw — byte-identical to the
/// prototype's `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.
/// Keys are sorted explicitly because serde_json's `preserve_order` (unified in from other
/// workspace crates) would otherwise keep file order.
pub fn canonical_json(v: &Value) -> String {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let items: Vec<String> =
                keys.iter().map(|k| format!("{}:{}", Value::String((*k).clone()), canonical_json(&m[k.as_str()]))).collect();
            format!("{{{}}}", items.join(","))
        }
        Value::Array(a) => format!("[{}]", a.iter().map(canonical_json).collect::<Vec<_>>().join(",")),
        other => other.to_string(),
    }
}

pub fn sha256_hex(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// The schema hash: sha256 of the canonical JSON of the schema document.
pub fn schema_hash(doc: &Value) -> String {
    sha256_hex(&canonical_json(doc))
}

/// `p_<slug>_<hash8>`, the prototype's naming function.
pub fn producer_schema_name(producer_type: &str) -> String {
    let mut slug = String::new();
    let mut last_sep = false;
    for ch in producer_type.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            last_sep = false;
        } else if !last_sep {
            slug.push('_');
            last_sep = true;
        }
    }
    let mut base = slug.trim_matches('_').to_owned();
    if base.is_empty() {
        base = "producer".to_owned();
    }
    if base.starts_with(|c: char| c.is_ascii_digit()) {
        base = format!("p_{base}");
    }
    base.truncate(48);
    format!("p_{}_{}", base.trim_end_matches('_'), &sha256_hex(producer_type)[..8])
}

pub fn is_ident(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn type_override(node: &Value, at: &str) -> Res<Option<String>> {
    let Some(v) = node.get("x-duckdb-type") else { return Ok(None) };
    let s = v.as_str().filter(|s| !s.trim().is_empty()).ok_or_else(|| format!("{at}: x-duckdb-type must be a non-empty string"))?;
    if !s.chars().all(|c| c.is_ascii_alphanumeric() || "_(),[] ".contains(c)) {
        return Err(format!("{at}: unsafe x-duckdb-type {s:?}"));
    }
    Ok(Some(s.trim().to_uppercase()))
}

fn is_null_branch(b: &Value) -> bool {
    b.get("type").and_then(Value::as_str) == Some("null")
}

/// True when the node admits JSON null: a `type` list with "null" or a union branch of type null.
fn nullable_of(node: &Value) -> bool {
    if let Some(Value::Array(t)) = node.get("type") {
        if t.iter().any(|x| x.as_str() == Some("null")) {
            return true;
        }
    }
    ["anyOf", "oneOf"].iter().any(|kw| node.get(kw).and_then(Value::as_array).is_some_and(|bs| bs.iter().any(is_null_branch)))
}

fn scalar_kind(v: &Value, at: &str) -> Res<&'static str> {
    match v {
        Value::Bool(_) => Ok("boolean"),
        Value::Number(n) if n.is_i64() || n.is_u64() => Ok("integer"),
        Value::Number(_) => Ok("number"),
        Value::String(_) => Ok("string"),
        _ => Err(format!("{at}: enum/const values must be scalar")),
    }
}

fn inferred_kind(node: &Value, at: &str) -> Res<String> {
    if node.get("properties").is_some() {
        return Ok("object".to_owned());
    }
    if node.get("items").is_some() {
        return Ok("array".to_owned());
    }
    if let Some(values) = node.get("enum").and_then(Value::as_array) {
        let kinds: Vec<&str> = values.iter().filter(|v| !v.is_null()).map(|v| scalar_kind(v, at)).collect::<Res<_>>()?;
        return match kinds.first() {
            Some(k) if kinds.iter().all(|x| x == k) => Ok((*k).to_owned()),
            _ => Err(format!("{at}: enum values have no single physical type")),
        };
    }
    if let Some(c) = node.get("const") {
        return scalar_kind(c, at).map(str::to_owned);
    }
    Err(format!("{at}: schema node has no inferable type (add \"x-duckdb-type\")"))
}

/// DuckDB type of a schema node. An `x-duckdb-type` wins over everything else on the node.
fn duckdb_type(node: &Value, at: &str) -> Res<String> {
    if let Some(ov) = type_override(node, at)? {
        return Ok(ov);
    }
    for kw in ["anyOf", "oneOf"] {
        if let Some(branches) = node.get(kw) {
            let branches = branches.as_array().ok_or_else(|| format!("{at}: {kw} must be an array"))?;
            let nonnull: Vec<&Value> = branches.iter().filter(|b| !is_null_branch(b)).collect();
            if nonnull.len() != 1 {
                return Err(format!("{at}: multi-branch union needs \"x-duckdb-type\""));
            }
            return duckdb_type(nonnull[0], at);
        }
    }
    let kind = match node.get("type") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(list)) => {
            let nonnull: Vec<&str> = list.iter().filter_map(Value::as_str).filter(|s| *s != "null").collect();
            if nonnull.len() != 1 {
                return Err(format!("{at}: ambiguous type union needs \"x-duckdb-type\""));
            }
            nonnull[0].to_owned()
        }
        Some(_) => return Err(format!("{at}: invalid type")),
        None => inferred_kind(node, at)?,
    };
    match kind.as_str() {
        "string" => Ok(match node.get("format").and_then(Value::as_str) {
            Some("date-time") => "TIMESTAMPTZ",
            Some("date") => "DATE",
            Some("time") => "TIME",
            Some("uuid") => "UUID",
            _ => "VARCHAR",
        }
        .to_owned()),
        "integer" => Ok("BIGINT".to_owned()),
        "number" => Ok("DOUBLE".to_owned()),
        "boolean" => Ok("BOOLEAN".to_owned()),
        "array" => {
            if node.get("prefixItems").is_some() {
                return Err(format!("{at}: tuple-style prefixItems unsupported"));
            }
            let items = node.get("items").ok_or_else(|| format!("{at}: array needs items"))?;
            Ok(format!("{}[]", duckdb_type(items, &format!("{at}/*"))?))
        }
        "object" => {
            let props = node
                .get("properties")
                .and_then(Value::as_object)
                .filter(|p| !p.is_empty())
                .ok_or_else(|| format!("{at}: object without fixed properties needs \"x-duckdb-type\""))?;
            let mut fields = Vec::new();
            let mut lowered: std::collections::HashMap<String, &str> = std::collections::HashMap::new();
            for (name, child) in props {
                // STRUCT field names are case-insensitive in DuckDB, like column names.
                if let Some(other) = lowered.insert(name.to_lowercase(), name) {
                    return Err(format!("{at}: properties {other:?} and {name:?} differ only in letter case (DuckDB field names are case-insensitive)"));
                }
                fields.push(format!("{} {}", qident(name), duckdb_type(child, &format!("{at}/{name}"))?));
            }
            Ok(format!("STRUCT({})", fields.join(", ")))
        }
        "null" => Err(format!("{at}: null-only field has no physical type")),
        other => Err(format!("{at}: unsupported type {other:?}")),
    }
}

/// One column per top-level payload property. NOT NULL only when the schema lists the property
/// in the top-level `required` and it is not nullable (NOT NULL cannot live inside a STRUCT, so
/// nested `required` is not enforced).
fn compile_columns(doc: &Value) -> Res<Vec<Column>> {
    if doc.get("type").and_then(Value::as_str) != Some("object") {
        return Err("top-level schema must be an object".to_owned());
    }
    let props = doc
        .get("properties")
        .and_then(Value::as_object)
        .filter(|p| !p.is_empty())
        .ok_or("top-level object must declare at least one property")?;
    let required: Vec<&str> = doc.get("required").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let mut columns = Vec::new();
    let mut lowered: std::collections::HashMap<String, &str> = std::collections::HashMap::new();
    for (name, node) in props {
        // DuckDB identifiers are case-insensitive: compare the lower-cased name everywhere.
        let lower = name.to_lowercase();
        if RESERVED_NAMES.contains(&lower.as_str()) || lower.starts_with(RESERVED_PREFIX) {
            return Err(format!("top-level property {name:?} is reserved for the digest envelope"));
        }
        // Two columns of one table that differ only in case would collide inside DuckDB.
        if let Some(other) = lowered.insert(lower, name) {
            return Err(format!("top-level properties {other:?} and {name:?} differ only in letter case (DuckDB column names are case-insensitive)"));
        }
        let replaces = match node.get("x-replaces") {
            None => None,
            Some(Value::String(old)) if !old.is_empty() && old != name => Some(old.clone()),
            Some(_) => return Err(format!("/{name}: x-replaces must name a different, non-empty property")),
        };
        columns.push(Column {
            name: name.clone(),
            ty: duckdb_type(node, &format!("/{name}"))?,
            not_null: required.contains(&name.as_str()) && !nullable_of(node),
            replaces,
        });
    }
    Ok(columns)
}

impl Producer {
    pub fn qualified_table(&self) -> String {
        format!("{}.{}", qident(&self.duckdb_schema), qident("events"))
    }

    /// Display name `_ingest.digest_<producer_type>`, as stored in the catalog.
    pub fn macro_name(&self) -> String {
        format!("_ingest.digest_{}", self.producer_type)
    }

    pub fn qualified_macro(&self) -> String {
        format!("{}.{}", qident("_ingest"), qident(&format!("digest_{}", self.producer_type)))
    }

    /// STRUCT type of the spool line's `payload`: every column's JSON name and type.
    pub fn payload_type(&self) -> String {
        format!("STRUCT({})", self.columns.iter().map(|c| format!("{} {}", qident(&c.name), c.ty)).collect::<Vec<_>>().join(", "))
    }

    /// Struct literal for `read_ndjson(columns = ...)`: the spool line is `{ts_ns, payload}`.
    pub fn reader_columns_sql(&self) -> String {
        format!("{{'ts_ns': 'BIGINT', 'payload': {}}}", sql_string(&self.payload_type()))
    }

    pub fn describe(&self) -> String {
        let mut lines = vec![
            format!("producer_type={}", self.producer_type),
            format!("spool={}", self.spool),
            format!("duckdb_schema={}", self.duckdb_schema),
            format!("schema_sha256={}", self.sha256),
            format!("table={}", self.qualified_table()),
        ];
        for c in &self.columns {
            lines.push(format!("  {}: {}{}", c.name, c.ty, if c.not_null { " NOT NULL" } else { " NULL" }));
        }
        lines.join("\n")
    }
}

/// Read the manifest, then every schema it names: hash check, column compile. Any problem is an
/// error naming the producer; nothing is skipped.
pub fn load_manifest(path: &Path) -> Res<Vec<Producer>> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("manifest {}: {e}", path.display()))?;
    let manifest: Manifest = serde_json::from_str(&text).map_err(|e| format!("manifest {}: {e}", path.display()))?;
    if manifest.producers.is_empty() {
        return Err("manifest needs a non-empty producers array".to_owned());
    }
    let base = path.parent().unwrap_or_else(|| Path::new(""));
    let mut out: Vec<Producer> = Vec::new();
    for e in manifest.producers {
        let pt = e.producer_type.clone();
        let fail = |msg: String| format!("producer {pt}: {msg}");
        if out.iter().any(|p| p.producer_type == pt) {
            return Err(fail("duplicate producer_type in manifest".to_owned()));
        }
        for (what, v) in [("source", &e.source), ("topic", &e.topic), ("spool", &e.spool)] {
            if !is_ident(v) {
                return Err(fail(format!("{what} {v:?} must be non-empty ASCII letters, digits and underscores")));
            }
        }
        let expected = format!("{}_{}_v{}", e.source, e.topic, e.version);
        if pt != expected {
            return Err(fail(format!("producer_type must be <source>_<topic>_v<version> = {expected}")));
        }
        let schema_path = base.join(&e.schema);
        let schema_text = std::fs::read_to_string(&schema_path).map_err(|err| fail(format!("schema {}: {err}", schema_path.display())))?;
        let schema_json: Value = serde_json::from_str(&schema_text).map_err(|err| fail(format!("schema {}: {err}", schema_path.display())))?;
        let sha256 = schema_hash(&schema_json);
        if sha256 != e.sha256 {
            return Err(fail(format!("manifest sha256 {} != canonical hash {sha256} of {}", e.sha256, schema_path.display())));
        }
        let columns = compile_columns(&schema_json).map_err(fail)?;
        out.push(Producer {
            duckdb_schema: producer_schema_name(&pt),
            producer_type: pt,
            source: e.source,
            topic: e.topic,
            version: e.version,
            claude_code_version: e.claude_code_version,
            spool: e.spool,
            valid_from: e.valid_from,
            schema_json,
            sha256,
            columns,
        });
    }
    Ok(out)
}

/// The current producer of every source+topic: the highest `version`, sorted by source then topic
/// (owner ruling D-G: the lookup that lets a producer pick the schema, and so the spool, to write to).
pub fn current_versions(producers: &[Producer]) -> Vec<&Producer> {
    let mut current: std::collections::BTreeMap<(&str, &str), &Producer> = std::collections::BTreeMap::new();
    for p in producers {
        let slot = current.entry((&p.source, &p.topic)).or_insert(p);
        if p.version > slot.version {
            *slot = p;
        }
    }
    current.into_values().collect()
}


/// `aldigest rehash`: recompute the canonical sha256 of every schema file the manifest names and
/// rewrite the `sha256` fields in place (same key order, 2-space indent, trailing newline).
/// Returns how many hashes changed. The schema files are the source of truth (owner ruling D-E),
/// edited by hand; this does no other validation, the next [`load_manifest`] does.
pub fn rehash_manifest(path: &Path) -> Res<usize> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("manifest {}: {e}", path.display()))?;
    let mut doc: Value = serde_json::from_str(&text).map_err(|e| format!("manifest {}: {e}", path.display()))?;
    let base = path.parent().unwrap_or_else(|| Path::new(""));
    let entries = doc.get_mut("producers").and_then(Value::as_array_mut).ok_or("manifest needs a producers array")?;
    let mut changed = 0;
    for entry in entries {
        let obj = entry.as_object_mut().ok_or("every producers entry must be an object")?;
        let schema = obj.get("schema").and_then(Value::as_str).ok_or("a producers entry has no schema path")?;
        let schema_path = base.join(schema);
        let schema_text = std::fs::read_to_string(&schema_path).map_err(|e| format!("schema {}: {e}", schema_path.display()))?;
        let schema_json: Value = serde_json::from_str(&schema_text).map_err(|e| format!("schema {}: {e}", schema_path.display()))?;
        let hash = schema_hash(&schema_json);
        let slot = obj.get_mut("sha256").ok_or_else(|| format!("entry for {}: no sha256 field", schema_path.display()))?;
        if slot.as_str() != Some(hash.as_str()) {
            *slot = Value::String(hash);
            changed += 1;
        }
    }
    let out = serde_json::to_string_pretty(&doc).map_err(|e| format!("manifest {}: {e}", path.display()))? + "\n";
    std::fs::write(path, out).map_err(|e| format!("manifest {}: {e}", path.display()))?;
    Ok(changed)
}
