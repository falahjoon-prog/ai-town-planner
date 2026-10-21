//! Deterministic rules: zone identification and overlay flags grouped by authority.
//! The AI only explains these facts.
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
    pub authority: String,
    #[serde(default)]
    pub always: bool,
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
    pub authority: String,
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

/// Report sections, in display order: (key, title, who is responsible).
pub const AUTHORITIES: &[(&str, &str, &str)] = &[
    ("council", "Council", "Brisbane City Council under Brisbane City Plan 2014"),
    ("sara", "SARA (State)", "the State Assessment and Referral Agency (SARA) under the Planning Regulation 2017 and SDAP"),
    ("pda", "PDA (EDQ)", "Economic Development Queensland under the Economic Development Act 2012 and the PDA development scheme"),
    ("state", "State plans", "the Queensland Government's regional and state planning instruments (ShapingSEQ 2023, State Planning Policy)"),
    ("other", "Other agencies", "other agencies and laws: utilities (Urban Utilities, Energex), federal law (EPBC Act, airspace) and state permits"),
];

pub const DISCLAIMER: &str = "Indicative desktop assessment generated from Brisbane City Council and Queensland Government open data and an AI model. It is not a formal planning certificate or legal advice. Verify against the current Brisbane City Plan 2014, SARA DA mapping and agency records, and engage a registered planner before making decisions.";

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

fn add_flag(flags: &mut Vec<Flag>, r: &Rule, layer: Option<&str>) {
    match flags.iter_mut().find(|f| f.rule.id == r.id) {
        Some(f) => {
            if let Some(l) = layer {
                if !f.layers.iter().any(|x| x == l) {
                    f.layers.push(l.to_string());
                }
            }
        }
        None => flags.push(Flag { rule: r.clone(), layers: layer.map(|l| vec![l.to_string()]).unwrap_or_default() }),
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
            let authority = if z.name.starts_with("Priority Development Area") { "pda" } else { "council" };
            zones.push(ZoneMatch { authority: authority.into(), zone: z.clone(), coverage_pct: h.coverage_pct, raw: h.props.clone() });
        }
    }
    // A PDA overrides City Plan, so show it first.
    zones.sort_by_key(|z| z.authority != "pda");

    let mut flags: Vec<Flag> = Vec::new();
    for h in &overlays {
        let hay = norm(&format!("{} {}", h.dataset_id, h.title));
        if h.authority == "council" && hay.contains("zoning") {
            continue;
        }
        for r in rules_kb().iter().filter(|r| !r.always) {
            // Agency rules match their own layers; "other" rules (federal, utilities) can match any layer.
            let same = r.authority == h.authority || r.authority == "other";
            if same && r.keywords.iter().any(|k| hay.contains(&norm(k))) {
                add_flag(&mut flags, r, Some(&h.title));
            }
        }
    }
    if zones.iter().any(|z| z.authority == "pda") {
        if let Some(r) = rules_kb().iter().find(|r| r.id == "pda") {
            add_flag(&mut flags, r, None);
        }
    }
    for r in rules_kb().iter().filter(|r| r.always) {
        add_flag(&mut flags, r, None);
    }
    Assessment { parcel, zones, flags, overlays, manifest }
}

fn trim(v: &Value, max: usize) -> String {
    let s = v.to_string();
    if s.len() <= max {
        return s;
    }
    let mut cut = max;
    while !s.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &s[..cut])
}

fn site_facts(a: &Assessment) -> Value {
    let p = &a.parcel;
    json!({"address": p.address, "lot_plan": p.lotplan, "suburb": p.suburb, "lot_area_m2": p.area_m2,
           "lot_attributes": trim(&p.props, 300), "data_date": a.manifest.get("built_at")})
}

fn authority_facts(a: &Assessment, key: &str) -> Value {
    let zones: Vec<Value> = a
        .zones
        .iter()
        .filter(|z| z.authority == key)
        .map(|z| json!({"zone": z.zone.name, "purpose": z.zone.purpose, "typical_uses": z.zone.typical, "coverage_pct": z.coverage_pct, "attributes": trim(&z.raw, 200)}))
        .collect();
    let triggers: Vec<Value> = a
        .flags
        .iter()
        .filter(|f| f.rule.authority == key)
        .map(|f| json!({"matter": f.rule.title, "legislation_or_code": f.rule.code, "implication": f.rule.note, "mapped_layers": f.layers, "checks": f.rule.checklist}))
        .collect();
    let layers: Vec<Value> = a
        .overlays
        .iter()
        .filter(|h| h.authority == key && !(key == "council" && norm(&h.dataset_id).contains("zoning")))
        .take(20)
        .map(|h| json!({"layer": h.title, "coverage_pct": h.coverage_pct, "distance_m": h.distance_m, "attributes": trim(&h.props, 180)}))
        .collect();
    json!({"zones": zones, "triggers": triggers, "mapped_layers": layers})
}

const PERSONA: &str = "You are a senior town planner in Brisbane, Queensland. Use ONLY the facts supplied. \
Never invent provisions, numbers, heights, setbacks, parking rates or levels of assessment that are not in the facts; \
if something must be confirmed, say exactly what and where to check. Be concise, practical and plain-English. Use Markdown.";

/// Sections to generate: only authorities with something to say, plus a summary.
pub fn sections(a: &Assessment) -> Vec<(&'static str, &'static str)> {
    let mut out: Vec<(&str, &str)> = AUTHORITIES
        .iter()
        .filter(|(k, _, _)| match *k {
            "council" | "sara" | "other" => true,
            k => a.flags.iter().any(|f| f.rule.authority == k) || a.zones.iter().any(|z| z.authority == k),
        })
        .map(|(k, t, _)| (*k, *t))
        .collect();
    out.push(("summary", "Summary"));
    out
}

/// Builds the (system, user) prompt for one report section.
pub fn section_prompt(a: &Assessment, key: &str, question: &str) -> (String, String) {
    let proposal = if question.trim().is_empty() { String::new() } else { format!("\nProposal / question: {}", question.trim()) };
    if key == "summary" {
        let all: BTreeMap<&str, Value> = AUTHORITIES.iter().map(|(k, _, _)| (*k, authority_facts(a, k))).collect();
        let user = format!(
            "SITE: {}\nFINDINGS BY AUTHORITY: {}\n{proposal}\n\nWrite the overall summary with these headings:\n### Key findings\n### Who assesses what\n(bullet per authority: council, SARA, EDQ if PDA, others)\n### Combined due-diligence checklist\n### Recommended next steps",
            site_facts(a),
            json!(all)
        );
        return (PERSONA.to_string(), user);
    }
    let (_, title, who) = AUTHORITIES.iter().find(|(k, _, _)| *k == key).copied().unwrap_or(("", "", ""));
    let facts = authority_facts(a, key);
    let empty = facts["zones"].as_array().map_or(true, |v| v.is_empty()) && facts["triggers"].as_array().map_or(true, |v| v.is_empty());
    let note = if empty && key == "sara" {
        "\nNo state referral triggers were found in the data pack. Say so, and recommend confirming against the SARA DA mapping system before lodging."
    } else {
        ""
    };
    let user = format!(
        "Write ONLY the \"{title}\" part of the site report: what {who} regulates for this site and what it means.\nSITE: {}\nFACTS FOR THIS AUTHORITY: {facts}{note}{proposal}\n\nUse these headings:\n### What applies\n### What it means for development\n### Checks before lodging\nAttribute each point to the authority (e.g. \"Council requires…\", \"SARA referral is likely because…\").",
        site_facts(a)
    );
    (PERSONA.to_string(), user)
}

pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

/// Chat messages for follow-up questions: system + site facts/report, then recent history.
pub fn chat_messages(a: &Assessment, report: &str, history: &[ChatMsg]) -> Vec<(String, String)> {
    let all: BTreeMap<&str, Value> = AUTHORITIES.iter().map(|(k, _, _)| (*k, authority_facts(a, k))).collect();
    let mut report = report.to_string();
    if report.len() > 6000 {
        let mut cut = 6000;
        while !report.is_char_boundary(cut) {
            cut -= 1;
        }
        report.truncate(cut);
    }
    let system = format!(
        "{PERSONA}\nYou are advising the user about one site and may discuss options, trade-offs and design changes that could improve the outcome \
(e.g. reducing height, changing use, avoiding a trigger). Always say which authority (council, SARA, EDQ, other) a point relates to, \
and be honest when the data cannot answer something.\n\nSITE: {}\nFINDINGS BY AUTHORITY: {}\nEARLIER REPORT:\n{report}",
        site_facts(a),
        json!(all)
    );
    let mut msgs = vec![("system".to_string(), system)];
    let start = history.len().saturating_sub(10);
    for m in &history[start..] {
        let role = if m.role == "assistant" { "assistant" } else { "user" };
        let content: String = m.content.chars().take(2000).collect();
        msgs.push((role.to_string(), content));
    }
    msgs
}
