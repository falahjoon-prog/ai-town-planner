# Work threads (briefs) – PlanLens / AI Town Planner

Coordinator: the Town Planning project chat. Threads are started one at a time after the current build result is known, because all of them touch `src/main.ts`. Max 3 coding threads at once. Each thread lives one day at most and ends with the report below.

Common rules for every thread
- Repo falahjoon-prog/ai-town-planner, branch from fresh `main`. Model: Sonnet (routine coding).
- One feature per PR; minimal patches; name files before editing; no new design docs.
- CI ("Build app" and the type check inside it) is the gate. After push: subscribe to PR activity, post a one-line status, end the turn; one check-in at 20-30 min; no polling.
- Merge yourself when CI is green on the head commit. Merge `main` first if you touched `src/main.ts`, `index.html` or `src/style.css` and another thread did too.
- Frontend: check 375/768/1280 px, light and dark, before/after screenshots.
- Report at the end: 1) files changed 2) work completed 3) tests performed with results 4) remaining issues; update this file.

## T1 – Fix and verify the v0.4.2 layout and forms page
- Goal: the PlanLens layout, forms page and setbacks section build and work on Windows.
- Read first: `src/main.ts` (search "Forms page", "Layout: full map"), `index.html`, `src/style.css`, build log of the latest "Build app" run.
- In: fix compile errors if any; check Full map rail, drag handles, forms autosave, helper focus text, answer-sheet PDF.
- Out: new features; setback numbers.
- Default chosen: map styles stay Plain, Street, Aerial.

## T2 – Open map zooms to the searched address
- Goal: "Open map" opens the chosen state map centred on the loaded address, not the general map.
- Read first: `src/maps.json`, `src/main.ts` (`mapUrlFor`, `STATE_MAPS`).
- In: add an `at` URL template per map with {lat}/{lng}; verify each template by opening it; Queensland Globe first, then the Brisbane council map.
- Out: embedding maps in the app (all map links open in the browser).
- Default chosen: if a map has no verified template, it opens the general map as today.
- Shared files: `src/main.ts` also touched by T1 (merge main first).

## T3 – Setback distances from City Plan (research, then data)
- Goal: setbacks for low density residential shown from verified City Plan values, with the source for each number.
- Read first: `src-tauri/knowledge/zones.json`, `src-tauri/src/rules.rs` (section on facts for the prompt), `renderSetbacks` in `src/main.ts`.
- In: find the dwelling house code setback provisions on the Brisbane City Plan site, record each value with its code reference, add `src-tauri/knowledge/setbacks.json`, show it in the Setbacks section; corner, laneway and special-area lots say "check with council".
- Out: drawing the building envelope on the map (separate package after the numbers exist).
- Model: Sonnet for the build; Opus briefly only if the code reading needs it.
- Rule: never invent a number; no source means no row.

### T3 report (blocked, no PR opened)
1) Files changed: handoffs/threads.md only.
2) Work: could not verify any setback number. Brisbane pages fetched (rules-boundary-setback, residential-development-in-suburban-zones) contain no setback values; they point to QDC MP 1.2 (lots 450 m2+) and QDC MP 1.1 / City Plan Dwelling house (small lot) code. The Queensland Housing Code PDF and the City Plan fact sheet were blocked (WebFetch permission not answered; curl 403). Existing src-tauri/knowledge/setbacks.json (QHC Table 1 A2.1, Table 3 A3.1; already warns "do not rely") is unverified by this thread and left unchanged.
3) Tests: none run (no code changed).
4) Remaining: approve WebFetch for housing.qld.gov.au PDF and the City Plan online dwelling house code / QDC MP 1.2 page, then rerun T3; decide whether to drop the unverified rows meanwhile.

## Not threads yet (blocked)
- Approval likelihood, timeframes, activity by company: needs approvals files from the owner (Gold Coast 12-month file is the candidate).
- Infrastructure charges for all councils: research package, start after T3.
- Watch service: needs a hosting and cost decision from the owner.

### T1 report
1) Files changed: src/main.ts (removed duplicate `let poly` in setbacks buildable-area code, TS2451); handoffs/threads.md.
2) Work completed: fixed the only `tsc` error on feature/map-picker v0.4.2 head 678bd88. Targeted code review of rail/handles/autosave/PDF was not done in depth.
3) Tests: `npx tsc --noEmit` clean; `npx vite build` OK. Cargo/Windows build left to CI.
4) Remaining: CI result on the new head pending; Rust side and the UI items (rail, handles, autosave, focus text, PDF) not manually verified.
