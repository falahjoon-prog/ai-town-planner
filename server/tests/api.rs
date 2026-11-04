//! API tests against a tiny data pack built with the pipeline's schema, and a mock AI service.
use atp_server::{app, AppState, Config};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

const KEY: &str = "sk-ant-TEST-SECRET-9f8e7d6c5b4a";

/// Data pack with the schema from pipeline/build_datapack.py: three lots in a low density residential zone.
fn make_pack(dir: &PathBuf) {
    std::fs::create_dir_all(dir).unwrap();
    let path = dir.join("datapack.sqlite");
    let _ = std::fs::remove_file(&path);
    let c = Connection::open(&path).unwrap();
    c.execute_batch(
        "CREATE TABLE manifest(key TEXT PRIMARY KEY, value TEXT);
         CREATE TABLE parcels(pid INTEGER PRIMARY KEY, lotplan TEXT, address TEXT, suburb TEXT,
             search TEXT, area REAL, props TEXT, geom TEXT, council TEXT);
         CREATE TABLE layers(lid INTEGER PRIMARY KEY, dataset_id TEXT UNIQUE, title TEXT, n INTEGER, authority TEXT, council TEXT);
         CREATE TABLE features(fid INTEGER PRIMARY KEY, lid INTEGER, props TEXT, geom TEXT);
         CREATE VIRTUAL TABLE feature_idx USING rtree(fid, minx, maxx, miny, maxy);
         CREATE VIRTUAL TABLE parcel_idx USING rtree(pid, minx, maxx, miny, maxy);
         INSERT INTO manifest VALUES('version', 'test');
         INSERT INTO layers VALUES(1, 'cp14-zoning-overlay', 'Zoning', 1, 'council', 'brisbane');",
    )
    .unwrap();
    let (x0, y0, dx, dy) = (153.05, -27.62, 0.0002, 0.0004); // about 20 m x 45 m
    for (pid, k, no) in [(1i64, 0.0, 28), (2, 1.0, 30), (3, 2.0, 32)] {
        let x = x0 + k * dx;
        let g = json!({"type": "Polygon", "coordinates": [[[x, y0], [x + dx, y0], [x + dx, y0 + dy], [x, y0 + dy], [x, y0]]]});
        let addr = format!("{no} EDEN ELM ST, CALAMVALE QLD 4116");
        c.execute(
            "INSERT INTO parcels VALUES(?1, ?2, ?3, 'CALAMVALE', ?4, 900, '{}', ?5, 'brisbane')",
            params![pid, format!("{pid}RP850593"), addr, format!("{addr} {pid}RP850593").to_uppercase(), g.to_string()],
        )
        .unwrap();
        c.execute("INSERT INTO parcel_idx VALUES(?1, ?2, ?3, ?4, ?5)", params![pid, x, x + dx, y0, y0 + dy]).unwrap();
    }
    let z = json!({"type": "Polygon", "coordinates": [[[x0 - 0.01, y0 - 0.01], [x0 + 0.01, y0 - 0.01], [x0 + 0.01, y0 + 0.01], [x0 - 0.01, y0 + 0.01], [x0 - 0.01, y0 - 0.01]]]});
    c.execute(
        "INSERT INTO features VALUES(1, 1, ?1, ?2)",
        params![json!({"zone_prec_desc": "LDR - Low density residential", "lvl2_zone": "Low density residential"}).to_string(), z.to_string()],
    )
    .unwrap();
    c.execute("INSERT INTO feature_idx VALUES(1, ?1, ?2, ?3, ?4)", params![x0 - 0.01, x0 + 0.01, y0 - 0.01, y0 + 0.01]).unwrap();
}

struct T {
    app: Router,
    logs: Arc<Mutex<Vec<String>>>,
}

fn setup(name: &str, with_pack: bool, ai_base: &str, rate: u32) -> T {
    setup_with(name, with_pack, ai_base, rate, "http://127.0.0.1:9/none")
}

fn setup_with(name: &str, with_pack: bool, ai_base: &str, rate: u32, releases: &str) -> T {
    let dir = std::env::temp_dir().join(format!("atp-server-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    if with_pack {
        make_pack(&dir);
    } else {
        std::fs::create_dir_all(&dir).unwrap();
    }
    let dist = dir.join("dist");
    std::fs::create_dir_all(dist.join("assets")).unwrap();
    std::fs::write(dist.join("index.html"), "<!doctype html><title>ATP</title>").unwrap();
    std::fs::write(dist.join("assets/app-abc123.js"), "console.log('hi')").unwrap();
    let cfg = Config {
        data_dir: dir.clone(),
        dist_dir: dist,
        admin_token: Some("admin-token-0123456789".into()),
        releases_url: releases.into(),
        anthropic_url: format!("{ai_base}/anthropic"),
        openai_url: format!("{ai_base}/openai"),
        google_url: format!("{ai_base}/google"),
        rate_per_min: rate,
        ai_rate_per_min: rate,
        extra_origins: vec![],
    };
    let logs = Arc::new(Mutex::new(Vec::new()));
    let l2 = logs.clone();
    let st = AppState::new(cfg, Arc::new(move |s: &str| l2.lock().unwrap().push(s.to_string())));
    T { app: app(st), logs }
}

async fn call(t: &T, req: Request<Body>) -> (StatusCode, Vec<u8>, axum::http::HeaderMap) {
    let res = t.app.clone().oneshot(req).await.unwrap();
    let (s, h) = (res.status(), res.headers().clone());
    (s, res.into_body().collect().await.unwrap().to_bytes().to_vec(), h)
}

fn post(cmd: &str, body: Value) -> Request<Body> {
    Request::post(format!("/api/{cmd}")).header("host", "ai-town-planner.fly.dev").header("content-type", "application/json").body(Body::from(body.to_string())).unwrap()
}

async fn json_call(t: &T, cmd: &str, body: Value) -> (StatusCode, Value) {
    let (s, b, _) = call(t, post(cmd, body)).await;
    (s, serde_json::from_slice(&b).unwrap_or(Value::Null))
}

/// Mock Claude/OpenAI service that records the API keys it receives.
async fn mock_ai() -> (String, Arc<Mutex<Vec<String>>>) {
    use axum::http::HeaderMap;
    use axum::routing::post;
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let (s1, s2) = (seen.clone(), seen.clone());
    let r = Router::new()
        .route(
            "/anthropic",
            post(move |h: HeaderMap| async move {
                let key = h.get("x-api-key").unwrap().to_str().unwrap().to_string();
                s1.lock().unwrap().push(key.clone());
                if key.contains("BAD") {
                    // A hostile upstream echoing the key must not leak it back.
                    return (StatusCode::UNAUTHORIZED, format!("{{\"error\":{{\"message\":\"invalid x-api-key {key}\"}}}}"));
                }
                (
                    StatusCode::OK,
                    "event: message_start\ndata: {\"type\":\"message_start\"}\n\n\
                     data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"Hello\"}}\n\n\
                     data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\" planner\"}}\n\n\
                     data: {\"type\":\"message_stop\"}\n\n"
                        .to_string(),
                )
            }),
        )
        .route(
            "/openai",
            post(move |h: HeaderMap| async move {
                s2.lock().unwrap().push(h.get("authorization").unwrap().to_str().unwrap().to_string());
                "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\" there\"}}]}\n\ndata: [DONE]\n\n"
            }),
        );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, r).await.unwrap() });
    (format!("http://{addr}"), seen)
}

#[tokio::test]
async fn health_status_and_search() {
    let t = setup("search", true, "http://127.0.0.1:9", 1000);
    let (s, b, _) = call(&t, Request::get("/healthz").body(Body::empty()).unwrap()).await;
    assert_eq!((s, b.as_slice()), (StatusCode::OK, b"ok".as_slice()));

    // status with an empty body, as `invoke("status")` sends no args
    let (s, b, _) = call(&t, Request::post("/api/status").body(Body::empty()).unwrap()).await;
    assert_eq!(s, StatusCode::OK);
    let v: Value = serde_json::from_slice(&b).unwrap();
    assert_eq!(v["web"], true);
    assert_eq!(v["flags"]["web"], true);
    assert_eq!(v["datapack"]["version"], "test");
    assert_eq!(v["models"], json!([]));
    assert_eq!(v["pack"]["state"], "ready");

    let (s, v) = json_call(&t, "search", json!({"q": "28 eden elm street"})).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v[0]["pid"], 1, "{v}");
    assert_eq!(v[0]["council"], "brisbane");
    let (_, v) = json_call(&t, "search", json!({"q": "eden elm calamvale"})).await;
    assert_eq!(v.as_array().unwrap().len(), 3);
    let (_, v) = json_call(&t, "search", json!({"q": "edenn elm"})).await; // typo corrected
    assert!(!v.as_array().unwrap().is_empty());

    let (s, v) = json_call(&t, "search", json!({"nope": 1})).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(v["error"].as_str().unwrap().contains("Invalid arguments"));
}

#[tokio::test]
async fn assess_potential_and_maps() {
    let t = setup("assess", true, "http://127.0.0.1:9", 1000);
    let (s, v) = json_call(&t, "assess", json!({"pid": 1})).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["parcel"]["pid"], 1);
    assert_eq!(v["parcel"]["lotplan"], "1RP850593");
    assert!(v["zones"][0]["zone"]["name"].as_str().unwrap().to_lowercase().contains("low density"), "{}", v["zones"]);
    assert!(v["council"]["name"].is_string());

    // camelCase (as invoke sends) and snake_case both accepted
    let (s, v) = json_call(&t, "potential", json!({"pid": 1, "useId": "dual"})).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert!(v["area_m2"].as_f64().unwrap() > 100.0);
    let (s, _) = json_call(&t, "potential", json!({"pid": 1, "use_id": "house"})).await;
    assert_eq!(s, StatusCode::OK);

    let (s, v) = json_call(&t, "flood_map", json!({"pid": 1})).await;
    assert_eq!((s, v.is_array()), (StatusCode::OK, true));
    let (s, v) = json_call(&t, "infra_map", json!({"pid": 1})).await;
    assert_eq!((s, v.is_array()), (StatusCode::OK, true));
    let (s, v) = json_call(&t, "suburb_stats", json!({"suburb": "Calamvale"})).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["lots"], 3);

    let (s, v) = json_call(&t, "assess", json!({"pid": 999})).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(v["error"].is_string());
}

#[tokio::test]
async fn desktop_only_and_unknown_are_404() {
    let t = setup("404", true, "http://127.0.0.1:9", 1000);
    for c in ["import_model", "download_model", "import_datapack", "save_text", "save_bytes", "generate_report", "draft_form", "open_external"] {
        let (s, v) = json_call(&t, c, json!({})).await;
        assert_eq!(s, StatusCode::NOT_FOUND, "{c}");
        assert!(v["error"].as_str().unwrap().contains("desktop"), "{c}");
    }
    let (s, _) = json_call(&t, "rm_rf", json!({})).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, v) = json_call(&t, "google_suggest", json!({"q": "1 george st"})).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(v["error"].as_str().unwrap().contains("Google"));
}

#[tokio::test]
async fn ai_streams_with_user_key_and_never_logs_it() {
    let (base, seen) = mock_ai().await;
    let t = setup("ai", true, &base, 1000);

    let req = Request::post("/api/assistant")
        .header("host", "ai-town-planner.fly.dev")
        .header("origin", "https://ai-town-planner.fly.dev")
        .header("x-ai-provider", "anthropic")
        .header("x-ai-key", KEY)
        .body(Body::from(json!({"pid": 1, "history": [{"role": "user", "content": "Can I build a duplex?"}]}).to_string()))
        .unwrap();
    let (s, b, h) = call(&t, req).await;
    let body = String::from_utf8(b).unwrap();
    assert_eq!(s, StatusCode::OK, "{body}");
    assert!(h["content-type"].to_str().unwrap().starts_with("text/event-stream"));
    assert!(body.contains("data: \"Hello\"") && body.contains("data: \" planner\""), "{body}");
    assert!(body.contains("event: done"));
    assert_eq!(seen.lock().unwrap().as_slice(), [KEY.to_string()], "key forwarded to the provider only");

    // chat (site report context) via OpenAI
    let req = Request::post("/api/chat")
        .header("x-ai-provider", "openai")
        .header("x-ai-key", KEY)
        .header("x-ai-model", "gpt-test")
        .body(Body::from(json!({"pid": 1, "report": "r", "history": [{"role": "user", "content": "hi"}]}).to_string()))
        .unwrap();
    let (s, b, _) = call(&t, req).await;
    let body = String::from_utf8(b).unwrap();
    assert_eq!(s, StatusCode::OK, "{body}");
    assert!(body.contains("data: \"Hi\"") && body.contains("data: \" there\""), "{body}");

    // a rejected key: clear error, and the key is not echoed back
    let bad = format!("{KEY}-BAD");
    let req = Request::post("/api/assistant")
        .header("x-ai-provider", "anthropic")
        .header("x-ai-key", &bad)
        .body(Body::from(json!({"pid": null, "history": [{"role": "user", "content": "hi"}]}).to_string()))
        .unwrap();
    let (s, b, _) = call(&t, req).await;
    let body = String::from_utf8(b).unwrap();
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert!(!body.contains("SECRET"), "{body}");

    // missing key
    let (s, _) = json_call(&t, "assistant", json!({"pid": null, "history": []})).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    let logs = t.logs.lock().unwrap().join("\n");
    assert!(logs.contains("POST /api/assistant 200"), "{logs}");
    assert!(!logs.contains("SECRET") && !logs.to_lowercase().contains("x-ai-key"), "key leaked into logs: {logs}");
}

#[tokio::test]
async fn security_limits_and_static() {
    let t = setup("sec", true, "http://127.0.0.1:9", 5);
    let req = Request::post("/api/search").header("host", "ai-town-planner.fly.dev").header("origin", "https://evil.example").body(Body::from("{\"q\":\"x\"}")).unwrap();
    assert_eq!(call(&t, req).await.0, StatusCode::FORBIDDEN);

    // admin refresh needs the token
    let req = Request::post("/admin/refresh").body(Body::empty()).unwrap();
    assert_eq!(call(&t, req).await.0, StatusCode::UNAUTHORIZED);

    let big = format!("{{\"q\":\"{}\"}}", "a".repeat(2 << 20));
    assert_eq!(call(&t, post("search", Value::Null).map(|_| Body::from(big))).await.0, StatusCode::PAYLOAD_TOO_LARGE);

    let mut last = StatusCode::OK;
    for _ in 0..8 {
        last = json_call(&t, "search", json!({"q": "eden"})).await.0;
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);

    // SPA fallback and cache headers
    let (s, b, h) = call(&t, Request::get("/site/123").body(Body::empty()).unwrap()).await;
    assert_eq!(s, StatusCode::OK);
    assert!(String::from_utf8(b).unwrap().contains("<title>ATP"));
    assert_eq!(h["cache-control"], "no-cache");
    let (s, _, h) = call(&t, Request::get("/assets/app-abc123.js").body(Body::empty()).unwrap()).await;
    assert_eq!(s, StatusCode::OK);
    assert!(h["cache-control"].to_str().unwrap().contains("immutable"));
    assert_eq!(h["x-content-type-options"], "nosniff");

}

#[tokio::test]
async fn no_pack_yet_is_503() {
    let t = setup("nopack", false, "http://127.0.0.1:9", 1000);
    let (s, v) = json_call(&t, "search", json!({"q": "eden"})).await;
    assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE);
    assert!(v["error"].as_str().unwrap().contains("data pack"));
    let (s, v) = json_call(&t, "status", json!({})).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["pack"]["state"], "missing");
    assert_eq!(v["datapack"], Value::Null);
}

/// First load and admin refresh: newest `datapack-*` release is picked, streamed, gunzipped and validated.
#[tokio::test]
async fn pack_download_and_refresh() {
    use axum::routing::get;
    use std::io::Write;
    let src = std::env::temp_dir().join(format!("atp-server-test-src-{}", std::process::id()));
    make_pack(&src);
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gz.write_all(&std::fs::read(src.join("datapack.sqlite")).unwrap()).unwrap();
    let gz = gz.finish().unwrap();
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    let rel = json!([
        {"tag_name": "testpack-x", "assets": [{"name": "datapack.sqlite.gz", "browser_download_url": format!("{base}/bad.gz")}]},
        {"tag_name": "datapack-20261021-0939", "assets": [{"name": "datapack.sqlite.gz", "browser_download_url": format!("{base}/bad.gz")}]},
        {"tag_name": "datapack-20261101-1855", "assets": [{"name": "datapack.sqlite.gz", "browser_download_url": format!("{base}/good.gz")}]}
    ]);
    let r = Router::new()
        .route("/releases", get(move || async move { axum::Json(rel) }))
        .route("/good.gz", get(move || async move { gz }))
        .route("/bad.gz", get(|| async { StatusCode::NOT_FOUND }));
    tokio::spawn(async move { axum::serve(l, r).await.unwrap() });

    let t = setup_with("dl", false, "http://127.0.0.1:9", 1000, &format!("{base}/releases"));
    let req = || Request::post("/admin/refresh").header("authorization", "Bearer admin-token-0123456789").body(Body::empty()).unwrap();
    assert_eq!(call(&t, req()).await.0, StatusCode::ACCEPTED);
    let mut v = Value::Null;
    for _ in 0..100 {
        v = json_call(&t, "status", json!({})).await.1;
        if v["pack"]["state"] == "ready" || v["pack"]["state"] == "failed" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(v["pack"]["state"], "ready", "{v}");
    assert_eq!(v["pack"]["tag"], "datapack-20261101-1855");
    assert_eq!(v["datapack"]["version"], "test");
    let (s, v) = json_call(&t, "search", json!({"q": "28 eden elm"})).await;
    assert_eq!((s, v[0]["pid"].clone()), (StatusCode::OK, json!(1)));
}
