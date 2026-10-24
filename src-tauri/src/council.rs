//! Council registry (knowledge/councils.json, shared with the data pack pipeline) and per-council
//! rule data (knowledge/council_rules.json). Adding a council is a data change: a registry entry plus,
//! when sourced, its zones, overlay rules, provisions, uses and setbacks in council_rules.json.
//! Brisbane keeps its own files (zones.json, rules.json, provisions.json, uses.json, setbacks.json).
use crate::dev::{ProvSet, UseRule};
use crate::rules::{Rule, Zone};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::OnceLock;

pub const DEFAULT: &str = "brisbane";

fn registry() -> &'static Vec<Value> {
    static R: OnceLock<Vec<Value>> = OnceLock::new();
    R.get_or_init(|| serde_json::from_str(include_str!("../knowledge/councils.json")).expect("councils.json"))
}

/// Registry entry for the app (pipeline settings removed); unknown ids fall back to the first entry.
pub fn info(id: &str) -> Value {
    let r = registry();
    let mut v = r.iter().find(|c| c["id"] == id).or_else(|| r.first()).cloned().unwrap_or(Value::Null);
    if let Value::Object(m) = &mut v {
        m.remove("pipeline");
        m.remove("samples");
    }
    v
}

/// A text field of the council's registry entry ("" if missing).
pub fn field(id: &str, key: &str) -> String {
    info(id)[key].as_str().unwrap_or("").to_string()
}

/// False for councils whose zones and overlays are not in the data pack (registry key "zones_loaded": false).
pub fn zones_loaded(id: &str) -> bool {
    info(id)["zones_loaded"].as_bool().unwrap_or(true)
}

#[derive(Deserialize, Default)]
pub struct CouncilUse {
    /// Zones where the use is generally contemplated (keywords; empty = not recorded)
    #[serde(default)]
    pub zones: Vec<String>,
    #[serde(default)]
    pub checks: Vec<String>,
    #[serde(default)]
    pub sources: Vec<Value>,
    #[serde(default)]
    pub rules: Vec<UseRule>,
}

#[derive(Deserialize, Default)]
pub struct CouncilKb {
    #[serde(default)]
    pub zones: Vec<Zone>,
    #[serde(default)]
    pub rules: Vec<Rule>,
    #[serde(default)]
    pub provisions: Vec<ProvSet>,
    #[serde(default)]
    pub uses: BTreeMap<String, CouncilUse>,
}

fn kbs() -> &'static BTreeMap<String, CouncilKb> {
    static K: OnceLock<BTreeMap<String, CouncilKb>> = OnceLock::new();
    K.get_or_init(|| {
        let mut m: BTreeMap<String, CouncilKb> =
            serde_json::from_str(include_str!("../knowledge/council_rules.json")).expect("council_rules.json");
        for (id, kb) in m.iter_mut() {
            for r in kb.rules.iter_mut() {
                r.council = Some(id.clone()); // a council's rules only apply to its own lots
            }
        }
        m
    })
}

/// Rule data for a council other than Brisbane (None when nothing is loaded for it yet).
pub fn kb(id: &str) -> Option<&'static CouncilKb> {
    kbs().get(id)
}

/// "Not loaded yet" text that points to the council's planning scheme.
pub fn not_loaded(id: &str) -> String {
    format!("Not loaded yet – see {} ({})", field(id, "scheme"), field(id, "scheme_url"))
}
