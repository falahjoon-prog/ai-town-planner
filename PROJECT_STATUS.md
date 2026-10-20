# PROJECT_STATUS – AI Town Planner

## Architecture
- **App:** Tauri 2 (Rust core + Vite/TypeScript UI). One codebase for desktop (Windows/Mac/Linux), with Android/iOS to follow.
- **Data pack:** SQLite built by `pipeline/build_datapack.py` (GitHub Action "Build data pack", published as a release asset `datapack.sqlite.gz`). It holds BCC parcels with addresses, plus every `cp14-*` City Plan 2014 spatial dataset, using an R*Tree index. Data © Brisbane City Council, CC BY 4.0.
- **Rules engine:** `src-tauri/src/rules.rs` gives deterministic zone identification and overlay flags from `knowledge/zones.json` and `knowledge/rules.json`.
- **Spatial:** `src-tauri/src/data.rs` finds overlays by lot/feature area overlap (geo crate), which avoids false hits from boundaries that only touch.
- **AI:** `src-tauri/src/llm.rs` runs llama.cpp on-device (`llama-cpp-2` crate; Metal on Mac, CPU elsewhere). The GGUF model downloads once from Settings: Qwen3 4B (compact) or Qwen2.5 7B (professional). ChatML prompt.
- **Builds:** GitHub Action "Build app" uses tauri-action and publishes installers to a release tagged `app-vX.Y.Z`.

## Completed
- Phase 1 code: pipeline, Rust core, UI (search, map, zoning and constraints, AI report, save HTML), CI workflows.

## Current issues
- The cloud workspace has no package registry access, so all compiling and testing happens in GitHub Actions.
- The Windows build is CPU-only for AI (Vulkan GPU support comes later).
- The level of assessment is not yet encoded; the report flags it as indicative.

## Next steps
1. Get the CI builds green, then run the data pack workflow.
2. Encode the Part 5 tables of assessment for common uses.
3. Add state layers (SPP, Queensland Heritage Register, koala).
4. Android and iOS builds.
5. Auto-update the data pack.
