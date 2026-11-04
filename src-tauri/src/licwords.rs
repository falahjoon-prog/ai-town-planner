//! Licence words and dates shared by the desktop app and the web server (Trade AI `product_access` answers).
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The words shown to the person for a licence answer.
pub fn message(lic: &Value) -> String {
    let days = lic["expires_at"].as_str().and_then(days_left);
    match lic["state"].as_str().unwrap_or("") {
        "trial" => match days {
            Some(d) => format!("Trial: {d} day{} left", if d == 1 { "" } else { "s" }),
            None => "Free trial".into(),
        },
        "licensed" => format!("{} licence active", title(lic["plan"].as_str().unwrap_or("Paid"))),
        "no_seat" => format!(
            "All {} seat{} of your AI Town Planner licence are in use. Try again when someone signs out, or add seats at trade-ai.com.au.",
            lic["seats"], if lic["seats"] == 1 { "" } else { "s" }
        ),
        "disabled" => "This account has been disabled. Contact Trade AI at trade-ai.com.au.".into(),
        _ => "Your free trial of AI Town Planner has ended. Licence needed — buy at trade-ai.com.au.".into(),
    }
}

fn title(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

/// Whole days left, counted the way people do (15 on the first day of a 15-day trial).
pub fn days_left(iso: &str) -> Option<i64> {
    let secs = parse_iso(iso)? as i64 - now_secs() as i64;
    Some(if secs <= 0 { 0 } else { (secs + 86_399) / 86_400 })
}

/// Seconds since 1970 for a Postgres/ISO timestamp such as `2026-11-19T04:05:06.123+00:00`.
pub fn parse_iso(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    // days from civil (Howard Hinnant)
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let mut t = days * 86_400 + h * 3600 + mi * 60 + se;
    let rest = &s[19..];
    let rest = rest.trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    if let Some(off) = rest.get(..1).filter(|c| *c == "+" || *c == "-") {
        let hh = rest.get(1..3)?.parse::<i64>().ok()?;
        let mm = rest.get(rest.len().saturating_sub(2)..)?.parse::<i64>().unwrap_or(0);
        let o = hh * 3600 + if rest.len() > 3 { mm * 60 } else { 0 };
        t -= if off == "+" { o } else { -o };
    }
    u64::try_from(t).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn iso_and_days() {
        assert_eq!(parse_iso("1970-01-02T00:00:00+00:00"), Some(86_400));
        assert_eq!(parse_iso("2026-11-04T10:00:00.123456+10:00"), parse_iso("2026-11-04T00:00:00Z"));
        assert_eq!(parse_iso("2000-03-01T00:00:00Z"), Some(951_868_800));
        assert!(days_left("2001-01-01T00:00:00Z") == Some(0));
    }

    #[test]
    fn words() {
        assert_eq!(message(&json!({"state": "trial", "expires_at": "2001-01-01T00:00:00Z"})), "Trial: 0 days left");
        assert!(message(&json!({"state": "expired"})).contains("Licence needed — buy at trade-ai.com.au"));
        assert_eq!(message(&json!({"state": "licensed", "plan": "team"})), "Team licence active");
    }
}
