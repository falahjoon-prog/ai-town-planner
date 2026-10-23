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
- v0.2: report split by authority; "Ask the planner" chat; AI engines (built-in, Ollama, Claude API, OpenAI-compatible; OS keychain); State layers; PDA; PDF via print.
- v0.3.x: development potential (lot dimensions, provisions with sources, subdivision yield and sketch), forms with exact links and AI drafts (DA Form 1 as a form, cover letter), data-centre power infrastructure (Geoscience Australia), flood map, contours, Maps dialog (78 councils), in-app data pack download (repo is public), typo-tolerant search, optional Google Places search, saved/recent addresses with notes, title search links with AI summary of the title PDF, light/dark theme, ✕ close and pinned dialog titles, easement layer + rule.
- v0.4.0: base map (plain/street/aerial – Queensland Government imagery), level of assessment and key numbers by zone for house/dual occupancy/multiple dwelling (v36–v37 2026 sources), multiple-dwelling parking rates (v36.00/2026), Council infrastructure charge estimate for subdivisions (Resolution No. 15 2026), DA register button (Development.i), client-ready PDF (branding, map snapshot, constraints by authority, potential, title, notes), 3D height envelope, suburb lot-size report, compare 2–3 sites, frontage fix (road/easement polygons ignored).

## Completed (cont.)
- v0.4.2 (PlanLens layout): left tools column with logo; map in the middle with map styles and Full map under it; right column with address bar and collapsible side panel (pinned header, jump links); Full map keeps a slim tool rail; side columns resize by drag.
- v0.4.2 forms page: DA Form 1 (v1.3) editable and numbered as on the PDF, saved per lot on this PC; form helper that knows the current part and question; download list with blank forms and answer-sheet PDF. Declarations and Part 9 are never ticked or filled by the app.
- v0.4.2 setbacks section: rows from knowledge/setbacks.json (Queensland Housing Code Chapter 2, lots 450 m² and over, flagged verify); other lots say check with council.
- v0.4.2 (cont.): window size and fit, remembers last site/map/columns, backup and restore, batch address check (CSV), lodgement checklist, setback area drawn on the map (indicative, convex lots with one frontage only).

## Current issues
- No package registry access in the cloud workspace: compile and test happen only in GitHub Actions; the app is not run by the developer – the user tests on Windows.
- Windows AI is CPU-only (Vulkan later).
- Level of assessment is encoded only for common residential uses; other uses link to the City Plan tables. Several numbers come from secondary sources and are flagged "verify".
- Dwelling infrastructure charges (Table B/C) not encoded – only the per-lot rate.
- No open Brisbane DA register dataset found: nearby approvals is a link, not an in-app list.
- Setback distances per zone are not in the data pack; need verified City Plan values before showing numbers.
- Forms page not yet tested on Windows; helper uses the existing chat command with form context.
- Frontage fix assumes BCC parcel type/tenure fields mark roads; unconfirmed until tested on 28 Eden Elm St.

## Next steps
1. User testing of v0.4.0 on Windows (report, chat, PDF, aerial, 3D, compare).
2. City Plan code text library (quote acceptable outcomes), more uses and zones in the level-of-assessment tables, site cover.
3. Full data pack rebuild with the easement layer (test pack first).
4. Android and iOS builds; Windows GPU (Vulkan).
