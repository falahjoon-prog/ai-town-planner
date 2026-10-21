# PROJECT_STATUS – AI Town Planner

## Architecture
- **App:** Tauri 2 (Rust core + Vite/TypeScript UI). One codebase for desktop (Windows/Mac/Linux), with Android/iOS to follow.
- **Data pack:** SQLite built by `pipeline/build_datapack.py` (GitHub Action "Build data pack", published as a release asset `datapack.sqlite.gz`). It holds BCC parcels with addresses, plus every `cp14-*` City Plan 2014 spatial dataset, using an R*Tree index. Data © Brisbane City Council, CC BY 4.0.
- **Rules engine:** `src-tauri/src/rules.rs` gives deterministic zone identification and overlay flags from `knowledge/zones.json` and `knowledge/rules.json`.
- **Spatial:** `src-tauri/src/data.rs` finds overlays by lot/feature area overlap (geo crate), which avoids false hits from boundaries that only touch.
- **AI:** `src-tauri/src/llm.rs` runs llama.cpp on-device (`llama-cpp-2` crate; Metal on Mac, CPU elsewhere). The GGUF model downloads once from Settings: Qwen3 4B (compact) or Qwen2.5 7B (professional). ChatML prompt.
- **Builds:** GitHub Action "Build app" uses tauri-action and publishes installers to a release tagged `app-vX.Y.Z`.

## Completed
- v0.1: pipeline, Rust core, UI (search, map, zoning and constraints, AI report, save HTML), CI workflows.
- v0.2: report split by authority (Council / SARA / EDQ-PDA / State / Other / Summary); "Ask the planner" chat; AI engine choice (built-in, Ollama, Claude API, OpenAI-compatible; keys stored in the OS keychain via `ai.rs`); state layers (SCR 25 m trigger, koala, wetlands, RVM, coastal, PDA, ShapingSEQ); PDA recognition; PDF export via print.
- All builds are green on Windows, Mac and Linux.

## Current issues
- The cloud workspace has no package registry access, so all compiling and testing happens in GitHub Actions.
- The Windows build is CPU-only for AI (Vulkan GPU support comes later).
- The level of assessment is not yet encoded; the report flags it as indicative.

## Next steps
1. Development potential tab: City Plan text library (RAG) for height, site cover, density, parking and subdivision tables; lot dimensions and a subdivision sketch on the map; a 3D envelope; aerial imagery (cached).
2. Suburb report (ABS / QGSO).
3. In-app data pack download (needs a public data repo, or a fix for the user's GitHub sign-in).
4. Android and iOS builds; Windows GPU (Vulkan).
