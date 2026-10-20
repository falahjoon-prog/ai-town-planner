//! Deterministic rules: zone identification and overlay flags. The AI only explains these facts.
use crate::data::{OverlayHit, Parcel};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::OnceLock;

#[derive(Deserialize, Serialize, Clone)]
pub struct Zone {
    pub name: String,
    pub keywords: Vec<String>,
    pub purpose: String,
    pub typical: String,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct Rule {
    pub id: String,
    pub keywords: Vec<String>,
    pub title: String,
    pub code: String,
    pub note: String,
    pub checklist: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct Flag {
    pub rule: Rule,
    pub layers: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct ZoneMatch {
    pub zone: Zone,
    pub coverage_pct: Option<f64>,
    pub raw: Value,
}

#[derive(Serialize, Clone)]
pub struct Assessment {
    pub parcel: Parcel,
    pub zones: Vec<ZoneMatch>,
    pub flags: Vec<Flag>,
    pub overlays: Vec<OverlayHit>,
    pub manifest: BTreeMap<String, String>,
}

pub const DISCLAIMER: &str = "Indicative desktop assessment generated offline from Brisbane City Council open data and an on-device AI model. It is not a formal planning certificate or legal advice. Verify against the current Brisbane City Plan 2014 and Council records, and engage a registered planner before making decisions.";

fn zones_kb() -> &'static Vec<Zone> {
    static Z: OnceLock<Vec<Zone>> = OnceLock::new();
    Z.get_or_init(|| serde_json::from_str(include_str!("../knowledge/zones.json")).expect("zones.json"))
}

fn rules_kb() -> &'static Vec<Rule> {
    static R: OnceLock<Vec<Rule>> = OnceLock::new();
    R.get_or_init(|| serde_json::from_str(include_str!("../knowledge/rules.json")).expect("rules.json"))
}

fn norm(s: &str) -> String {
    s.to_lowercase().replace(['-', '_', '—'], " ")
}

fn prop_text(v: &Value) -> String {
    match v {
        Value::Object(m) => m.values().map(prop_text).collect::<Vec<_>>().join(" | "),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

pub fn assess(parcel: Parcel, overlays: Vec<OverlayHit>, manifest: BTreeMap<String, String>) -> Assessment {
    let mut zones = Vec::new();
    for h in overlays.iter().filter(|h| norm(&h.dataset_id).contains("zoning")) {
        let text = norm(&prop_text(&h.props));
        // Longest matching keyword wins (e.g. "low medium density residential" over "medium density residential").
        let best = zones_kb()
            .iter()
            .flat_map(|z| z.keywords.iter().map(move |k| (z, norm(k))))
            .filter(|(_, k)| text.contains(k.as_str()))
            .max_by_key(|(_, k)| k.len());
        if let Some((z, _)) = best {
            zones.push(ZoneMatch { zone: z.clone(), coverage_pct: h.coverage_pct, raw: h.props.clone() });
        }
    }
    let mut flags: Vec<Flag> = Vec::new();
    for h in &overlays {
        let hay = norm(&format!("{} {}", h.dataset_id, h.title));
        if hay.contains("zoning") {
            continue;
        }
        for r in rules_kb() {
            if r.keywords.iter().any(|k| hay.contains(&norm(k))) {
                match flags.iter_mut().find(|f| f.rule.id == r.id) {
                    Some(f) if !f.layers.contains(&h.title) => f.layers.push(h.title.clone()),
                    Some(_) => {}
                    None => flags.push(Flag { rule: r.clone(), layers: vec![h.title.clone()] }),
                }
            }
        }
    }
    Assessment { parcel, zones, flags, overlays, manifest }
}

fn trim(v: &Value, max: usize) -> String {
    let s = v.to_string();
    if s.len() > max {
        let mut cut = max;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}…", &s[..cut])
    } else {
        s
    }
}

/// Builds (system, user) prompts. Facts are compact JSON so they fit a small model's context.
pub fn prompt(a: &Assessment, question: &str) -> (String, String) {
    let system = "You are a senior town planner in Brisbane, Queensland, writing a desktop due-diligence assessment under the Planning Act 2016 and Brisbane City Plan 2014. \
Use ONLY the facts supplied. Never invent provisions, numbers, heights, setbacks or levels of assessment that are not in the facts; where something must be checked, say so. \
Name the relevant City Plan zone codes and overlay codes supplied. Be concise and practical. Write in Markdown with these sections:\n\
## Site summary\n## Zoning and intent\n## Overlays and constraints\n## Likely assessment pathway (indicative: refer to City Plan Part 5 tables of assessment)\n## Due-diligence checklist\n## Recommended next steps".to_string();
    let p = &a.parcel;
    let overlays: Vec<Value> = a
        .overlays
        .iter()
        .filter(|h| !norm(&h.dataset_id).contains("zoning"))
        .take(25)
        .map(|h| json!({"layer": h.title, "coverage_pct": h.coverage_pct, "attributes": trim(&h.props, 220)}))
        .collect();
    let facts = json!({
        "address": p.address, "lot_plan": p.lotplan, "suburb": p.suburb, "lot_area_m2": p.area_m2,
        "lot_attributes": trim(&p.props, 400),
        "zones": a.zones.iter().map(|z| json!({"zone": z.zone.name, "purpose": z.zone.purpose, "typical_uses": z.zone.typical, "coverage_pct": z.coverage_pct, "attributes": trim(&z.raw, 200)})).collect::<Vec<_>>(),
        "constraints": a.flags.iter().map(|f| json!({"constraint": f.rule.title, "code": f.rule.code, "implication": f.rule.note, "layers": f.layers})).collect::<Vec<_>>(),
        "overlay_features": overlays,
        "data_date": a.manifest.get("built_at"),
    });
    let q = if question.trim().is_empty() {
        "Prepare the planning assessment for this site.".to_string()
    } else {
        format!("Prepare the planning assessment for this site, specifically addressing this proposal/question: {}", question.trim())
    };
    (system, format!("FACTS:\n{facts}\n\n{q}"))
}
