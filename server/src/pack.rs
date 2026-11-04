//! The data pack on the volume: downloaded from the newest `datapack-*` GitHub release on first start
//! (streamed and gunzipped straight to disk), and refreshed on demand via `POST /admin/refresh`.
use crate::{data, err, AppState};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

#[derive(Clone, Serialize, Default)]
pub struct PackStatus {
    /// missing | downloading | ready | failed
    pub state: String,
    /// Release tag of the loaded pack
    pub tag: Option<String>,
    /// Tag being downloaded (first load or refresh)
    pub update: Option<String>,
    pub done: u64,
    pub total: u64,
    pub error: Option<String>,
}

pub struct Pack {
    dir: PathBuf,
    path: PathBuf,
    status: Mutex<PackStatus>,
    busy: AtomicBool,
}

impl Pack {
    pub fn new(dir: &Path) -> Self {
        let _ = std::fs::create_dir_all(dir);
        let path = dir.join("datapack.sqlite");
        let ok = path.exists() && data::open(&path).is_ok();
        let tag = std::fs::read_to_string(dir.join("datapack.tag")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let status = PackStatus { state: if ok { "ready" } else { "missing" }.into(), tag: if ok { tag } else { None }, ..Default::default() };
        Pack { dir: dir.to_path_buf(), path, status: Mutex::new(status), busy: AtomicBool::new(false) }
    }

    pub fn status(&self) -> PackStatus {
        self.status.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn set(&self, f: impl FnOnce(&mut PackStatus)) {
        f(&mut self.status.lock().unwrap_or_else(|p| p.into_inner()));
    }

    /// Path of the loaded pack, or a message saying why there is none yet.
    pub fn ready_path(&self) -> Result<PathBuf, String> {
        let s = self.status();
        if s.state == "ready" {
            return Ok(self.path.clone());
        }
        Err(match s.state.as_str() {
            "downloading" if s.total > 0 => format!("The data pack is still loading ({}%). Try again in a minute.", s.done * 100 / s.total),
            "downloading" => "The data pack is still loading. Try again in a minute.".into(),
            "failed" => format!("The data pack could not be loaded: {}", s.error.unwrap_or_default()),
            _ => "No data pack loaded yet. Try again in a minute.".into(),
        })
    }

    pub fn contours_dir(&self) -> PathBuf {
        let d = self.dir.join("contours");
        let _ = std::fs::create_dir_all(&d);
        d
    }
}

/// Newest `datapack-YYYYMMDD-HHMM` release that has a `datapack.sqlite.gz` asset: (tag, url).
async fn latest(st: &AppState) -> Result<(String, String), String> {
    let list: Value = st.http.get(&st.cfg.releases_url).send().await.map_err(data::e)?.error_for_status().map_err(data::e)?.json().await.map_err(data::e)?;
    list.as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let tag = r["tag_name"].as_str().filter(|t| t.starts_with("datapack-"))?;
            let url = r["assets"].as_array()?.iter().find(|a| a["name"] == "datapack.sqlite.gz")?["browser_download_url"].as_str()?;
            Some((tag.to_string(), url.to_string()))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
        .ok_or_else(|| "No data pack release found".into())
}

/// Downloads the newest pack if it differs from the loaded one (or `force`). The old pack stays in
/// service until the new one is complete and validated, then is swapped in with a rename.
pub async fn update(st: &AppState, force: bool) -> Result<(), String> {
    if st.pack.busy.swap(true, Ordering::SeqCst) {
        return Err("A data pack download is already running.".into());
    }
    let r = update_inner(st, force).await;
    if let Err(m) = &r {
        st.pack.set(|s| {
            if s.state != "ready" {
                s.state = "failed".into();
            }
            s.update = None;
            s.error = Some(m.clone());
        });
    }
    st.pack.busy.store(false, Ordering::SeqCst);
    r
}

async fn update_inner(st: &AppState, force: bool) -> Result<(), String> {
    let pack = &st.pack;
    let (tag, url) = latest(st).await?;
    let cur = pack.status();
    if cur.state == "ready" && cur.tag.as_deref() == Some(tag.as_str()) && !force {
        return Ok(());
    }
    (st.log)(&format!("data pack: downloading {tag}"));
    pack.set(|s| {
        if s.state != "ready" {
            s.state = "downloading".into();
        }
        s.update = Some(tag.clone());
        s.error = None;
        s.done = 0;
        s.total = 0;
    });
    let resp = st.http.get(&url).send().await.map_err(data::e)?.error_for_status().map_err(data::e)?;
    pack.set(|s| s.total = resp.content_length().unwrap_or(0));
    let part = pack.dir.join("datapack.sqlite.part");
    // Gunzip on a blocking thread while the download streams in, so the .gz is never stored.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<bytes::Bytes>(32);
    let p2 = part.clone();
    let writer = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let f = std::fs::File::create(&p2).map_err(data::e)?;
        let mut gz = flate2::write::GzDecoder::new(std::io::BufWriter::with_capacity(1 << 20, f));
        while let Some(chunk) = rx.blocking_recv() {
            gz.write_all(&chunk).map_err(data::e)?;
        }
        gz.finish().map_err(data::e)?.flush().map_err(data::e)
    });
    let mut stream = resp.bytes_stream();
    let mut done = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(data::e)?;
        done += chunk.len() as u64;
        pack.set(|s| s.done = done);
        if tx.send(chunk).await.is_err() {
            break; // writer failed; its error is reported below
        }
    }
    drop(tx);
    let res = writer.await.map_err(data::e)?;
    if let Err(m) = res {
        let _ = std::fs::remove_file(&part);
        return Err(format!("Unpacking failed: {m}"));
    }
    if let Err(m) = data::open(&part) {
        let _ = std::fs::remove_file(&part);
        return Err(format!("Downloaded file is not a valid data pack: {m}"));
    }
    std::fs::rename(&part, &pack.path).map_err(data::e)?; // open connections keep the old file until they close
    let _ = std::fs::write(pack.dir.join("datapack.tag"), &tag);
    data::reset_vocab();
    pack.set(|s| {
        s.state = "ready".into();
        s.tag = Some(tag.clone());
        s.update = None;
        s.error = None;
    });
    (st.log)(&format!("data pack: {tag} ready"));
    Ok(())
}

/// First start: load the pack, retrying a few times if GitHub or the network fails.
pub async fn ensure(st: AppState) {
    if st.pack.status().state == "ready" {
        return;
    }
    for wait in [30u64, 120, 600] {
        match update(&st, false).await {
            Ok(()) => return,
            Err(m) => (st.log)(&format!("data pack: load failed ({m}); retrying in {wait}s")),
        }
        tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
    }
    let _ = update(&st, false).await;
}

fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `POST /admin/refresh` with `Authorization: Bearer <ADMIN_TOKEN>`; `?force=1` re-downloads the same tag.
/// Runs in the background; poll `POST /api/status` (field `pack`) for progress.
pub async fn admin_refresh(State(st): State<AppState>, headers: HeaderMap, uri: axum::http::Uri) -> Response {
    let Some(token) = st.cfg.admin_token.clone() else { return err(StatusCode::NOT_FOUND, "Not found") };
    let given = headers.get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).unwrap_or("");
    if !same(given.as_bytes(), token.as_bytes()) {
        return err(StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    if st.pack.busy.load(Ordering::SeqCst) {
        return err(StatusCode::CONFLICT, "A data pack download is already running.");
    }
    let force = uri.query().is_some_and(|q| q.split('&').any(|p| p == "force=1" || p == "force=true"));
    let s2 = st.clone();
    tokio::spawn(async move {
        if let Err(m) = update(&s2, force).await {
            (s2.log)(&format!("data pack: refresh failed ({m})"));
        }
    });
    (StatusCode::ACCEPTED, Json(json!({ "started": true, "pack": st.pack.status() }))).into_response()
}
