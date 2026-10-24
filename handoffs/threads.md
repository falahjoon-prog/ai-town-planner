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

## Not threads yet (blocked)
- Approval likelihood, timeframes, activity by company: needs approvals files from the owner (Gold Coast 12-month file is the candidate).
- Infrastructure charges for all councils: research package, start after T3.
- Watch service: needs a hosting and cost decision from the owner.

### T1 report
1) Files changed: src/main.ts (removed duplicate `let poly` in setbacks buildable-area code, TS2451); handoffs/threads.md.
2) Work completed: fixed the only `tsc` error on feature/map-picker v0.4.2 head 678bd88. Targeted code review of rail/handles/autosave/PDF was not done in depth.
3) Tests: `npx tsc --noEmit` clean; `npx vite build` OK. Cargo/Windows build left to CI.
4) Remaining: CI result on the new head pending; Rust side and the UI items (rail, handles, autosave, focus text, PDF) not manually verified.

### T4 report – chat docked in right panel
1) Files: index.html, src/main.ts, src/style.css, handoffs/threads.md.
2) Done: chat no longer floats over the map. It is now a section of the right column (below the address bar) that replaces the site panel while open; "Ask" button moved next to the address box; same input/Send/close/history; Escape closes; opening it from Full map restores the right column. Old floating-dialog CSS/handlers removed. Chose a docked section, not a tab, because the site panel's tabs are scroll links and the panel is hidden before an address is loaded.
3) Tests: tsc --noEmit clean; vite build OK; headless Chromium at 375/768/1280, light and dark: no horizontal scroll, chat never overlaps the map at 768/1280 (at 375 the existing desktop layout already collapses the map to 0 width; unchanged). Only console error is Tauri invoke missing in a plain browser (pre-existing).
4) Remaining: 375 px layout not mobile-responsive (pre-existing); chat not tested with a live AI engine or a loaded site.

### T5 report – right panel icon rail (Option B)
1) Files: index.html, src/main.ts, src/style.css, handoffs/threads.md.
2) Done: right panel is now one card, width 340-520 px (40vw), with a 76 px icon rail (Zoning, Setbacks, Constraints, Potential, Approvals, Checklist, Forms, Assistant pinned bottom) replacing the pill tabs. Choice: one section at a time (rail click swaps the visible section; suburb report sits under Zoning, title and notes under Checklist, AI report opens via "Generate AI report"). Search row has input, saved/recent dropdown button, save star, theme toggle; plan number and suburb line; Lot / Zone / Flags tiles (flags = constraints + mapped layers) with empty state. Zones and constraints are compact cards (COUNCIL/STATE badge, title, 2-line text, chevron expands per card). Footer buttons stay pinned. Assistant rail item reuses the T4 chat. Old pill tabs, address block, section toggles and .zone/.flag/.phead/.jump CSS removed. Resize handle kept (range now 340-700).
3) Tests: tsc --noEmit clean; vite build OK; headless Chromium (mocked Tauri invoke with sample data) at 1280/768/375, light and dark: no horizontal scroll, no console errors besides mock null geometry; screenshots in /tmp/claude-0/shots/ (before-* and after-*).
4) Remaining: 768 px panel is tight (340 px); 375 px not mobile-responsive (pre-existing); other sections (setbacks table, potential, checklist, forms) not visually reviewed with real data; CI/Windows build pending.

## T6 – Slim tools rail and tighter cards (PR into t5-right-panel-rail)
1) Files: index.html, src/main.ts, src/style.css, handoffs/threads.md.
2) Done: left column is now a 56 px icon rail (app icon on top, 7 tool buttons with SVG icon, title tooltip, aria-label, same ids/order/actions, hover/focus/on states); old logo card, text labels, `--left` clamp, left grip and its drag/localStorage code removed (fixed width makes resizing pointless; right grip kept). Full map still adds Map style and Exit full map to the rail. Right panel: section title 18->15 px, tile value 15->14, finding card title 14.5->14, card/panel padding 10-12 px, setbacks table 12.5 px with 5 px cell padding. At <=900 px right panel is 380 px, tiles go 2 columns with Zone full width, map tools wrap. Map gains about 90 px at 1280.
3) Tests: tsc --noEmit clean; vite build OK; headless Chromium with mocked invoke at 768/1280/1920, light and dark, constraints and setbacks: no horizontal scroll, no clipped text, no page errors; full map checked at 1280. Shots in /tmp/claude-0/shots/t6-before-* and t6-after-*.
4) Remaining: at 768 the map is only about 300 px wide; at 1280 the right panel is still 512 px (40vw), the main lever for more map width; other sections (potential, checklist, forms, assistant) only checked indirectly via shared tokens.

## T7 report – rail to right edge
1) Files: src/style.css (line 56 `.rail`: `order: 2`, border-right -> border-left), handoffs/threads.md.
2) Done: rail is now the outermost element on the panel's right edge; content sits next to the map; grip, widths, Full map and chat unchanged. No dead CSS (swap only).
3) Tests: tsc --noEmit ok; vite build ok; headless Chromium 768/1280/1920 light+dark: no horizontal scroll, no clipped text, rail x 1197-1273 / content 763-1197 at 1280, grip drag 762->673 works. Shots /tmp/claude-0/shots/t7-before-* and t7-after-*.
4) Remaining: none known.

## T8 report – Compare dialog address entry (branch t8-compare-entry, stacked on t7-rail-right)
1) Files: index.html, src/main.ts, src/style.css, handoffs/threads.md.
2) Done: address search input in Compare dialog using new shared `findAddresses()` (main search `runSearch` now uses it too, no second search); picked result is added as a checked row, max 3, limit message, Remove button on added rows, Compare disabled until 2-3 ticked; dialog width min(940px, 92vw), max 85vh, larger rows/font, title/X pinned; comparison output code unchanged.
3) Tests: `tsc --noEmit` and `vite build` pass; headless Chromium (mocked invoke) at 768/1280, light/dark: dialog fully inside viewport, no horizontal scroll, add/remove/limit/disable verified; shots /tmp/claude-0/shots/t8-before-* and t8-after-*. Not tested: Google suggest path (no key), real Windows build.
4) Remaining: none known; 375 px not checked.

## T9 report – wider right panel
1) Files: src/main.ts (maxRight/clampRight, drag clamp), src/style.css (.rcontent container, two-column cards >=900px), handoffs/threads.md.
2) Done: grip drags to max = window - 94px chrome - max(200px, 20%) (about 75-78%, map keeps >=20%/200px); min stays 340; resize and stored-width restore clamp to the new max; old fixed 700 clamp removed; no grip double-click reset existed (Window > Reset panel widths unchanged); zone/flag cards go 2 columns when content is over 900px, tiles stay 3 across.
3) Tests: tsc and vite build clean; headless Chromium 1280/1920 light+dark: max (930/1442 px), min (340), shrink 1920->1000 clamps 1442->706, reload keeps clamp; no horizontal scroll, no page errors, map visible (>=206 px) and grip reachable. Shots /tmp/claude-0/shots/t9-*.
4) Remaining: map minimum counts side chrome so max is about 75% not a flat 80%; chat view only checked for no errors at max width.

## T10 – Slim panel chrome
1) Files: index.html (rail buttons icon-only with title+aria-label), src/style.css (.rail 48px, .sqbtn 32px/16px icons, #q flex:1, .panelfoot nowrap), handoffs/threads.md.
2) Done: rail 76->48px icon-only (40px targets, labels and unused label CSS removed); address row buttons 32px square, input takes remaining width; Generate AI report and Client PDF always in one row.
3) Tests: tsc and vite build clean; headless Chromium 768/1280/1920 light+dark, default and 340px min: rail 48px, 0 buttons without name/tooltip, address input 152-332px, buttons one row, no clipping, no horizontal scroll; chat view opens. Shots: /tmp/claude-0/shots/t10-*.
4) Remaining: at 340px the address input is about 152px (long addresses still truncate); rail tooltips are native title only.

### T11 report (branch t11-fast-chat, PR into t10-slim-chrome)
1) Files: src-tauri/src/llm.rs, src-tauri/src/lib.rs (chat/assistant max_new 900 -> 512), handoffs/threads.md.
2) Done: Qwen3 non-2507 GGUFs get an empty think block prefilled; ThinkFilter strips any `<think>` text from streamed output (Qwen3 only, no buffering except a partial tag); n_threads/n_threads_batch set to ~half of logical CPUs (min 4) instead of the crate default. Model is already cached across messages. Note: the catalog Qwen3-4B-Instruct-2507 has no thinking mode, so the minute was mostly CPU prefill of the long system prompt (app guide + site facts) in a fresh context per message plus default threads.
3) Tests: Rust NOT compiled locally (no cargo registry); diff re-read for types/borrows. CI Build app is the gate. tsc/vite unaffected (no TS change).
4) Remaining: context/KV-cache reuse across messages (prefix reuse) not done (risky refactor, biggest remaining win); shorter system prompt for the assistant; physical-core count is estimated (no num_cpus crate); 512 limit also applies to Ollama/API for chat+assistant.

## T12 report (branch t12-tiles-sticky, PR against t11-fast-chat)
1) Files: index.html (grip title), src/style.css, src/main.ts, handoffs/threads.md.
2) Done: slim tiles strip (cols .8/1.6/.8fr, 43 px high, 10/13 px text); Proposal type row sticky in .pbody with opaque panel bg and border; saved/recent and search results as floating popover (Escape, outside click, pick closes; aria-haspopup/expanded; old inline margin/hint rules removed); grip is full-height 12 px hit zone with hover/drag accent line, pointer capture, double-click expand/restore (150 ms transition, reduced-motion aware, persists colRight).
3) Tests: tsc and vite build pass; headless Chromium 1280/1920 light/dark, default and 340 px: tiles 43 px, zone not clipped at default (clipped with ellipsis at 340), no horizontal scroll, popover moves nothing and closes on Esc/outside, sticky row gap 0 while scrolled, drag from top/mid/bottom works, dbl-click expands (930 / 1442 px) and restores. Shots: /tmp/claude-0/shots/t12-*.
4) Remaining: zone name still ellipsised at 340 px (title tooltip kept); typed-search results also use the popover.

### T13 report (map legend compact, PR against t12-tiles-sticky)
1) Files: src/style.css (.legend rules; removed old .legend + short-window override), handoffs/threads.md.
2) Done: legend now 11.5px labels, 10.5px note (wraps, max-width 260px), 10px swatches, 6/8px padding, 3px line gap, 8px radius, 86% panel surface, bottom-left at 8px/64px (just above the style bar). Same #legend container serves flood and power legends, so both get it; content unchanged.
3) Tests: tsc and vite build pass; headless Chromium at 768/1280/1920, light+dark, injected power legend: no overlap with style bar or attribution (at 768 the pre-existing attribution/bar overlap is unchanged), no clipping, no page errors. Shots: /tmp/claude-0/shots/t13-{before,after}-*.png.
4) Remaining: map pane is narrow (about 300 px at 768), so the legend cannot sit lower than the style bar's top without overlapping it; it is kept above the bar.

### T14 report
1) Files changed: index.html, src/main.ts, src/style.css, handoffs/threads.md. No Rust.
2) Work completed: "Open the last address on start" Settings checkbox (default on; silent if the address no longer resolves; last address, map style and state map were already persisted). Old overwrite-and-reload backup replaced by versioned (v2, v1 files still read) backup `planlens-backup-YYYY-MM-DD.json` (saved/recent addresses, notes, checklist ticks, DA forms, non-secret settings; no keys) and a validated merge restore with a counts confirm (newer ts wins notes/title, stars and ticks unioned, nothing deleted). Reuses existing save/open dialogs and save_text/read_backup.
3) Tests: tsc clean; vite build OK; headless Chromium (mocked invoke) light and dark 1280: reload restores address and map style; toggle off gives empty start; unresolvable address gives no dialog; backup JSON has no secret; merge and counts correct; 4 corrupt/wrong files show a message and change nothing. Shots /tmp/claude-0/shots/t14-*.
4) Remaining: CI result pending (Rust untouched); 375/768 not checked; notes only have a lot-level timestamp (site ts), not a per-note one.

### T15 report (project folders, PR against t14-remember-backup)
1) Files changed: index.html, src/main.ts, src/style.css, handoffs/threads.md. No Rust.
2) Done: projects (id, name, optional client, optional note, created) in localStorage "projects"; the address-to-project link is `project` on the site record (one project per address, so no separate site-id list). Saved/recent dropdown: project filter select (All, Unfiled, each), New / Rename / Delete (inline form, delete asks first and only unfiles), rows grouped by project under All, per-row "Move to project" select. Compare dialog: project filter plus "Select all in project (up to 3)". Backup now version 3 (adds projects and site links; v1 and v2 still read); restore merges projects by id (existing wins, missing added, never deleted) and fills a missing site link. Old showRecents replaced.
3) Tests: tsc clean; vite build OK; headless Chromium (mocked invoke) light and dark at 1280 and 340 px panel: create 2 projects, move, filter, rename, delete (addresses remain), reload persists, backup v3 has projects, v2 file and v3 restore merge with no duplicates; no horizontal scroll; popover inside panel; no page errors. Shots /tmp/claude-0/shots/t15-*.
4) Remaining: batch check not touched; 375/768 viewports not checked; no "new project" from inside the move select; project filter choice is not remembered across restarts.

### T16 report (map markup, PR against t15-project-folders)
1) Files changed: index.html, src/main.ts, src/style.css, src-tauri/src/lib.rs (new `save_bytes` command; no existing binary write existed for the PNG), handoffs/threads.md.
2) Done: "Annotate map" tool (pencil) with bar: Arrow, Rectangle, Text label (+ label input), Freehand pen, 5 colour swatches (red, orange, blue, green, white), Undo, Clear, Save map image (PNG), Done. Shapes are SVG in an overlay, stored as lng/lat so they follow pan/zoom (wheel zoom passes through while drawing), persisted per lot as `marks` on the site record (same store as notes; kept by saveSites). PNG and client PDF/HTML report use one capture (`map.getCanvas()`) with marks drawn on top at canvas resolution; no marks = plain snapshot as before. Labels are filled boxes with white outlined text. Esc/Done leave the tool; starting a measure tool closes it. Also in Tools menu. Selection/Delete skipped: Undo/Clear only.
3) Tests: tsc clean; vite build OK; headless Chromium, mocked invoke, light/dark at 1280 and 768: draw all 4 shapes, colour change, undo, clear, PNG export (save_bytes called, data URL decodes), PDF path embeds annotated image (larger than plain), plain image after Clear, Esc closes, persisted marks count correct, no horizontal scroll, bar wraps and fits.
4) Remaining: 375 px not tested (map is behind the panel there, pre-existing); real Tauri save_bytes (Rust) only verified by CI build; dragging to pan is blocked while Annotate is on (use Done); no shape selection.

### T17 report (statutory clock + possible referrals, PR against t16-map-markup)
1) Files changed: index.html, src/main.ts, src/style.css, src-tauri/knowledge/timeframes.json (new), src-tauri/knowledge/referrals.json (new, no rows), handoffs/threads.md. No Rust (JSON is imported by TS like setbacks.json).
2) Done: Approvals section (renamed "Approvals, clock & referrals"; better fit than Checklist because it is the process after lodgement) has a Lodgement date input and Code/Impact select, saved per lot in the sites store (`lodged`, `path`; kept like notes), and a list of latest dates: confirmation notice 10 bd, information request 10 bd, applicant response 3 months, public notification start 20 bd and period 15 bd (impact, 20 Dec-5 Jan skipped), decision 35 bd, decision notice 5 bd, applicant and submitter appeal 20 bd. Every row has source name+URL and a verify pill; all rows are verify=true because DA Rules v3.0 and Planning Act text could not be fetched (legislation.qld.gov.au refused; v3 PDF blocked). Sources: Dept DA Rules guidance (July 2025), DA Rules v2.0 PDF, a 2019 Brisbane appeal-rights table. Qld/Brisbane public holidays 2026-2027 (incl. Ekka 12 Aug 2026, 11 Aug 2027) from qld.gov.au are in timeframes.json; UI warns when dates pass the loaded years. "Possible referrals" list with the label "Indicative only: confirm with the State Assessment and Referral Agency (SARA) or council" is built (matches detected flag ids to referrals.json rows); the data file has no rows and the UI says "No sourced rules loaded yet."
3) Tests: tsc clean; vite build OK; headless Chromium (mocked invoke) light/dark at 1280 and 340 px: no horizontal scroll, no page errors. Business-day maths cross-checked against an independent Python calc for 3 lodgement dates (weekends, Ekka holiday, Dec-Jan exclusion): all dates match. Per-lot persistence and reload verified. Referral matching verified with a temporary test row (matched shown, non-matching hidden), then removed. Shots /tmp/claude-0/shots/t17-*.
4) Remaining: no referral rows shipped; needed from owner: Planning Regulation 2017 Schedule 10 PDF and the Brisbane City Plan referral list. To clear verify flags: Planning Act 2016 PDF (ss53, 229, Sch 1, Sch 2 "business day") and DA Rules v3.0 PDF (rule numbers, start points for info request and decision, notice of compliance, referral stage). Assumptions: no referral agency, no stop-the-clock, no local holidays other than Ekka, no holidays after 2027. CI result pending.
