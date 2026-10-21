//! AI provider selection: built-in llama.cpp (offline), local Ollama, Claude API, or any OpenAI-compatible API.
use crate::data::e;
use crate::llm::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

pub type Sink = Arc<dyn Fn(&str) + Send + Sync>;

const KEYRING_SERVICE: &str = "ai-town-planner";

fn d_ollama_url() -> String {
    "http://localhost:11434".into()
}
fn d_anthropic_model() -> String {
    "claude-sonnet-5-5".into()
}
fn d_openai_base() -> String {
    "https://api.openai.com/v1".into()
}
fn d_provider() -> String {
    "builtin".into()
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AiSettings {
    #[serde(default = "d_provider")]
    pub provider: String,
    /// Built-in model file name (in the app's models folder)
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default = "d_ollama_url")]
    pub ollama_url: String,
    #[serde(default)]
    pub ollama_model: String,
    #[serde(default = "d_anthropic_model")]
    pub anthropic_model: String,
    #[serde(default = "d_openai_base")]
    pub openai_base: String,
    #[serde(default)]
    pub openai_model: String,
}

impl Default for AiSettings {
    fn default() -> Self {
        serde_json::from_str("{}").expect("defaults")
    }
}

/// API keys live in the OS credential store (Windows Credential Manager / macOS Keychain).
pub fn set_key(provider: &str, key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, provider).map_err(e)?;
    if key.is_empty() {
        let _ = entry.delete_credential();
        Ok(())
    } else {
        entry.set_password(key).map_err(e)
    }
}

pub fn get_key(provider: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, provider).ok()?.get_password().ok().filter(|k| !k.is_empty())
}

pub async fn ollama_models(url: &str) -> Result<Vec<String>, String> {
    let body = reqwest::get(format!("{}/api/tags", url.trim_end_matches('/')))
        .await
        .map_err(|_| "Ollama is not running. Start Ollama and try again.".to_string())?
        .text()
        .await
        .map_err(e)?;
    let v: Value = serde_json::from_str(&body).map_err(e)?;
    Ok(v["models"].as_array().into_iter().flatten().filter_map(|m| m["name"].as_str().map(String::from)).collect())
}

/// Reads a streaming HTTP body line by line, passing each complete line to `on_line`.
async fn stream_lines(
    resp: reqwest::Response,
    engine: &Engine,
    mut on_line: impl FnMut(&str) -> Result<bool, String>,
) -> Result<(), String> {
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("AI service error {status}: {}", text.chars().take(400).collect::<String>()));
    }
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        if engine.cancel.load(Ordering::SeqCst) {
            return Ok(());
        }
        buf.extend_from_slice(&chunk.map_err(e)?);
        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            if !on_line(line.trim())? {
                return Ok(());
            }
        }
    }
    Ok(())
}

pub async fn generate(
    cfg: &AiSettings,
    builtin_model: Option<PathBuf>,
    engine: Arc<Engine>,
    messages: Vec<(String, String)>,
    max_new: usize,
    sink: Sink,
) -> Result<(), String> {
    engine.cancel.store(false, Ordering::SeqCst);
    let client = reqwest::Client::new();
    match cfg.provider.as_str() {
        "ollama" => {
            if cfg.ollama_model.is_empty() {
                return Err("Choose an Ollama model in Settings.".into());
            }
            let msgs: Vec<Value> = messages.iter().map(|(r, c)| json!({"role": r, "content": c})).collect();
            let body = json!({"model": cfg.ollama_model, "messages": msgs, "stream": true,
                              "options": {"num_ctx": 8192, "num_predict": max_new, "temperature": 0.3}});
            let resp = client
                .post(format!("{}/api/chat", cfg.ollama_url.trim_end_matches('/')))
                .header("content-type", "application/json")
                .body(body.to_string())
                .send()
                .await
                .map_err(|_| "Ollama is not running. Start Ollama and try again.".to_string())?;
            stream_lines(resp, &engine, |line| {
                if line.is_empty() {
                    return Ok(true);
                }
                let v: Value = serde_json::from_str(line).map_err(e)?;
                if let Some(err) = v["error"].as_str() {
                    return Err(format!("Ollama: {err}"));
                }
                if let Some(t) = v["message"]["content"].as_str() {
                    sink(t);
                }
                Ok(!v["done"].as_bool().unwrap_or(false))
            })
            .await
        }
        "anthropic" => {
            let key = get_key("anthropic").ok_or("Add your Claude API key in Settings.")?;
            let system: String = messages.iter().filter(|(r, _)| r == "system").map(|(_, c)| c.as_str()).collect::<Vec<_>>().join("\n\n");
            let msgs: Vec<Value> = messages.iter().filter(|(r, _)| r != "system").map(|(r, c)| json!({"role": r, "content": c})).collect();
            let body = json!({"model": cfg.anthropic_model, "max_tokens": max_new.max(1024), "system": system,
                              "messages": msgs, "stream": true, "temperature": 0.3});
            let resp = client
                .post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .body(body.to_string())
                .send()
                .await
                .map_err(e)?;
            stream_lines(resp, &engine, |line| {
                let Some(data) = line.strip_prefix("data:") else { return Ok(true) };
                let v: Value = serde_json::from_str(data.trim()).unwrap_or(Value::Null);
                match v["type"].as_str() {
                    Some("content_block_delta") => {
                        if let Some(t) = v["delta"]["text"].as_str() {
                            sink(t);
                        }
                        Ok(true)
                    }
                    Some("error") => Err(format!("Claude API: {}", v["error"]["message"].as_str().unwrap_or("error"))),
                    Some("message_stop") => Ok(false),
                    _ => Ok(true),
                }
            })
            .await
        }
        "openai" => {
            if cfg.openai_model.is_empty() {
                return Err("Set the API model name in Settings.".into());
            }
            let msgs: Vec<Value> = messages.iter().map(|(r, c)| json!({"role": r, "content": c})).collect();
            let body = json!({"model": cfg.openai_model, "messages": msgs, "stream": true, "max_tokens": max_new.max(1024), "temperature": 0.3});
            let mut req = client
                .post(format!("{}/chat/completions", cfg.openai_base.trim_end_matches('/')))
                .header("content-type", "application/json")
                .body(body.to_string());
            if let Some(key) = get_key("openai") {
                req = req.bearer_auth(key);
            }
            let resp = req.send().await.map_err(e)?;
            stream_lines(resp, &engine, |line| {
                let Some(data) = line.strip_prefix("data:") else { return Ok(true) };
                let data = data.trim();
                if data == "[DONE]" {
                    return Ok(false);
                }
                let v: Value = serde_json::from_str(data).unwrap_or(Value::Null);
                if let Some(t) = v["choices"][0]["delta"]["content"].as_str() {
                    sink(t);
                }
                Ok(true)
            })
            .await
        }
        _ => {
            let model = builtin_model.ok_or("No AI model installed. Open Settings to download one, or choose Ollama / an API.")?;
            tauri::async_runtime::spawn_blocking(move || engine.generate(&model, &messages, max_new, |t| sink(t)))
                .await
                .map_err(e)?
        }
    }
}
