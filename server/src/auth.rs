//! Trade AI sign-in and the `townplanner` licence for the web app (licensing/README.md).
//! The browser signs in to Supabase itself (`auth_config` gives it the public project URL and anon key);
//! every other `/api/*` call must carry `Authorization: Bearer <Supabase access token>`. The server asks
//! Supabase `product_access(product, device)` with that token: Supabase checks the token's signature and
//! expiry, the function checks the trial / paid licence and takes a seat for the device. Answers are cached
//! briefly per token. Tokens are never logged.
use crate::{err, AppState};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Commands that work without a token.
const OPEN: &[&str] = &["auth_config"];

const OK_TTL: Duration = Duration::from_secs(60);
const DENIED_TTL: Duration = Duration::from_secs(20);
/// When Supabase can't be reached, a token that was fine this recently keeps working.
const STALE_OK: Duration = Duration::from_secs(15 * 60);

#[derive(Clone)]
enum Verdict {
    /// Trial or seat held: the licence JSON from `product_access`.
    Allowed(Value),
    /// Signed in, but no trial / seat (HTTP 402): the licence JSON.
    Denied(Value),
    /// No / bad / expired token (HTTP 401).
    SignIn(String),
    /// Not configured, or Supabase unreachable (HTTP 503).
    Unavailable(String),
}

#[derive(Default)]
pub struct Cache(Mutex<HashMap<String, (Instant, Verdict)>>);

fn bearer(h: &HeaderMap) -> Option<&str> {
    h.get("authorization")?.to_str().ok()?.strip_prefix("Bearer ").map(str::trim).filter(|t| !t.is_empty() && t.len() < 8192)
}

/// The phone's own id (random, made by the browser), so each phone counts as one device / seat.
fn device(h: &HeaderMap) -> String {
    let raw = h.get("x-device-id").and_then(|v| v.to_str().ok()).unwrap_or("");
    let id: String = raw.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(64).collect();
    format!("web-{}", if id.is_empty() { "unknown" } else { &id })
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Local check of an HS256 token with the project's JWT secret (optional; Supabase checks it anyway).
/// Tokens signed with the newer asymmetric keys are left to Supabase.
fn jwt_ok(token: &str, secret: &str) -> bool {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    let dec = |s: &str| URL_SAFE_NO_PAD.decode(s.trim_end_matches('=')).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    let (Some(head), Some(claims)) = (dec(parts[0]), dec(parts[1])) else { return false };
    match head["alg"].as_str() {
        Some("HS256") => {
            let Ok(sig) = URL_SAFE_NO_PAD.decode(parts[2].trim_end_matches('=')) else { return false };
            let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret.as_bytes());
            if ring::hmac::verify(&key, format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig).is_err() {
                return false;
            }
        }
        Some("ES256" | "RS256" | "EdDSA") => {}
        _ => return false, // "none" or unknown
    }
    claims["exp"].as_u64().is_some_and(|exp| exp > now_secs())
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
fn days_left(iso: &str) -> Option<i64> {
    let secs = parse_iso(iso)? as i64 - now_secs() as i64;
    Some(if secs <= 0 { 0 } else { (secs + 86_399) / 86_400 })
}

/// Seconds since 1970 for a Postgres/ISO timestamp such as `2026-11-19T04:05:06.123+00:00`.
fn parse_iso(s: &str) -> Option<u64> {
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

fn with_message(mut lic: Value) -> Value {
    lic["message"] = json!(message(&lic));
    lic["days_left"] = json!(lic["expires_at"].as_str().and_then(days_left));
    lic
}

async fn ask_supabase(st: &AppState, token: &str, dev: &str) -> Verdict {
    let c = &st.cfg;
    let res = st
        .http
        .post(format!("{}/rest/v1/rpc/product_access", c.supabase_url))
        .header("apikey", &c.supabase_anon_key)
        .bearer_auth(token)
        .timeout(Duration::from_secs(15))
        .json(&json!({ "p_product": c.product, "p_device_id": dev, "p_device_name": "Phone web app", "p_app_version": concat!("web ", env!("CARGO_PKG_VERSION")) }))
        .send()
        .await;
    let r = match res {
        Ok(r) => r,
        Err(_) => return Verdict::Unavailable("Can't reach the Trade AI sign-in service. Try again in a minute.".into()),
    };
    let status = r.status();
    let body: Value = r.json().await.unwrap_or(Value::Null);
    if status.is_success() && body.is_object() {
        let lic = with_message(body);
        return if lic["ok"] == true { Verdict::Allowed(lic) } else { Verdict::Denied(lic) };
    }
    let text = body["message"].as_str().unwrap_or("");
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN || text.contains("Not signed in") || text.to_lowercase().contains("jwt") {
        return Verdict::SignIn("Your sign-in has expired. Please sign in again.".into());
    }
    if text.contains("product_access") || status == StatusCode::NOT_FOUND {
        return Verdict::Unavailable("Licensing is not set up in the Trade AI database yet (licensing/SUPABASE_SETUP.sql).".into());
    }
    Verdict::Unavailable(format!("The Trade AI sign-in service answered with an error ({}). Try again.", status.as_u16()))
}

async fn verdict(st: &AppState, h: &HeaderMap) -> Verdict {
    let c = &st.cfg;
    if c.supabase_url.is_empty() || c.supabase_anon_key.is_empty() {
        return Verdict::Unavailable("Sign-in is not set up on this server yet (SUPABASE_URL and SUPABASE_ANON_KEY).".into());
    }
    let Some(token) = bearer(h) else { return Verdict::SignIn("Please sign in with your Trade AI account.".into()) };
    if let Some(secret) = &c.supabase_jwt_secret {
        if !jwt_ok(token, secret) {
            return Verdict::SignIn("Your sign-in has expired. Please sign in again.".into());
        }
    }
    let dev = device(h);
    let key = format!("{dev}|{token}");
    let cached = st.auth.0.lock().unwrap_or_else(|p| p.into_inner()).get(&key).cloned();
    if let Some((t, v)) = &cached {
        let ttl = if matches!(v, Verdict::Allowed(_)) { OK_TTL } else { DENIED_TTL };
        if t.elapsed() < ttl {
            return v.clone();
        }
    }
    let v = ask_supabase(st, token, &dev).await;
    if let (Verdict::Unavailable(_), Some((t, old @ Verdict::Allowed(_)))) = (&v, &cached) {
        if t.elapsed() < STALE_OK {
            return old.clone();
        }
    }
    if matches!(v, Verdict::Allowed(_) | Verdict::Denied(_)) {
        let mut m = st.auth.0.lock().unwrap_or_else(|p| p.into_inner());
        if m.len() > 10_000 {
            m.retain(|_, (t, _)| t.elapsed() < STALE_OK);
        }
        m.insert(key, (Instant::now(), v.clone()));
    } else {
        st.auth.0.lock().unwrap_or_else(|p| p.into_inner()).remove(&key);
    }
    v
}

fn refuse(v: Verdict) -> Response {
    match v {
        Verdict::Allowed(lic) => Json(lic).into_response(),
        Verdict::Denied(lic) => (StatusCode::PAYMENT_REQUIRED, Json(json!({ "error": lic["message"].clone(), "licence": lic }))).into_response(),
        Verdict::SignIn(m) => err(StatusCode::UNAUTHORIZED, m),
        Verdict::Unavailable(m) => err(StatusCode::SERVICE_UNAVAILABLE, m),
    }
}

/// Sign-in commands, and the gate in front of every other command: `Some(response)` answers the request.
pub async fn route(st: &AppState, cmd: &str, h: &HeaderMap) -> Option<Response> {
    if OPEN.contains(&cmd) {
        let c = &st.cfg;
        let on = !c.supabase_url.is_empty() && !c.supabase_anon_key.is_empty();
        return Some(Json(json!({ "configured": on, "url": c.supabase_url, "anon_key": c.supabase_anon_key, "product": c.product })).into_response());
    }
    let v = verdict(st, h).await;
    match (cmd, v) {
        ("licence_state", Verdict::Allowed(lic) | Verdict::Denied(lic)) => Some(Json(lic).into_response()),
        ("auth_sign_out", Verdict::Allowed(_) | Verdict::Denied(_)) => {
            let token = bearer(h).unwrap_or_default().to_string();
            let dev = device(h);
            let c = &st.cfg;
            let _ = st
                .http
                .post(format!("{}/rest/v1/rpc/release_product_seat", c.supabase_url))
                .header("apikey", &c.supabase_anon_key)
                .bearer_auth(&token)
                .timeout(Duration::from_secs(8))
                .json(&json!({ "p_product": c.product, "p_device_id": dev }))
                .send()
                .await;
            st.auth.0.lock().unwrap_or_else(|p| p.into_inner()).remove(&format!("{dev}|{token}"));
            Some(Json(Value::Null).into_response())
        }
        (_, Verdict::Allowed(_)) => None,
        (_, v) => Some(refuse(v)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_and_days() {
        assert_eq!(parse_iso("1970-01-02T00:00:00+00:00"), Some(86_400));
        assert_eq!(parse_iso("2026-11-04T10:00:00.123456+10:00"), parse_iso("2026-11-04T00:00:00Z"));
        assert_eq!(parse_iso("2000-03-01T00:00:00Z"), Some(951_868_800));
        assert!(days_left("2001-01-01T00:00:00Z") == Some(0));
    }

    #[test]
    fn hs256() {
        let secret = "super-secret-jwt-token-with-at-least-32-characters";
        let head = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
        let body = URL_SAFE_NO_PAD.encode(format!(r#"{{"sub":"u1","exp":{}}}"#, now_secs() + 600));
        let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret.as_bytes());
        let sig = URL_SAFE_NO_PAD.encode(ring::hmac::sign(&key, format!("{head}.{body}").as_bytes()).as_ref());
        assert!(jwt_ok(&format!("{head}.{body}.{sig}"), secret));
        assert!(!jwt_ok(&format!("{head}.{body}.{sig}"), "another-secret"));
        let none = URL_SAFE_NO_PAD.encode(br#"{"alg":"none"}"#);
        assert!(!jwt_ok(&format!("{none}.{body}."), secret));
        let old = URL_SAFE_NO_PAD.encode(br#"{"sub":"u1","exp":1000}"#);
        let sig2 = URL_SAFE_NO_PAD.encode(ring::hmac::sign(&key, format!("{head}.{old}").as_bytes()).as_ref());
        assert!(!jwt_ok(&format!("{head}.{old}.{sig2}"), secret));
    }
}
