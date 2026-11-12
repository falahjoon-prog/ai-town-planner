//! Data pack listing: parses GitHub releases JSON into selectable packs (pure, unit tested).
use serde::Serialize;
use serde_json::Value;

pub const REPO_DOWNLOAD: &str = "https://github.com/falahjoon-prog/ai-town-planner/releases/download/";
const ASSET: &str = "datapack.sqlite.gz";
const SEVEN: [&str; 7] = ["Brisbane", "Ipswich", "Logan", "Redland", "Moreton Bay", "Gold Coast", "Mackay"];

#[derive(Serialize, Debug, PartialEq)]
pub struct Pack {
    pub tag: String,
    pub published: String,
    pub size: u64,
    pub title: String,
    pub councils: Vec<String>,
    /// Approximate size on disk once unpacked, when known.
    pub disk_gb: Option<f64>,
}

/// Tag must match ^(datapack|branchpack)-[A-Za-z0-9._-]+$
pub fn valid_tag(t: &str) -> bool {
    let rest = t.strip_prefix("datapack-").or_else(|| t.strip_prefix("branchpack-"));
    rest.is_some_and(|r| !r.is_empty() && r.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)))
}

/// Branch name of a branchpack tag: drops the "branchpack-" prefix and a trailing -YYYYMMDD-HHMM stamp.
fn branch_of(tag: &str) -> String {
    let rest = tag.strip_prefix("branchpack-").unwrap_or(tag);
    let parts: Vec<&str> = rest.split('-').collect();
    let n = parts.len();
    let num = |s: &str, len: usize| s.len() == len && s.chars().all(|c| c.is_ascii_digit());
    if n > 2 && num(parts[n - 2], 8) && num(parts[n - 1], 4) { parts[..n - 2].join("-") } else { rest.to_string() }
}

/// A `councils: A, B, C` line in the release body overrides the built-in mapping.
fn body_councils(body: &str) -> Option<Vec<String>> {
    body.lines().find_map(|l| {
        let l = l.trim().trim_start_matches(['*', '-', ' ']);
        let v = l.get(..9).filter(|p| p.eq_ignore_ascii_case("councils:")).map(|_| l[9..].trim())?;
        let list: Vec<String> = v.trim_matches('*').split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        (!list.is_empty()).then_some(list)
    })
}

/// Newest datapack-* plus the newest branchpack-* per branch, newest first.
pub fn parse_releases(v: &Value) -> Vec<Pack> {
    let mut out: Vec<(Pack, String)> = vec![]; // (pack, group key)
    for r in v.as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        let tag = r["tag_name"].as_str().unwrap_or("");
        let is_branch = tag.starts_with("branchpack-");
        if !valid_tag(tag) || r["draft"].as_bool() == Some(true) { continue; }
        let Some(asset) = r["assets"].as_array().and_then(|a| a.iter().find(|a| a["name"] == ASSET)) else { continue };
        let branch = if is_branch { branch_of(tag) } else { String::new() };
        let mapped: Option<Vec<String>> = if !is_branch {
            Some(vec!["Brisbane".into()])
        } else if branch.starts_with("t20-four-councils") {
            Some(SEVEN.iter().map(|s| s.to_string()).collect())
        } else { None };
        let seven = is_branch && branch.starts_with("t20-four-councils");
        let councils = body_councils(r["body"].as_str().unwrap_or("")).or(mapped).unwrap_or_default();
        let multi = is_branch;
        out.push((Pack {
            tag: tag.to_string(),
            published: r["published_at"].as_str().or(r["created_at"].as_str()).unwrap_or("").to_string(),
            size: asset["size"].as_u64().unwrap_or(0),
            title: if multi { "Multi-council (test build)".into() } else { "Brisbane".into() },
            disk_gb: (seven && councils.len() == 7).then_some(6.6),
            councils: if councils.is_empty() { vec!["Councils not listed".into()] } else { councils },
        }, if is_branch { format!("b:{branch}") } else { "d".into() }));
    }
    out.sort_by(|a, b| b.0.published.cmp(&a.0.published));
    let mut seen = std::collections::HashSet::new();
    out.into_iter().filter(|(_, k)| seen.insert(k.clone())).map(|(p, _)| p).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rel(tag: &str, date: &str, size: u64, body: &str, asset: &str) -> Value {
        json!({"tag_name": tag, "published_at": date, "body": body, "assets": [{"name": asset, "size": size}]})
    }

    #[test]
    fn tags() {
        assert!(valid_tag("datapack-2026-10-01"));
        assert!(valid_tag("branchpack-t20-four-councils-20261024-1651"));
        for bad in ["datapack-", "datapack", "v1", "datapack-a/b", "datapack-a b", "branchpack-../x", "xdatapack-1", "datapack-a?b"] {
            assert!(!valid_tag(bad), "{bad}");
        }
    }

    #[test]
    fn lists_newest_per_group() {
        let v = json!([
            rel("branchpack-t20-four-councils-20261024-1651", "2026-10-24T06:00:00Z", 1_140_000_000, "", "datapack.sqlite.gz"),
            rel("branchpack-t20-four-councils-20261020-0900", "2026-10-20T06:00:00Z", 1_000_000_000, "", "datapack.sqlite.gz"),
            rel("datapack-20261010", "2026-10-10T00:00:00Z", 420_000_000, "", "datapack.sqlite.gz"),
            rel("datapack-20260901", "2026-09-01T00:00:00Z", 400_000_000, "", "datapack.sqlite.gz"),
            rel("branchpack-other-20261101-1200", "2026-11-01T00:00:00Z", 5, "", "other.zip"),
            rel("branchpack-t99-x-20261102-1200", "2026-11-02T00:00:00Z", 7, "", "datapack.sqlite.gz"),
            rel("v1.0", "2026-11-03T00:00:00Z", 7, "", "datapack.sqlite.gz"),
        ]);
        let p = parse_releases(&v);
        let tags: Vec<&str> = p.iter().map(|x| x.tag.as_str()).collect();
        assert_eq!(tags, ["branchpack-t99-x-20261102-1200", "branchpack-t20-four-councils-20261024-1651", "datapack-20261010"]);
        assert_eq!(p[0].councils, ["Councils not listed"]);
        assert_eq!(p[1].councils.len(), 7);
        assert_eq!(p[1].title, "Multi-council (test build)");
        assert_eq!((p[1].size, p[1].disk_gb), (1_140_000_000, Some(6.6)));
        assert_eq!((p[2].councils.clone(), p[2].disk_gb), (vec!["Brisbane".to_string()], None));
    }

    #[test]
    fn body_overrides() {
        let v = json!([rel("datapack-1", "2026-10-10T00:00:00Z", 1, "Notes\nCouncils: Brisbane, Logan\n", "datapack.sqlite.gz")]);
        assert_eq!(parse_releases(&v)[0].councils, ["Brisbane", "Logan"]);
        assert!(parse_releases(&json!({"message": "rate limited"})).is_empty());
    }
}
