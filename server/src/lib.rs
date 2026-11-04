//! AI Town Planner web server: the desktop app's Rust core (data, rules, council, dev) behind
//! `POST /api/<command>`, plus the built frontend as static files. Read-only data pack on a volume.

// The core is compiled straight from the desktop crate, so both apps run the same code.
#[allow(dead_code)]
#[path = "../../src-tauri/src/council.rs"]
mod council;
#[allow(dead_code)]
#[path = "../../src-tauri/src/data.rs"]
mod data;
#[allow(dead_code)]
#[path = "../../src-tauri/src/dev.rs"]
mod dev;
#[allow(dead_code)]
#[path = "../../src-tauri/src/rules.rs"]
mod rules;

mod ai;
mod api;
pub mod pack;

use axum::extract::{ConnectInfo, DefaultBodyLimit, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};

/// Where log lines go (stderr in production; tests capture them). Lines never contain headers or bodies.
pub type LogSink = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone)]
pub struct Config {
    pub data_dir: PathBuf,
    pub dist_dir: PathBuf,
    /// Guards `POST /admin/refresh`; the endpoint is off when unset.
    pub admin_token: Option<String>,
    pub releases_url: String,
    pub anthropic_url: String,
    pub openai_url: String,
    pub google_url: String,
    /// Requests per minute per IP for the API, and for the AI/Google calls within it.
    pub rate_per_min: u32,
    pub ai_rate_per_min: u32,
    /// Extra allowed Origins (besides the site's own host), e.g. a dev server.
    pub extra_origins: Vec<String>,
}

impl Config {
    pub fn from_env() -> Self {
        let env = |k: &str, d: &str| std::env::var(k).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| d.to_string());
        Config {
            data_dir: env("DATA_DIR", "/data").into(),
            dist_dir: env("DIST_DIR", "dist").into(),
            admin_token: std::env::var("ADMIN_TOKEN").ok().filter(|t| t.len() >= 16),
            releases_url: env("RELEASES_URL", "https://api.github.com/repos/falahjoon-prog/ai-town-planner/releases?per_page=100"),
            anthropic_url: env("ANTHROPIC_URL", "https://api.anthropic.com/v1/messages"),
            openai_url: env("OPENAI_URL", "https://api.openai.com/v1/chat/completions"),
            google_url: env("GOOGLE_PLACES_URL", "https://places.googleapis.com/v1"),
            rate_per_min: env("RATE_PER_MIN", "120").parse().unwrap_or(120),
            ai_rate_per_min: env("AI_RATE_PER_MIN", "20").parse().unwrap_or(20),
            extra_origins: env("EXTRA_ORIGINS", "").split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
        }
    }
}

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub pack: Arc<pack::Pack>,
    pub http: reqwest::Client,
    pub log: LogSink,
    limiter: Arc<Mutex<HashMap<String, (Instant, u32)>>>,
}

impl AppState {
    pub fn new(cfg: Config, log: LogSink) -> Self {
        let pack = Arc::new(pack::Pack::new(&cfg.data_dir));
        let http = reqwest::Client::builder()
            .user_agent("ai-town-planner-web")
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(90))
            .build()
            .expect("http client");
        AppState { cfg: Arc::new(cfg), pack, http, log, limiter: Arc::new(Mutex::new(HashMap::new())) }
    }

    /// Fixed one-minute window per key. Returns false when the limit is exceeded.
    fn allow(&self, key: String, limit: u32) -> bool {
        let mut m = self.limiter.lock().unwrap_or_else(|p| p.into_inner());
        let now = Instant::now();
        if m.len() > 20_000 {
            m.retain(|_, (t, _)| now.duration_since(*t) < Duration::from_secs(60));
        }
        let slot = m.entry(key).or_insert((now, 0));
        if now.duration_since(slot.0) >= Duration::from_secs(60) {
            *slot = (now, 0);
        }
        slot.1 += 1;
        slot.1 <= limit
    }
}

pub fn app(st: AppState) -> Router {
    let dist = st.cfg.dist_dir.clone();
    let spa = ServeDir::new(&dist).fallback(ServeFile::new(dist.join("index.html")));
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/api/{cmd}", post(api::handle))
        .route("/admin/refresh", post(pack::admin_refresh))
        .layer(DefaultBodyLimit::max(1 << 20))
        .fallback_service(spa)
        .layer(middleware::from_fn_with_state(st.clone(), guard))
        .layer(CompressionLayer::new())
        .with_state(st)
}

pub(crate) fn err(code: StatusCode, msg: impl Into<String>) -> Response {
    (code, Json(json!({ "error": msg.into() }))).into_response()
}

/// Client IP: the hosting proxy's X-Forwarded-For first, then the socket peer.
fn client_ip(req: &Request) -> String {
    let h = req.headers();
    if let Some(ip) = h.get("x-forwarded-for").and_then(|v| v.to_str().ok()).and_then(|v| v.split(',').next()) {
        return ip.trim().to_string();
    }
    req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip().to_string()).unwrap_or_else(|| "local".into())
}

/// Same-origin only: a browser `Origin` must name this site's host (or an EXTRA_ORIGINS entry).
fn origin_ok(h: &HeaderMap, extra: &[String]) -> bool {
    let Some(origin) = h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else { return true };
    if extra.iter().any(|o| o == origin) {
        return true;
    }
    let host = h.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
    let o_host = origin.split("://").nth(1).unwrap_or("");
    !host.is_empty() && o_host.eq_ignore_ascii_case(host)
}

/// Logging (method, path, status, time — never headers, keys or bodies), origin check,
/// per-IP rate limit, security and cache headers.
async fn guard(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let start = Instant::now();
    let path = req.uri().path().to_string();
    let method = req.method().clone();
    let is_api = path.starts_with("/api/") || path.starts_with("/admin/");
    let mut res = if is_api && !origin_ok(req.headers(), &st.cfg.extra_origins) {
        err(StatusCode::FORBIDDEN, "Cross-origin requests are not allowed.")
    } else if is_api && !st.allow(client_ip(&req), st.cfg.rate_per_min) {
        err(StatusCode::TOO_MANY_REQUESTS, "Too many requests. Wait a minute and try again.")
    } else if is_api && api::is_metered(&path) && !st.allow(format!("ai:{}", client_ip(&req)), st.cfg.ai_rate_per_min) {
        err(StatusCode::TOO_MANY_REQUESTS, "Too many AI requests. Wait a minute and try again.")
    } else {
        next.run(req).await
    };
    let ok_status = res.status().is_success();
    let h = res.headers_mut();
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    h.insert("x-frame-options", HeaderValue::from_static("DENY"));
    h.insert("referrer-policy", HeaderValue::from_static("strict-origin-when-cross-origin"));
    let cache = if is_api || path == "/healthz" {
        "no-store"
    } else if path.starts_with("/assets/") && ok_status {
        "public, max-age=31536000, immutable" // Vite hashed file names
    } else {
        "no-cache" // index.html, manifest, service worker: always revalidate
    };
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    (st.log)(&format!("{method} {path} {} {}ms", res.status().as_u16(), start.elapsed().as_millis()));
    res
}
