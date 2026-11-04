//! Streams a chat completion from the user's own Claude or OpenAI key (sent per request in
//! `X-AI-Key` / `X-AI-Provider`, optional `X-AI-Model`). Keys are used for the one upstream call
//! and never stored or logged. Same request shapes and stream parsing as the desktop `ai.rs`.
use crate::AppState;
use axum::http::{HeaderMap, StatusCode};
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::sync::mpsc;

pub struct AiReq {
    provider: &'static str,
    key: String,
    model: String,
}

fn hdr(h: &HeaderMap, k: &str) -> String {
    h.get(k).and_then(|v| v.to_str().ok()).unwrap_or("").trim().to_string()
}

pub fn from_headers(h: &HeaderMap) -> Result<AiReq, String> {
    let provider = match hdr(h, "x-ai-provider").to_ascii_lowercase().as_str() {
        "anthropic" | "claude" => "anthropic",
        "openai" => "openai",
        "" => return Err("Choose an AI provider (Claude or OpenAI) and add your API key in Settings.".into()),
        _ => return Err("Unknown AI provider. Use Claude (anthropic) or OpenAI.".into()),
    };
    let key = hdr(h, "x-ai-key");
    if key.len() < 8 || key.len() > 400 || !key.chars().all(|c| c.is_ascii_graphic()) {
        return Err("Add your API key in Settings.".into());
    }
    let model = hdr(h, "x-ai-model");
    if model.len() > 100 || !model.chars().all(|c| c.is_ascii_alphanumeric() || "._:-/".contains(c)) {
        return Err("Invalid AI model name.".into());
    }
    let model = if !model.is_empty() {
        model
    } else if provider == "anthropic" {
        "claude-sonnet-5-5".into()
    } else {
        "gpt-4.1-mini".into()
    };
    Ok(AiReq { provider, key, model })
}

/// Starts the upstream call. Errors before streaming (bad key, quota) come back as (status, message);
/// after that, tokens (Ok) and a possible error (Err) arrive on the channel.
pub async fn start(
    st: &AppState,
    req: AiReq,
    messages: Vec<(String, String)>,
    max_new: usize,
) -> Result<mpsc::Receiver<Result<String, String>>, (StatusCode, String)> {
    let resp = if req.provider == "anthropic" {
        let system: String = messages.iter().filter(|(r, _)| r == "system").map(|(_, c)| c.as_str()).collect::<Vec<_>>().join("\n\n");
        let msgs: Vec<Value> = messages.iter().filter(|(r, _)| r != "system").map(|(r, c)| json!({"role": r, "content": c})).collect();
        let body = json!({"model": req.model, "max_tokens": max_new.max(1024), "system": system, "messages": msgs, "stream": true, "temperature": 0.3});
        st.http
            .post(&st.cfg.anthropic_url)
            .header("x-api-key", &req.key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await
    } else {
        let msgs: Vec<Value> = messages.iter().map(|(r, c)| json!({"role": r, "content": c})).collect();
        let body = json!({"model": req.model, "messages": msgs, "stream": true, "max_tokens": max_new.max(1024), "temperature": 0.3});
        st.http.post(&st.cfg.openai_url).bearer_auth(&req.key).json(&body).send().await
    }
    .map_err(|_| (StatusCode::BAD_GATEWAY, "Could not reach the AI service. Try again.".to_string()))?;
    let name = if req.provider == "anthropic" { "Claude API" } else { "OpenAI" };
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(String::from))
            .unwrap_or_else(|| text.chars().take(300).collect());
        let detail = detail.replace(&req.key, "***"); // never echo the key back, even if upstream does
        let code = match status.as_u16() {
            401 | 403 => StatusCode::UNAUTHORIZED,
            429 => StatusCode::TOO_MANY_REQUESTS,
            400 | 404 => StatusCode::BAD_REQUEST,
            _ => StatusCode::BAD_GATEWAY,
        };
        return Err((code, format!("{name} error {}: {detail}", status.as_u16())));
    }
    let (tx, rx) = mpsc::channel(256);
    let anthropic = req.provider == "anthropic";
    drop(req); // the key is not needed past this point
    tokio::spawn(async move {
        let mut stream = resp.bytes_stream();
        let mut buf: Vec<u8> = Vec::new();
        while let Some(chunk) = stream.next().await {
            let Ok(chunk) = chunk else {
                let _ = tx.send(Err(format!("{name}: connection lost"))).await;
                return;
            };
            buf.extend_from_slice(&chunk);
            while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = buf.drain(..=pos).collect();
                let line = String::from_utf8_lossy(&line);
                let Some(data) = line.trim().strip_prefix("data:") else { continue };
                let data = data.trim();
                let out = if anthropic {
                    let v: Value = serde_json::from_str(data).unwrap_or(Value::Null);
                    match v["type"].as_str() {
                        Some("content_block_delta") => v["delta"]["text"].as_str().map(|t| Ok(t.to_string())),
                        Some("error") => Some(Err(format!("{name}: {}", v["error"]["message"].as_str().unwrap_or("error")))),
                        Some("message_stop") => return,
                        _ => None,
                    }
                } else {
                    if data == "[DONE]" {
                        return;
                    }
                    let v: Value = serde_json::from_str(data).unwrap_or(Value::Null);
                    v["choices"][0]["delta"]["content"].as_str().map(|t| Ok(t.to_string()))
                };
                if let Some(o) = out {
                    let stop = o.is_err();
                    if tx.send(o).await.is_err() || stop {
                        return; // the phone closed the connection (cancel), or an error was sent
                    }
                }
            }
        }
    });
    Ok(rx)
}
