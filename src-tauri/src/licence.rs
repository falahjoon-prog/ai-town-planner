//! Trade AI sign-in and the `townplanner` licence on the desktop (licensing/README.md).
//! Same accounts as ElectricalAI / PaintingAI / TilingAI (Supabase e-mail + password). The project URL and
//! public anon key are written in at build time (repository variables); a copy without them stays locked.
//! Only the refresh token and a small licence summary are kept, in the OS credential store; the access
//! token lives in memory. Tokens and passwords are never logged or shown.
use crate::licwords::{days_left, message, now_secs, parse_iso};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

const URL: Option<&str> = option_env!("TRADEAI_SUPABASE_URL");
const ANON: Option<&str> = option_env!("TRADEAI_SUPABASE_ANON_KEY");
const PRODUCT: &str = "townplanner";
const SERVICE: &str = "ai-town-planner-account";
/// No internet: someone checked online within this many days keeps working (ElectricalAI's OFFLINE_GRACE_DAYS).
const OFFLINE_GRACE_DAYS: u64 = 7;
const APP: &str = concat!("townplanner ", env!("CARGO_PKG_VERSION"));

/// Set after a successful check; the data commands refuse to run without it.
static LICENSED: AtomicBool = AtomicBool::new(false);
/// The access token and its expiry (memory only).
static ACCESS: Mutex<Option<(String, u64)>> = Mutex::new(None);

#[derive(Serialize, Default)]
pub struct LicenceState {
    pub configured: bool,
    pub signed_in: bool,
    pub ok: bool,
    /// trial | licensed | expired | no_seat | disabled | signed_out | offline | not_configured
    pub state: String,
    pub email: String,
    pub plan: String,
    pub days_left: Option<i64>,
    pub message: String,
    pub offline: bool,
}

fn base() -> Option<(&'static str, &'static str)> {
    let (u, k) = (URL?.trim().trim_end_matches('/'), ANON?.trim());
    (u.starts_with("https://") && !k.is_empty()).then_some((u, k))
}

pub fn require() -> Result<(), String> {
    if LICENSED.load(Ordering::SeqCst) {
        Ok(())
    } else {
        Err("Sign in with your Trade AI account to use AI Town Planner.".into())
    }
}

// ---------------------------------------------------------------- credential store
fn kr_get(name: &str) -> Option<String> {
    keyring::Entry::new(SERVICE, name).ok()?.get_password().ok().filter(|v| !v.is_empty())
}
fn kr_set(name: &str, v: &str) {
    if let Ok(en) = keyring::Entry::new(SERVICE, name) {
        let _ = if v.is_empty() { en.delete_credential() } else { en.set_password(v) };
    }
}
/// Licence summary kept for working offline: {email, online_at, valid_until, state, plan}.
fn cached() -> Value {
    kr_get("licence").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null)
}

/// A random id for this computer, made once and kept in the app data folder.
pub fn device_id(dir: &Path) -> String {
    let f = dir.join("device.id");
    if let Ok(s) = std::fs::read_to_string(&f) {
        let s = s.trim().to_string();
        if s.starts_with("atp-") && s.len() > 10 {
            return s;
        }
    }
    use std::hash::{BuildHasher, Hasher};
    let mut a = std::collections::hash_map::RandomState::new().build_hasher();
    a.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    a.write_u32(std::process::id());
    let b = std::collections::hash_map::RandomState::new().build_hasher().finish();
    let id = format!("atp-{:016x}{:016x}", a.finish(), b);
    let _ = std::fs::write(&f, &id);
    id
}

fn device_name() -> String {
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "This computer".into()).chars().take(120).collect()
}

// ---------------------------------------------------------------- Supabase calls
enum Fail {
    Offline,
    Http(u16, Value),
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .user_agent(concat!("ai-town-planner/", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_default()
}

async fn call(path: &str, body: Value, token: Option<&str>) -> Result<Value, Fail> {
    let (url, key) = base().ok_or(Fail::Offline)?;
    let r = client()
        .post(format!("{url}{path}"))
        .header("apikey", key)
        .bearer_auth(token.unwrap_or(key))
        .json(&body)
        .send()
        .await
        .map_err(|_| Fail::Offline)?;
    let status = r.status().as_u16();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    if (200..300).contains(&status) {
        Ok(v)
    } else {
        Err(Fail::Http(status, v))
    }
}

/// The words for a failed sign-in call (same wording as the other Trade AI apps).
fn friendly(f: Fail) -> String {
    let (status, v) = match f {
        Fail::Offline => return "Can't reach the Trade AI sign-in service. Check your internet connection and try again.".into(),
        Fail::Http(s, v) => (s, v),
    };
    let code = v["error_code"].as_str().or(v["error"].as_str()).or(v["code"].as_str()).unwrap_or("");
    let msg = v["msg"].as_str().or(v["message"].as_str()).or(v["error_description"].as_str()).unwrap_or("");
    match code {
        "invalid_credentials" | "invalid_grant" => "That e-mail and password don't match. Check them, or use 'Forgot password?'.".into(),
        "email_not_confirmed" => "Please confirm your e-mail first - open the link we sent you, then sign in.".into(),
        "user_already_exists" | "email_exists" => "There's already an account with this e-mail. Sign in instead.".into(),
        "weak_password" => "Please choose a stronger password (at least 8 characters).".into(),
        "over_email_send_rate_limit" => "We've just sent you an e-mail. Please wait a minute before asking again.".into(),
        "user_banned" => "This account has been disabled. Contact Trade AI at trade-ai.com.au.".into(),
        _ if status == 429 => "Too many tries. Please wait a minute and try again.".into(),
        _ if msg.contains("Invalid login credentials") => "That e-mail and password don't match. Check them, or use 'Forgot password?'.".into(),
        _ if status == 401 || status == 403 => "Your sign-in has expired. Please sign in again.".into(),
        _ if !msg.is_empty() && msg.len() < 200 => msg.into(),
        _ => format!("The Trade AI sign-in service answered with an error ({status}). Please try again."),
    }
}

/// Keeps a new session: refresh token in the credential store, access token in memory.
fn keep(resp: &Value) -> Result<String, String> {
    let token = resp["access_token"].as_str().ok_or("The sign-in didn't return a session. Please try again.")?;
    let exp = resp["expires_at"].as_u64().unwrap_or_else(|| now_secs() + resp["expires_in"].as_u64().unwrap_or(3600));
    if let Some(r) = resp["refresh_token"].as_str() {
        kr_set("session", r);
    }
    *ACCESS.lock().unwrap_or_else(|p| p.into_inner()) = Some((token.to_string(), exp));
    Ok(resp["user"]["email"].as_str().unwrap_or("").to_string())
}

/// A current access token, refreshed when needed. Err(true) = offline, Err(false) = signed out.
async fn access() -> Result<String, bool> {
    if let Some((t, exp)) = ACCESS.lock().unwrap_or_else(|p| p.into_inner()).clone() {
        if exp > now_secs() + 60 {
            return Ok(t);
        }
    }
    let Some(rt) = kr_get("session") else { return Err(false) };
    match call("/auth/v1/token?grant_type=refresh_token", json!({ "refresh_token": rt }), None).await {
        Ok(v) => keep(&v).map(|_| ACCESS.lock().unwrap_or_else(|p| p.into_inner()).clone().map(|a| a.0).unwrap_or_default()).map_err(|_| false),
        Err(Fail::Offline) => Err(true),
        Err(Fail::Http(s, _)) if s >= 500 => Err(true),
        Err(_) => {
            forget();
            Err(false)
        }
    }
}

fn forget() {
    kr_set("session", "");
    kr_set("licence", "");
    *ACCESS.lock().unwrap_or_else(|p| p.into_inner()) = None;
    LICENSED.store(false, Ordering::SeqCst);
}

fn signed_out(msg: &str) -> LicenceState {
    LICENSED.store(false, Ordering::SeqCst);
    LicenceState { configured: true, state: "signed_out".into(), message: msg.into(), ..Default::default() }
}

/// Offline: the saved summary decides (checked online within 7 days, and its end date not passed).
fn offline_state() -> LicenceState {
    let c = cached();
    let now = now_secs();
    let fresh = c["online_at"].as_u64().is_some_and(|t| now.saturating_sub(t) <= OFFLINE_GRACE_DAYS * 86_400);
    let valid = c["valid_until"].as_u64().is_some_and(|t| t > now);
    let ok = fresh && valid && matches!(c["state"].as_str(), Some("trial" | "licensed"));
    LICENSED.store(ok, Ordering::SeqCst);
    let lic = json!({ "state": c["state"], "plan": c["plan"], "seats": 1, "expires_at": c["expires_iso"] });
    LicenceState {
        configured: true,
        signed_in: c.is_object(),
        ok,
        state: if ok { c["state"].as_str().unwrap_or("").to_string() } else { "offline".into() },
        email: c["email"].as_str().unwrap_or("").into(),
        plan: c["plan"].as_str().unwrap_or("").into(),
        days_left: c["expires_iso"].as_str().and_then(days_left),
        message: if ok {
            format!("{} (offline)", message(&lic))
        } else {
            "Can't reach the Trade AI sign-in service. Connect to the internet to check your licence (you can work offline for up to 7 days after a check).".into()
        },
        offline: true,
    }
}

/// Signed in? Trial or seat? Called on start, after sign-in and every few minutes (keeps the seat).
pub async fn state(dir: &Path) -> LicenceState {
    if base().is_none() {
        LICENSED.store(false, Ordering::SeqCst);
        return LicenceState {
            state: "not_configured".into(),
            message: "Sign-in is not set up in this copy yet. Please download the latest AI Town Planner from trade-ai.com.au.".into(),
            ..Default::default()
        };
    }
    let token = match access().await {
        Ok(t) => t,
        Err(true) => return offline_state(),
        Err(false) => return signed_out(""),
    };
    let args = json!({ "p_product": PRODUCT, "p_device_id": device_id(dir), "p_device_name": device_name(), "p_app_version": APP });
    let lic = match call("/rest/v1/rpc/product_access", args, Some(&token)).await {
        Ok(v) if v.is_object() => v,
        Err(Fail::Offline) => return offline_state(),
        Err(Fail::Http(401 | 403, _)) => {
            forget();
            return signed_out("Your sign-in has expired. Please sign in again.");
        }
        Err(Fail::Http(s, v)) => {
            LICENSED.store(false, Ordering::SeqCst);
            let missing = s == 404 || v["message"].as_str().is_some_and(|m| m.contains("product_access"));
            return LicenceState {
                configured: true,
                signed_in: true,
                state: "error".into(),
                email: cached()["email"].as_str().unwrap_or("").into(),
                message: if missing { "Licensing is not set up in the Trade AI database yet. Please contact Trade AI.".into() } else { friendly(Fail::Http(s, v)) },
                ..Default::default()
            };
        }
        Ok(_) => return offline_state(),
    };
    let ok = lic["ok"] == true;
    LICENSED.store(ok, Ordering::SeqCst);
    let mut c = cached();
    if !c.is_object() {
        c = json!({});
    }
    c["online_at"] = json!(now_secs());
    c["state"] = lic["state"].clone();
    c["plan"] = lic["plan"].clone();
    c["expires_iso"] = lic["expires_at"].clone();
    c["valid_until"] = json!(lic["expires_at"].as_str().and_then(parse_iso).unwrap_or(0));
    kr_set("licence", &c.to_string());
    LicenceState {
        configured: true,
        signed_in: true,
        ok,
        state: lic["state"].as_str().unwrap_or("").into(),
        email: c["email"].as_str().unwrap_or("").into(),
        plan: lic["plan"].as_str().unwrap_or("").into(),
        days_left: lic["expires_at"].as_str().and_then(days_left),
        message: message(&lic),
        offline: false,
    }
}

fn remember_email(email: &str) {
    let mut c = cached();
    if !c.is_object() {
        c = json!({});
    }
    c["email"] = json!(email);
    kr_set("licence", &c.to_string());
}

pub async fn sign_in(dir: &Path, email: &str, password: &str) -> Result<LicenceState, String> {
    base().ok_or("Sign-in is not set up in this copy yet.")?;
    let email = email.trim().to_lowercase();
    let v = call("/auth/v1/token?grant_type=password", json!({ "email": email, "password": password }), None).await.map_err(friendly)?;
    forget();
    let got = keep(&v)?;
    remember_email(if got.is_empty() { &email } else { &got });
    let token = ACCESS.lock().unwrap_or_else(|p| p.into_inner()).clone().map(|a| a.0).unwrap_or_default();
    let ev = json!({ "p_event": "sign_in", "p_provider": "email", "p_device_id": device_id(dir), "p_device_name": device_name(), "p_os": std::env::consts::OS, "p_app_version": APP });
    let _ = call("/rest/v1/rpc/log_login_event", ev, Some(&token)).await; // the shared login log, if present
    Ok(state(dir).await)
}

/// New Trade AI account. Ok(None) = check your e-mail to confirm; Ok(Some) = signed in straight away.
pub async fn sign_up(dir: &Path, email: &str, password: &str, full_name: &str) -> Result<Option<LicenceState>, String> {
    base().ok_or("Sign-in is not set up in this copy yet.")?;
    let email = email.trim().to_lowercase();
    let body = json!({ "email": email, "password": password, "data": { "full_name": full_name.trim() } });
    let v = call("/auth/v1/signup", body, None).await.map_err(friendly)?;
    if v["access_token"].is_string() {
        forget();
        keep(&v)?;
        remember_email(&email);
        return Ok(Some(state(dir).await));
    }
    let user = if v["user"].is_object() { &v["user"] } else { &v };
    if user["identities"].as_array().is_some_and(|a| a.is_empty()) {
        return Err("There's already an account with this e-mail. Sign in instead.".into());
    }
    Ok(None)
}

pub async fn reset(email: &str) -> Result<(), String> {
    base().ok_or("Sign-in is not set up in this copy yet.")?;
    call("/auth/v1/recover", json!({ "email": email.trim().to_lowercase() }), None).await.map(|_| ()).map_err(friendly)
}

pub async fn sign_out(dir: &Path) {
    if let Ok(t) = access().await {
        let _ = call("/rest/v1/rpc/release_product_seat", json!({ "p_product": PRODUCT, "p_device_id": device_id(dir) }), Some(&t)).await;
        let _ = call("/auth/v1/logout", json!({}), Some(&t)).await;
    }
    forget();
}
