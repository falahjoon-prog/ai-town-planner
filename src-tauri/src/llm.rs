//! On-device LLM via llama.cpp (GGUF models, ChatML prompt format).
use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaModel, Special};
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
const MAX_NEW: usize = 1800;
const CHUNK: usize = 512;

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
        system: &str,
        user: &str,
        mut on_text: impl FnMut(&str),
    ) -> Result<(), String> {
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

        let prompt = format!(
            "<|im_start|>system\n{system}<|im_end|>\n<|im_start|>user\n{user}<|im_end|>\n<|im_start|>assistant\n"
        );
        let ctx_params = LlamaContextParams::default().with_n_ctx(NonZeroU32::new(N_CTX));
        let mut ctx = model.new_context(backend, ctx_params).map_err(e)?;
        let tokens = model.str_to_token(&prompt, AddBos::Never).map_err(e)?;
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
        for _ in 0..MAX_NEW {
            if self.cancel.load(Ordering::SeqCst) || pos as u32 >= N_CTX - 1 {
                break;
            }
            let token = sampler.sample(&ctx, batch.n_tokens() - 1);
            if model.is_eog_token(token) {
                break;
            }
            pending.extend(model.token_to_bytes(token, Special::Tokenize).map_err(e)?);
            // Emit only complete UTF-8 sequences; keep partial bytes for the next token.
            let valid = match std::str::from_utf8(&pending) {
                Ok(_) => pending.len(),
                Err(err) if err.error_len().is_some() => {
                    // Genuinely invalid bytes: flush lossily rather than stall.
                    on_text(&String::from_utf8_lossy(&pending));
                    pending.clear();
                    0
                }
                Err(err) => err.valid_up_to(),
            };
            if valid > 0 {
                on_text(std::str::from_utf8(&pending[..valid]).unwrap_or_default());
                pending.drain(..valid);
            }
            batch.clear();
            batch.add(token, pos, &[0], true).map_err(e)?;
            pos += 1;
            ctx.decode(&mut batch).map_err(e)?;
        }
        Ok(())
    }
}
