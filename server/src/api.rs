//! `POST /api/<command>`: same JSON arguments (camelCase, as `invoke` sends them; snake_case also
//! accepted) and same JSON result as the desktop Tauri commands. Errors: `{"error": "..."}` with a 4xx/5xx.
//! Streaming commands (chat, assistant) answer with Server-Sent Events: `data: "<token>"` lines,
//! then `event: done`; a failure mid-stream is `event: error` with `data: "<message>"`.
use crate::{ai, data, dev, err, rules, AppState};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::StreamExt;
use rusqlite::Connection;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::convert::Infallible;
use std::time::Duration;

/// Desktop commands that make no sense on a phone web app (local files, models, OS keychain, local AI).
const DESKTOP_ONLY: &[&str] = &[
    "import_datapack", "download_datapack", "import_model", "download_model", "set_model", "delete_model",
    "save_bytes", "save_text", "read_backup", "read_text_file", "open_external", "generate_report", "draft_form",
    "summarise_title", "save_ai_settings", "set_api_key", "ollama_models",
];

/// Commands that call a paid third-party API with the user's key: rate limited more tightly.
pub fn is_metered(path: &str) -> bool {
    ["/api/chat", "/api/assistant", "/api/google_suggest", "/api/google_pick"].contains(&path)
}

#[derive(Deserialize)]
struct Q {
    q: String,
}
#[derive(Deserialize)]
struct Pid {
    pid: i64,
}
#[derive(Deserialize)]
struct PotArgs {
    pid: i64,
    #[serde(rename = "useId", alias = "use_id")]
    use_id: String,
}
#[derive(Deserialize)]
struct Suburb {
    suburb: String,
}
#[derive(Deserialize)]
struct Place {
    #[serde(rename = "placeId", alias = "place_id")]
    place_id: String,
}
#[derive(Deserialize)]
struct Devi {
    host: String,
    term: String,
}
#[derive(Deserialize)]
struct ChatIn {
    role: String,
    content: String,
}
#[derive(Deserialize)]
struct ChatArgs {
    pid: i64,
    #[serde(default)]
    report: String,
    history: Vec<ChatIn>,
}
#[derive(Deserialize)]
struct AssistantArgs {
    #[serde(default)]
    pid: Option<i64>,
    history: Vec<ChatIn>,
}

fn args<T: DeserializeOwned>(v: Value) -> Result<T, Response> {
    serde_json::from_value(v).map_err(|x| err(StatusCode::BAD_REQUEST, format!("Invalid arguments: {x}")))
}

fn ok<T: Serialize>(r: Result<T, Response>) -> Response {
    match r {
        Ok(v) => Json(v).into_response(),
        Err(r) => r,
    }
}

/// Runs a read on its own read-only connection (requests never wait on each other), on a blocking
/// thread. A panic becomes an error; after 20 s the query is interrupted.
async fn db<T: Send + 'static>(st: &AppState, f: impl FnOnce(&Connection) -> Result<T, String> + Send + 'static) -> Result<T, Response> {
    let path = st.pack.ready_path().map_err(|m| err(StatusCode::SERVICE_UNAVAILABLE, m))?;
    let c = data::open(&path).map_err(|m| err(StatusCode::SERVICE_UNAVAILABLE, m))?;
    let stop = c.get_interrupt_handle();
    let job = tokio::task::spawn_blocking(move || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&c))).unwrap_or_else(|p| {
            let msg = p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned());
            Err(format!("Internal error: {}", msg.unwrap_or_else(|| "unexpected failure".into())))
        })
    });
    match tokio::time::timeout(Duration::from_secs(20), job).await {
        Ok(Ok(r)) => r.map_err(|m| err(StatusCode::BAD_REQUEST, m)),
        Ok(Err(x)) => Err(err(StatusCode::INTERNAL_SERVER_ERROR, x.to_string())),
        Err(_) => {
            stop.interrupt();
            Err(err(StatusCode::GATEWAY_TIMEOUT, "Timed out after 20 seconds reading the data pack. Try again."))
        }
    }
}

fn assessment(c: &Connection, pid: i64) -> Result<rules::Assessment, String> {
    let p = data::parcel(c, pid)?;
    let o = data::overlays(c, &p)?;
    Ok(rules::assess(p, o, data::manifest(c)?))
}

pub async fn handle(State(st): State<AppState>, Path(cmd): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let v: Value = if body.iter().all(|b| b.is_ascii_whitespace()) {
        json!({})
    } else {
        match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(_) => return err(StatusCode::BAD_REQUEST, "Request body must be JSON."),
        }
    };
    // Trade AI sign-in: every command needs a signed-in person with a trial or licence seat.
    if let Some(r) = crate::auth::route(&st, &cmd, &headers).await {
        return r;
    }
    match cmd.as_str() {
        "status" => Json(status(&st).await).into_response(),
        "search" => ok(async {
            let a: Q = args(v)?;
            db(&st, move |c| data::search(c, &a.q)).await
        }
        .await),
        "assess" => ok(async {
            let a: Pid = args(v)?;
            db(&st, move |c| assessment(c, a.pid)).await
        }
        .await),
        "potential" => ok(async {
            let a: PotArgs = args(v)?;
            db(&st, move |c| dev::potential(c, &assessment(c, a.pid)?, &a.use_id)).await
        }
        .await),
        "suburb_stats" => ok(async {
            let a: Suburb = args(v)?;
            db(&st, move |c| data::suburb_stats(c, &a.suburb)).await
        }
        .await),
        "flood_map" => ok(async {
            let a: Pid = args(v)?;
            db(&st, move |c| data::flood_map(c, &data::parcel(c, a.pid)?, 400.0)).await
        }
        .await),
        "infra_map" => ok(async {
            let a: Pid = args(v)?;
            db(&st, move |c| {
                let p = data::parcel(c, a.pid)?;
                let pg = data::to_geo(&p.geom.to_string())?;
                let rect = geo::BoundingRect::bounding_rect(&pg).ok_or("Empty lot")?;
                let pr = data::Proj::new(rect.center().y);
                dev::infra(c, &pg, &pr, 5_000.0, 5_000.0).map(|(_, f)| f)
            })
            .await
        }
        .await),
        "contours" => ok(contours(&st, v).await),
        "devi_land_number" => ok(async {
            let a: Devi = args(v)?;
            Ok(devi_land_number(&st, &a.host, &a.term).await)
        }
        .await),
        "google_suggest" => ok(google_suggest(&st, &headers, v).await),
        "google_pick" => ok(google_pick(&st, &headers, v).await),
        "chat" | "assistant" => stream_chat(&st, &cmd, &headers, v).await,
        "cancel_report" => Json(Value::Null).into_response(), // on the web, aborting the fetch cancels
        c if DESKTOP_ONLY.contains(&c) => err(StatusCode::NOT_FOUND, format!("'{c}' is only available in the desktop app.")),
        _ => err(StatusCode::NOT_FOUND, "Unknown command."),
    }
}

async fn status(st: &AppState) -> Value {
    let pack = st.pack.status();
    let datapack = if pack.state == "ready" { db(st, |c| data::manifest(c)).await.ok() } else { None };
    json!({
        "datapack": datapack,
        "models": [],
        "custom_models": [],
        "active_model": null,
        "ai": {
            "provider": "anthropic", "model": null, "ollama_url": "", "ollama_model": "",
            "anthropic_model": "claude-sonnet-5-5", "openai_base": "https://api.openai.com/v1", "openai_model": ""
        },
        "has_anthropic_key": false,
        "has_openai_key": false,
        "has_google_key": false,
        "disclaimer": rules::DISCLAIMER,
        "web": true,
        "flags": { "web": true, "ai_providers": ["anthropic", "openai"] },
        "pack": pack,
    })
}

/// Contours need the State service; results are cached per lot on the volume.
async fn contours(st: &AppState, v: Value) -> Result<Value, Response> {
    let a: Pid = args(v)?;
    let cache = st.pack.contours_dir().join(format!("{}.json", a.pid));
    if let Some(v) = std::fs::read_to_string(&cache).ok().and_then(|s| serde_json::from_str(&s).ok()) {
        return Ok(v);
    }
    let pid = a.pid;
    let p = db(st, move |c| data::parcel(c, pid)).await?;
    let v = dev::contours(&p).await.map_err(|m| err(StatusCode::BAD_GATEWAY, m))?;
    let _ = std::fs::write(&cache, v.to_string());
    Ok(v)
}

/// Development.i land number (same as the desktop command: three hosts only).
async fn devi_land_number(st: &AppState, host: &str, term: &str) -> Option<String> {
    const HOSTS: [&str; 3] = ["developmenti.brisbane.qld.gov.au", "developmenti.redland.qld.gov.au", "developmenti.ipswich.qld.gov.au"];
    if !HOSTS.contains(&host) || term.trim().is_empty() || term.len() > 200 {
        return None;
    }
    let v: Value = st
        .http
        .get(format!("https://{host}/Geo/AddressCompoundSearch"))
        .query(&[("searchTerm", term.trim())])
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let is_lotplan = !term.contains(' ') && term.chars().any(|c| c.is_ascii_digit());
    let id = if is_lotplan { &v["LotPlan"][0]["id"] } else { &v["Address"][0]["id"] };
    match id {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Google Places needs the user's own key in `X-Google-Key` (the server has none).
fn google_key(h: &HeaderMap) -> Result<String, Response> {
    h.get("x-google-key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| s.len() >= 8 && s.len() <= 200 && s.chars().all(|c| c.is_ascii_graphic()))
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "Google address search needs your own Google API key in Settings. The built-in search works without it."))
}

async fn google_suggest(st: &AppState, h: &HeaderMap, v: Value) -> Result<Value, Response> {
    let key = google_key(h)?;
    let a: Q = args(v)?;
    let body = json!({
        "input": a.q,
        "includedRegionCodes": ["au"],
        "includedPrimaryTypes": ["street_address", "premise", "subpremise"],
        "locationBias": {"circle": {"center": {"latitude": -27.47, "longitude": 153.03}, "radius": 50000.0}}
    });
    let r: Value = st
        .http
        .post(format!("{}/places:autocomplete", st.cfg.google_url))
        .header("X-Goog-Api-Key", key)
        .json(&body)
        .send()
        .await
        .map_err(|_| err(StatusCode::BAD_GATEWAY, "Could not reach Google."))?
        .json()
        .await
        .map_err(|x| err(StatusCode::BAD_GATEWAY, x.to_string()))?;
    if let Some(m) = r["error"]["message"].as_str() {
        return Err(err(StatusCode::BAD_REQUEST, format!("Google: {m}")));
    }
    let list: Vec<Value> = r["suggestions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| {
            let p = &s["placePrediction"];
            Some(json!({"place_id": p["placeId"].as_str()?, "text": p["text"]["text"].as_str()?}))
        })
        .collect();
    Ok(Value::Array(list))
}

async fn google_pick(st: &AppState, h: &HeaderMap, v: Value) -> Result<data::ParcelHit, Response> {
    let key = google_key(h)?;
    let a: Place = args(v)?;
    if a.place_id.is_empty() || !a.place_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(err(StatusCode::BAD_REQUEST, "Invalid place id."));
    }
    let r: Value = st
        .http
        .get(format!("{}/places/{}", st.cfg.google_url, a.place_id))
        .header("X-Goog-Api-Key", key)
        .header("X-Goog-FieldMask", "location")
        .send()
        .await
        .map_err(|_| err(StatusCode::BAD_GATEWAY, "Could not reach Google."))?
        .json()
        .await
        .map_err(|x| err(StatusCode::BAD_GATEWAY, x.to_string()))?;
    let (Some(lat), Some(lng)) = (r["location"]["latitude"].as_f64(), r["location"]["longitude"].as_f64()) else {
        return Err(err(StatusCode::BAD_REQUEST, "Google could not locate that address."));
    };
    db(st, move |c| data::parcel_at(c, lng, lat))
        .await?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "That address is not inside the data pack."))
}

async fn stream_chat(st: &AppState, cmd: &str, h: &HeaderMap, v: Value) -> Response {
    let req = match ai::from_headers(h) {
        Ok(r) => r,
        Err(m) => return err(StatusCode::BAD_REQUEST, m),
    };
    let msgs = if cmd == "chat" {
        let a: ChatArgs = match args(v) {
            Ok(a) => a,
            Err(r) => return r,
        };
        let hist: Vec<rules::ChatMsg> = a.history.into_iter().map(|m| rules::ChatMsg { role: m.role, content: m.content }).collect();
        let report = a.report;
        match db(st, move |c| Ok(rules::chat_messages(&assessment(c, a.pid)?, &report, &hist))).await {
            Ok(m) => m,
            Err(r) => return r,
        }
    } else {
        let a: AssistantArgs = match args(v) {
            Ok(a) => a,
            Err(r) => return r,
        };
        let hist: Vec<rules::ChatMsg> = a.history.into_iter().map(|m| rules::ChatMsg { role: m.role, content: m.content }).collect();
        match a.pid {
            Some(pid) => match db(st, move |c| Ok(rules::assistant_messages(Some(&assessment(c, pid)?), &hist))).await {
                Ok(m) => m,
                Err(r) => return r,
            },
            None => rules::assistant_messages(None, &hist),
        }
    };
    let rx = match ai::start(st, req, msgs, 512).await {
        Ok(rx) => rx,
        Err((code, m)) => return err(code, m),
    };
    let tokens = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|m| (m, rx)) }).map(|m| {
        Ok::<_, Infallible>(match m {
            Ok(t) => Event::default().data(Value::String(t).to_string()),
            Err(e) => Event::default().event("error").data(Value::String(e).to_string()),
        })
    });
    let end = futures_util::stream::once(async { Ok::<_, Infallible>(Event::default().event("done").data("{}")) });
    Sse::new(tokens.chain(end)).keep_alive(KeepAlive::default()).into_response()
}
