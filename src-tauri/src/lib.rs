mod ai;
mod council;
mod data;
mod dev;
mod llm;
mod rules;

use data::e;
use futures_util::StreamExt;
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufReader, Write};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

struct AppState {
    db: Arc<Mutex<Option<rusqlite::Connection>>>,
    llm: Arc<llm::Engine>,
}

fn dir(app: &AppHandle, sub: &str) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(e)?.join(sub);
    fs::create_dir_all(&d).map_err(e)?;
    Ok(d)
}

fn datapack_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(dir(app, "data")?.join("datapack.sqlite"))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(dir(app, "")?.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> ai::AiSettings {
    settings_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn store_settings(app: &AppHandle, s: &ai::AiSettings) -> Result<(), String> {
    fs::write(settings_path(app)?, serde_json::to_string_pretty(s).map_err(e)?).map_err(e)
}

fn active_model(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let models = dir(app, "models")?;
    let chosen = load_settings(app).model.map(|m| models.join(m)).filter(|p| p.exists());
    if chosen.is_some() {
        return Ok(chosen);
    }
    // Fall back to the largest installed model.
    let mut found: Vec<_> = fs::read_dir(&models)
        .map_err(e)?
        .filter_map(|x| x.ok())
        .filter(|x| x.path().extension().map(|ext| ext == "gguf").unwrap_or(false))
        .map(|x| (x.metadata().map(|m| m.len()).unwrap_or(0), x.path()))
        .collect();
    found.sort();
    Ok(found.pop().map(|(_, p)| p))
}

fn with_db<T>(state: &AppState, f: impl FnOnce(&rusqlite::Connection) -> Result<T, String>) -> Result<T, String> {
    let g = state.db.lock().map_err(e)?;
    let c = g.as_ref().ok_or("No data pack loaded. Open Settings and import a data pack.")?;
    f(c)
}

#[derive(Serialize)]
struct ModelStatus {
    id: String,
    name: String,
    file: String,
    size_gb: f32,
    min_ram_gb: u32,
    note: String,
    installed: bool,
    active: bool,
}

#[derive(Serialize)]
struct Status {
    datapack: Option<BTreeMap<String, String>>,
    models: Vec<ModelStatus>,
    custom_models: Vec<String>,
    active_model: Option<String>,
    ai: ai::AiSettings,
    has_anthropic_key: bool,
    has_openai_key: bool,
    has_google_key: bool,
    disclaimer: &'static str,
}

#[tauri::command]
async fn status(app: AppHandle, state: State<'_, AppState>) -> Result<Status, String> {
    let datapack = with_db(&state, data::manifest).ok();
    let models_dir = dir(&app, "models")?;
    let active = active_model(&app)?.and_then(|p| p.file_name().map(|f| f.to_string_lossy().to_string()));
    let models = llm::CATALOG
        .iter()
        .map(|m| ModelStatus {
            id: m.id.into(),
            name: m.name.into(),
            file: m.file.into(),
            size_gb: m.size_gb,
            min_ram_gb: m.min_ram_gb,
            note: m.note.into(),
            installed: models_dir.join(m.file).exists(),
            active: active.as_deref() == Some(m.file),
        })
        .collect();
    let custom_models = fs::read_dir(&models_dir)
        .map_err(e)?
        .filter_map(|x| x.ok())
        .map(|x| x.file_name().to_string_lossy().to_string())
        .filter(|f| f.ends_with(".gguf") && !llm::CATALOG.iter().any(|m| m.file == f))
        .collect();
    Ok(Status {
        datapack,
        models,
        custom_models,
        active_model: active,
        ai: load_settings(&app),
        has_anthropic_key: ai::get_key("anthropic").is_some(),
        has_openai_key: ai::get_key("openai").is_some(),
        has_google_key: ai::get_key("google").is_some(),
        disclaimer: rules::DISCLAIMER,
    })
}

async fn install_pack(app: &AppHandle, db: Arc<Mutex<Option<rusqlite::Connection>>>, path: String) -> Result<BTreeMap<String, String>, String> {
    let dest = datapack_path(app)?;
    let tmp = dest.with_extension("importing");
    tauri::async_runtime::spawn_blocking(move || -> Result<BTreeMap<String, String>, String> {
        let src = fs::File::open(&path).map_err(e)?;
        let mut out = fs::File::create(&tmp).map_err(e)?;
        if path.ends_with(".gz") {
            std::io::copy(&mut flate2::read::GzDecoder::new(BufReader::new(src)), &mut out).map_err(e)?;
        } else {
            std::io::copy(&mut BufReader::new(src), &mut out).map_err(e)?;
        }
        out.flush().map_err(e)?;
        drop(out);
        let manifest = data::manifest(&data::open(&tmp)?)?; // validate before replacing
        let mut g = db.lock().map_err(e)?;
        *g = None;
        fs::rename(&tmp, &dest).map_err(e)?;
        *g = Some(data::open(&dest)?);
        data::reset_vocab();
        Ok(manifest)
    })
    .await
    .map_err(e)?
}

#[tauri::command]
async fn import_datapack(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<BTreeMap<String, String>, String> {
    install_pack(&app, state.db.clone(), path).await
}

const RELEASES: &str = "https://api.github.com/repos/falahjoon-prog/ai-town-planner/releases?per_page=30";

#[tauri::command]
async fn download_datapack(app: AppHandle, state: State<'_, AppState>, on_progress: Channel<Progress>) -> Result<BTreeMap<String, String>, String> {
    let client = reqwest::Client::builder().user_agent("ai-town-planner").build().map_err(e)?;
    let list: serde_json::Value = client.get(RELEASES).send().await.map_err(e)?.error_for_status()
        .map_err(|_| "Data pack not available online yet. Import the file instead.".to_string())?
        .json().await.map_err(e)?;
    let url = list.as_array().and_then(|r| {
        r.iter().find(|x| x["tag_name"].as_str().is_some_and(|t| t.starts_with("datapack-")))
    }).and_then(|x| x["assets"].as_array()?.iter().find(|a| a["name"] == "datapack.sqlite.gz")?["browser_download_url"].as_str().map(String::from))
        .ok_or("No data pack release found")?;
    let part = datapack_path(&app)?.with_extension("download.gz");
    let resp = client.get(&url).send().await.map_err(e)?.error_for_status().map_err(e)?;
    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(&part).await.map_err(e)?;
    let mut stream = resp.bytes_stream();
    let (mut done, mut last) = (0u64, 0u64);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(e)?;
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await.map_err(e)?;
        done += chunk.len() as u64;
        if done - last > 8 << 20 {
            last = done;
            let _ = on_progress.send(Progress { done, total });
        }
    }
    tokio::io::AsyncWriteExt::flush(&mut file).await.map_err(e)?;
    drop(file);
    let _ = on_progress.send(Progress { done, total });
    let r = install_pack(&app, state.db.clone(), part.to_string_lossy().to_string()).await;
    let _ = fs::remove_file(&part);
    r
}

#[derive(Serialize)]
struct Suggest {
    place_id: String,
    text: String,
}

/// Google Places address suggestions (needs the user's own Google API key).
#[tauri::command]
async fn google_suggest(q: String) -> Result<Vec<Suggest>, String> {
    let key = ai::get_key("google").ok_or("No Google key")?;
    let body = serde_json::json!({
        "input": q,
        "includedRegionCodes": ["au"],
        "includedPrimaryTypes": ["street_address", "premise", "subpremise"],
        "locationBias": {"circle": {"center": {"latitude": -27.47, "longitude": 153.03}, "radius": 50000.0}}
    });
    let v: serde_json::Value = reqwest::Client::new()
        .post("https://places.googleapis.com/v1/places:autocomplete")
        .header("X-Goog-Api-Key", key)
        .json(&body)
        .send()
        .await
        .map_err(|_| "Google address search needs internet.".to_string())?
        .json()
        .await
        .map_err(e)?;
    if let Some(m) = v["error"]["message"].as_str() {
        return Err(format!("Google: {m}"));
    }
    Ok(v["suggestions"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| {
                    let p = &s["placePrediction"];
                    Some(Suggest { place_id: p["placeId"].as_str()?.into(), text: p["text"]["text"].as_str()?.into() })
                })
                .collect()
        })
        .unwrap_or_default())
}

/// Resolve a Google place to the lot that contains it in the data pack.
#[tauri::command]
async fn google_pick(state: State<'_, AppState>, place_id: String) -> Result<data::ParcelHit, String> {
    let key = ai::get_key("google").ok_or("No Google key")?;
    let v: serde_json::Value = reqwest::Client::new()
        .get(format!("https://places.googleapis.com/v1/places/{place_id}"))
        .header("X-Goog-Api-Key", key)
        .header("X-Goog-FieldMask", "location")
        .send()
        .await
        .map_err(|_| "Google address search needs internet.".to_string())?
        .json()
        .await
        .map_err(e)?;
    let (lat, lng) = (v["location"]["latitude"].as_f64(), v["location"]["longitude"].as_f64());
    let (Some(lat), Some(lng)) = (lat, lng) else { return Err("Google could not locate that address.".into()) };
    with_db(&state, |c| data::parcel_at(c, lng, lat))?
        .ok_or_else(|| "That address is not inside the loaded data pack. Download the full data pack in Settings.".to_string())
}

/// Read a purchased title search PDF and have the AI summarise easements, covenants and interests.
#[tauri::command]
async fn summarise_title(app: AppHandle, state: State<'_, AppState>, path: String, on_token: Channel<String>) -> Result<(), String> {
    let text = tauri::async_runtime::spawn_blocking(move || pdf_extract::extract_text(&path).map_err(e))
        .await
        .map_err(e)??;
    if text.trim().len() < 80 {
        return Err("Could not read text from this PDF. Use the PDF downloaded from the title search (not a scan or photo).".into());
    }
    let text: String = text.chars().take(14000).collect();
    let cfg = load_settings(&app);
    let model = active_model(&app)?;
    let (sys, user) = rules::title_prompt(&text);
    let sink: ai::Sink = Arc::new(move |t: &str| {
        let _ = on_token.send(t.to_string());
    });
    ai::generate(&cfg, model, state.llm.clone(), vec![("system".into(), sys), ("user".into(), user)], 1200, sink).await
}

#[tauri::command]
async fn search(state: State<'_, AppState>, q: String) -> Result<Vec<data::ParcelHit>, String> {
    with_db(&state, |c| data::search(c, &q))
}

#[tauri::command]
async fn assess(state: State<'_, AppState>, pid: i64) -> Result<rules::Assessment, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || load_assessment(&db, pid)).await.map_err(e)?
}

#[tauri::command]
async fn flood_map(state: State<'_, AppState>, pid: i64) -> Result<Vec<data::OverlayHit>, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let g = db.lock().map_err(e)?;
        let c = g.as_ref().ok_or("No data pack loaded")?;
        data::flood_map(c, &data::parcel(c, pid)?, 400.0)
    })
    .await
    .map_err(e)?
}

#[tauri::command]
async fn potential(state: State<'_, AppState>, pid: i64, use_id: String) -> Result<dev::Potential, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let a = load_assessment(&db, pid)?;
        let g = db.lock().map_err(e)?;
        let c = g.as_ref().ok_or("No data pack loaded")?;
        dev::potential(c, &a, &use_id)
    })
    .await
    .map_err(e)?
}

/// Lot-size profile of a suburb from the data pack (one row per lot/plan).
#[tauri::command]
async fn suburb_stats(state: State<'_, AppState>, suburb: String) -> Result<serde_json::Value, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let g = db.lock().map_err(e)?;
        let c = g.as_ref().ok_or("No data pack loaded")?;
        let mut st = c
            .prepare("SELECT max(area) FROM parcels WHERE suburb = ?1 COLLATE NOCASE AND area > 0 GROUP BY lotplan")
            .map_err(e)?;
        let mut v: Vec<f64> = st.query_map([&suburb], |r| r.get::<_, f64>(0)).map_err(e)?.flatten().collect();
        if v.is_empty() {
            return Err(format!("No lots found for {suburb}"));
        }
        v.sort_by(|a, b| a.total_cmp(b));
        let q = |f: f64| v[((v.len() - 1) as f64 * f).round() as usize].round();
        let share = |min: f64| (v.iter().filter(|x| **x >= min).count() as f64 * 1000.0 / v.len() as f64).round() / 10.0;
        Ok(serde_json::json!({
            "suburb": suburb, "lots": v.len(), "median_m2": q(0.5), "p25_m2": q(0.25), "p75_m2": q(0.75),
            "pct_600": share(600.0), "pct_800": share(800.0), "pct_900": share(900.0), "pct_1000": share(1000.0),
            "count_900": v.iter().filter(|x| **x >= 900.0).count()
        }))
    })
    .await
    .map_err(e)?
}

/// Electricity infrastructure within 5 km of the lot (for the map).
#[tauri::command]
async fn infra_map(state: State<'_, AppState>, pid: i64) -> Result<Vec<serde_json::Value>, String> {
    let db = state.db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let g = db.lock().map_err(e)?;
        let c = g.as_ref().ok_or("No data pack loaded")?;
        let p = data::parcel(c, pid)?;
        let pg = data::to_geo(&p.geom.to_string())?;
        let rect = geo::BoundingRect::bounding_rect(&pg).ok_or("Empty lot")?;
        let pr = data::Proj::new(rect.center().y);
        dev::infra(c, &pg, &pr, 5_000.0, 5_000.0).map(|(_, f)| f)
    })
    .await
    .map_err(e)?
}

/// Contours need internet the first time; results are cached per lot for offline use.
#[tauri::command]
async fn contours(app: AppHandle, state: State<'_, AppState>, pid: i64) -> Result<serde_json::Value, String> {
    let cache = dir(&app, "contours")?.join(format!("{pid}.json"));
    if let Ok(s) = fs::read_to_string(&cache) {
        if let Ok(v) = serde_json::from_str(&s) {
            return Ok(v);
        }
    }
    let p = with_db(&state, |c| data::parcel(c, pid))?;
    let v = dev::contours(&p).await?;
    let _ = fs::write(&cache, v.to_string());
    Ok(v)
}

/// AI-drafted DA Form 1 answers (streamed).
#[tauri::command]
async fn draft_form(
    app: AppHandle,
    state: State<'_, AppState>,
    pid: i64,
    use_id: String,
    proposal: String,
    letter: bool,
    on_token: Channel<String>,
) -> Result<(), String> {
    let cfg = load_settings(&app);
    let model = active_model(&app)?;
    let db = state.db.clone();
    let (a, dev_facts) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let a = load_assessment(&db, pid)?;
        let g = db.lock().map_err(e)?;
        let c = g.as_ref().ok_or("No data pack loaded")?;
        let pot = dev::potential(c, &a, &use_id)?;
        Ok((a, dev::facts(&pot)))
    })
    .await
    .map_err(e)??;
    let (sys, user) = rules::form_prompt(&a, &dev_facts, &proposal, letter);
    let sink: ai::Sink = Arc::new(move |t: &str| {
        let _ = on_token.send(t.to_string());
    });
    ai::generate(&cfg, model, state.llm.clone(), vec![("system".into(), sys), ("user".into(), user)], 1400, sink).await
}

fn load_assessment(db: &Arc<Mutex<Option<rusqlite::Connection>>>, pid: i64) -> Result<rules::Assessment, String> {
    let g = db.lock().map_err(e)?;
    let c = g.as_ref().ok_or("No data pack loaded")?;
    let p = data::parcel(c, pid)?;
    let o = data::overlays(c, &p)?;
    Ok(rules::assess(p, o, data::manifest(c)?))
}

#[derive(Serialize, Clone)]
struct ReportEvent {
    section: String,
    title: String,
    text: String,
}

/// Generates the report one authority section at a time, streaming text tagged with its section.
#[tauri::command]
async fn generate_report(
    app: AppHandle,
    state: State<'_, AppState>,
    pid: i64,
    question: String,
    use_id: String,
    on_event: Channel<ReportEvent>,
) -> Result<(), String> {
    let cfg = load_settings(&app);
    let model = active_model(&app)?;
    let db = state.db.clone();
    let uid = use_id.clone();
    let (a, dev_facts) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let a = load_assessment(&db, pid)?;
        let g = db.lock().map_err(e)?;
        let c = g.as_ref().ok_or("No data pack loaded")?;
        let pot = dev::potential(c, &a, &uid)?;
        Ok((a, dev::facts(&pot)))
    })
    .await
    .map_err(e)??;
    state.llm.cancel.store(false, Ordering::SeqCst);
    for (key, title) in rules::sections(&a) {
        if state.llm.cancel.load(Ordering::SeqCst) {
            break;
        }
        let _ = on_event.send(ReportEvent { section: key.into(), title: title.into(), text: String::new() });
        let (sys, user) = if key == "potential" { rules::potential_prompt(&a, &dev_facts, &question) } else { rules::section_prompt(&a, key, &question) };
        let ch = on_event.clone();
        let sink: ai::Sink = Arc::new(move |t: &str| {
            let _ = ch.send(ReportEvent { section: key.into(), title: title.into(), text: t.to_string() });
        });
        ai::generate(&cfg, model.clone(), state.llm.clone(), vec![("system".into(), sys), ("user".into(), user)], 700, sink).await?;
    }
    Ok(())
}

#[derive(serde::Deserialize)]
struct ChatIn {
    role: String,
    content: String,
}

#[tauri::command]
async fn chat(
    app: AppHandle,
    state: State<'_, AppState>,
    pid: i64,
    report: String,
    history: Vec<ChatIn>,
    on_token: Channel<String>,
) -> Result<(), String> {
    let cfg = load_settings(&app);
    let model = active_model(&app)?;
    let db = state.db.clone();
    let a = tauri::async_runtime::spawn_blocking(move || load_assessment(&db, pid)).await.map_err(e)??;
    let hist: Vec<rules::ChatMsg> = history.into_iter().map(|m| rules::ChatMsg { role: m.role, content: m.content }).collect();
    let msgs = rules::chat_messages(&a, &report, &hist);
    let sink: ai::Sink = Arc::new(move |t: &str| {
        let _ = on_token.send(t.to_string());
    });
    ai::generate(&cfg, model, state.llm.clone(), msgs, 512, sink).await
}

#[tauri::command]
async fn assistant(
    app: AppHandle,
    state: State<'_, AppState>,
    pid: Option<i64>,
    history: Vec<ChatIn>,
    on_token: Channel<String>,
) -> Result<(), String> {
    let cfg = load_settings(&app);
    let model = active_model(&app)?;
    let a = match pid {
        Some(pid) => {
            let db = state.db.clone();
            Some(tauri::async_runtime::spawn_blocking(move || load_assessment(&db, pid)).await.map_err(e)??)
        }
        None => None,
    };
    let hist: Vec<rules::ChatMsg> = history.into_iter().map(|m| rules::ChatMsg { role: m.role, content: m.content }).collect();
    let msgs = rules::assistant_messages(a.as_ref(), &hist);
    let sink: ai::Sink = Arc::new(move |t: &str| {
        let _ = on_token.send(t.to_string());
    });
    ai::generate(&cfg, model, state.llm.clone(), msgs, 512, sink).await
}

#[tauri::command]
fn save_ai_settings(app: AppHandle, settings: ai::AiSettings) -> Result<(), String> {
    let mut s = settings;
    s.model = load_settings(&app).model; // built-in model choice is managed by set_model
    store_settings(&app, &s)
}

#[tauri::command]
fn set_api_key(provider: String, key: String) -> Result<(), String> {
    if !["anthropic", "openai", "google"].contains(&provider.as_str()) {
        return Err("Unknown provider".into());
    }
    ai::set_key(&provider, key.trim())
}

#[tauri::command]
async fn ollama_models(url: String) -> Result<Vec<String>, String> {
    ai::ollama_models(&url).await
}

#[tauri::command]
fn cancel_report(state: State<'_, AppState>) {
    state.llm.cancel.store(true, Ordering::SeqCst);
}

#[derive(Serialize, Clone)]
struct Progress {
    done: u64,
    total: u64,
}

#[tauri::command]
async fn download_model(app: AppHandle, id: String, on_progress: Channel<Progress>) -> Result<(), String> {
    let spec = llm::CATALOG.iter().find(|m| m.id == id).ok_or("Unknown model")?;
    let dest = dir(&app, "models")?.join(spec.file);
    let part = dest.with_extension("part");
    let resp = reqwest::get(spec.url).await.map_err(e)?.error_for_status().map_err(e)?;
    let total = resp.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(&part).await.map_err(e)?;
    let mut stream = resp.bytes_stream();
    let (mut done, mut last) = (0u64, 0u64);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(e)?;
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await.map_err(e)?;
        done += chunk.len() as u64;
        if done - last > 8 << 20 {
            last = done;
            let _ = on_progress.send(Progress { done, total });
        }
    }
    tokio::io::AsyncWriteExt::flush(&mut file).await.map_err(e)?;
    drop(file);
    fs::rename(&part, &dest).map_err(e)?;
    let _ = on_progress.send(Progress { done, total });
    set_model(app, spec.file.to_string())
}

#[tauri::command]
async fn import_model(app: AppHandle, path: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    let name = src.file_name().ok_or("Invalid file")?.to_string_lossy().to_string();
    if !name.ends_with(".gguf") {
        return Err("Model must be a .gguf file".into());
    }
    let dest = dir(&app, "models")?.join(&name);
    tauri::async_runtime::spawn_blocking(move || fs::copy(&src, &dest).map_err(e))
        .await
        .map_err(e)??;
    set_model(app, name.clone())?;
    Ok(name)
}

#[tauri::command]
fn set_model(app: AppHandle, file: String) -> Result<(), String> {
    let mut s = load_settings(&app);
    s.model = Some(file);
    s.provider = "builtin".into();
    store_settings(&app, &s)
}

#[tauri::command]
fn delete_model(app: AppHandle, file: String) -> Result<(), String> {
    let p = dir(&app, "models")?.join(&file);
    if p.parent() != Some(dir(&app, "models")?.as_path()) {
        return Err("Invalid file".into());
    }
    fs::remove_file(p).map_err(e)
}

#[tauri::command]
fn save_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    fs::write(path, bytes).map_err(e)
}

#[tauri::command]
fn save_text(path: String, content: String) -> Result<(), String> {
    fs::write(path, content).map_err(e)
}

/// Reads a backup file (.json only, max 20 MB).
#[tauri::command]
fn read_backup(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if p.extension().and_then(|x| x.to_str()).map(|x| x.eq_ignore_ascii_case("json")) != Some(true) {
        return Err("Only .json backup files can be restored".into());
    }
    if fs::metadata(&p).map_err(e)?.len() > 20_000_000 {
        return Err("Backup file is too large".into());
    }
    fs::read_to_string(p).map_err(e)
}

// -- Batch check: read a user-picked .csv/.txt list of addresses --
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let ok = PathBuf::from(&path)
        .extension()
        .and_then(|x| x.to_str())
        .map(|x| matches!(x.to_ascii_lowercase().as_str(), "csv" | "txt"))
        .unwrap_or(false);
    if !ok {
        return Err("Only .csv and .txt files can be read".into());
    }
    if fs::metadata(&path).map_err(e)?.len() > 2_000_000 {
        return Err("File is too large".into());
    }
    fs::read_to_string(path).map_err(e)
}

/// Opens a web link in the person's default browser (no in-app window).
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only web links can be opened".into());
    }
    #[cfg(target_os = "windows")]
    let child = std::process::Command::new("explorer").arg(&url).spawn();
    #[cfg(target_os = "macos")]
    let child = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let child = std::process::Command::new("xdg-open").arg(&url).spawn();
    child.map(|_| ()).map_err(e)
}

/// Development.i land number for a lot/plan or address (the register's search has no CORS, so the app asks from here).
/// Lot/plan terms use `LotPlan[0]`, address terms `Address[0]`. Only the three Development.i hosts are allowed.
#[tauri::command]
async fn devi_land_number(host: String, term: String) -> Option<String> {
    const HOSTS: [&str; 3] = [
        "developmenti.brisbane.qld.gov.au",
        "developmenti.redland.qld.gov.au",
        "developmenti.ipswich.qld.gov.au",
    ];
    if !HOSTS.contains(&host.as_str()) || term.trim().is_empty() {
        return None;
    }
    let v: serde_json::Value = reqwest::Client::new()
        .get(format!("https://{host}/Geo/AddressCompoundSearch"))
        .query(&[("searchTerm", term.trim())])
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let is_lotplan = !term.contains(' ') && term.chars().any(|c| c.is_ascii_digit());
    let id = if is_lotplan { &v["LotPlan"][0]["id"] } else { &v["Address"][0]["id"] };
    match id {
        serde_json::Value::String(s) if !s.is_empty() => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let path = datapack_path(app.handle())?;
            let conn = if path.exists() { data::open(&path).ok() } else { None };
            app.manage(AppState { db: Arc::new(Mutex::new(conn)), llm: Arc::new(llm::Engine::new()) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_bytes,
            status,
            assistant,
            open_external,
            devi_land_number,
            import_datapack,
            download_datapack,
            search,
            suburb_stats,
            summarise_title,
            google_suggest,
            google_pick,
            assess,
            flood_map,
            potential,
            contours,
            infra_map,
            draft_form,
            generate_report,
            chat,
            cancel_report,
            save_ai_settings,
            set_api_key,
            ollama_models,
            download_model,
            import_model,
            set_model,
            delete_model,
            save_text,
            read_backup,
            read_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running AI Town Planner");
}
