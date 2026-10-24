//! On-device LLM via llama.cpp (GGUF models, ChatML prompt format).
use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::LlamaModel;
use llama_cpp_2::sampling::LlamaSampler;
use serde::Serialize;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use crate::data::e;

#[derive(Serialize, Clone)]
pub struct ModelSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub file: &'static str,
    pub url: &'static str,
    pub size_gb: f32,
    pub min_ram_gb: u32,
    pub note: &'static str,
}

/// Apache-2.0 licensed models, both using the ChatML template.
pub const CATALOG: &[ModelSpec] = &[
    ModelSpec {
        id: "qwen3-4b",
        name: "Compact – Qwen3 4B Instruct",
        file: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        size_gb: 2.5,
        min_ram_gb: 8,
        note: "Phones and laptops with 8 GB RAM",
    },
    ModelSpec {
        id: "qwen2.5-7b",
        name: "Professional – Qwen2.5 7B Instruct",
        file: "Qwen2.5-7B-Instruct-Q4_K_M.gguf",
        url: "https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf",
        size_gb: 4.7,
        min_ram_gb: 16,
        note: "Desktops with 16 GB+ RAM; better reports",
    },
];

const N_CTX: u32 = 8192;
const CHUNK: usize = 512;

/// Drops `<think>...</think>` blocks from streamed text (Qwen3 reasoning), holding back
/// only a possible partial tag so normal text streams immediately.
struct ThinkFilter {
    buf: String,
    in_think: bool,
}

fn partial_len(buf: &str, tag: &str) -> usize {
    (1..tag.len()).rev().find(|k| buf.ends_with(&tag[..*k])).unwrap_or(0)
}

impl ThinkFilter {
    fn push(&mut self, s: &str, out: &mut impl FnMut(&str)) {
        self.buf.push_str(s);
        loop {
            if self.in_think {
                if let Some(i) = self.buf.find("</think>") {
                    self.buf.drain(..i + 8);
                    self.in_think = false;
                    let n = self.buf.len() - self.buf.trim_start().len();
                    self.buf.drain(..n);
                } else {
                    let cut = self.buf.len() - partial_len(&self.buf, "</think>");
                    self.buf.drain(..cut);
                    break;
                }
            } else if let Some(i) = self.buf.find("<think>") {
                if i > 0 {
                    out(&self.buf[..i]);
                }
                self.buf.drain(..i + 7);
                self.in_think = true;
            } else {
                let cut = self.buf.len() - partial_len(&self.buf, "<think>");
                if cut > 0 {
                    out(&self.buf[..cut]);
                }
                self.buf.drain(..cut);
                break;
            }
        }
    }

    fn flush(&mut self, out: &mut impl FnMut(&str)) {
        if !self.in_think && !self.buf.is_empty() {
            out(&self.buf);
        }
        self.buf.clear();
    }
}

pub struct Engine {
    backend: Mutex<Option<LlamaBackend>>,
    model: Mutex<Option<(PathBuf, LlamaModel)>>,
    pub cancel: AtomicBool,
}

impl Engine {
    pub fn new() -> Self {
        Self { backend: Mutex::new(None), model: Mutex::new(None), cancel: AtomicBool::new(false) }
    }

    pub fn generate(
        &self,
        model_path: &Path,
        messages: &[(String, String)],
        max_new: usize,
        mut on_text: impl FnMut(&str),
    ) -> Result<(), String> {
        // Qwen3 hybrid models reason in <think> blocks; skip that for fast answers.
        // (Qwen3-2507 Instruct has no thinking mode, so it needs no prefill.)
        let fname = model_path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
        let qwen3 = fname.contains("qwen3");
        let think_prefill = qwen3 && !fname.contains("2507");
        self.cancel.store(false, Ordering::SeqCst);
        let mut bguard = self.backend.lock().map_err(e)?;
        if bguard.is_none() {
            *bguard = Some(LlamaBackend::init().map_err(e)?);
        }
        let backend = bguard.as_ref().unwrap();

        let mut mguard = self.model.lock().map_err(e)?;
        if mguard.as_ref().map(|(p, _)| p != model_path).unwrap_or(true) {
            *mguard = None; // free the old model first
            let params = LlamaModelParams::default().with_n_gpu_layers(999);
            let m = LlamaModel::load_from_file(backend, model_path, &params).map_err(e)?;
            *mguard = Some((model_path.to_path_buf(), m));
        }
        let model = &mguard.as_ref().unwrap().1;

        let mut prompt: String = messages
            .iter()
            .map(|(role, content)| format!("<|im_start|>{role}\n{content}<|im_end|>\n"))
            .collect();
        prompt.push_str("<|im_start|>assistant\n");
        if think_prefill {
            prompt.push_str("<think>\n\n</think>\n\n");
        }
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let threads = ((threads / 2).max(4)).min(threads) as i32; // ~physical cores
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(N_CTX))
            .with_n_threads(threads)
            .with_n_threads_batch(threads);
        let mut ctx = model.new_context(backend, ctx_params).map_err(e)?;
        let vocab = model.vocab();
        let tokens = vocab.tokenize(prompt.as_bytes(), false, true);
        if tokens.len() + 256 > N_CTX as usize {
            return Err(format!("Prompt too long ({} tokens)", tokens.len()));
        }

        let mut batch = LlamaBatch::new(CHUNK, 1);
        let mut pos: i32 = 0;
        let last = tokens.len() - 1;
        for chunk in tokens.chunks(CHUNK) {
            batch.clear();
            for t in chunk {
                batch.add(*t, pos, &[0], pos as usize == last).map_err(e)?;
                pos += 1;
            }
            ctx.decode(&mut batch).map_err(e)?;
        }

        let mut sampler = LlamaSampler::chain_simple([
            LlamaSampler::top_k(40),
            LlamaSampler::top_p(0.9, 1),
            LlamaSampler::temp(0.3),
            LlamaSampler::dist(42),
        ]);
        let mut pending: Vec<u8> = Vec::new();
        let mut filter = ThinkFilter { buf: String::new(), in_think: false };
        let mut emit = |t: &str| {
            if qwen3 {
                filter.push(t, &mut on_text);
            } else {
                on_text(t);
            }
        };
        for _ in 0..max_new {
            if self.cancel.load(Ordering::SeqCst) || pos as u32 >= N_CTX - 1 {
                break;
            }
            let token = sampler.sample(&ctx, batch.n_tokens() - 1);
            if vocab.is_eog(token) {
                break;
            }
            pending.extend(vocab.token_to_piece(token, false, None));
            // Emit only complete UTF-8 sequences; keep partial bytes for the next token.
            let valid = match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                Err(err) if err.error_len().is_some() => {
                    // Genuinely invalid bytes: flush lossily rather than stall.
                    emit(&String::from_utf8_lossy(&pending));
                    pending.clear();
                    0
                }
                Err(err) => err.valid_up_to(),
            };
            if valid > 0 {
                emit(std::str::from_utf8(&pending[..valid]).unwrap_or_default());
                pending.drain(..valid);
            }
            batch.clear();
            batch.add(token, pos, &[0], true).map_err(e)?;
            pos += 1;
            ctx.decode(&mut batch).map_err(e)?;
        }
        if qwen3 {
            filter.flush(&mut on_text);
        }
        Ok(())
    }
}
