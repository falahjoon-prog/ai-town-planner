import { invoke, Channel } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { marked } from "marked";
import MAPS from "./maps.json";
import FORMS from "../src-tauri/knowledge/forms.json";
import SETBACKS_DATA from "../src-tauri/knowledge/setbacks.json";
import TIMEFRAMES_DATA from "../src-tauri/knowledge/timeframes.json";
import REFERRALS_DATA from "../src-tauri/knowledge/referrals.json";
import COUNCILS_DATA from "../src-tauri/knowledge/councils.json";
import COUNCIL_RULES from "../src-tauri/knowledge/council_rules.json";
import "./style.css";

type Hit = { pid: number; address: string; lotplan: string; suburb: string; council?: string };
// Council registry entry (src-tauri/knowledge/councils.json, shared with the data pack pipeline)
type Council = { id: string; name: string; short: string; scheme: string; scheme_url: string; maps_url?: string; maps_name?: string; website?: string; da_url?: string; da_name?: string; water?: { name: string; url: string }; title_prefix?: string; zones_loaded?: boolean };
const COUNCILS = COUNCILS_DATA as unknown as Council[];
/** Councils with no zone or overlay data in the pack (zones_loaded false in the registry) say so instead of showing blank or wrong data. */
const NO_ZONE = "Zone not loaded for this council yet";
const zonesMissing = (c: Council) => c.zones_loaded === false;
const councilOf = (id?: string): Council => COUNCILS.find((c) => c.id === (id || "brisbane")) ?? COUNCILS[0];
type Overlay = { authority: string; council?: string | null; distance_m: number | null; dataset_id: string; title: string; props: Record<string, unknown>; coverage_pct: number | null; geom: any };
type Assessment = {
  parcel: { pid: number; lotplan: string; address: string; suburb: string; council?: string; area_m2: number | null; geom: any };
  zones: { authority: string; zone: { name: string; purpose: string; typical: string; source?: string; url?: string; verify?: boolean }; precinct?: string | null; coverage_pct: number | null }[];
  flags: { rule: { id: string; authority: string; title: string; code: string; note: string; checklist: string[]; council?: string; url?: string }; layers: string[] }[];
  overlays: Overlay[];
  manifest: Record<string, string>;
  council?: Council;
};
/** The council of the loaded site (Brisbane for older data packs). */
const siteCouncil = (a: Assessment | null = current): Council => (a?.council as Council | undefined) ?? councilOf(a?.parcel.council);
/** Source badge: council findings name the council, others use the authority label. */
const authLabel = (authority: string, a: Assessment | null = current) => (authority === "council" ? `${siteCouncil(a).short} council` : AUTH[authority] ?? authority);
const zoneTitle = (z: Assessment["zones"][number]) => (z.precinct ? `${z.zone.name} – ${z.precinct}` : z.zone.name);
/** Councils covered by the installed data pack (from its manifest), else the registry. */
function packCouncils(): string[] {
  try {
    const list = JSON.parse(status?.datapack?.councils ?? "[]") as { name: string }[];
    if (list.length) return list.map((c) => c.name);
  } catch { /* older pack without a council list */ }
  return status?.datapack ? [status.datapack.region] : COUNCILS.map((c) => c.name);
}
type ModelStatus = { id: string; name: string; file: string; size_gb: number; min_ram_gb: number; note: string; installed: boolean; active: boolean };
type AiSettings = { provider: string; model: string | null; ollama_url: string; ollama_model: string; anthropic_model: string; openai_base: string; openai_model: string };
type Status = {
  datapack: Record<string, string> | null; models: ModelStatus[]; custom_models: string[]; active_model: string | null;
  ai: AiSettings; has_anthropic_key: boolean; has_openai_key: boolean; has_google_key: boolean; disclaimer: string;
};
const AUTH: Record<string, string> = { council: "Council", sara: "SARA", pda: "EDQ (PDA)", state: "State", other: "Other" };
const val = (id: string) => ($(id) as HTMLInputElement).value.trim();
const setVal = (id: string, v: string) => (($(id) as HTMLInputElement).value = v ?? "");

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let current: Assessment | null = null;
let sections: { key: string; title: string; text: string }[] = [];
let activeTab = "";
let chatHistory: { role: string; content: string }[] = [];
let status: Status | null = null;
let map: maplibregl.Map | null = null;

async function refreshStatus(): Promise<Status> {
  const s = await invoke<Status>("status");
  const p = s.datapack;
  $("packInfo").textContent = p ? `Data: ${p.region} · ${p.built_at}` : "No data pack: open Settings";
  $("packDetail").textContent = p
    ? `${p.region} · built ${p.built_at} · ${Number(p.parcels).toLocaleString()} lots · ${p.layers} planning scheme and state layers. ${p.attribution}`
    : "No data pack installed yet. Download the latest datapack .sqlite.gz from the GitHub Releases page, then import it here.";
  $("disclaimer").textContent = s.disclaimer;
  status = s;
  renderModels(s);
  renderAi(s);
  return s;
}

function renderAi(s: Status) {
  const ai = s.ai;
  document.querySelectorAll<HTMLInputElement>('input[name="provider"]').forEach((r) => (r.checked = r.value === ai.provider));
  setVal("ollamaUrl", ai.ollama_url);
  setVal("anthropicModel", ai.anthropic_model);
  setVal("openaiBase", ai.openai_base);
  setVal("openaiModel", ai.openai_model);
  ($("anthropicKey") as HTMLInputElement).placeholder = s.has_anthropic_key ? "Key saved. Type to replace (or clear by saving blank spaces)" : "Claude API key (sk-ant-…)";
  hasGoogle = s.has_google_key;
  ($("googleKey") as HTMLInputElement).placeholder = s.has_google_key ? "Google key saved. Type to replace" : "Google Places API key (optional – better address search)";
  ($("openaiKey") as HTMLInputElement).placeholder = s.has_openai_key ? "Key saved. Type to replace" : "API key";
  const sel = $("ollamaModel") as HTMLSelectElement;
  if (ai.ollama_model && ![...sel.options].some((o) => o.value === ai.ollama_model)) sel.add(new Option(ai.ollama_model, ai.ollama_model));
  sel.value = ai.ollama_model;
  showProviderCfg();
}

function showProviderCfg() {
  const p = document.querySelector<HTMLInputElement>('input[name="provider"]:checked')?.value ?? "builtin";
  document.querySelectorAll<HTMLElement>(".pcfg").forEach((d) => (d.hidden = d.dataset.for !== p));
  if (p === "ollama" && ($("ollamaModel") as HTMLSelectElement).options.length === 0) loadOllama();
}

async function loadOllama() {
  const sel = $("ollamaModel") as HTMLSelectElement;
  try {
    const models = await invoke<string[]>("ollama_models", { url: val("ollamaUrl") || "http://localhost:11434" });
    const keep = sel.value || status?.ai.ollama_model || "";
    sel.innerHTML = models.map((m) => `<option>${esc(m)}</option>`).join("");
    if (models.includes(keep)) sel.value = keep;
    $("aiMsg").textContent = models.length ? `${models.length} Ollama model(s) found.` : "Ollama has no models. Run e.g. 'ollama pull qwen2.5:7b'.";
  } catch (e) {
    $("aiMsg").textContent = String(e);
  }
}

document.querySelectorAll('input[name="provider"]').forEach((r) => r.addEventListener("change", showProviderCfg));
$("ollamaRefresh").addEventListener("click", loadOllama);
$("saveAi").addEventListener("click", async () => {
  const provider = document.querySelector<HTMLInputElement>('input[name="provider"]:checked')?.value ?? "builtin";
  const settings: AiSettings = {
    provider,
    model: status?.ai.model ?? null,
    ollama_url: val("ollamaUrl") || "http://localhost:11434",
    ollama_model: ($("ollamaModel") as HTMLSelectElement).value,
    anthropic_model: val("anthropicModel") || "claude-sonnet-5-5",
    openai_base: val("openaiBase") || "https://api.openai.com/v1",
    openai_model: val("openaiModel"),
  };
  try {
    const ak = ($("anthropicKey") as HTMLInputElement).value;
    const ok = ($("openaiKey") as HTMLInputElement).value;
    if (ak) await invoke("set_api_key", { provider: "anthropic", key: ak });
    if (ok) await invoke("set_api_key", { provider: "openai", key: ok });
    const gk = ($("googleKey") as HTMLInputElement).value;
    if (gk) await invoke("set_api_key", { provider: "google", key: gk });
    setVal("googleKey", "");
    setVal("anthropicKey", "");
    setVal("openaiKey", "");
    await invoke("save_ai_settings", { settings });
    $("aiMsg").textContent = "AI settings saved.";
  } catch (e) {
    $("aiMsg").textContent = String(e);
  }
  refreshStatus();
});

function renderModels(s: Status) {
  const box = $("models");
  box.innerHTML = s.models
    .map(
      (m) => `<div class="model ${m.active ? "active" : ""}">
        <div><b>${esc(m.name)}</b><div class="meta">${m.size_gb} GB download · ${esc(m.note)}</div></div>
        <div class="model-act" data-id="${m.id}" data-file="${esc(m.file)}">
          ${m.installed
            ? m.active ? `<span class="pill">Active</span>` : `<button type="button" data-act="use">Use</button>`
            : `<button type="button" data-act="dl">Download</button>`}
          ${m.installed ? `<button type="button" class="ghost" data-act="del">Delete</button>` : ""}
        </div></div>`
    )
    .join("") +
    s.custom_models
      .map(
        (f) => `<div class="model ${s.active_model === f ? "active" : ""}"><div><b>${esc(f)}</b><div class="meta">Imported model</div></div>
        <div class="model-act" data-file="${esc(f)}">${s.active_model === f ? `<span class="pill">Active</span>` : `<button type="button" data-act="use">Use</button>`}
        <button type="button" class="ghost" data-act="del">Delete</button></div></div>`
      )
      .join("");
}

$("models").addEventListener("click", async (ev) => {
  const btn = (ev.target as HTMLElement).closest("button");
  if (!btn) return;
  const wrap = btn.parentElement as HTMLElement;
  const { id, file } = wrap.dataset;
  try {
    if (btn.dataset.act === "use") await invoke("set_model", { file });
    if (btn.dataset.act === "del") await invoke("delete_model", { file });
    if (btn.dataset.act === "dl") {
      const ch = new Channel<{ done: number; total: number }>();
      ch.onmessage = (p) => {
        btn.textContent = p.total ? `${Math.floor((p.done / p.total) * 100)}%` : `${(p.done / 1e9).toFixed(2)} GB`;
      };
      btn.disabled = true;
      await invoke("download_model", { id, onProgress: ch });
    }
  } catch (e) {
    alertMsg(e);
  }
  refreshStatus();
});

$("downloadPack").addEventListener("click", async () => {
  const b = $("downloadPack") as HTMLButtonElement;
  const ch = new Channel<{ done: number; total: number }>();
  ch.onmessage = (p) => {
    b.textContent = p.total ? `Downloading ${Math.floor((p.done / p.total) * 100)}%` : `${(p.done / 1e6).toFixed(0)} MB`;
  };
  b.disabled = true;
  try {
    await invoke("download_datapack", { onProgress: ch });
  } catch (e) {
    alertMsg(e);
  }
  b.disabled = false;
  b.textContent = "Download data pack (about 400 MB)";
  refreshStatus();
});

$("importPack").addEventListener("click", async () => {
  const path = await open({ multiple: false, filters: [{ name: "Data pack", extensions: ["sqlite", "gz"] }] });
  if (!path) return;
  const b = $("importPack") as HTMLButtonElement;
  b.disabled = true;
  b.textContent = "Importing…";
  try {
    await invoke("import_datapack", { path });
  } catch (e) {
    alertMsg(e);
  }
  b.disabled = false;
  b.textContent = "Import data pack (.sqlite or .sqlite.gz)";
  refreshStatus();
});

$("importModel").addEventListener("click", async () => {
  const path = await open({ multiple: false, filters: [{ name: "GGUF model", extensions: ["gguf"] }] });
  if (!path) return;
  try {
    await invoke("import_model", { path });
  } catch (e) {
    alertMsg(e);
  }
  refreshStatus();
});

$("settingsBtn").addEventListener("click", () => {
  refreshStatus();
  ($("settings") as HTMLDialogElement).showModal();
});

function alertMsg(e: unknown) {
  $("hint").textContent = String(e);
  $("hint").classList.add("err");
}

// ---- Search ----
let timer: number | undefined;
$("q").addEventListener("input", () => {
  clearTimeout(timer);
  timer = window.setTimeout(runSearch, 220);
});

let hasGoogle = false;
const OPEN_LAST_KEY = "openLast"; // "0" = do not reopen the last address on start

type Site = { pid: number; address: string; lotplan: string; ts: number; star?: boolean; note?: string; title?: string; project?: string; marks?: Mark[]; lodged?: string; path?: string };
function sites(): Record<string, Site> {
  try { return JSON.parse(localStorage.getItem("sites") ?? "{}"); } catch { return {}; }
}
function saveSites(m: Record<string, Site>) {
  // keep every starred lot plus the 20 most recent others
  const all = Object.values(m).sort((x, y) => y.ts - x.ts);
  let n = 0;
  const keep: Record<string, Site> = {};
  for (const x of all) if (x.star || x.note || x.title || x.project || x.marks?.length || x.lodged || n++ < 20) keep[x.lotplan] = x;
  try { localStorage.setItem("sites", JSON.stringify(keep)); } catch { /* storage unavailable */ }
}
function touchSite(p: { pid: number; address: string; lotplan: string }, patch: Partial<Site> = {}) {
  const m = sites();
  m[p.lotplan] = { ...m[p.lotplan], pid: p.pid, address: p.address, lotplan: p.lotplan, ts: Date.now(), ...patch };
  saveSites(m);
}
// ---- Projects: named groups of saved addresses (one per address). Stored in localStorage "projects"; the link lives on the site as `project`. ----
type Project = { id: string; name: string; client?: string; note?: string; created: number };
function projects(): Project[] {
  try { const a = JSON.parse(localStorage.getItem("projects") ?? "[]"); return Array.isArray(a) ? a : []; } catch { return []; }
}
function saveProjects(a: Project[]) {
  try { localStorage.setItem("projects", JSON.stringify(a)); } catch { /* storage unavailable */ }
}
const sortedProjects = () => projects().sort((a, b) => a.name.localeCompare(b.name));
const projLabel = (p: Project) => p.client ? `${p.name} (${p.client})` : p.name;
function moveSite(lp: string, pid: string) {
  const m = sites();
  if (!m[lp]) return;
  if (pid) m[lp].project = pid; else delete m[lp].project;
  saveSites(m);
}
let projFilter = "all"; // "all" | "none" (Unfiled) | project id
let projMode: "" | "new" | "edit" | "del" = "";
function projOptions(sel: string, all = true) {
  return `${all ? `<option value="all"${sel === "all" ? " selected" : ""}>All addresses</option>` : ""}<option value="none"${sel === "none" ? " selected" : ""}>Unfiled</option>${sortedProjects().map((p) => `<option value="${esc(p.id)}"${sel === p.id ? " selected" : ""}>${esc(projLabel(p))}</option>`).join("")}`;
}
function showRecents(focus = "") {
  const ps = sortedProjects();
  if (projFilter !== "all" && projFilter !== "none" && !ps.some((p) => p.id === projFilter)) projFilter = "all";
  const cur = ps.find((p) => p.id === projFilter);
  const all = Object.values(sites()).sort((x, y) => Number(!!y.star) - Number(!!x.star) || y.ts - x.ts);
  const inProj = (h: Site) => (h.project && ps.some((p) => p.id === h.project) ? h.project : "none");
  const r = all.filter((h) => projFilter === "all" || inProj(h) === projFilter);
  const row = (h: Site) => `<li data-pid="${h.pid}" data-lp="${esc(h.lotplan)}"><div class="rrow"><div class="rtxt"><b>${h.star ? "★ " : ""}${esc(h.address || h.lotplan)}</b><span>${esc(h.lotplan)}${h.note ? " · note" : ""}${h.title ? " · title" : ""}</span></div><select class="mv" aria-label="Move ${esc(h.address || h.lotplan)} to project" title="Move to project">${projOptions(inProj(h), false)}</select></div></li>`;
  let rows = "";
  if (projFilter === "all" && ps.length) {
    for (const g of [...ps.map((p) => p.id), "none"]) {
      const items = r.filter((h) => inProj(h) === g);
      if (items.length) rows += `<li class="rgrp" role="presentation">${esc(g === "none" ? "Unfiled" : projLabel(ps.find((p) => p.id === g)!))}</li>${items.map(row).join("")}`;
    }
  } else rows = r.map(row).join("");
  const ctl = `<li class="rtools" role="presentation"><label for="projSel" class="meta">Project</label><div class="rbar"><select id="projSel" aria-label="Filter by project">${projOptions(projFilter)}</select><button type="button" class="ghost ibtn" data-act="new" title="New project" aria-label="New project"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button><button type="button" class="ghost ibtn" data-act="edit"${cur ? "" : " disabled"} title="Rename project" aria-label="Rename project"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20l1-4L16 5l3 3L8 19z"/></svg></button><button type="button" class="ghost ibtn" data-act="del"${cur ? "" : " disabled"} title="Delete project" aria-label="Delete project"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></div>${
    projMode === "new" || (projMode === "edit" && cur)
      ? `<div class="rform"><label>Name<input id="pfName" value="${esc(projMode === "edit" ? cur!.name : "")}" maxlength="60"></label><label>Client (optional)<input id="pfClient" value="${esc(projMode === "edit" ? cur!.client ?? "" : "")}" maxlength="60"></label><label>Note (optional)<input id="pfNote" value="${esc(projMode === "edit" ? cur!.note ?? "" : "")}" maxlength="120"></label><div class="rbar"><button type="button" data-act="save">Save</button><button type="button" class="ghost" data-act="cancel">Cancel</button></div></div>`
      : projMode === "del" && cur
        ? `<div class="rform" role="alert"><span>Delete project "${esc(cur.name)}"? Its ${all.filter((h) => inProj(h) === cur.id).length} address(es) become Unfiled. No address is deleted.</span><div class="rbar"><button type="button" data-act="delgo">Delete project</button><button type="button" class="ghost" data-act="cancel">Cancel</button></div></div>`
        : cur?.note ? `<div class="meta">${esc(cur.note)}</div>` : ""
  }</li>`;
  $("results").innerHTML = ctl + rows;
  $("hint").textContent = r.length ? "Saved and recent addresses" : "";
  if (focus) ($(focus) as HTMLElement | null)?.focus();
}

$("results").addEventListener("change", (ev) => {
  const t = ev.target as HTMLSelectElement;
  if (t.id === "projSel") { projFilter = t.value; projMode = ""; showRecents("projSel"); }
  else if (t.classList.contains("mv")) {
    const lp = t.closest<HTMLElement>("li")!.dataset.lp!;
    moveSite(lp, t.value === "none" ? "" : t.value);
    showRecents();
  }
});
$("results").addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("button[data-act]");
  if (!b || !$("results").contains(b)) return;
  const act = b.dataset.act;
  const val = (id: string) => ($(id) as HTMLInputElement).value.trim();
  if (act === "new" || act === "edit" || act === "del") { projMode = act; showRecents(act === "del" ? "" : "pfName"); }
  else if (act === "cancel") { projMode = ""; showRecents("projSel"); }
  else if (act === "save") {
    const name = val("pfName");
    if (!name) { $("pfName").focus(); return; }
    const a = projects();
    const f = { name, client: val("pfClient") || undefined, note: val("pfNote") || undefined };
    if (projMode === "edit") { const p = a.find((x) => x.id === projFilter); if (p) Object.assign(p, f); }
    else { const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; a.push({ id, created: Date.now(), ...f }); projFilter = id; }
    saveProjects(a); projMode = ""; showRecents("projSel");
  } else if (act === "delgo") {
    const m = sites();
    for (const x of Object.values(m)) if (x.project === projFilter) delete x.project;
    saveSites(m);
    saveProjects(projects().filter((p) => p.id !== projFilter));
    projFilter = "all"; projMode = ""; showRecents("projSel");
  }
});

// Shared address search (main box and Compare dialog): Google suggestions when a key is set, else the offline typo-tolerant search.
const notFound = () => {
  const all = COUNCILS.map((c) => c.name), pack = packCouncils();
  const missing = all.filter((n) => !pack.includes(n));
  return `Not found in the data pack. The app covers ${all.slice(0, -1).join(", ")} and ${all[all.length - 1]}.${missing.length ? ` Your installed data pack does not include ${missing.join(", ")}: import a newer pack in Settings.` : ""} The address may be in another council area.`;
};
async function findAddresses(q: string): Promise<{ google?: { place_id: string; text: string }[]; hits?: Hit[]; note?: string }> {
  let note: string | undefined;
  if (hasGoogle) {
    try {
      const sg = await invoke<{ place_id: string; text: string }[]>("google_suggest", { q });
      if (sg.length) return { google: sg };
    } catch (e) {
      note = String(e); // fall back to the offline search below
    }
  }
  return { hits: await invoke<Hit[]>("search", { q }), note };
}

async function runSearch() {
  const q = ($("q") as HTMLInputElement).value.trim();
  const list = $("results");
  $("hint").classList.remove("err");
  if (q.length < 3) {
    showRecents();
    return;
  }
  try {
    const r = await findAddresses(q);
    if (r.note) $("hint").textContent = r.note;
    if (r.google) {
      list.innerHTML = r.google.map((x) => `<li data-place="${esc(x.place_id)}"><b>${esc(x.text)}</b><span>Google</span></li>`).join("");
      $("hint").textContent = `${r.google.length} suggestion${r.google.length > 1 ? "s" : ""}`;
      return;
    }
    const hits = r.hits ?? [];
    list.innerHTML = hits
      .map((h) => `<li data-pid="${h.pid}"><b>${esc(h.address || h.lotplan)}</b><span>${esc(h.lotplan)} · ${esc(councilOf(h.council).short)}</span></li>`)
      .join("");
    $("hint").textContent = hits.length ? `${hits.length} result${hits.length > 1 ? "s" : ""}` : notFound();
  } catch (e) {
    alertMsg(e);
  }
}

$("results").addEventListener("click", (ev) => {
  const li = (ev.target as HTMLElement).closest("li");
  if (!li || li.classList.contains("rtools") || li.classList.contains("rgrp") || (ev.target as HTMLElement).closest("select")) return;
  document.querySelectorAll("#results li").forEach((x) => x.classList.toggle("sel", x === li));
  if (li.dataset.place) {
    invoke<Hit>("google_pick", { placeId: li.dataset.place }).then((h) => loadSite(h.pid), alertMsg);
  } else openSaved(li);
});

// A saved lot is re-found by lot/plan if the data pack was replaced and the id changed.
async function openSaved(li: HTMLElement) {
  const lp = li.dataset.lp;
  if (!lp) return loadSite(Number(li.dataset.pid));
  await loadSite(Number(li.dataset.pid));
  if (current?.parcel.lotplan !== lp) {
    const hits = await invoke<Hit[]>("search", { q: lp }).catch(() => []);
    const h = hits.find((x) => x.lotplan === lp);
    if (h) await loadSite(h.pid);
  }
}

// ---- Site ----
const PALETTE = ["#c2410c", "#0e7490", "#7c3aed", "#b91c1c", "#15803d", "#a16207", "#be185d", "#1d4ed8"];

// Compact finding card: source badge, title, short description; long text collapses behind a whole-card toggle ("Show more").
function fcard(kind: string, authority: string, title: string, sub: string, text: string) {
  const long = text.length > 150;
  return `<div class="fcard ${kind}${long ? " fold" : ""}"${long ? ` role="button" tabindex="0" aria-expanded="false" title="Show or hide the full description"` : ""}><div class="fc-top"><span class="auth">${esc(authLabel(authority))}</span><b>${esc(title)}</b></div>${sub ? `<div class="meta fc-sub">${esc(sub)}</div>` : ""}<p class="fc-text">${esc(text)}</p>${long ? `<span class="fc-more" aria-hidden="true"></span>` : ""}</div>`;
}
function foldCard(c: HTMLElement) {
  c.setAttribute("aria-expanded", String(c.classList.toggle("open")));
}
$("site").addEventListener("click", (ev) => {
  const c = (ev.target as HTMLElement).closest<HTMLElement>(".fcard.fold");
  if (c) foldCard(c);
});
$("site").addEventListener("keydown", (ev) => {
  const c = (ev.target as HTMLElement).closest<HTMLElement>(".fcard.fold");
  if (c && c === ev.target && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); foldCard(c); }
});

async function loadSite(pid: number, silent = false) {
  try {
    current = await invoke<Assessment>("assess", { pid });
  } catch (e) {
    return silent ? undefined : alertMsg(e);
  }
  const a = current;
  try { localStorage.setItem("lastPid", String(a.parcel.pid)); } catch { /* storage unavailable */ }
  touchSite(a.parcel);
  renderSiteTools();
  $("empty").hidden = true;
  $("site").hidden = false;
  ($("q") as HTMLInputElement).value = a.parcel.address || a.parcel.lotplan;
  $("results").innerHTML = "";
  const cn = siteCouncil(a);
  $("siteMeta").textContent = [a.parcel.lotplan, a.parcel.suburb, cn.name].filter(Boolean).join(" · ");
  $("siteMeta").title = `${cn.name} · ${cn.scheme}`;
  $("tZoneLbl").textContent = `Zone · ${cn.short}`;
  const daName = cn.da_name ?? "DA register";
  $("daRegBtn").textContent = `Open ${cn.short} DA register (${daName})`;
  $("daRegNote").textContent = `The address is copied. Paste it into the search on ${daName} to see applications and decisions on this lot and next door.`;
  $("tLot").textContent = a.parcel.area_m2 ? `${Math.round(a.parcel.area_m2).toLocaleString()} m²` : "–";
  $("tZone").textContent = a.zones[0] ? zoneTitle(a.zones[0]) : zonesMissing(cn) ? "Not loaded" : "–";
  $("tZone").title = a.zones.length ? `${a.zones.map(zoneTitle).join(", ")} (${cn.scheme})` : zonesMissing(cn) ? `${NO_ZONE} (${cn.scheme})` : cn.scheme;
  $("tFlags").textContent = String(a.flags.length + a.overlays.length);
  $("tFlags").title = `${a.flags.length} constraints, ${a.overlays.length} mapped layers`;
  $("zones").innerHTML = a.zones.length
    ? a.zones
        .map((z) => fcard("zone", z.authority, zoneTitle(z), [z.authority === "council" ? cn.scheme : "", z.coverage_pct != null && z.coverage_pct < 99 ? `${z.coverage_pct}% of lot` : ""].filter(Boolean).join(" · "), z.zone.purpose + (z.zone.source ? ` (Source: ${z.zone.source}${z.zone.verify ? "; verify" : ""})` : "")))
        .join("")
    : zonesMissing(cn)
      ? `<p class="meta"><b>${NO_ZONE}.</b> ${esc(cn.name)} does not publish its zoning as open data, so this lot's zone and overlays are not in the app. Look the lot up on ${cn.maps_url ? link(cn.maps_url, cn.maps_name ?? "the council's online map") : "the council's online map"} or in the ${link(cn.scheme_url, cn.scheme)}.</p>`
      : `<p class="meta">Zone not identified from the data pack. Check the zoning layer attributes below, or ${link(cn.scheme_url, cn.scheme)}.</p>`;
  $("flags").innerHTML = a.flags.length
    ? a.flags
        .map((f) => fcard("flag", f.rule.authority, f.rule.title, f.rule.authority === "council" ? `${cn.scheme}: ${f.rule.code}` : f.rule.code, f.rule.note))
        .join("")
    : `<p class="meta">No overlay constraints mapped on this lot.</p>`;
  renderSetbacks(a);
  renderClock();
  renderReferrals(a);
  $("ovSummary").textContent = `All mapped layers (${a.overlays.length})`;
  $("overlays").innerHTML = a.overlays
    .map(
      (o) => `<li><span class="auth">${esc(authLabel(o.authority, a))}</span> <b>${esc(o.title)}</b>${o.coverage_pct != null ? ` · ${o.coverage_pct}% of lot` : ""}${o.distance_m != null ? ` · ${o.distance_m} m away` : ""}
      <div class="meta">${Object.entries(o.props).slice(0, 6).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(" · ")}</div></li>`
    )
    .join("");
  sections = [];
  activeTab = "";
  renderReport();
  renderChat();
  $("saveBtn").hidden = true;
  $("pdfBtn").hidden = false; // the client PDF works before an AI report too
  subOn = false; contOn = false; powerOn = false;
  toolUi("subBtn", false); toolUi("contBtn", false); toolUi("powerBtn", false);
  envOn = false; toolUi("envBtn", false);
  resetSetbackTool();
  $("suburbOut").innerHTML = "";
  drawMap(a);
  loadPotential();
}

function bounds(geom: any): [number, number, number, number] {
  let [x0, y0, x1, y1] = [180, 90, -180, -90];
  const walk = (c: any) => {
    if (typeof c[0] === "number") {
      x0 = Math.min(x0, c[0]); y0 = Math.min(y0, c[1]); x1 = Math.max(x1, c[0]); y1 = Math.max(y1, c[1]);
    } else c.forEach(walk);
  };
  walk(geom.coordinates);
  return [x0, y0, x1, y1];
}

let floodOn = false;

// ---- Development potential, forms, map tools ----
type Pot = {
  area_m2: number; frontage_m: number | null; depth_m: number | null;
  edges: { length_m: number; mid: [number, number]; frontage: boolean | null }[];
  provisions: { title: string; items: { label: string; value: string; source: string; url: string; verify: boolean }[] } | null;
  subdivision: string[]; lots_by_area: number | null; sketch: { area_m2: number; geom: any }[];
  use_fit: { use_def: { name: string; term: string; checks: string[]; sources: { name: string; url: string }[] }; zone_ok: boolean | null; note: string;
    rule: { level: string; items: { label: string; value: string; source: string; url: string; verify: boolean; key?: string; n?: number }[] } | null } | null;
  forms: { form: { name: string; to: string; when: string; url: string; lodge: string; lodge_url: string }; reason: string }[];
  pda: boolean;
  power: { kind: string; distance_m: number; props: Record<string, unknown> }[];
};
let powerOn = false;
const POWER_COLORS: Record<string, string> = { "Transmission line": "#dc2626", Substation: "#7c3aed", "Solar farm": "#f59e0b", "Wind farm": "#0891b2", "Power station": "#111827" };
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
const brief = (o: Record<string, unknown>) =>
  Object.entries(o).filter(([k, v]) => v != null && v !== "" && /name|owner|operator|volt|kv|capacity|mw|fuel|class|status/i.test(k)).slice(0, 5).map(([k, v]) => `${k}: ${v}`).join(" · ");
let pot: Pot | null = null;
let dimMarkers: maplibregl.Marker[] = [];
let dimOn = true;
let subOn = false;
let contOn = false;
const useId = () => ($("useSel") as HTMLSelectElement).value;
const link = (url: string, text: string) => (url ? `<a href="#" data-url="${esc(url)}" data-title="${esc(text)}">${esc(text)}</a>` : esc(text));

async function loadPotential(changed = false) {
  if (!current) return;
  $("pot").innerHTML = `<p class="meta">Loading…</p>`;
  try {
    pot = await invoke<Pot>("potential", { pid: current.parcel.pid, useId: useId() });
    renderPotential();
  } catch (e) {
    $("pot").innerHTML = `<p class="err">Development potential could not be shown: ${esc(e)}</p>`;
    return;
  }
  if (changed) {
    const pb = $("site").querySelector<HTMLElement>(".pbody")!;
    pb.scrollTop = 0;
    const f = document.getElementById("useFit");
    if (f) { f.classList.remove("flash"); void f.offsetWidth; f.classList.add("flash"); }
  }
  drawDims();
  if (subOn) drawSketch();
}

function renderPotential() {
  if (!pot) return;
  const p = pot;
  const facts = [
    `<b>${Math.round(p.area_m2).toLocaleString()} m²</b> lot area`,
    p.frontage_m != null ? `<b>${p.frontage_m} m</b> open boundary / frontage` : `frontage: could not be measured – check the plan`,
    p.depth_m != null ? `≈ <b>${p.depth_m} m</b> depth` : "",
  ].filter(Boolean).join(" · ");
  const prov = p.provisions
    ? `<table class="ptable"><tr><th colspan="2">${esc(p.provisions.title)}</th><th>Source</th></tr>${p.provisions.items
        .map((i) => `<tr><td>${esc(i.label)}</td><td><b>${esc(i.value)}</b>${i.verify ? ` <span class="pill warn" title="Not yet confirmed: check with ${esc(siteCouncil().name)} or a registered planner">verify</span>` : ""}</td><td class="meta">${link(i.url, i.source)}</td></tr>`)
        .join("")}</table>`
    : `<p class="meta">${p.pda ? "PDA site: limits come from the PDA development scheme (EDQ)." : siteCouncil().id === "brisbane" ? "No sourced numeric provisions for this zone in the app yet. The AI report names the City Plan codes that set them." : `Zone provisions: not loaded yet – see ${link(siteCouncil().scheme_url, siteCouncil().scheme)}.`}</p>`;
  const fit = p.use_fit
    ? `<div id="useFit" class="fcard usefit ${p.use_fit.zone_ok === false ? "flag" : "zone"}"><span class="auth">Proposal</span> <b>${esc(p.use_fit.use_def.name)}</b>
       <div class="meta">Planning use term: ${esc(p.use_fit.use_def.term)}</div><p>${esc(p.use_fit.note)}</p>
       ${p.use_fit.rule ? `<p><b>Level of assessment:</b> ${esc(p.use_fit.rule.level)}</p>
         <table class="ptable"><tbody>${p.use_fit.rule.items.map((i) => `<tr><td>${esc(i.label)}</td><td><b>${esc(i.value)}</b>${i.verify ? ' <span class="pill warn">verify</span>' : ""}</td><td class="meta">${i.url ? link(i.url, i.source) : esc(i.source)}</td></tr>`).join("")}</tbody></table>${chargeEstimate(p)}` : ""}
       <ul>${p.use_fit.use_def.checks.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
       ${(p.use_fit.use_def.sources ?? []).length ? `<div class="meta">Sources: ${p.use_fit.use_def.sources.map((x) => link(x.url, x.name)).join(" · ")}</div>` : ""}</div>`
    : "";
  $("pot").innerHTML = `${fit}<p>${facts}</p>${prov}<h4>Subdivision</h4><ul>${p.subdivision.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    ${p.power?.length ? `<h4>Nearest power infrastructure</h4><ul>${p.power.map((n) => `<li><b>${esc(n.kind)}</b>: ${km(n.distance_m)} <span class="meta">${esc(brief(n.props))}</span></li>`).join("")}</ul>
      <p class="meta">Source: Geoscience Australia national electricity infrastructure. Energex distribution lines/capacity, water, sewer, recycled water and fibre aren't open data: see Maps → Energex DAPR map and BYDA.</p>` : ""}
    ${p.sketch.length ? `<p class="meta">Indicative split: ${p.sketch.map((s) => `${Math.round(s.area_m2)} m²`).join(" + ")}. Concept only; a surveyor confirms the layout.</p>` : ""}`;
  $("forms").innerHTML = p.forms
    .map((f) => `<div class="mapitem"><div><b>${esc(f.form.name)}</b><div class="meta">To: ${esc(f.form.to)} · ${esc(f.reason)}</div>
      <div class="meta">Lodge: ${f.form.lodge_url ? link(f.form.lodge_url, f.form.lodge) : esc(f.form.lodge)}</div></div>
      <button type="button" class="ghost" data-url="${esc(f.form.url)}" data-title="${esc(f.form.name)}">Open form</button></div>`)
    .join("");
  renderChecklist(p);
}

// ---- Lodgement checklist (thread C): ticks are the user's own, saved per lot ----
function renderChecklist(p: Pot) {
  if (!current) return;
  const pid = current.parcel.pid;
  const key = `checklist:${pid}`;
  const items = [
    ...p.forms.map((f) => `Form: ${f.form.name}`),
    "Site plan",
    "Planning report",
    "Owner's consent (if applicable)",
    "Applicant details",
  ];
  let ticked: string[] = [];
  try { ticked = JSON.parse(localStorage.getItem(key) ?? "[]"); } catch { /* ignore */ }
  $("checklist").innerHTML = items
    .map((t, i) => `<label class="mapitem"><span><input type="checkbox" data-i="${i}" ${ticked.includes(t) ? "checked" : ""}> ${esc(t)}</span></label>`)
    .join("");
  $("checklist").onchange = () => {
    const on = [...document.querySelectorAll<HTMLInputElement>("#checklist input:checked")].map((el) => items[Number(el.dataset.i)]);
    try { localStorage.setItem(key, JSON.stringify(on)); } catch { /* ignore */ }
  };
}

$("useSel").addEventListener("change", () => loadPotential(true));
// Every link in the side panel opens in the browser.
document.querySelector(".panel")!.addEventListener("click", (ev) => {
  const el = (ev.target as HTMLElement).closest("[data-url]") as HTMLElement | null;
  if (!el) return;
  ev.preventDefault();
  openExternal(el.dataset.url!);
});

function drawDims() {
  dimMarkers.forEach((m) => m.remove());
  dimMarkers = [];
  if (!map || !pot || !dimOn) return;
  for (const e of pot.edges) {
    if (e.length_m < 2) continue;
    const el = document.createElement("div");
    el.className = `dim ${e.frontage ? "front" : ""}`;
    el.textContent = `${e.length_m} m`;
    dimMarkers.push(new maplibregl.Marker({ element: el }).setLngLat(e.mid).addTo(map));
  }
}

function drawSketch() {
  if (!map) return;
  if (map.getLayer("sub")) { map.removeLayer("sub"); map.removeLayer("sub-fill"); map.removeSource("sub"); }
  if (!subOn || !pot?.sketch.length) return;
  map.addSource("sub", { type: "geojson", data: { type: "FeatureCollection", features: pot.sketch.map((s) => ({ type: "Feature", properties: {}, geometry: s.geom })) } });
  map.addLayer({ id: "sub-fill", type: "fill", source: "sub", paint: { "fill-color": "#f59e0b", "fill-opacity": 0.15 } });
  map.addLayer({ id: "sub", type: "line", source: "sub", paint: { "line-color": "#b45309", "line-width": 2, "line-dasharray": [2, 1] } });
}

function toolUi(id: string, on: boolean) {
  $(id).classList.toggle("on", on);
  $(id).setAttribute("aria-pressed", String(on));
}

$("dimBtn").addEventListener("click", () => { dimOn = !dimOn; toolUi("dimBtn", dimOn); drawDims(); });
$("subBtn").addEventListener("click", () => {
  subOn = !subOn;
  toolUi("subBtn", subOn);
  if (subOn && !pot?.sketch.length) setFloodUi(floodOn, `<b>No subdivision sketch</b><div class="meta">The lot is below the minimum area for 2 lots, or the zone's minimum lot size isn't recorded.</div>`);
  drawSketch();
});
$("contBtn").addEventListener("click", async () => {
  if (!current || !map) return;
  const m = map;
  contOn = !contOn;
  toolUi("contBtn", contOn);
  if (!contOn) {
    if (m.getLayer("cont")) { m.removeLayer("cont"); m.removeSource("cont"); }
    return setFloodUi(floodOn);
  }
  $("contBtn").classList.add("busy");
  try {
    const c = await invoke<{ source: string; stats: { min_m: number; max_m: number; fall_m: number; approx_slope_pct: number } | null; features: any[] }>("contours", { pid: current.parcel.pid });
    m.addSource("cont", { type: "geojson", data: { type: "FeatureCollection", features: c.features } });
    m.addLayer({ id: "cont", type: "line", source: "cont", paint: { "line-color": "#7c5e3c", "line-width": 1, "line-opacity": 0.8 } }, "lot");
    const st = c.stats;
    setFloodUi(floodOn, `<b>${esc(c.source)}</b>${st ? `<div>Lot elevation ${st.min_m}–${st.max_m} m AHD · fall ${st.fall_m} m · ≈${st.approx_slope_pct}% slope</div>` : ""}<div class="meta">© State of Queensland. Saved for offline use.</div>`);
  } catch (e) {
    contOn = false;
    toolUi("contBtn", false);
    alertMsg(e);
  }
  $("contBtn").classList.remove("busy");
});

$("powerBtn").addEventListener("click", async () => {
  if (!current || !map) return;
  const m = map;
  powerOn = !powerOn;
  toolUi("powerBtn", powerOn);
  if (m.getLayer("pw-line")) { m.removeLayer("pw-line"); m.removeLayer("pw-pt"); m.removeSource("pw"); }
  if (!powerOn) { setFloodUi(floodOn); return fitTo([current.parcel.geom]); }
  try {
    const feats = await invoke<any[]>("infra_map", { pid: current.parcel.pid });
    feats.forEach((f) => (f.properties.c = POWER_COLORS[f.properties.kind] ?? "#111827"));
    m.addSource("pw", { type: "geojson", data: { type: "FeatureCollection", features: feats } });
    m.addLayer({ id: "pw-line", type: "line", source: "pw", filter: ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false], paint: { "line-color": ["get", "c"], "line-width": 2.5 } });
    m.addLayer({ id: "pw-pt", type: "circle", source: "pw", filter: ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false], paint: { "circle-color": ["get", "c"], "circle-radius": 6, "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
    const kinds = [...new Set(feats.map((f) => f.properties.kind as string))];
    setFloodUi(floodOn, (kinds.length ? kinds.map((k) => `<div><i style="background:${POWER_COLORS[k] ?? "#111827"}"></i>${esc(k)}</div>`).join("") : "<b>No major power infrastructure within 5 km</b>")
      + `<div class="meta">Within 5 km · Geoscience Australia. Distribution (Energex) lines not shown.</div>`);
    fitTo([current.parcel.geom, ...feats.map((f) => f.geometry)]);
  } catch (e) {
    powerOn = false; toolUi("powerBtn", false); alertMsg(e);
  }
});

function renderForm(text: string, edit: boolean): string {
  let html = "";
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (l.startsWith("## ")) html += `<h3 class="fpart">${esc(l.slice(3))}</h3>`;
    else if (l.startsWith("Q:")) {
      const [q, ...a] = l.slice(2).split("| A:");
      const ans = a.join("| A:").trim();
      html += `<div class="frow"><label>${esc(q.trim())}</label>${edit ? `<textarea rows="2">${esc(ans)}</textarea>` : `<div class="fans">${esc(ans)}</div>`}</div>`;
    }
  }
  return html || `<p class="meta">Drafting…</p>`;
}

function renderLetter(text: string): string {
  return `<div class="letter">${esc(text).replace(/\n/g, "<br>")}</div>`;
}

let docText = "";
async function draft(letter: boolean, prelodge = false) {
  if (!current) return;
  const btn = $(prelodge ? "prelodgeBtn" : letter ? "letterBtn" : "formBtn") as HTMLButtonElement;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Drafting…";
  docText = "";
  $("docTitle").textContent = prelodge ? "Pre-lodgement meeting request" : letter ? "Cover letter" : "DA Form 1 – Development application details";
  $("docBody").innerHTML = `<p class="meta">Drafting…</p>`;
  ($("docDlg") as HTMLDialogElement).showModal();
  const ch = new Channel<string>();
  ch.onmessage = (t) => {
    docText += t;
    $("docBody").innerHTML = letter ? renderLetter(docText) : renderForm(docText, false);
  };
  try {
    const proposal = prelodge ? `Request a pre-lodgement meeting with council about: ${val("question") || "the proposal on this site"}` : val("question");
    await invoke("draft_form", { pid: current.parcel.pid, useId: useId(), proposal, letter, onToken: ch });
    if (!letter) $("docBody").innerHTML = renderForm(docText, true);
  } catch (e) {
    $("docBody").innerHTML = `<p class="err">${esc(e)}</p>`;
  }
  btn.disabled = false;
  btn.textContent = label;
}
$("formBtn").addEventListener("click", () => draft(false));
$("letterBtn").addEventListener("click", () => draft(true));
$("prelodgeBtn").addEventListener("click", () => draft(true, true));

function docPlain(): string {
  const body = $("docBody");
  if (body.querySelector(".letter")) return docText;
  return [...body.children].map((el) => el.classList.contains("fpart")
    ? `\n${el.textContent}\n`
    : `${el.querySelector("label")?.textContent}: ${(el.querySelector("textarea") as HTMLTextAreaElement | null)?.value ?? el.querySelector(".fans")?.textContent ?? ""}`).join("\n");
}
$("docCopy").addEventListener("click", () => navigator.clipboard.writeText(docPlain()));
$("docPdf").addEventListener("click", () => {
  const clone = $("docBody").cloneNode(true) as HTMLElement;
  clone.querySelectorAll("textarea").forEach((t) => {
    const d = document.createElement("div");
    d.className = "fans";
    d.textContent = (t as HTMLTextAreaElement).value;
    t.replaceWith(d);
  });
  $("printArea").innerHTML = `<h1>${esc($("docTitle").textContent ?? "")}</h1>` + clone.innerHTML;
  ($("docDlg") as HTMLDialogElement).close();
  window.print();
});
const FLOOD_COLORS = ["#1d4ed8", "#0891b2", "#7c3aed", "#0369a1", "#4f46e5", "#0e7490", "#2563eb", "#6d28d9"];

function fitTo(geoms: any[]) {
  let [x0, y0, x1, y1] = [180, 90, -180, -90];
  for (const g of geoms) {
    if (!g?.coordinates) continue;
    const b = bounds(g);
    x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
  }
  map?.fitBounds([[x0, y0], [x1, y1]], { padding: 30, duration: 300 });
}

function setFloodUi(on: boolean, legend = "") {
  floodOn = on;
  $("floodBtn").title = on ? "Hide flood map" : "Flood map";
  $("floodBtn").classList.toggle("on", on);
  $("floodBtn").classList.remove("busy");
  $("legend").innerHTML = legend;
  $("legend").hidden = !legend;
}

// Flood map: all flood layers within ~400 m of the lot, coloured by layer, with a legend.
$("floodBtn").addEventListener("click", async () => {
  if (!current || !map) return;
  const m = map;
  if (floodOn) {
    if (m.getLayer("flood")) m.removeLayer("flood");
    if (m.getLayer("flood-line")) m.removeLayer("flood-line");
    if (m.getSource("flood")) m.removeSource("flood");
    setFloodUi(false);
    fitTo([current.parcel.geom]);
    return;
  }
  $("floodBtn").classList.add("busy");
  let feats: Overlay[];
  try {
    feats = await invoke<Overlay[]>("flood_map", { pid: current.parcel.pid });
  } catch (e) {
    setFloodUi(false);
    return alertMsg(e);
  }
  if (!feats.length) {
    setFloodUi(true, `<b>No mapped flooding within 400 m</b><div class="meta">${floodCheck()}</div>`);
    return;
  }
  const titles = [...new Set(feats.map((f) => f.title))];
  const color = (t: string) => FLOOD_COLORS[titles.indexOf(t) % FLOOD_COLORS.length];
  m.addSource("flood", {
    type: "geojson",
    data: { type: "FeatureCollection", features: feats.map((f) => ({ type: "Feature", properties: { c: color(f.title) }, geometry: f.geom })) },
  });
  m.addLayer({ id: "flood", type: "fill", source: "flood", paint: { "fill-color": ["get", "c"], "fill-opacity": 0.25 } }, "lot");
  m.addLayer({ id: "flood-line", type: "line", source: "flood", paint: { "line-color": ["get", "c"], "line-width": 1 } }, "lot");
  const pre = siteCouncil().title_prefix ?? "";
  const short = (t: string) => (pre && t.startsWith(pre) ? t.slice(pre.length) : t).replace(/^Queensland — /, "State: ");
  setFloodUi(
    true,
    titles.map((t) => `<div><i style="background:${color(t)}"></i>${esc(short(t))}</div>`).join("") +
      `<div class="meta">Mapped flood areas. ${siteCouncil().id === "brisbane" ? "Levels: FloodWise Property Report." : `Levels: ask ${esc(siteCouncil().name)} for flood information for this property.`}</div>`
  );
  fitTo([current.parcel.geom, ...feats.map((f) => f.geom)]);
});

/** What to check to confirm flooding, by council. */
function floodCheck(): string {
  const c = siteCouncil();
  return c.id === "brisbane" ? "Check Council's FloodWise Property Report to confirm." : `Ask ${esc(c.name)} for flood information for this property to confirm.`;
}

function drawMap(a: Assessment) {
  map?.remove();
  setFloodUi(false);
  map = new maplibregl.Map({
    container: "map",
    style: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#efece4" } }] },
    attributionControl: { compact: true },
    canvasContextAttributes: { preserveDrawingBuffer: true }, // lets the PDF include a map snapshot
  });
  markAttach();
  map.on("load", () => {
    const m = map!;
    setBase(baseKind());
    a.overlays.forEach((o, i) => {
      const id = `o${i}`;
      const color = PALETTE[i % PALETTE.length];
      m.addSource(id, { type: "geojson", data: { type: "Feature", properties: {}, geometry: o.geom } });
      const t = o.geom?.type ?? "";
      if (t.includes("Polygon")) m.addLayer({ id, type: "line", source: id, paint: { "line-color": color, "line-width": 1.5, "line-opacity": 0.8, "line-dasharray": [2, 2] } });
      else if (t.includes("Line")) m.addLayer({ id, type: "line", source: id, paint: { "line-color": color, "line-width": 3 } });
      else m.addLayer({ id, type: "circle", source: id, paint: { "circle-color": color, "circle-radius": 5 } });
    });
    m.addSource("lot", { type: "geojson", data: { type: "Feature", properties: {}, geometry: a.parcel.geom } });
    m.addLayer({ id: "lot-hl", type: "fill", source: "lot", paint: { "fill-color": "#fde68a", "fill-opacity": 0.12 } });
    m.addLayer({ id: "lot", type: "line", source: "lot", paint: { "line-color": "#111827", "line-width": 2.5 } });
    const b = bounds(a.parcel.geom);
    m.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 40, duration: 0 });
    m.on("click", (e) => measClick([e.lngLat.lng, e.lngLat.lat]));
    m.on("contextmenu", (e) => { e.preventDefault(); measUndo(); });
  });
}

// ---- Measure distance / area ----
let measMode: "" | "d" | "a" = "";
let measPts: [number, number][] = [];
let measMarks: maplibregl.Marker[] = [];
const toM = (a: [number, number], b: [number, number]) => {
  const R = 6371008.8, r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
function measArea(p: [number, number][]) {
  const r = Math.PI / 180, R = 6371008.8, lat0 = p[0][1] * r;
  const xy = p.map(([x, y]) => [(x - p[0][0]) * r * Math.cos(lat0) * R, (y - p[0][1]) * r * R]);
  let s = 0;
  xy.forEach((q, i) => { const n = xy[(i + 1) % xy.length]; s += q[0] * n[1] - n[0] * q[1]; });
  return Math.abs(s) / 2;
}
function measDraw() {
  const m = map; if (!m || !m.isStyleLoaded()) return;
  measMarks.forEach((k) => k.remove()); measMarks = [];
  const closed = measMode === "a" && measPts.length > 2;
  const coords = closed ? [...measPts, measPts[0]] : measPts;
  const data: any = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } };
  if (m.getSource("meas")) (m.getSource("meas") as maplibregl.GeoJSONSource).setData(data);
  else {
    m.addSource("meas", { type: "geojson", data });
    m.addLayer({ id: "meas", type: "line", source: "meas", paint: { "line-color": "#e11d48", "line-width": 3 } });
    m.addSource("measp", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    m.addLayer({ id: "measp", type: "circle", source: "measp", paint: { "circle-color": "#fff", "circle-stroke-color": "#e11d48", "circle-stroke-width": 2, "circle-radius": 4 } });
  }
  (m.getSource("measp") as maplibregl.GeoJSONSource).setData({ type: "FeatureCollection", features: measPts.map((c) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c } })) });
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = toM(coords[i - 1], coords[i]); total += d;
    const el = document.createElement("div"); el.className = "measlbl"; el.textContent = d.toFixed(2) + " m";
    measMarks.push(new maplibregl.Marker({ element: el }).setLngLat([(coords[i - 1][0] + coords[i][0]) / 2, (coords[i - 1][1] + coords[i][1]) / 2]).addTo(m));
  }
  const out = $("measTxt");
  out.textContent = !measPts.length ? (measMode === "a" ? "Click the corners of the area" : "Click points to measure")
    : measMode === "a" ? (closed ? `Area ${measArea(measPts).toFixed(1)} m² · Perimeter ${total.toFixed(2)} m` : `Perimeter so far ${total.toFixed(2)} m`)
    : `Total ${total.toFixed(2)} m`;
}
function measClick(ll: [number, number]) { if (!measMode) return; measPts.push(ll); measDraw(); }
function measUndo() { if (!measMode) return; measPts.pop(); measDraw(); }
function measReset() {
  measPts = [];
  measMarks.forEach((k) => k.remove()); measMarks = [];
  if (map?.getLayer("measp")) { map.removeLayer("measp"); map.removeSource("measp"); }
  if (map?.getLayer("meas")) { map.removeLayer("meas"); map.removeSource("meas"); }
}
function measSet(mode: "" | "d" | "a") {
  measMode = measMode === mode ? "" : mode;
  if (measMode && markOn) markSet(false);
  toolUi("measDBtn", measMode === "d"); toolUi("measABtn", measMode === "a");
  measReset();
  ($("measOut") as HTMLElement).hidden = !measMode;
  document.querySelector(".maplibregl-canvas")?.classList.toggle("meas", !!measMode);
  if (measMode) measDraw();
}
$("measDBtn").addEventListener("click", () => measSet("d"));
$("measABtn").addEventListener("click", () => measSet("a"));
$("measUndo").addEventListener("click", measUndo);

// ---- Map markup: arrows, boxes, labels and freehand drawn over the map. Points are stored as lng/lat per lot (site.marks) so they follow pan/zoom. ----
type MarkKind = "arrow" | "rect" | "text" | "pen";
type Mark = { k: MarkKind; c: string; p: [number, number][]; s?: string };
let marks: Mark[] = [];
let markOn = false;
let markTool: MarkKind = "arrow";
let markCol = "#b91c1c";
let markDraft: Mark | null = null;
let markedPng = "";
const markEl = () => document.getElementById("markSvg") as SVGSVGElement | null;
function markSvg(list: Mark[]): string {
  if (!map) return "";
  return list.map((m) => {
    const q = m.p.map((l) => map!.project(l));
    const a = q[0], b = q[q.length - 1];
    const two = (tag: string, at: string) => `<${tag} ${at} fill="none" stroke="#111" stroke-opacity=".55" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><${tag} ${at} fill="none" stroke="${m.c}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    if (m.k === "arrow") {
      const ang = Math.atan2(b.y - a.y, b.x - a.x), L = 14;
      const h = (d: number) => `${(b.x - L * Math.cos(ang + d)).toFixed(1)} ${(b.y - L * Math.sin(ang + d)).toFixed(1)}`;
      return two("path", `d="M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}M${h(0.45)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}L${h(-0.45)}"`);
    }
    if (m.k === "rect") return two("rect", `x="${Math.min(a.x, b.x).toFixed(1)}" y="${Math.min(a.y, b.y).toFixed(1)}" width="${Math.abs(b.x - a.x).toFixed(1)}" height="${Math.abs(b.y - a.y).toFixed(1)}"`);
    if (m.k === "pen") return two("polyline", `points="${q.map((r) => `${r.x.toFixed(1)},${r.y.toFixed(1)}`).join(" ")}"`);
    const t = m.s ?? "", w = t.length * 8.5 + 14, white = m.c === "#ffffff";
    return `<rect x="${a.x.toFixed(1)}" y="${(a.y - 18).toFixed(1)}" width="${w.toFixed(1)}" height="24" rx="4" fill="${m.c}" stroke="#111" stroke-opacity=".55" stroke-width="1.5"/><text x="${(a.x + 7).toFixed(1)}" y="${(a.y - 1).toFixed(1)}" fill="${white ? "#111" : "#fff"}" ${white ? "" : 'stroke="#111" stroke-width="2.5" paint-order="stroke"'}>${esc(t)}</text>`;
  }).join("");
}
function markRender() {
  const s = markEl();
  if (s) s.innerHTML = markSvg(markDraft ? [...marks, markDraft] : marks);
}
function markSave() {
  if (!current) return;
  const m = sites()[current.parcel.lotplan];
  if (!m && !marks.length) return;
  touchSite(current.parcel, { marks: marks.length ? marks : undefined });
}
function markAttach() {
  markEl()?.remove();
  markOn = false; markDraft = null;
  ($("markBar") as HTMLElement).hidden = true; toolUi("markBtn", false);
  const host = $("map").parentElement!;
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
  s.id = "markSvg"; s.setAttribute("aria-hidden", "true");
  host.appendChild(s);
  marks = (current && sites()[current.parcel.lotplan]?.marks) || [];
  const at = (e: PointerEvent): [number, number] => {
    const r = s.getBoundingClientRect();
    const l = map!.unproject([e.clientX - r.left, e.clientY - r.top]);
    return [l.lng, l.lat];
  };
  s.addEventListener("pointerdown", (e) => {
    if (!markOn || !map) return;
    e.preventDefault();
    const p = at(e);
    if (markTool === "text") {
      marks.push({ k: "text", c: markCol, p: [p], s: ($("markTxt") as HTMLInputElement).value.trim() || "Label" });
      markSave(); markRender(); return;
    }
    markDraft = { k: markTool, c: markCol, p: markTool === "pen" ? [p] : [p, p] };
    s.setPointerCapture(e.pointerId);
  });
  s.addEventListener("pointermove", (e) => {
    if (!markDraft || !map) return;
    const p = at(e);
    if (markDraft.k === "pen") markDraft.p.push(p); else markDraft.p[1] = p;
    markRender();
  });
  const end = () => {
    if (!markDraft || !map) return;
    const q = markDraft.p.map((l) => map!.project(l));
    const moved = Math.hypot(q[q.length - 1].x - q[0].x, q[q.length - 1].y - q[0].y) > 4;
    if (moved) marks.push(markDraft);
    markDraft = null; markSave(); markRender();
  };
  s.addEventListener("pointerup", end);
  s.addEventListener("pointercancel", () => { markDraft = null; markRender(); });
  s.addEventListener("wheel", (e) => { map?.getCanvas().dispatchEvent(new WheelEvent("wheel", e)); e.preventDefault(); }, { passive: false });
  map!.on("move", markRender);
  markRender();
}
function markSet(on: boolean) {
  if (on && (!current || !map)) return;
  markOn = on;
  toolUi("markBtn", on);
  ($("markBar") as HTMLElement).hidden = !on;
  markEl()?.classList.toggle("on", on);
  if (on) measSet("");
}
function markUi() {
  document.querySelectorAll<HTMLElement>("#markBar [data-mk]").forEach((b) => { const o = b.dataset.mk === markTool; b.classList.toggle("on", o); b.setAttribute("aria-pressed", String(o)); });
  document.querySelectorAll<HTMLElement>("#markBar [data-col]").forEach((b) => b.classList.toggle("on", b.dataset.col === markCol));
  ($("markTxt") as HTMLElement).hidden = markTool !== "text";
}
// Same map capture as the client PDF (map.getCanvas()), with the vector marks drawn on top at canvas resolution.
async function markedMapUrl(force = false): Promise<string> {
  if (!map || (!marks.length && !force)) return "";
  const cv = map.getCanvas(), w = cv.clientWidth, h = cv.clientHeight;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cv.width}" height="${cv.height}" viewBox="0 0 ${w} ${h}" font-family="Arial,Helvetica,sans-serif" font-size="14" font-weight="700">${markSvg(marks)}</svg>`;
  const img = new Image();
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  await img.decode();
  const o = document.createElement("canvas");
  o.width = cv.width; o.height = cv.height;
  const g = o.getContext("2d")!;
  g.drawImage(cv, 0, 0); g.drawImage(img, 0, 0, cv.width, cv.height);
  return o.toDataURL("image/png");
}
$("markBtn").addEventListener("click", () => markSet(!markOn));
$("markDone").addEventListener("click", () => markSet(false));
$("markUndo").addEventListener("click", () => { marks.pop(); markSave(); markRender(); });
$("markClear").addEventListener("click", () => { marks = []; markSave(); markRender(); });
$("markBar").addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest("button") as HTMLElement | null;
  if (!t) return;
  if (t.dataset.mk) { markTool = t.dataset.mk as MarkKind; markUi(); }
  if (t.dataset.col) { markCol = t.dataset.col; markUi(); }
});
$("markPng").addEventListener("click", async () => {
  if (!current || !map) return;
  try {
    const url = await markedMapUrl(true);
    const name = (current.parcel.address || current.parcel.lotplan).replace(/[^\w]+/g, "_").slice(0, 60);
    const path = await save({ defaultPath: `Map_${name}.png`, filters: [{ name: "PNG image", extensions: ["png"] }] });
    if (!path) return;
    const bin = atob(url.split(",")[1]);
    const bytes = Array.from({ length: bin.length }, (_, i) => bin.charCodeAt(i));
    await invoke("save_bytes", { path, bytes });
    $("hint").textContent = "Map image saved.";
  } catch (e) { alertMsg(e); }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && markOn && !document.querySelector("dialog[open]")) markSet(false); });

$("measClear").addEventListener("click", () => { measPts = []; measDraw(); });

// ---- Report (one tab per authority) ----
function renderReport() {
  $("tabs").innerHTML = sections
    .map((x) => `<button type="button" class="tab ${x.key === activeTab ? "on" : ""}" data-key="${x.key}">${esc(x.title)}</button>`)
    .join("");
  const cur = sections.find((x) => x.key === activeTab);
  $("report").innerHTML = cur ? (marked.parse(cur.text || "_Writing…_") as string) : "";
}

$("tabs").addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest("button");
  if (!b) return;
  activeTab = b.dataset.key!;
  renderReport();
});

$("genBtn").addEventListener("click", async () => {
  if (!current) return;
  const gen = $("genBtn") as HTMLButtonElement;
  gen.disabled = true;
  gen.textContent = "Starting AI…";
  $("stopBtn").hidden = false;
  $("saveBtn").hidden = true;
  sections = [];
  activeTab = "";
  renderReport();
  const ch = new Channel<{ section: string; title: string; text: string }>();
  ch.onmessage = (ev) => {
    let sec = sections.find((x) => x.key === ev.section);
    if (!sec) {
      sec = { key: ev.section, title: ev.title, text: "" };
      sections.push(sec);
      activeTab = ev.section; // follow the section being written
      gen.textContent = `Writing ${ev.title}…`;
    }
    sec.text += ev.text;
    renderReport();
  };
  try {
    await invoke("generate_report", { pid: current.parcel.pid, question: val("question"), useId: useId(), onEvent: ch });
    if (sections.length) activeTab = sections[0].key;
    renderReport();
    $("saveBtn").hidden = !sections.length;
  } catch (e) {
    $("report").innerHTML = `<p class="err">${esc(e)}</p>`;
  }
  gen.disabled = false;
  gen.textContent = "Generate planner report";
  $("stopBtn").hidden = true;
});

// ---- Chat ----
function renderChat() {
  const log = $("chatLog");
  if (!chatHistory.length) {
    log.innerHTML = `<p class="meta">Ask me anything: how the app works, this site, planning rules, or any other question.</p>`;
    return;
  }
  log.innerHTML = chatHistory
    .map((m) => `<div class="msg ${m.role}">${m.role === "user" ? esc(m.content) : (marked.parse(m.content || "…") as string)}</div>`)
    .join("");
  log.scrollTop = log.scrollHeight;
}

$("chatForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const q = val("chatInput");
  if (!q) return;
  setVal("chatInput", "");
  const btn = $("chatBtn") as HTMLButtonElement;
  btn.disabled = true;
  chatHistory.push({ role: "user", content: q });
  const reply = { role: "assistant", content: "" };
  chatHistory.push(reply);
  renderChat();
  const ch = new Channel<string>();
  ch.onmessage = (t) => {
    reply.content += t;
    renderChat();
  };
  try {
    await invoke("assistant", { pid: current?.parcel.pid ?? null, history: chatHistory.slice(0, -1), onToken: ch });
  } catch (e) {
    reply.content = `**Error:** ${String(e)}`;
    renderChat();
  }
  btn.disabled = false;
});

$("stopBtn").addEventListener("click", () => invoke("cancel_report"));

type Brand = { company?: string; by?: string; logo?: string };
function brand(): Brand {
  try { return JSON.parse(localStorage.getItem("brand") ?? "{}"); } catch { return {}; }
}

// Client-ready report: branding, map, zoning and constraints by authority, potential, title, notes, AI report.
function reportBody(a: Assessment, full = true): string {
  const b = brand();
  const site = sites()[a.parcel.lotplan];
  let mapImg = "";
  try { if (full && map) mapImg = `<img class="rmap" src="${markedPng || map.getCanvas().toDataURL("image/png")}" alt="Site map">`; } catch { /* map not ready */ }
  const byAuth = (k: string) => a.flags.filter((f) => f.rule.authority === k);
  const cn = siteCouncil(a);
  const auths: [string, string][] = [["council", `Council (${cn.name}, ${cn.scheme})`], ["sara", "State (SARA)"], ["pda", "Economic Development Queensland (PDA)"], ["state", "State interests"], ["other", "Other agencies and services"]];
  const head = b.logo || b.company
    ? `<div class="rbrand">${b.logo ? `<img src="${b.logo}" alt="">` : ""}<div><b>${esc(b.company ?? "")}</b>${b.by ? `<br><small>Prepared by ${esc(b.by)}</small>` : ""}</div></div>` : "";
  return `${head}<h1>Planning assessment: ${esc(a.parcel.address || a.parcel.lotplan)}</h1>
<small>${esc(a.parcel.lotplan)}${a.parcel.area_m2 ? ` · ${Math.round(a.parcel.area_m2).toLocaleString()} m²` : ""} · ${esc(cn.name)} · Data pack ${esc(a.manifest.built_at)} · ${new Date().toLocaleDateString("en-AU")}</small>
${mapImg}
${full ? `<h2>Zoning (${esc(cn.scheme)})</h2><ul>${a.zones.length || !zonesMissing(cn) ? "" : `<li>${NO_ZONE}: check ${esc(cn.maps_name ?? "the council online map")}.</li>`}${a.zones.map((z) => `<li><b>${esc(zoneTitle(z))}</b> (${esc(z.authority)})${z.coverage_pct != null ? ` – ${Math.round(z.coverage_pct)}% of lot` : ""}</li>`).join("")}</ul>
<h2>Constraints by authority</h2>${auths.filter(([k]) => byAuth(k).length).map(([k, t]) => `<h3>${t}</h3><ul>${byAuth(k).map((f) => `<li><b>${esc(f.rule.title)}</b> – ${esc(f.rule.note)}</li>`).join("")}</ul>`).join("") || "<p>No mapped constraints.</p>"}
<h2>Development potential</h2>${$("pot").innerHTML}
${site?.title ? `<h2>Title search summary</h2>${marked.parse(site.title)}` : ""}
${site?.note ? `<h2>Notes</h2><p>${esc(site.note).replace(/\n/g, "<br>")}</p>` : ""}` : ""}
${sections.map((x) => `<h2>${esc(x.title)}</h2>${marked.parse(x.text)}`).join("")}
<p class="d">${esc($("disclaimer").textContent)}<br>${esc(a.manifest.attribution)}</p>`;
}

const REPORT_CSS = "font:14px/1.55 Georgia,serif;color:#1f2937";

$("saveBtn").addEventListener("click", async () => {
  if (!current) return;
  const name = (current.parcel.address || current.parcel.lotplan).replace(/[^\w]+/g, "_").slice(0, 60);
  markedPng = await markedMapUrl().catch(() => "");
  const path = await save({ defaultPath: `Planning_report_${name}.html`, filters: [{ name: "HTML report", extensions: ["html"] }] });
  if (!path) return;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Planning report: ${esc(current.parcel.address)}</title>
<style>body{${REPORT_CSS};max-width:820px;margin:40px auto;padding:0 20px}h1{font-size:24px}h2{font-size:18px;margin-top:28px;border-bottom:1px solid #ddd}small,.d{color:#6b7280;font-size:12px}</style></head>
<body>${reportBody(current)}</body></html>`;
  await invoke("save_text", { path, content: html });
});

// PDF: print only the report; choose "Save as PDF" / "Microsoft Print to PDF" in the print dialog.
$("pdfBtn").addEventListener("click", async () => {
  if (!current) return;
  markedPng = await markedMapUrl().catch(() => "");
  $("printArea").innerHTML = reportBody(current);
  window.print();
});

// ---- Queensland maps (open in the default browser) ----
type StateMap = { name: string; url: string; desc: string; at?: string };
const STATE_MAPS = MAPS.state as StateMap[];
const MAP_KEY = "mapSource";

function chosenMap(): StateMap {
  let name = "";
  try { name = localStorage.getItem(MAP_KEY) ?? ""; } catch { /* storage unavailable */ }
  return STATE_MAPS.find((m) => m.name === name) ?? STATE_MAPS[0];
}

// With an address loaded and an address-URL template on the map, centre on the lot; otherwise the general map.
function mapUrlFor(m: StateMap): string {
  if (!m.at || !current) return m.url;
  const [x0, y0, x1, y1] = bounds(current.parcel.geom);
  return m.at.replace("{lat}", ((y0 + y1) / 2).toFixed(6)).replace("{lng}", ((x0 + x1) / 2).toFixed(6));
}

function openExternal(url: string) {
  invoke("open_external", { url }).catch(alertMsg);
}

const mapPick = $("mapPick") as HTMLSelectElement;
mapPick.innerHTML = STATE_MAPS.map((m) => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join("");
mapPick.value = chosenMap().name;
mapPick.addEventListener("change", () => {
  try { localStorage.setItem(MAP_KEY, mapPick.value); } catch { /* storage unavailable */ }
});
$("myMapBtn").addEventListener("click", () => openExternal(mapUrlFor(chosenMap())));

function renderMaps() {
  const f = val("mapsFilter").toLowerCase();
  const ok = (n: string) => !f || n.toLowerCase().includes(f);
  const mine = current ? siteCouncil().id : "";
  // Councils covered by the app (the registry): the site's council first.
  $("siteCouncilMaps").innerHTML = [...COUNCILS].sort((a, b) => Number(b.id === mine) - Number(a.id === mine))
    .filter((c) => ok(c.name) || ok(c.short))
    .map((c) => `<div class="mapitem"><div><b>${esc(c.name)}</b><div class="meta">${c.id === mine ? "This site's council · " : ""}${esc(c.scheme)}</div></div><div class="model-act">
        ${c.maps_url ? `<button type="button" data-url="${esc(c.maps_url)}" data-title="${esc(c.maps_name ?? c.name)}">${esc(c.maps_name ?? "Interactive map")}</button>` : ""}
        <button type="button" class="ghost" data-url="${esc(c.scheme_url)}" data-title="${esc(c.scheme)}">Planning scheme</button>
        ${c.website ? `<button type="button" class="ghost" data-url="${esc(c.website)}" data-title="${esc(c.name)}">Website</button>` : ""}</div></div>`)
    .join("");
  $("stateMaps").innerHTML = MAPS.state
    .filter((m) => ok(m.name))
    .map((m) => `<div class="mapitem"><div><b>${esc(m.name)}</b><div class="meta">${esc(m.desc)}</div></div><button type="button" data-url="${esc(m.url)}" data-title="${esc(m.name)}">Open</button></div>`)
    .join("");
  const inApp = new Set(COUNCILS.map((c) => c.short.toLowerCase()));
  $("councilMaps").innerHTML = MAPS.councils
    .filter((c) => ok(c.name) && !inApp.has(c.name.toLowerCase()))
    .map(
      (c) => `<div class="mapitem"><b>${esc(c.name)}</b><div class="model-act">
        ${c.map ? `<button type="button" data-url="${esc(c.map)}" data-title="${esc(c.name)} mapping">Interactive map</button>` : ""}
        <button type="button" class="ghost" data-url="${esc(c.website)}" data-title="${esc(c.name)} Council">Website</button></div></div>`
    )
    .join("");
}

$("mapsBtn").addEventListener("click", () => {
  renderMaps();
  ($("mapsDlg") as HTMLDialogElement).showModal();
});
$("mapsFilter").addEventListener("input", renderMaps);
$("mapsDlg").addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest("button[data-url]") as HTMLElement | null;
  if (b) openExternal(b.dataset.url!);
});

// ---- Approvals by council: DA register link where known, category copied as a search term ----
const APPR_CATS = ["Development application", "New house", "Dual occupancy", "Multiple dwelling", "Commercial", "Industrial", "Subdivision", "Shed or pool"];
const apprCouncil = $("apprCouncil") as HTMLSelectElement;
const apprCat = $("apprCat") as HTMLSelectElement;
apprCouncil.innerHTML = `<option value="__all__">All councils</option>` + MAPS.councils.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("");
apprCat.innerHTML = APPR_CATS.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");

function renderAppr() {
  const pick = apprCouncil.value;
  const list = MAPS.councils.filter((c) => pick === "__all__" || c.name === pick);
  $("apprList").innerHTML = list
    .map((c) => {
      const da = (c as { da?: string }).da;
      return `<div class="mapitem"><div><b>${esc(c.name)}</b><div class="meta">${da ? "Development applications" : "No application page found"}</div></div><div class="model-act">${da ? `<button type="button" data-url="${esc(da)}">DA applications</button>` : ""}<button type="button" class="ghost" data-url="${esc(c.website)}">Website</button></div></div>`;
    })
    .join("");
}

apprCouncil.addEventListener("change", renderAppr);
$("apprBtn").addEventListener("click", () => {
  renderAppr();
  ($("apprDlg") as HTMLDialogElement).showModal();
});
$("apprList").addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest("button[data-url]") as HTMLElement | null;
  if (b) openExternal(b.dataset.url!);
});
$("apprCopy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(apprCat.value); } catch (e) { alertMsg(e); }
});

refreshStatus().then((s) => {
  if (!s.datapack) return ($("settings") as HTMLDialogElement).showModal();
  // Remember on start: reopen the last site
  let last = 0;
  try { if (localStorage.getItem(OPEN_LAST_KEY) !== "0") last = Number(localStorage.getItem("lastPid")); } catch { /* storage unavailable */ }
  if (last > 0) void loadSite(last, true); // silent: an address that no longer resolves leaves the empty start screen
});

// Light / dark theme (follows the system until the user picks one)
function setTheme(t: "light" | "dark") {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("theme", t); } catch { /* storage unavailable */ }
  document.querySelectorAll<HTMLElement>(".themebtn").forEach((b) => (b.textContent = t === "dark" ? "☀" : "☾"));
}
{
  let t: string | null = null;
  try { t = localStorage.getItem("theme"); } catch { /* storage unavailable */ }
  setTheme(t === "light" || t === "dark" ? t : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
document.querySelectorAll<HTMLElement>(".themebtn").forEach((b) => b.addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark")));

// ---- Star, notes and title search for the open lot ----
const TITLE_LINKS = [
  ["Title search by address (Info Broker)", "https://ib.com.au/buy/445/qld-title-search-by-address"],
  ["Title search by lot/plan (Info Broker)", "https://ib.com.au/buy/425/qld-title-search"],
  ["Order via Landchecker", "https://app.landchecker.com.au/documents/certificates/title"],
];

function renderSiteTools() {
  if (!current) return;
  const s = sites()[current.parcel.lotplan];
  $("starBtn").textContent = s?.star ? "★" : "☆";
  ($("siteNote") as HTMLTextAreaElement).value = s?.note ?? "";
  $("titleLinks").innerHTML = TITLE_LINKS.map(([t, u]) => `<a href="${u}" data-url="${u}" data-title="${esc(t)}" class="ext">${esc(t)}</a>`).join(" · ");
  $("titleOut").innerHTML = s?.title ? (marked.parse(s.title) as string) : "";
}
$("starBtn").addEventListener("click", () => {
  if (!current) return;
  const s = sites()[current.parcel.lotplan];
  touchSite(current.parcel, { star: !s?.star });
  renderSiteTools();
});
$("siteNote").addEventListener("input", () => {
  if (current) touchSite(current.parcel, { note: ($("siteNote") as HTMLTextAreaElement).value });
});
$("titleLinks").addEventListener("click", (ev) => {
  const a = (ev.target as HTMLElement).closest("a");
  if (!a) return;
  ev.preventDefault();
  if (current) navigator.clipboard.writeText(current.parcel.lotplan).catch(() => {});
  openExternal(a.dataset.url!);
});
$("titleBtn").addEventListener("click", async () => {
  if (!current) return;
  const path = await open({ multiple: false, filters: [{ name: "Title search PDF", extensions: ["pdf"] }] });
  if (!path) return;
  const b = $("titleBtn") as HTMLButtonElement;
  b.disabled = true;
  b.textContent = "Reading title…";
  let text = "";
  const ch = new Channel<string>();
  ch.onmessage = (t) => { text += t; $("titleOut").innerHTML = marked.parse(text) as string; };
  try {
    await invoke("summarise_title", { path, onToken: ch });
    touchSite(current.parcel, { title: text });
  } catch (e) {
    $("titleOut").innerHTML = `<p class="err">${esc(e)}</p>`;
  }
  b.disabled = false;
  b.textContent = "Attach title search PDF";
});

// ---- Base map: plain, street (OpenStreetMap) or aerial photo (Queensland Government imagery) ----
const BASES: Record<string, { tiles: string[]; attribution: string; maxzoom: number } | null> = {
  plain: null,
  street: { tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], attribution: "© OpenStreetMap contributors", maxzoom: 19 },
  sat: {
    tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
    attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
    maxzoom: 19,
  },
};
function baseKind(): string {
  let k: string | null = null;
  try { k = localStorage.getItem("base"); } catch { /* storage unavailable */ }
  return k && k in BASES ? k : "sat";
}
function setBase(kind: string) {
  const m = map;
  if (!m) return;
  if (m.getLayer("base")) m.removeLayer("base");
  if (m.getSource("base")) m.removeSource("base");
  const b = BASES[kind];
  if (b) {
    m.addSource("base", { type: "raster", tileSize: 256, ...b });
    const first = m.getStyle().layers.find((l) => l.id !== "bg")?.id; // keep overlays and the lot above the photo
    m.addLayer({ id: "base", type: "raster", source: "base" }, first);
  }
}
($("baseSel") as HTMLSelectElement).value = baseKind();
$("baseSel").addEventListener("change", () => {
  const k = ($("baseSel") as HTMLSelectElement).value;
  try { localStorage.setItem("base", k); } catch { /* storage unavailable */ }
  setBase(k);
});

// Council infrastructure charge for the extra lots a subdivision would create (Council share only).
function chargeEstimate(p: any): string {
  const rate = p.use_fit?.rule?.items.find((i: any) => i.key === "ic_lot")?.n;
  const n = p.lots_by_area;
  if (!rate || !n || n < 2) return "";
  const money = (x: number) => `$${Math.round(x).toLocaleString()}`;
  return `<p class="meta"><b>Estimate:</b> ${n} lots = ${n - 1} additional × ${money(rate)} = <b>${money((n - 1) * rate)}</b> Council charge, plus ${esc(siteCouncil().water?.name ?? "water and sewer")} water and sewer. Before indexation and any credits.</p>`;
}

// ---- Nearby approvals: the site council's DA register (Brisbane: Development.i), address copied for pasting ----
$("daRegBtn").addEventListener("click", () => {
  if (!current) return;
  navigator.clipboard.writeText(current.parcel.address || current.parcel.lotplan).catch(() => {});
  const c = siteCouncil();
  openExternal(c.da_url || c.website || c.scheme_url);
});

// ---- Statutory clock: rules from knowledge/timeframes.json (each with source); lodgement date and path saved per lot ----
type TfRule = { id: string; label: string; days: number | null; months: number | null; day_type: string; applies_to: string[]; start: string; start_by_path?: Record<string, string>; exclude_md_ranges?: string[][]; source: { name: string; url: string }; verify: boolean; note: string };
const TF = TIMEFRAMES_DATA as unknown as { holidays_source: { name: string; url: string }; holidays_cover: string[]; holidays: { date: string; name: string; scope: string }[]; notes: string[]; rules: TfRule[] };
const HOLIDAYS = new Set(TF.holidays.map((h) => h.date));
const isoD = (d: Date) => d.toISOString().slice(0, 10);
const parseD = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const plusDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
function nonBusiness(d: Date, ranges: string[][]): boolean {
  const dow = d.getUTCDay(), iso = isoD(d), md = iso.slice(5);
  return dow === 0 || dow === 6 || HOLIDAYS.has(iso) || ranges.some(([a, b]) => (a <= b ? md >= a && md <= b : md >= a || md <= b));
}
/** Counts n business days starting the day after `start`. */
function addBusiness(start: Date, n: number, ranges: string[][] = []): Date {
  let d = start;
  for (let c = 0; c < n; ) { d = plusDays(d, 1); if (!nonBusiness(d, ranges)) c++; }
  return d;
}
function addMonths(d: Date, n: number): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  x.setUTCDate(Math.min(d.getUTCDate(), new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate()));
  return x;
}
function clockDates(lodged: string, path: string): { rule: TfRule; date: Date }[] {
  const out: { rule: TfRule; date: Date }[] = [];
  const at: Record<string, Date> = { lodgement: parseD(lodged) };
  for (const r of TF.rules) {
    if (!r.applies_to.includes(path)) continue;
    const from = at[r.start_by_path?.[path] ?? r.start];
    if (!from) continue;
    const d = r.months ? addMonths(from, r.months) : r.day_type === "business" ? addBusiness(from, r.days ?? 0, r.exclude_md_ranges) : plusDays(from, r.days ?? 0);
    at[r.id] = d;
    out.push({ rule: r, date: d });
  }
  return out;
}
const fmtD = (d: Date) => d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
function renderClock() {
  if (!current) return;
  const s = sites()[current.parcel.lotplan];
  const dateEl = $("clkDate") as HTMLInputElement, pathEl = $("clkPath") as HTMLSelectElement;
  if (document.activeElement !== dateEl) dateEl.value = s?.lodged ?? "";
  pathEl.value = s?.path === "impact" ? "impact" : "code";
  const out = $("clockOut");
  if (!TF.rules.length) { out.innerHTML = `<p class="meta">No sourced rules loaded yet.</p>`; return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateEl.value)) { out.innerHTML = `<p class="meta">Enter the lodgement date to see the key dates.</p>`; return; }
  const rows = clockDates(dateEl.value, pathEl.value);
  const last = TF.holidays_cover[TF.holidays_cover.length - 1];
  const beyond = rows.some((r) => String(r.date.getUTCFullYear()) > last) || dateEl.value.slice(0, 4) < TF.holidays_cover[0];
  const link = (u: { name: string; url: string }) => `<a href="${esc(u.url)}" data-url="${esc(u.url)}" class="ext">${esc(u.name)}</a>`;
  out.innerHTML = `<table class="ptable"><tbody>${rows.map(({ rule: r, date }) => `<tr><td><b>${esc(fmtD(date))}</b><div>${esc(r.label)}</div><div class="meta">${r.months ? `${r.months} months` : `${r.days} ${r.day_type} days`} · ${link(r.source)}${r.verify ? ` <span class="pill warn">verify</span>` : ""}</div>${r.note ? `<div class="meta">${esc(r.note)}</div>` : ""}</td></tr>`).join("")}</tbody></table>
    <p class="meta">Latest dates, assuming no referral agency. Business days skip weekends and Queensland and Brisbane public holidays (${esc(TF.holidays_cover.join(", "))}; ${link(TF.holidays_source)}).${beyond ? " Some dates fall outside the loaded holiday years, so holidays may be missing." : ""}</p>
    ${TF.notes.map((n) => `<p class="meta">${esc(n)}</p>`).join("")}`;
}
function saveClock() {
  if (!current) return;
  touchSite(current.parcel, { lodged: ($("clkDate") as HTMLInputElement).value, path: ($("clkPath") as HTMLSelectElement).value });
  renderClock();
}
$("clkDate").addEventListener("input", saveClock);
$("clkPath").addEventListener("change", saveClock);

// ---- Possible referrals: constraints detected on the lot matched to rows in knowledge/referrals.json (rows need a primary source) ----
type RefRow = { flag_id: string; agency: string; trigger: string; description: string; source: { name: string; url: string }; verify: boolean };
const REFERRALS = (REFERRALS_DATA as unknown as { rows: RefRow[] }).rows;
function renderReferrals(a: Assessment) {
  const label = `<p class="meta">Indicative only: confirm with the State Assessment and Referral Agency (SARA) or council.</p>`;
  if (!REFERRALS.length) { $("referralOut").innerHTML = `<p class="meta">No sourced rules loaded yet.</p>${label}`; return; }
  const ids = new Set(a.flags.map((f) => f.rule.id));
  const hit = REFERRALS.filter((r) => ids.has(r.flag_id));
  $("referralOut").innerHTML = (hit.length
    ? hit.map((r) => `<div class="card"><b>${esc(r.agency)}</b> ${r.verify ? `<span class="pill warn">verify</span>` : ""}<div class="meta">${esc(r.trigger)}</div><p>${esc(r.description)}</p><a href="${esc(r.source.url)}" data-url="${esc(r.source.url)}" class="ext">${esc(r.source.name)}</a></div>`).join("")
    : `<p class="meta">No known referral triggers matched the constraints detected on this lot.</p>`) + label;
}

// ---- Report branding (Settings) ----
function showBrand() {
  const b = brand();
  setVal("brandCompany", b.company ?? "");
  setVal("brandBy", b.by ?? "");
  ($("brandLogoPrev") as HTMLImageElement).src = b.logo ?? "";
  $("brandLogoPrev").hidden = !b.logo;
}
function saveBrand(patch: Brand) {
  try { localStorage.setItem("brand", JSON.stringify({ ...brand(), ...patch })); } catch { alertMsg("Could not save branding (logo may be too large)."); }
  showBrand();
}
$("brandCompany").addEventListener("change", () => saveBrand({ company: val("brandCompany") }));
$("brandBy").addEventListener("change", () => saveBrand({ by: val("brandBy") }));
$("brandLogo").addEventListener("change", () => {
  const f = ($("brandLogo") as HTMLInputElement).files?.[0];
  if (!f) return;
  if (f.size > 1_500_000) return alertMsg("Please use a logo under 1.5 MB.");
  const r = new FileReader();
  r.onload = () => saveBrand({ logo: String(r.result) });
  r.readAsDataURL(f);
});
$("brandClear").addEventListener("click", () => saveBrand({ logo: undefined }));
showBrand();

// ---- 3D height envelope: the lot extruded to its height limit (setbacks and site cover not applied) ----
let envOn = false;
function envHeight(): number {
  const it = (pot?.provisions?.items ?? []).find((i: any) => /height/i.test(i.label));
  const m = it?.value.match(/(\d+(?:\.\d+)?)\s*m\b/);
  return m ? Number(m[1]) : 9.5;
}
$("envBtn").addEventListener("click", () => {
  if (!current || !map) return;
  const m = map;
  envOn = !envOn;
  toolUi("envBtn", envOn);
  if (m.getLayer("env")) { m.removeLayer("env"); m.removeSource("env"); }
  if (!envOn) { m.easeTo({ pitch: 0, bearing: 0, duration: 400 }); return setFloodUi(floodOn); }
  const h = envHeight();
  m.addSource("env", { type: "geojson", data: { type: "Feature", properties: {}, geometry: current.parcel.geom } });
  m.addLayer({ id: "env", type: "fill-extrusion", source: "env", paint: { "fill-extrusion-color": "#2563eb", "fill-extrusion-height": h, "fill-extrusion-opacity": 0.45 } });
  m.easeTo({ pitch: 60, bearing: -25, duration: 700 });
  setFloodUi(floodOn, `<div><b>3D envelope: ${h} m</b></div><div class="meta">Whole lot raised to the height limit. Setbacks and site cover are not applied – indicative only. Turn on Aerial photo for context.</div>`);
});

// ---- Suburb report (from the data pack) ----
// Suburb from the address text when the parcel has none: last comma part without state/postcode, else the words after the street type.
function suburbFromAddress(addr: string): string {
  const clean = (t: string) => t.replace(/\b(QLD|QUEENSLAND)\b/gi, "").replace(/\b\d{4}\b/g, "").replace(/\s+/g, " ").trim();
  const parts = addr.split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1) return clean(parts[parts.length - 1]);
  const m = clean(addr).match(/\b(?:street|st|road|rd|avenue|ave|drive|dr|court|ct|place|pl|lane|ln|crescent|cres|terrace|tce|parade|pde|way|close|cl|boulevard|blvd|highway|hwy|circuit|cct)\.?\s+(.+)$/i);
  return m ? m[1].trim() : "";
}
$("suburbBtn").addEventListener("click", async () => {
  if (!current) return;
  const out = $("suburbOut");
  const sub = current.parcel.suburb?.trim() || suburbFromAddress(current.parcel.address || "");
  if (!sub) { out.innerHTML = `<p class="err" role="alert">Could not work out the suburb for this address, so there is no suburb report.</p>`; return; }
  out.innerHTML = `<p class="meta" role="status">Loading suburb report for ${esc(sub)}…</p>`;
  ($("suburbBtn") as HTMLButtonElement).disabled = true;
  try {
    const r = await invoke<any>("suburb_stats", { suburb: sub });
    if (!r || !r.lots) { out.innerHTML = `<p class="err" role="alert">No lots found in the data pack for "${esc(sub)}". Check the suburb name; the pack covers ${esc(packCouncils().join(", "))}.</p>`; return; }
    const lot = current.parcel.area_m2 ?? 0;
    out.innerHTML = `<table class="ptable"><tbody>
      <tr><td>Lots in ${esc(r.suburb)}</td><td><b>${r.lots.toLocaleString()}</b></td></tr>
      <tr><td>Median lot size</td><td><b>${r.median_m2} m²</b> (middle half ${r.p25_m2}–${r.p75_m2} m²)</td></tr>
      <tr><td>This lot</td><td><b>${Math.round(lot)} m²</b> – ${lot >= r.median_m2 ? "larger" : "smaller"} than the suburb median</td></tr>
      <tr><td>Lots 600 m² or more</td><td>${r.pct_600}%</td></tr>
      <tr><td>Lots 800 m² or more</td><td>${r.pct_800}%</td></tr>
      <tr><td>Lots 900 m² or more (2 × 450 m² by area)</td><td>${r.pct_900}% (${r.count_900.toLocaleString()} lots)</td></tr>
      <tr><td>Lots 1,000 m² or more</td><td>${r.pct_1000}%</td></tr></tbody></table>
      <p class="meta">${siteCouncil().id === "brisbane" ? "From the Brisbane cadastre in the data pack." : "From the Queensland cadastre in the data pack (lots in this suburb name, all councils)."} Population, income and housing: ${link("https://www.abs.gov.au/census/find-census-data/quickstats", "ABS Census QuickStats")} (search "${esc(sub)}").</p>`;
  } catch (e) {
    out.innerHTML = `<p class="err" role="alert">Suburb report failed: ${esc(String(e))}</p>`;
  } finally {
    ($("suburbBtn") as HTMLButtonElement).disabled = false;
  }
});

// ---- Compare 2–3 sites ----
let cmpAdded: Site[] = [];
function cmpRender() {
  const checked = new Set([...document.querySelectorAll<HTMLInputElement>("#cmpPick input:checked")].map((i) => i.value));
  const ps = projects();
  const pf = ($("cmpProj") as HTMLSelectElement).value || "all";
  const pOf = (h: Site) => (h.project && ps.some((p) => p.id === h.project) ? h.project : "none");
  const list = Object.values(sites()).sort((x, y) => Number(!!y.star) - Number(!!x.star) || y.ts - x.ts).filter((h) => !cmpAdded.some((c) => c.lotplan === h.lotplan) && (pf === "all" || pOf(h) === pf));
  const row = (h: Site, added: boolean) => `<div class="mapitem cmprow"><label><input type="checkbox" value="${esc(h.lotplan)}" data-pid="${h.pid}"${checked.has(h.lotplan) ? " checked" : ""}> ${h.star ? "★ " : ""}<b>${esc(h.address || h.lotplan)}</b> <span class="meta">${esc(h.lotplan)}</span></label>${added ? `<button type="button" class="ghost cmp-rm" data-lp="${esc(h.lotplan)}" aria-label="Remove ${esc(h.address || h.lotplan)}">Remove</button>` : ""}</div>`;
  $("cmpProj").innerHTML = projOptions(ps.some((p) => p.id === pf) || pf === "none" ? pf : "all");
  ($("cmpAll") as HTMLButtonElement).disabled = pf === "all" || !list.length;
  $("cmpPick").innerHTML = cmpAdded.map((h) => row(h, true)).join("") + list.map((h) => row(h, false)).join("") || `<p class="meta">No saved addresses yet. Search above to add one.</p>`;
  cmpSync();
}
function cmpSync() {
  const boxes = [...document.querySelectorAll<HTMLInputElement>("#cmpPick input")];
  const n = boxes.filter((i) => i.checked).length;
  boxes.forEach((i) => { i.disabled = n >= 3 && !i.checked; });
  ($("cmpGo") as HTMLButtonElement).disabled = n < 2;
  $("cmpMsg").textContent = n >= 3 ? "Limit of 3 addresses reached. Untick or remove one to change the selection." : `${n} of 3 selected (pick at least 2).`;
}
$("cmpPick").addEventListener("change", cmpSync);
$("cmpProj").addEventListener("change", cmpRender);
$("cmpAll").addEventListener("click", () => {
  for (const i of document.querySelectorAll<HTMLInputElement>("#cmpPick input:not(:checked)")) {
    if (document.querySelectorAll("#cmpPick input:checked").length >= 3) break;
    i.checked = true;
  }
  cmpSync();
});
$("cmpPick").addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>(".cmp-rm");
  if (!b) return;
  cmpAdded = cmpAdded.filter((c) => c.lotplan !== b.dataset.lp);
  cmpRender();
});
async function cmpFind() {
  const q = ($("cmpQ") as HTMLInputElement).value.trim();
  const out = $("cmpRes");
  if (q.length < 3) { out.innerHTML = ""; return; }
  try {
    const r = await findAddresses(q);
    const items = r.google ? r.google.map((x) => `<li><button type="button" class="ghost" data-place="${esc(x.place_id)}"><b>${esc(x.text)}</b><span>Google</span></button></li>`)
      : (r.hits ?? []).map((h) => `<li><button type="button" class="ghost" data-pid="${h.pid}" data-addr="${esc(h.address)}" data-lp="${esc(h.lotplan)}"><b>${esc(h.address || h.lotplan)}</b><span>${esc(h.lotplan)} · ${esc(councilOf(h.council).short)}</span></button></li>`);
    out.innerHTML = items.length ? items.join("") : `<li class="meta">${notFound()}</li>`;
  } catch (e) {
    out.innerHTML = `<li class="err">${esc(e)}</li>`;
  }
}
let cmpTimer = 0;
$("cmpQ").addEventListener("input", () => { clearTimeout(cmpTimer); cmpTimer = window.setTimeout(cmpFind, 250); });
$("cmpQ").addEventListener("keydown", (ev) => { if ((ev as KeyboardEvent).key === "Enter") { ev.preventDefault(); clearTimeout(cmpTimer); cmpFind(); } });
$("cmpRes").addEventListener("click", async (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("button");
  if (!b) return;
  if (document.querySelectorAll("#cmpPick input:checked").length >= 3) { cmpSync(); return; }
  let h: Hit | undefined;
  try {
    h = b.dataset.place ? await invoke<Hit>("google_pick", { placeId: b.dataset.place }) : { pid: Number(b.dataset.pid), address: b.dataset.addr ?? "", lotplan: b.dataset.lp ?? "", suburb: "" };
  } catch (e) { return alertMsg(e); }
  if (!h) return;
  const lp = h.lotplan;
  if (!cmpAdded.some((c) => c.lotplan === lp)) cmpAdded.unshift({ pid: h.pid, address: h.address, lotplan: lp, ts: Date.now() });
  ($("cmpQ") as HTMLInputElement).value = "";
  $("cmpRes").innerHTML = "";
  cmpRender();
  const box = [...document.querySelectorAll<HTMLInputElement>("#cmpPick input")].find((i) => i.value === lp);
  if (box) { box.checked = true; cmpSync(); }
});
$("cmpBtn").addEventListener("click", () => {
  cmpAdded = [];
  ($("cmpQ") as HTMLInputElement).value = "";
  $("cmpRes").innerHTML = "";
  $("cmpOut").innerHTML = "";
  cmpRender();
  ($("cmpDlg") as HTMLDialogElement).showModal();
});
$("cmpGo").addEventListener("click", async () => {
  const picked = [...document.querySelectorAll<HTMLInputElement>("#cmpPick input:checked")].slice(0, 3);
  if (picked.length < 2) return;
  $("cmpOut").innerHTML = `<p class="meta">Comparing…</p>`;
  const rows: { a: Assessment; p: any }[] = [];
  for (const el of picked) {
    try {
      let a = await invoke<Assessment>("assess", { pid: Number(el.dataset.pid) });
      if (a.parcel.lotplan !== el.value) {
        const h = (await invoke<Hit[]>("search", { q: el.value })).find((x) => x.lotplan === el.value);
        if (!h) continue;
        a = await invoke<Assessment>("assess", { pid: h.pid });
      }
      rows.push({ a, p: await invoke("potential", { pid: a.parcel.pid, useId: useId() }) });
    } catch { /* skip lots that fail */ }
  }
  const cell = (f: (r: { a: Assessment; p: any }) => string) => rows.map((r) => `<td>${f(r)}</td>`).join("");
  const height = (p: any) => (p.provisions?.items ?? []).find((i: any) => /height/i.test(i.label))?.value ?? "–";
  $("cmpOut").innerHTML = `<table class="ptable cmp"><thead><tr><th></th>${cell((r) => `<b>${esc(r.a.parcel.address || r.a.parcel.lotplan)}</b>`)}</tr></thead><tbody>
    <tr><td>Lot/plan</td>${cell((r) => esc(r.a.parcel.lotplan))}</tr>
    <tr><td>Area</td>${cell((r) => `${Math.round(r.p.area_m2)} m²`)}</tr>
    <tr><td>Frontage</td>${cell((r) => (r.p.frontage_m != null ? `${r.p.frontage_m} m` : "–"))}</tr>
    <tr><td>Zone</td>${cell((r) => esc(r.a.zones.map(zoneTitle).join(", ") || (zonesMissing(siteCouncil(r.a)) ? "Not loaded" : "–")))}</tr>
    <tr><td>Height</td>${cell((r) => esc(height(r.p)))}</tr>
    <tr><td>Lots by area</td>${cell((r) => (r.p.lots_by_area ? String(r.p.lots_by_area) : "1"))}</tr>
    <tr><td>Level of assessment</td>${cell((r) => esc(r.p.use_fit?.rule?.level ?? "Choose a proposal type"))}</tr>
    <tr><td>Constraints</td>${cell((r) => r.a.flags.map((f) => `<span class="auth">${esc(f.rule.authority)}</span> ${esc(f.rule.title)}`).join("<br>") || "None mapped")}</tr>
  </tbody></table>`;
});

// ---- Batch address check (thread C) ----
let batchCsv = "";
const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
$("batchBtn").addEventListener("click", () => ($("batchDlg") as HTMLDialogElement).showModal());
$("batchPick").addEventListener("click", async () => {
  const path = await open({ multiple: false, filters: [{ name: "Address list", extensions: ["csv", "txt"] }] });
  if (typeof path !== "string") return;
  const out = $("batchOut");
  let lines: string[];
  try {
    lines = (await invoke<string>("read_text_file", { path }))
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^"(.*)"$/, "$1").trim())
      .filter(Boolean);
  } catch (e) {
    out.innerHTML = `<p class="err">${esc(e)}</p>`;
    return;
  }
  if (lines.length && /^(input|address|lot ?\/? ?plan)\b/i.test(lines[0])) lines.shift();
  if (!lines.length) { out.innerHTML = `<p class="meta">No lines found in that file.</p>`; return; }
  ($("batchSave") as HTMLButtonElement).disabled = true;
  const rows: string[][] = [["input", "matched address", "lot/plan", "council", "area m2", "zone(s)", "number of constraints", "constraint titles"]];
  const shown: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.innerHTML = `<p class="meta">Checking ${i + 1} of ${lines.length}…</p>${shown.join("")}`;
    const q = lines[i];
    try {
      const h = (await invoke<Hit[]>("search", { q }))[0];
      if (!h) throw new Error("no match");
      const a = await invoke<Assessment>("assess", { pid: h.pid });
      rows.push([q, a.parcel.address, a.parcel.lotplan, siteCouncil(a).name, a.parcel.area_m2 != null ? String(Math.round(a.parcel.area_m2)) : "",
        a.zones.map(zoneTitle).join("; ") || (zonesMissing(siteCouncil(a)) ? NO_ZONE : ""), String(a.flags.length), a.flags.map((f) => f.rule.title).join("; ")]);
      shown.push(`<div class="mapitem"><span><b>${esc(a.parcel.address || a.parcel.lotplan)}</b> <span class="meta">${esc(q)}</span></span><span class="meta">${a.flags.length} constraint(s)</span></div>`);
    } catch {
      rows.push([q, "", "", "", "", "", "", ""]);
      shown.push(`<div class="mapitem"><span>${esc(q)}</span><span class="meta">no match</span></div>`);
    }
  }
  batchCsv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  out.innerHTML = `<p class="meta">Done: ${lines.length} line(s) checked.</p>${shown.join("")}`;
  ($("batchSave") as HTMLButtonElement).disabled = false;
});
$("batchSave").addEventListener("click", async () => {
  if (!batchCsv) return;
  const path = await save({ defaultPath: "Batch_address_check.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
  if (!path) return;
  try { await invoke("save_text", { path, content: batchCsv }); } catch (e) { alertMsg(e); }
});

// ---- Setbacks: rows come from knowledge/setbacks.json, only for zones and lot sizes it covers ----
// Brisbane: knowledge/setbacks.json (plus extra zones under "brisbane" in council_rules.json). Other councils: "setbacks" in knowledge/council_rules.json (keyed by zone, optional precincts).
type SetbackSet = { title: string; min_area_m2: number; note: string; source: string; rows: { label: string; value: string; ref: string }[]; check: string; precinct?: string[] };
const SETBACKS = SETBACKS_DATA as Record<string, SetbackSet>;
const COUNCIL_KB = COUNCIL_RULES as unknown as Record<string, { setbacks?: Record<string, SetbackSet | SetbackSet[]> }>;
/** The setback set for this lot, only when its zone (and precinct, if the set names one) is covered and the lot is at least the set's minimum area. */
function setbackSet(a: Assessment): SetbackSet | undefined {
  const cid = siteCouncil(a).id;
  const low = (x: string) => x.toLowerCase();
  const pick = (z: Assessment["zones"][number]): SetbackSet | undefined => {
    // Brisbane: setbacks.json first, then zones that only council_rules.json covers.
    const v = (cid === "brisbane" ? SETBACKS[z.zone.name] : undefined) ?? COUNCIL_KB[cid]?.setbacks?.[z.zone.name];
    return (Array.isArray(v) ? v : v ? [v] : []).find((s) => !s.precinct?.length || s.precinct.some((p) => low(z.precinct ?? "").includes(low(p))));
  };
  const set = a.zones.map(pick).find(Boolean);
  const area = a.parcel.area_m2;
  return set && area != null && area >= set.min_area_m2 ? set : undefined;
}
function renderSetbacks(a: Assessment) {
  const zones = a.zones.map(zoneTitle);
  const set = setbackSet(a);
  const area = a.parcel.area_m2;
  const cn = siteCouncil(a);
  const fact = cn.id === "brisbane"
    ? `<button type="button" class="ghost" data-url="https://www.brisbane.qld.gov.au/planning-building/planning-guidelines-tools/brisbane-city-plan-2014/fact-sheets/residential-development-suburban-zones">Open the City Plan fact sheet</button>`
    : `<button type="button" class="ghost" data-url="${esc(cn.scheme_url)}">Open the ${esc(cn.scheme)}</button>`;
  if (!set) {
    $("setbacks").innerHTML = `<div class="card"><div class="meta">Zone: ${esc(zones.join(", ") || (zonesMissing(cn) ? NO_ZONE.toLowerCase() : "not identified"))}${area != null ? ` · ${Math.round(area)} m²` : ""}</div>
      <p>Setback distances for this zone and lot size aren't in the app yet, so none are shown. Check with ${esc(cn.name)}.</p>${fact}</div>`;
    return;
  }
  $("setbacks").innerHTML = `<div class="card"><div class="meta">${esc(set.title)} · <span class="pill warn">verify</span></div>
    <table class="ptable"><tbody>${set.rows.map((r) => `<tr><td>${esc(r.label)}<div class="meta">${esc(r.ref)}</div></td><td><b>${esc(r.value)}</b></td></tr>`).join("")}</tbody></table>
    <p class="meta">${esc(set.note)}</p><p class="meta">${esc(set.check)}</p>
    <button type="button" class="primary" data-act="setb">Show on map and try options</button> <button type="button" class="ghost" data-url="${esc(set.source)}">Open the code</button> ${fact}</div>`;
}

// ==== Setbacks tool: buildable area inset from the lot by the ground-floor setbacks (indicative only) ====
let setbackOn = false;
let setbackMarkers: maplibregl.Marker[] = [];
let setbackNote = "";
type XY = [number, number];
const SETBACK_ROWS = { front: "Front, primary frontage (building wall)", side: "Side, ground floor or wall up to 4.5 m", rear: "Rear, ground floor or wall up to 4.5 m" };

function clearSetbackLayer() {
  setbackMarkers.forEach((m) => m.remove());
  setbackMarkers = [];
  if (map?.getLayer("setbf")) map.removeLayer("setbf");
  if (map?.getLayer("setb")) { map.removeLayer("setb"); map.removeSource("setb"); }
}
function resetSetbackTool() {
  measMode = ""; measPts = []; measMarks = []; toolUi("measDBtn", false); toolUi("measABtn", false); ($("measOut") as HTMLElement).hidden = true;
  setbackOn = false;
  setbackOv = {};
  ($("setbackEd") as HTMLElement).hidden = true;
  toolUi("setbackBtn", false);
  setbackMarkers = []; // the map is rebuilt on a new site, which removes the layer
}

/** Buildable polygon (lon/lat ring) and labels, or a reason it can't be drawn. */
type SbInfo = { i: number; kind: string; len: number; std: number; off: number; mid: XY };
function setbackEnvelope(a: Assessment, p: Pot, ov: Record<number, number> = {}): { ring: XY[]; labels: { ll: XY; text: string }[]; info: SbInfo[]; area: number; stdArea: number; lotArea: number } | string {
  const set = setbackSet(a);
  if (!set) return "Setback distances for this zone and lot size aren't in the app.";
  const val = (label: string) => parseFloat(set.rows.find((r) => r.label === label)?.value ?? "");
  const d = { front: val(SETBACK_ROWS.front), side: val(SETBACK_ROWS.side), rear: val(SETBACK_ROWS.rear) };
  if (!isFinite(d.front) || !isFinite(d.side) || !isFinite(d.rear)) return "The setback rows needed aren't in the data.";
  const g = a.parcel.geom;
  const polys: XY[][][] = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  const shoe = (r: XY[]) => r.reduce((t, c, i) => t + (r[(i + 1) % r.length][0] - c[0]) * (r[(i + 1) % r.length][1] + c[1]), 0) / 2;
  const outer = polys.map((q) => q[0]).sort((x, y) => Math.abs(shoe(y)) - Math.abs(shoe(x)))[0];
  if (!outer || outer.length < 4) return "No lot outline.";
  const lat0 = (Math.min(...outer.map((c) => c[1])) + Math.max(...outer.map((c) => c[1]))) / 2;
  const lon0 = (Math.min(...outer.map((c) => c[0])) + Math.max(...outer.map((c) => c[0]))) / 2;
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320, ky = 111320;
  const toM = (c: XY): XY => [(c[0] - lon0) * kx, (c[1] - lat0) * ky];
  const toLL = (c: XY): XY => [lon0 + c[0] / kx, lat0 + c[1] / ky];
  // Merge near-collinear segments exactly as dev.rs sides() does, so the edges line up with pot.edges.
  const ring = outer.map(toM);
  const sides: [XY, XY][] = [];
  for (let i = 0; i + 1 < ring.length; i++) {
    const [s0, s1] = [ring[i], ring[i + 1]];
    if (Math.hypot(s1[0] - s0[0], s1[1] - s0[1]) < 0.05) continue;
    const last = sides[sides.length - 1];
    if (last) {
      let diff = Math.abs(Math.atan2(last[1][0] - last[0][0], last[1][1] - last[0][1]) - Math.atan2(s1[0] - s0[0], s1[1] - s0[1]));
      if (diff > Math.PI) diff = 2 * Math.PI - diff;
      if (diff < (12 * Math.PI) / 180) { last[1] = s1; continue; }
    }
    sides.push([s0, s1]);
  }
  const n = sides.length;
  if (n < 3 || n !== p.edges.length) return "The lot outline doesn't match the measured sides.";
  for (let i = 0; i < n; i++) {
    const m = toM(p.edges[i].mid), len = Math.hypot(sides[i][1][0] - sides[i][0][0], sides[i][1][1] - sides[i][0][1]);
    if (Math.hypot(m[0] - (sides[i][0][0] + sides[i][1][0]) / 2, m[1] - (sides[i][0][1] + sides[i][1][1]) / 2) > 1.5 || Math.abs(len - p.edges[i].length_m) > 0.3) return "The lot outline doesn't match the measured sides.";
  }
  if (p.edges.some((e) => e.frontage == null)) return "The street frontage couldn't be identified.";
  const fronts = p.edges.map((e, i) => (e.frontage ? i : -1)).filter((i) => i >= 0);
  if (!fronts.length) return "No street edge could be identified for this lot.";
  const flen = (i: number) => p.edges[i].length_m;
  const fi = fronts.reduce((x, y) => (flen(y) < flen(x) ? y : x)); // corner lot: the shorter street edge is treated as the primary frontage
  const corner = fronts.length > 1;
  const cross = (i: number) => {
    const u = [sides[i][1][0] - sides[i][0][0], sides[i][1][1] - sides[i][0][1]], v = [sides[(i + 1) % n][1][0] - sides[(i + 1) % n][0][0], sides[(i + 1) % n][1][1] - sides[(i + 1) % n][0][1]];
    return u[0] * v[1] - u[1] * v[0];
  };
  const cs = sides.map((_, i) => cross(i));
  if (!(cs.every((c) => c >= -1e-6) || cs.every((c) => c <= 1e-6))) return "The lot isn't a simple convex shape.";
  const ccw = shoe(sides.map((sd) => sd[0])) < 0; // shoe() is the (x2-x1)(y2+y1) form: negative = counter-clockwise
  const dirOf = (i: number): XY => { const l = Math.hypot(sides[i][1][0] - sides[i][0][0], sides[i][1][1] - sides[i][0][1]); return [(sides[i][1][0] - sides[i][0][0]) / l, (sides[i][1][1] - sides[i][0][1]) / l]; };
  const normal = (i: number): XY => { const u = dirOf(i); return ccw ? [-u[1], u[0]] : [u[1], -u[0]]; }; // pointing into the lot
  const fn = normal(fi);
  const fa = sides[fi][0];
  const depthOf = (i: number) => { const m: XY = [(sides[i][0][0] + sides[i][1][0]) / 2, (sides[i][0][1] + sides[i][1][1]) / 2]; return (m[0] - fa[0]) * fn[0] + (m[1] - fa[1]) * fn[1]; };
  let ri = -1;
  for (let i = 0; i < n; i++) if (!fronts.includes(i) && (ri < 0 || depthOf(i) > depthOf(ri))) ri = i;
  const fd = dirOf(fi), rd = dirOf(ri);
  if (Math.abs(fd[0] * rd[0] + fd[1] * rd[1]) < Math.cos((30 * Math.PI) / 180)) return "No clear rear edge opposite the front.";
  const kindOf = (i: number) => (fronts.includes(i) ? "front" : i === ri ? "rear" : "side");
  const std = (i: number) => (fronts.includes(i) ? d.front : i === ri ? d.rear : d.side);
  // Clip the lot by every edge moved inward by its setback.
  const clip = (offOf: (i: number) => number) => {
    let poly: XY[] = sides.map((sd) => sd[0]);
    const lines: { a: XY; nrm: XY; off: number }[] = [];
    for (let i = 0; i < n; i++) {
      const off = offOf(i);
      const nrm = normal(i);
      lines.push({ a: sides[i][0], nrm, off });
      const f = (q: XY) => (q[0] - sides[i][0][0]) * nrm[0] + (q[1] - sides[i][0][1]) * nrm[1] - off;
      const out: XY[] = [];
      for (let k = 0; k < poly.length; k++) {
        const [c, nx] = [poly[k], poly[(k + 1) % poly.length]];
        const [fc, fnx] = [f(c), f(nx)];
        if (fc >= 0) out.push(c);
        if ((fc >= 0) !== (fnx >= 0)) { const t = fc / (fc - fnx); out.push([c[0] + (nx[0] - c[0]) * t, c[1] + (nx[1] - c[1]) * t]); }
      }
      poly = out;
      if (poly.length < 3) return null;
    }
    return Math.abs(shoe(poly)) < 1 ? null : { poly, lines };
  };
  const base = clip(std);
  const cur = clip((i) => ov[i] ?? std(i));
  if (!cur) return "The setbacks leave no buildable area on this lot.";
  const { poly, lines } = cur;
  const labels: { ll: XY; text: string }[] = [];
  lines.forEach((ln, i) => {
    const on = poly.filter((q) => Math.abs((q[0] - ln.a[0]) * ln.nrm[0] + (q[1] - ln.a[1]) * ln.nrm[1] - ln.off) < 0.01);
    if (on.length < 2) return;
    const u = dirOf(i), t = (q: XY) => q[0] * u[0] + q[1] * u[1];
    const [lo, hi] = [on.reduce((x, y) => (t(y) < t(x) ? y : x)), on.reduce((x, y) => (t(y) > t(x) ? y : x))];
    if (Math.hypot(hi[0] - lo[0], hi[1] - lo[1]) < 1) return;
    labels.push({ ll: toLL([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2]), text: `${kindOf(i)} ${+ln.off.toFixed(2)} m` });
  });
  setbackNote = corner ? " Corner lot: both street edges use the front setback; a secondary frontage may need less, so check." : "";
  const info: SbInfo[] = sides.map((_, i) => ({ i, kind: kindOf(i), len: p.edges[i].length_m, std: std(i), off: ov[i] ?? std(i), mid: p.edges[i].mid as XY }));
  return { ring: [...poly, poly[0]].map(toLL), labels, info, area: Math.abs(shoe(poly)), stdArea: base ? Math.abs(shoe(base.poly)) : 0, lotArea: Math.abs(shoe(sides.map((sd) => sd[0]))) };
}

let setbackOv: Record<number, number> = {};
function drawSetbacks() {
  if (!map) return;
  clearSetbackLayer();
  const ed = $("setbackEd") as HTMLElement;
  if (!setbackOn) { ed.hidden = true; return setFloodUi(floodOn); }
  const res = current && pot ? setbackEnvelope(current, pot, setbackOv) : "Lot measurements aren't loaded yet.";
  if (typeof res === "string") { ed.hidden = true; return setFloodUi(floodOn, `<b>Can't draw setbacks for this lot</b><div class="meta">${esc(res)}</div>`); }
  const geom = { type: "Polygon", coordinates: [res.ring] };
  map.addSource("setb", { type: "geojson", data: { type: "Feature", properties: {}, geometry: geom as any } });
  map.addLayer({ id: "setbf", type: "fill", source: "setb", paint: { "fill-color": "#0f5e4b", "fill-opacity": 0.15 } });
  map.addLayer({ id: "setb", type: "line", source: "setb", paint: { "line-color": "#0f5e4b", "line-width": 2, "line-dasharray": [3, 2] } });
  for (const l of res.labels) {
    const el = document.createElement("div");
    el.className = "dim front";
    el.textContent = l.text;
    setbackMarkers.push(new maplibregl.Marker({ element: el }).setLngLat(l.ll).addTo(map));
  }
  for (const e of res.info) {
    const el = document.createElement("div");
    el.className = "measlbl";
    el.textContent = String(e.i + 1);
    setbackMarkers.push(new maplibregl.Marker({ element: el }).setLngLat(e.mid).addTo(map));
  }
  const diff = res.area - res.stdArea;
  ed.hidden = false;
  ed.innerHTML = `<b>Setbacks: try options</b>
    <div class="meta">Numbered lot edges. Change a distance to see the buildable area.</div>
    <table>${res.info.map((e) => `<tr><td>${e.i + 1} · ${e.kind}<div class="meta">${e.len.toFixed(1)} m edge</div></td><td><input type="number" step="0.1" min="0" max="30" data-edge="${e.i}" value="${+e.off.toFixed(2)}" class="${e.off < e.std - 0.001 ? "below" : ""}" /> m<div class="meta">standard ${+e.std.toFixed(2)}</div></td></tr>`).join("")}</table>
    <div class="sbarea">Buildable area <b>${res.area.toFixed(0)} m²</b> of ${res.lotArea.toFixed(0)} m² lot<div class="meta">Standard setbacks: ${res.stdArea.toFixed(0)} m² (${diff >= 0 ? "+" : ""}${diff.toFixed(0)} m² with your changes)</div></div>
    ${res.info.some((e) => e.off < e.std - 0.001) ? `<p class="meta warnp">Orange distances are below the standard. A building closer than the acceptable outcome is assessed against the performance outcome instead, and council has to agree. Ask Brisbane City Council before relying on it.</p>` : `<p class="meta">Moving one side in lets you move another side out only if council accepts the lower distance.</p>`}
    <button type="button" class="ghost" id="sbReset">Reset to standard</button>`;
  setFloodUi(floodOn, `<b>Setbacks (indicative)</b><div class="meta">Ground-floor building wall setbacks from the Queensland Housing Code, applied to the measured lot. Verify with council before designing.${setbackNote}</div>`);
}
$("setbackEd").addEventListener("change", (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.dataset.edge == null) return;
  const v = parseFloat(t.value);
  if (isFinite(v) && v >= 0) setbackOv[Number(t.dataset.edge)] = v; else delete setbackOv[Number(t.dataset.edge)];
  drawSetbacks();
});
$("setbackEd").addEventListener("click", (ev) => { if ((ev.target as HTMLElement).id === "sbReset") { setbackOv = {}; drawSetbacks(); } });
document.querySelector(".panel")!.addEventListener("click", (ev) => {
  if (!(ev.target as HTMLElement).closest("[data-act=setb]")) return;
  setbackOn = true; toolUi("setbackBtn", true); drawSetbacks();
});
$("setbackBtn").addEventListener("click", () => { setbackOn = !setbackOn; toolUi("setbackBtn", setbackOn); drawSetbacks(); });
// ==== end Setbacks tool ====

// ---- Layout: full map, map styles, side column resizing ----
const app = $("app");
const clampN = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
function resizeMap() {
  requestAnimationFrame(() => map?.resize());
}
function setFull(on: boolean) {
  app.classList.toggle("fullmap", on);
  try { localStorage.setItem("fullmap", on ? "1" : "0"); } catch { /* storage unavailable */ }
  resizeMap();
}
$("fullBtn").addEventListener("click", () => setFull(true));
$("fullBtnRail").addEventListener("click", () => setFull(false));
window.addEventListener("resize", resizeMap);

function syncBase() {
  document.querySelectorAll<HTMLElement>(".seg [data-base]").forEach((b) => b.classList.toggle("on", b.dataset.base === baseKind()));
}
document.querySelectorAll<HTMLElement>(".seg [data-base]").forEach((b) =>
  b.addEventListener("click", () => {
    const sel = $("baseSel") as HTMLSelectElement;
    sel.value = b.dataset.base!;
    sel.dispatchEvent(new Event("change"));
    syncBase();
  })
);
syncBase();

// Right panel may grow to ~80% of the window; the map keeps >= 20% (never below 200 px) beside the 94 px of side chrome
const maxRight = () => Math.max(340, innerWidth - 94 - Math.max(200, innerWidth * 0.2));
function clampRight() {
  const cur = parseFloat(document.documentElement.style.getPropertyValue("--right"));
  if (cur > maxRight()) { document.documentElement.style.setProperty("--right", `${Math.floor(maxRight())}px`); resizeMap(); }
}
addEventListener("resize", clampRight);

function drag(el: HTMLElement) {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
    const move = (ev: PointerEvent) => {
      const px = clampN(innerWidth - ev.clientX - 6, 340, maxRight());
      document.documentElement.style.setProperty("--right", `${px}px`);
      resizeMap();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", () => {
      el.classList.remove("dragging");
      el.removeEventListener("pointermove", move);
      try { localStorage.setItem("colRight", document.documentElement.style.getPropertyValue("--right")); } catch { /* storage unavailable */ }
    }, { once: true });
  });
}
drag($("gripR"));
// Double-click: expand to max width, again to restore the remembered width (or the default)
let prevRight: string | null = null;
$("gripR").addEventListener("dblclick", (e) => {
  e.preventDefault();
  const root = document.documentElement;
  const cur = $("rightcol").getBoundingClientRect().width;
  const max = Math.floor(maxRight());
  if (cur >= max - 1) {
    if (prevRight) root.style.setProperty("--right", prevRight);
    else root.style.removeProperty("--right");
    prevRight = null;
  } else {
    prevRight = root.style.getPropertyValue("--right") || null;
    root.style.setProperty("--right", `${max}px`);
  }
  root.classList.add("grip-anim");
  setTimeout(() => { root.classList.remove("grip-anim"); resizeMap(); }, 180);
  resizeMap();
  try {
    const v = root.style.getPropertyValue("--right");
    if (v) localStorage.setItem("colRight", v); else localStorage.removeItem("colRight");
  } catch { /* storage unavailable */ }
});

// Restore remembered layout (right panel width, Full map)
try {
  const r = localStorage.getItem("colRight");
  if (r && /^\d+(\.\d+)?px$/.test(r)) document.documentElement.style.setProperty("--right", r);
  clampRight();
  if (localStorage.getItem("fullmap") === "1") app.classList.add("fullmap");
} catch { /* storage unavailable */ }

// ---- Backup and restore (Settings): saved/recent addresses, notes, checklist ticks, forms and non-secret settings. No API keys or tokens. ----
const BACKUP_SETTINGS = ["brand", MAP_KEY, "base", "theme", OPEN_LAST_KEY];
const openLastBox = $("openLast") as HTMLInputElement;
try { openLastBox.checked = localStorage.getItem(OPEN_LAST_KEY) !== "0"; } catch { /* storage unavailable */ }
openLastBox.addEventListener("change", () => {
  try { localStorage.setItem(OPEN_LAST_KEY, openLastBox.checked ? "1" : "0"); } catch { /* storage unavailable */ }
});

type Backup = { app: string; version: number; savedAt: string; sites: Record<string, Site>; checklists: Record<string, string[]>; forms: Record<string, string>; settings: Record<string, string>; projects: Project[] };
const backupMsg = (t: string) => { $("backupMsg").textContent = t; };
let pendingBackup: Backup | null = null;

function backupCounts(b: Backup) {
  const s = Object.values(b.sites);
  return { saved: s.filter((x) => x.star).length, recent: s.filter((x) => !x.star).length, notes: s.filter((x) => x.note).length, projects: b.projects.length };
}
const countText = (c: { saved: number; recent: number; notes: number; projects: number }) => `${c.saved} saved, ${c.recent} recent, ${c.notes} note${c.notes === 1 ? "" : "s"}, ${c.projects} project${c.projects === 1 ? "" : "s"}`;

function makeBackup(): Backup {
  const b: Backup = { app: "ai-town-planner", version: 3, savedAt: new Date().toISOString(), sites: sites(), checklists: {}, forms: {}, settings: {}, projects: projects() };
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = k ? localStorage.getItem(k) : null;
      if (!k || v === null) continue;
      if (k.startsWith("checklist:")) { try { b.checklists[k] = JSON.parse(v); } catch { /* skip */ } }
      else if (k.startsWith("daform1:")) b.forms[k] = v;
      else if (BACKUP_SETTINGS.includes(k)) b.settings[k] = v;
    }
  } catch { /* storage unavailable */ }
  return b;
}

// Checks the shape and version; throws a short message for anything else. Version 1 files (flat key/value data) are converted.
function parseBackup(text: string): Backup {
  let p: any;
  try { p = JSON.parse(text); } catch { throw new Error("That file is not valid JSON."); }
  if (!p || typeof p !== "object" || p.app !== "ai-town-planner" || typeof p.version !== "number") throw new Error("That is not a backup from this app.");
  if (p.version > 3 || p.version < 1) throw new Error(`Backup version ${p.version} is not supported by this app.`);
  const out: Backup = { app: p.app, version: 3, savedAt: String(p.savedAt ?? ""), sites: {}, checklists: {}, forms: {}, settings: {}, projects: [] };
  if (p.version === 1) {
    const d = p.data;
    if (!d || typeof d !== "object") throw new Error("The backup has no data.");
    p = { sites: safeJson(d.sites), forms: Object.fromEntries(Object.entries(d).filter(([k]) => k.startsWith("daform1:"))), settings: Object.fromEntries(Object.entries(d).filter(([k]) => BACKUP_SETTINGS.includes(k))), checklists: {} };
  }
  const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
  if (!isObj(p.sites)) throw new Error("The backup has no saved addresses section.");
  for (const [lp, x] of Object.entries(p.sites)) {
    if (!isObj(x) || typeof x.pid !== "number" || typeof x.lotplan !== "string" || typeof x.address !== "string") throw new Error("The backup has a damaged address entry.");
    out.sites[lp] = { pid: x.pid, address: x.address, lotplan: x.lotplan, ts: Number(x.ts) || 0, ...(x.star ? { star: true } : {}), ...(typeof x.note === "string" && x.note ? { note: x.note } : {}), ...(typeof x.title === "string" && x.title ? { title: x.title } : {}), ...(typeof x.project === "string" && x.project ? { project: x.project } : {}) };
  }
  if (Array.isArray(p.projects)) for (const q of p.projects) if (isObj(q) && typeof q.id === "string" && q.id && typeof q.name === "string" && q.name) out.projects.push({ id: q.id, name: q.name, created: Number(q.created) || 0, ...(typeof q.client === "string" && q.client ? { client: q.client } : {}), ...(typeof q.note === "string" && q.note ? { note: q.note } : {}) });
  for (const x of Object.values(out.sites)) if (x.project && !out.projects.some((q) => q.id === x.project)) delete x.project;
  if (isObj(p.checklists)) for (const [k, v] of Object.entries(p.checklists)) if (k.startsWith("checklist:") && Array.isArray(v)) out.checklists[k] = v.filter((t) => typeof t === "string");
  if (isObj(p.forms)) for (const [k, v] of Object.entries(p.forms)) if (k.startsWith("daform1:") && typeof v === "string") out.forms[k] = v;
  if (isObj(p.settings)) for (const [k, v] of Object.entries(p.settings)) if (BACKUP_SETTINGS.includes(k) && typeof v === "string") out.settings[k] = v;
  return out;
}
function safeJson(s: unknown): unknown { try { return JSON.parse(String(s)); } catch { return undefined; } }

// Merge only: nothing is deleted. The newer entry's note and title win (by timestamp); stars and checklist ticks are unioned.
function mergeBackup(b: Backup) {
  const pj = projects();
  for (const q of b.projects) if (!pj.some((x) => x.id === q.id)) pj.push(q);
  saveProjects(pj);
  const cur = sites();
  for (const [lp, inc] of Object.entries(b.sites)) {
    const ex = cur[lp];
    if (!ex) { cur[lp] = inc; continue; }
    const project = ex.project ?? inc.project;
    const newer = inc.ts > ex.ts;
    cur[lp] = { ...ex, ts: Math.max(ex.ts, inc.ts), star: ex.star || inc.star || undefined, note: newer ? inc.note ?? ex.note : ex.note ?? inc.note, title: newer ? inc.title ?? ex.title : ex.title ?? inc.title, ...(project ? { project } : {}) };
  }
  saveSites(cur);
  try {
    for (const [k, ticks] of Object.entries(b.checklists)) {
      let have: string[] = [];
      try { have = JSON.parse(localStorage.getItem(k) ?? "[]"); } catch { /* ignore */ }
      localStorage.setItem(k, JSON.stringify([...new Set([...have, ...ticks])]));
    }
    for (const [k, v] of [...Object.entries(b.forms), ...Object.entries(b.settings)]) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
  } catch { /* storage unavailable */ }
}

$("backupBtn").addEventListener("click", async () => {
  try {
    const b = makeBackup();
    const path = await save({ defaultPath: `planlens-backup-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "Backup", extensions: ["json"] }] });
    if (!path) return;
    await invoke("save_text", { path, content: JSON.stringify(b, null, 2) });
    backupMsg(`Backed up ${countText(backupCounts(b))}.`);
  } catch (e) { backupMsg(`Backup failed: ${e}`); }
});
$("restoreBtn").addEventListener("click", async () => {
  $("restoreBox").hidden = true;
  pendingBackup = null;
  try {
    const path = await open({ multiple: false, filters: [{ name: "Backup", extensions: ["json"] }] });
    if (typeof path !== "string") return;
    pendingBackup = parseBackup(await invoke<string>("read_backup", { path }));
    $("restoreText").textContent = `This backup has ${countText(backupCounts(pendingBackup))}. Merge it into your data? Nothing is deleted.`;
    $("restoreBox").hidden = false;
    backupMsg("");
  } catch (e) { backupMsg(`Restore failed: ${e instanceof Error ? e.message : e}`); }
});
$("restoreGo").addEventListener("click", () => {
  if (!pendingBackup) return;
  mergeBackup(pendingBackup);
  backupMsg(`Merged ${countText(backupCounts(pendingBackup))}.`);
  pendingBackup = null;
  $("restoreBox").hidden = true;
  renderSiteTools();
});
$("restoreCancel").addEventListener("click", () => { pendingBackup = null; $("restoreBox").hidden = true; backupMsg("Restore cancelled. Nothing changed."); });

// ---- Forms page: DA Form 1 (Queensland, version 1.3), numbered as on the PDF ----
type FItem = { id: string; n: string; q: string; t: "text" | "area" | "radio" | "check" | "note"; o?: string[] };
const FORM_PARTS: { title: string; items: FItem[] }[] = [
  { title: "Applicant details", items: [
    { id: "ap_name", n: "1)", q: "Applicant name(s) (individual or company full name)", t: "text" },
    { id: "ap_contact", n: "1)", q: "Contact name (companies only)", t: "text" },
    { id: "ap_postal", n: "1)", q: "Postal address (PO Box or street address)", t: "text" },
    { id: "ap_suburb", n: "1)", q: "Suburb", t: "text" },
    { id: "ap_postcode", n: "1)", q: "Postcode", t: "text" },
    { id: "ap_phone", n: "1)", q: "Contact number", t: "text" },
    { id: "ap_email", n: "1)", q: "Email address (optional)", t: "text" },
    { id: "ap_mobile", n: "1)", q: "Mobile number (optional)", t: "text" },
    { id: "ap_ref", n: "1)", q: "Applicant's reference number (if applicable)", t: "text" },
    { id: "own", n: "2.1)", q: "Is written consent of the owner required for this application?", t: "radio", o: ["Yes – consent attached", "No – go to Part 2"] },
  ] },
  { title: "Location details", items: [
    { id: "loc_no", n: "3.1)", q: "Street number", t: "text" },
    { id: "loc_unit", n: "3.1)", q: "Unit number (if any)", t: "text" },
    { id: "loc_street", n: "3.1)", q: "Street name and type", t: "text" },
    { id: "loc_suburb", n: "3.1)", q: "Suburb", t: "text" },
    { id: "loc_postcode", n: "3.1)", q: "Postcode", t: "text" },
    { id: "loc_lot", n: "3.1)", q: "Lot number", t: "text" },
    { id: "loc_plan", n: "3.1)", q: "Plan type and number (e.g. SP, RP)", t: "text" },
    { id: "loc_lga", n: "3.1)", q: "Local government area", t: "text" },
    { id: "n32", n: "3.2)", q: "Coordinates: only for remote sites or land over water. Leave blank for most lots.", t: "note" },
    { id: "addl", n: "3.3)", q: "Additional premises", t: "radio", o: ["Not required", "Attached in a schedule"] },
    { id: "n4", n: "4)", q: "Water body, port land, tidal area, airport, EMR or CLR. Check each item against the PDF form. Nothing is pre-ticked.", t: "note" },
    { id: "ease", n: "5)", q: "Existing easements over the premises?", t: "radio", o: ["Yes – all easement plans attached", "No"] },
  ] },
  { title: "Development details", items: [
    { id: "t1", n: "6.1)", q: "a) Type of development (tick one)", t: "radio", o: ["Material change of use", "Reconfiguring a lot", "Operational work", "Building work"] },
    { id: "ap1", n: "6.1)", q: "b) Approval type (tick one)", t: "radio", o: ["Development permit", "Preliminary approval", "Preliminary approval that includes a variation approval"] },
    { id: "lv1", n: "6.1)", q: "c) Level of assessment (check the zone's assessment table)", t: "radio", o: ["Code assessment", "Impact assessment (requires public notification)"] },
    { id: "desc1", n: "6.1)", q: "d) Brief description of the proposal", t: "area" },
    { id: "plans1", n: "6.1)", q: "e) Relevant plans of the proposed development are attached", t: "check" },
    { id: "n62", n: "6.2–6.3)", q: "Second aspect and additional aspects: leave blank unless there is more than one type of development.", t: "note" },
    { id: "q7_mcu", n: "7)", q: "Material change of use (complete Division 1)", t: "check" },
    { id: "q7_rol", n: "7)", q: "Reconfiguring a lot (complete Division 2)", t: "check" },
    { id: "q7_ops", n: "7)", q: "Operational work (complete Division 3)", t: "check" },
    { id: "q7_bw", n: "7)", q: "Building work (complete DA Form 2 – Building work details)", t: "check" },
    { id: "mcu_desc", n: "8.1)", q: "Division 1: describe the proposed use, its planning scheme definition, dwelling units and gross floor area (m²)", t: "area" },
    { id: "mcu_exist", n: "8.2)", q: "Does the proposed use involve existing buildings on the premises?", t: "radio", o: ["Yes", "No"] },
    { id: "ex_lots", n: "9.1)", q: "Division 2: total number of existing lots making up the premises", t: "text" },
    { id: "rol_sub", n: "9.2)", q: "Subdivision (complete question 10)", t: "check" },
    { id: "rol_agr", n: "9.2)", q: "Dividing land into parts by agreement (complete question 11)", t: "check" },
    { id: "rol_bnd", n: "9.2)", q: "Boundary realignment (complete question 12)", t: "check" },
    { id: "rol_acc", n: "9.2)", q: "Creating or changing an easement giving access from a constructed road (complete question 13)", t: "check" },
    { id: "sub_res", n: "10.1)", q: "Number of residential lots created", t: "text" },
    { id: "sub_com", n: "10.1)", q: "Number of commercial lots created", t: "text" },
    { id: "sub_ind", n: "10.1)", q: "Number of industrial lots created", t: "text" },
    { id: "sub_oth", n: "10.1)", q: "Other lots created (specify use and number)", t: "text" },
    { id: "staged", n: "10.2)", q: "Will the subdivision be staged?", t: "radio", o: ["Yes – give stage details", "No"] },
    { id: "stages", n: "10.2)", q: "If staged: how many stages, and which stage(s) this application covers", t: "text" },
    { id: "bnd_area", n: "12)", q: "Boundary realignment: current and proposed lot areas (m²) and the reason", t: "area" },
    { id: "easem", n: "13)", q: "Easements changed or proposed: existing or proposed, width (m), length (m), purpose, and the lot(s) benefited (attach a schedule if more than two)", t: "area" },
    { id: "ops_nature", n: "14.1)", q: "Division 3: nature of the operational work (e.g. road, drainage, stormwater, landscaping)", t: "text" },
    { id: "ops_lots", n: "14.2)", q: "Is the operational work necessary to create new lots?", t: "radio", o: ["Yes", "No"] },
    { id: "ops_lot_n", n: "14.2)", q: "If yes: number of new lots", t: "text" },
    { id: "ops_value", n: "14.3)", q: "Monetary value of the operational work, including GST, materials and labour ($)", t: "text" },
  ] },
  { title: "Assessment manager details", items: [
    { id: "assessor", n: "15)", q: "Assessment manager", t: "text" },
    { id: "superseded", n: "16)", q: "Has council agreed to apply a superseded planning scheme?", t: "radio", o: ["Yes – decision notice attached", "No"] },
  ] },
  { title: "Referral details", items: [
    { id: "referral", n: "17)", q: "Does the application include aspects with referral requirements? (check the map layers, then confirm)", t: "radio", o: ["No – no referral requirements, go to Part 6", "Yes – tick the referral matters on the PDF form"] },
    { id: "ref_resp", n: "18)", q: "Has any referral agency provided a referral response?", t: "radio", o: ["Yes – responses attached", "No"] },
  ] },
  { title: "Information request", items: [
    { id: "info", n: "19)", q: "Information request under Part 3 of the DA Rules", t: "radio", o: ["I agree to receive an information request if needed", "I do not agree"] },
  ] },
  { title: "Further details", items: [
    { id: "assoc", n: "20)", q: "Are there associated development applications or current approvals?", t: "radio", o: ["Yes – give details", "No"] },
    { id: "ql", n: "21)", q: "Portable long service leave levy (building or operational work over $150,000 excluding GST)", t: "radio", o: ["Paid – receipt attached", "Will be paid before approval", "Not applicable (under $150,000 excl GST)"] },
    { id: "show", n: "22)", q: "Is this application in response to a show cause or enforcement notice?", t: "radio", o: ["Yes – notice attached", "No"] },
    { id: "n23", n: "23)", q: "Further legislative requirements: 16 yes/no questions (environmentally relevant activities, hazardous chemicals, native vegetation, offsets, koala habitat, water, waterways, marine, quarry, referable dams, tidal works, heritage, brothels, state roads, walkable neighbourhoods). Answer each one on the PDF form. Most house and subdivision applications answer No.", t: "note" },
  ] },
  { title: "Checklist and applicant declaration", items: [
    { id: "c_assess", n: "24)", q: "Assessment manager identified (question 15)", t: "radio", o: ["Yes", "No"] },
    { id: "c_bw", n: "24)", q: "Building work parts of DA Form 2 completed", t: "radio", o: ["Yes", "Not applicable"] },
    { id: "c_report", n: "24)", q: "Supporting information and planning report attached", t: "radio", o: ["Yes", "No"] },
    { id: "c_plans", n: "24)", q: "Relevant plans attached", t: "radio", o: ["Yes", "No"] },
    { id: "c_ql", n: "24)", q: "QLeave levy paid, or to be paid before a development permit is issued", t: "radio", o: ["Yes", "Not applicable"] },
    { id: "decl1", n: "25)", q: "I declare that all information in this development application is true and correct", t: "check" },
    { id: "decl2", n: "25)", q: "I consent to receive electronic communications from council and referral agencies (Electronic Transactions Act 2001)", t: "check" },
    { id: "n25", n: "25)", q: "You tick the declaration yourself. The app never ticks it.", t: "note" },
  ] },
  { title: "For council use only", items: [
    { id: "n9", n: "Part 9", q: "Leave blank. Council completes this part.", t: "note" },
  ] },
];

// Values filled from the site and proposal. Anything the user has answered overrides these.
function prefill(): Record<string, string> {
  const rol = val("useSel") === "rol";
  const out: Record<string, string> = {
    t1: rol ? "Reconfiguring a lot" : "Material change of use",
    ap1: "Development permit",
    q7_rol: rol ? "1" : "",
    q7_mcu: rol ? "" : "1",
    rol_sub: rol ? "1" : "",
    ex_lots: "1",
    own: "No",
    addl: "Not required",
    ease: "No",
    staged: "No",
    assessor: siteCouncil().name,
    loc_lga: siteCouncil().name,
    superseded: "No",
    ref_resp: "No",
    assoc: "No",
    ql: "Not applicable (under $150,000 excl GST)",
    show: "No",
    c_assess: "Yes",
    c_bw: "Not applicable",
    c_ql: "Not applicable",
    desc1: val("question"),
  };
  const p = current?.parcel;
  if (p) {
    const m = /^(\S+)\s+(.+?),\s*(.+?)\s+QLD\s+(\d{4})/.exec(p.address ?? "");
    if (m) Object.assign(out, { loc_no: m[1], loc_street: m[2], loc_suburb: m[3], loc_postcode: m[4] });
    const lp = /^(\d+)([A-Z]+\d+)$/.exec(p.lotplan ?? "");
    if (lp) Object.assign(out, { loc_lot: lp[1], loc_plan: lp[2] });
  }
  return out;
}

let formPid = 0;
let formVals: Record<string, string> = {};
let fvCtx = { part: "", n: "", q: "" };
let fvHistory: { role: string; content: string }[] = [];
const formKey = (pid: number) => `daform1:${pid}`;

function fieldHtml(it: FItem): string {
  const v = formVals[it.id] ?? "";
  const head = it.t === "check" || it.t === "note" ? "" : `<div class="fq"><span>${esc(it.n)}</span>${esc(it.q)}</div>`;
  let body = "";
  if (it.t === "text") body = `<input type="text" data-k="${it.id}" value="${esc(v)}" />`;
  else if (it.t === "area") body = `<textarea data-k="${it.id}">${esc(v)}</textarea>`;
  else if (it.t === "radio")
    body = `<div class="fopts">${(it.o ?? []).map((o) => `<label><input type="radio" name="${it.id}" data-k="${it.id}" value="${esc(o)}" ${v === o ? "checked" : ""} /> ${esc(o)}</label>`).join("")}</div>`;
  else if (it.t === "check")
    body = `<label><input type="checkbox" data-k="${it.id}" ${v === "1" ? "checked" : ""} /><span class="fq" style="margin:0"><span>${esc(it.n)}</span></span> ${esc(it.q)}</label>`;
  else body = `<div class="fnote">${esc(it.q)}</div>`;
  return `<div class="ff" data-n="${esc(it.n)}" data-q="${esc(it.q)}">${head}${body}</div>`;
}

function renderFormPage() {
  if (!current) {
    $("fvMeta").textContent = "";
    $("fvBody").innerHTML = `<p class="meta">Search for an address first. The form is saved against that lot.</p>`;
    return;
  }
  formPid = current.parcel.pid;
  let saved: Record<string, string> = {};
  try { saved = JSON.parse(localStorage.getItem(formKey(formPid)) ?? "null") ?? {}; } catch { /* storage unavailable */ }
  formVals = { ...prefill(), ...saved };
  $("fvMeta").textContent = `${current.parcel.address || current.parcel.lotplan} · Saved on this PC · version 1.3`;
  $("fvBody").innerHTML =
    FORM_PARTS.map((p, i) => `<h3 class="fpart-h">Part ${i + 1} – ${esc(p.title)}</h3>` + p.items.map(fieldHtml).join("")).join("") +
    `<p class="fdone">Autosaved on this PC. Nothing is sent to council from here.</p>`;
}

function setWhere(ff: HTMLElement) {
  let part = ff.previousElementSibling;
  while (part && !part.classList.contains("fpart-h")) part = part.previousElementSibling;
  fvCtx = { part: part?.textContent ?? "", n: ff.dataset.n ?? "", q: ff.dataset.q ?? "" };
  $("fvWhere").innerHTML = `You are on <b>${esc(fvCtx.part)}</b>, question <b>${esc(fvCtx.n)}</b>: ${esc(fvCtx.q)}`;
}

function saveField(ev: Event) {
  const el = ev.target as HTMLInputElement | HTMLTextAreaElement;
  const k = el.dataset.k;
  if (!k) return;
  formVals[k] = el instanceof HTMLInputElement && el.type === "checkbox" ? (el.checked ? "1" : "") : el.value;
  try { localStorage.setItem(formKey(formPid), JSON.stringify(formVals)); } catch { /* storage unavailable */ }
}
$("fvBody").addEventListener("input", saveField);
$("fvBody").addEventListener("change", saveField);
$("fvBody").addEventListener("focusin", (ev) => {
  const ff = (ev.target as HTMLElement).closest(".ff") as HTMLElement | null;
  if (!ff) return;
  document.querySelectorAll(".ff.focused").forEach((x) => x.classList.remove("focused"));
  ff.classList.add("focused");
  setWhere(ff);
});

function fvRender() {
  const log = $("fvChat");
  if (!fvHistory.length) {
    log.innerHTML = `<p class="meta">Ask about the question you are on, or what a term means. The helper doesn't tick declarations or fill in council's part.</p>`;
    return;
  }
  log.innerHTML = fvHistory.map((m) => `<div class="msg ${m.role}">${m.role === "user" ? esc(m.content) : (marked.parse(m.content || "…") as string)}</div>`).join("");
  log.scrollTop = log.scrollHeight;
}

function formContext(): string {
  const answers = FORM_PARTS.flatMap((p) => p.items)
    .filter((it) => it.t !== "note" && formVals[it.id])
    .map((it) => `${it.n} ${it.q}: ${it.t === "check" ? "ticked" : formVals[it.id]}`);
  return [
    "TASK: Help the applicant complete the Queensland DA Form 1 (version 1.3). Explain questions in plain words, say what to check with council or its planning scheme, and suggest wording when asked. Do not tick declarations, do not fill in Part 9, and do not say an answer is correct.",
    `SITE: ${current?.parcel.address ?? ""} · ${current?.parcel.lotplan ?? ""}${current?.parcel.area_m2 ? ` · ${Math.round(current.parcel.area_m2)} m²` : ""}`,
    `COUNCIL: ${current ? `${siteCouncil().name} (${siteCouncil().scheme})` : "not known"}`,
    `ZONES: ${current?.zones.map(zoneTitle).join(", ") || (current && zonesMissing(siteCouncil(current)) ? NO_ZONE.toLowerCase() : "not identified")}`,
    `CURRENT QUESTION: ${fvCtx.n} ${fvCtx.q} (${fvCtx.part})`,
    "ANSWERS SO FAR:",
    ...(answers.length ? answers : ["(none yet)"]),
  ].join("\n");
}

$("fvForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const input = $("fvInput") as HTMLInputElement;
  const q = input.value.trim();
  if (!q || !current) return;
  input.value = "";
  fvHistory.push({ role: "user", content: q });
  const reply = { role: "assistant", content: "" };
  fvHistory.push(reply);
  fvRender();
  const ch = new Channel<string>();
  ch.onmessage = (t) => {
    reply.content += t;
    fvRender();
  };
  try {
    await invoke("chat", { pid: current.parcel.pid, report: formContext(), history: fvHistory.slice(0, -1), onToken: ch });
  } catch (e) {
    reply.content = `**Error:** ${String(e)}`;
    fvRender();
  }
});

function renderFormList() {
  const cards = (FORMS as { id: string; name: string; to?: string; when?: string; url?: string }[]).map(
    (f) => `<div class="fv-item ${f.id === "daform1" ? "active" : ""}"><h3>${esc(f.name)}</h3>
      <div class="meta">To: ${esc(f.to ?? "")}</div><div class="meta">${esc(f.when ?? "")}</div>
      <div class="btnrow">${f.id === "daform1" ? `<button type="button" data-fill="1">Open and fill in</button>` : ""}${f.url ? `<button type="button" class="ghost" data-url="${esc(f.url)}">Download blank</button>` : ""}</div></div>`
  );
  cards.push(
    `<div class="fv-item"><h3>Cover letter</h3><div class="meta">Drafted by AI from this site's details.</div><div class="btnrow"><button type="button" class="ghost" data-draft="letter">Draft with AI</button></div></div>`,
    `<div class="fv-item"><h3>Pre-lodgement meeting request</h3><div class="meta">To: council planning team, before you lodge.</div><div class="btnrow"><button type="button" class="ghost" data-draft="prelodge">Draft with AI</button></div></div>`
  );
  $("formList").innerHTML = cards.join("");
}
$("formList").addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest("button") as HTMLButtonElement | null;
  if (!b) return;
  if (b.dataset.fill) renderFormPage();
  else if (b.dataset.draft) draft(true, b.dataset.draft === "prelodge");
  else if (b.dataset.url) openExternal(b.dataset.url);
});

function openFormView() {
  app.classList.add("formsmode");
  $("formsView").hidden = false;
  renderFormList();
  renderFormPage();
  fvCtx = { part: "", n: "", q: "" };
  $("fvWhere").innerHTML = `Click a question to get help on it.`;
  fvHistory = [];
  fvRender();
  resizeMap();
}
function closeFormView() {
  app.classList.remove("formsmode");
  $("formsView").hidden = true;
  resizeMap();
}
$("formsBtn").addEventListener("click", openFormView);
$("openFormBtn").addEventListener("click", openFormView);
$("fvBack").addEventListener("click", closeFormView);
$("fvClose").addEventListener("click", closeFormView);
$("formsView").addEventListener("click", (e) => { if (e.target === $("formsView")) closeFormView(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && app.classList.contains("formsmode") && !document.querySelector("dialog[open]")) closeFormView(); });
// Left tool strip: clicking an open tool's icon again closes it; state shown with aria-pressed.
const TOOL_DLG: Record<string, string> = { settingsBtn: "settings", mapsBtn: "mapsDlg", apprBtn: "apprDlg", cmpBtn: "cmpDlg", batchBtn: "batchDlg" };
for (const [bid, did] of Object.entries(TOOL_DLG)) {
  const d = $(did) as HTMLDialogElement;
  const sync = () => { $(bid).setAttribute("aria-pressed", String(d.open)); $(bid).classList.toggle("on", d.open); };
  $(bid).setAttribute("aria-pressed", "false");
  new MutationObserver(sync).observe(d, { attributes: true, attributeFilter: ["open"] });
  $(bid).addEventListener("click", (ev) => { if (d.open) { ev.stopImmediatePropagation(); d.close(); } }, true);
}
$("formsBtn").setAttribute("aria-pressed", "false");
$("formsBtn").addEventListener("click", (ev) => { if (app.classList.contains("formsmode")) { ev.stopImmediatePropagation(); closeFormView(); } }, true);
new MutationObserver(() => { const o = app.classList.contains("formsmode"); $("formsBtn").setAttribute("aria-pressed", String(o)); $("formsBtn").classList.toggle("on", o); }).observe(app, { attributes: true, attributeFilter: ["class"] });
// any map tool returns to the map
["dimBtn","subBtn","setbackBtn","measDBtn","measABtn","contBtn","floodBtn","powerBtn","envBtn","markBtn"].forEach((id) =>
  $(id).addEventListener("click", () => { if (app.classList.contains("formsmode")) closeFormView(); }));

function printForm() {
  if (!current) return;
  const rows = FORM_PARTS.map(
    (p, i) =>
      `<h3 class="fpart">Part ${i + 1} – ${esc(p.title)}</h3>` +
      p.items
        .filter((it) => it.t !== "note")
        .map((it) => `<div class="frow"><label>${esc(it.n)} ${esc(it.q)}</label><div class="fans">${esc(it.t === "check" ? (formVals[it.id] === "1" ? "Ticked" : "Not ticked") : formVals[it.id] ?? "")}</div></div>`)
        .join("")
  ).join("");
  $("printArea").innerHTML =
    `<h1>DA Form 1 – Answer sheet</h1><p class="meta">${esc(current.parcel.address || current.parcel.lotplan)}. Answers for the official DA Form 1 (version 1.3). Copy these onto the official form, or lodge the official form, and check it before you lodge.</p>` + rows;
  window.print();
}
$("fvPrint").addEventListener("click", printForm);

// Side panel footer shortcuts
$("footReport").addEventListener("click", () => { showSec("report"); $("genBtn").click(); });
$("footPdf").addEventListener("click", () => $("pdfBtn").click());

// Clicking outside a window (on the dimmed backdrop) closes it.
document.querySelectorAll<HTMLDialogElement>("dialog").forEach((d) => d.addEventListener("click", (ev) => { if (ev.target === d) d.close(); }));

// ---- Assistant chat (docked in the right panel) ----
function setChat(on: boolean) {
  if (on && app.classList.contains("fullmap")) setFull(false);
  ($("botWin") as HTMLElement).hidden = !on;
  $("rightcol").classList.toggle("chatopen", on);
  $("rail").querySelectorAll<HTMLElement>("button").forEach((b) => b.classList.toggle("on", on ? b.dataset.sec === "assistant" : b.dataset.sec === curSec));
  if (on) { setRcol(false); renderChat(); $("chatInput").focus(); }
  syncRail();
}
// Right panel collapses to its icon rail; clicking the active rail icon toggles it.
function syncRail() {
  const shut = app.classList.contains("rcol");
  $("rail").querySelectorAll<HTMLElement>("button").forEach((b) => b.setAttribute("aria-pressed", String(!shut && b.classList.contains("on"))));
}
function setRcol(on: boolean) {
  app.classList.toggle("rcol", on);
  syncRail();
  resizeMap();
}
// Right-panel rail: one section group shown at a time
const SEC_GROUPS: Record<string, [string, string[]]> = {
  zoning: ["Zoning", ["s-zoning", "s-suburb"]],
  setbacks: ["Setbacks", ["s-setbacks"]],
  constraints: ["Constraints", ["s-constraints"]],
  potential: ["Development potential", ["s-potential"]],
  approvals: ["Approvals, clock & referrals", ["s-approvals"]],
  checklist: ["Lodgement checklist", ["s-checklist", "s-title"]],
  forms: ["Forms & lodgement", ["s-forms"]],
  report: ["AI planner report", ["s-report"]],
};
let curSec = "zoning";
function showSec(k: string) {
  const g = SEC_GROUPS[k];
  if (!g) return;
  curSec = k;
  if (!($("botWin") as HTMLElement).hidden) setChat(false);
  document.querySelectorAll<HTMLDetailsElement>(".pbody > .sec").forEach((d) => { d.hidden = !g[1].includes(d.id); d.open = true; });
  $("secTitle").textContent = g[0];
  $("secSub").textContent = k === "constraints" ? "Council · State" : "";
  $("rail").querySelectorAll<HTMLElement>("button").forEach((b) => b.classList.toggle("on", b.dataset.sec === k));
  setRcol(false);
  $("site").querySelector(".pbody")!.scrollTop = 0;
}
$("rail").addEventListener("click", (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>("button");
  if (!b) return;
  if (b.classList.contains("on") && !app.classList.contains("rcol")) { setRcol(true); return; }
  if (b.dataset.sec === "assistant") setChat(($("botWin") as HTMLElement).hidden || app.classList.contains("rcol"));
  else showSec(b.dataset.sec!);
});
showSec("zoning");
$("recentBtn").setAttribute("aria-haspopup", "listbox");
$("recentBtn").setAttribute("aria-expanded", "false");
$("recentBtn").addEventListener("click", () => { if ($("results").innerHTML) $("results").innerHTML = ""; else showRecents(); });
new MutationObserver(() => {
  const open = !!$("results").firstElementChild;
  $("recentBtn").setAttribute("aria-expanded", String(open));
  if (!open && !$("hint").classList.contains("err") && $("hint").textContent !== notFound()) $("hint").textContent = "";
}).observe($("results"), { childList: true });
document.addEventListener("mousedown", (ev) => {
  if (!$("results").firstElementChild) return;
  const t = ev.target as HTMLElement;
  if (!t.closest("#results") && !t.closest("#recentBtn") && t.id !== "q") $("results").innerHTML = "";
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && $("results").firstElementChild) { $("results").innerHTML = ""; $("recentBtn").focus(); }
});
$("botClose").addEventListener("click", () => setChat(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !($("botWin") as HTMLElement).hidden && !document.querySelector("dialog[open]")) setChat(false); });

// ---- Top menu bar and status bar ----
function openSettings(sec?: string) {
  refreshStatus();
  const d = $("settings") as HTMLDialogElement;
  if (!d.open) d.showModal();
  if (sec) requestAnimationFrame(() => document.getElementById(sec)?.scrollIntoView({ block: "start" }));
}
const clickId = (id: string) => () => $(id).click();
const setBaseTo = (k: string) => () => { ($("baseSel") as HTMLSelectElement).value = k; $("baseSel").dispatchEvent(new Event("change")); syncBase(); };
type MI = [string, () => void] | "-";
const MENUS: [string, MI[]][] = [
  ["File", [["Back up my data…", () => openSettings("sset-backup")], ["Restore from backup…", () => openSettings("sset-backup")], "-", ["Batch check…", clickId("batchBtn")], ["Client PDF", clickId("footPdf")], "-", ["Report branding…", () => openSettings("sset-brand")], ["Data pack…", () => openSettings("sset-data")], ["Address search key…", () => openSettings("sset-search")]]],
  ["AI", [["AI engine…", () => openSettings("sset-ai")], ["Built-in models…", () => openSettings("sset-models")], "-", ["Generate AI report", clickId("footReport")], ["Ask the assistant", () => setChat(true)]]],
  ["Forms", [["Open DA forms", clickId("formsBtn")], ["Approvals", clickId("apprBtn")]]],
  ["Tools", [["Dimensions", clickId("dimBtn")], ["Subdivision sketch", clickId("subBtn")], ["Setbacks", clickId("setbackBtn")], ["Measure distance", clickId("measDBtn")], ["Measure area", clickId("measABtn")], ["Contours", clickId("contBtn")], ["Flood map", clickId("floodBtn")], ["Power", clickId("powerBtn")], ["3D envelope", clickId("envBtn")], ["Annotate map", clickId("markBtn")], "-", ["Compare", clickId("cmpBtn")], ["Maps", clickId("mapsBtn")], ["Open map", clickId("myMapBtn")]]],
  ["Window", [["Full map on/off", () => setFull(!app.classList.contains("fullmap"))], "-", ["Plain map", setBaseTo("plain")], ["Street map", setBaseTo("street")], ["Aerial photo", setBaseTo("sat")], "-", ["Light / dark", clickId("themeBtn")], ["Reset panel widths", () => { document.documentElement.style.removeProperty("--right"); try { localStorage.removeItem("colRight"); } catch { /* storage unavailable */ } resizeMap(); }], "-", ["Settings…", () => openSettings()]]],
];
const mbar = $("menubar");
MENUS.forEach(([name, items]) => {
  const w = document.createElement("div"); w.className = "mn";
  const b = document.createElement("button"); b.type = "button"; b.textContent = name;
  const dd = document.createElement("div"); dd.className = "mdrop";
  items.forEach((it) => {
    if (it === "-") { dd.appendChild(document.createElement("hr")); return; }
    const x = document.createElement("button"); x.type = "button"; x.textContent = it[0];
    x.addEventListener("click", () => { closeMenus(); it[1](); });
    dd.appendChild(x);
  });
  b.addEventListener("click", (e) => { e.stopPropagation(); const was = w.classList.contains("open"); closeMenus(); if (!was) w.classList.add("open"); });
  b.addEventListener("mouseenter", () => { if (mbar.querySelector(".mn.open") && !w.classList.contains("open")) { closeMenus(); w.classList.add("open"); } });
  w.append(b, dd); mbar.appendChild(w);
});
function closeMenus() { mbar.querySelectorAll(".mn.open").forEach((n) => n.classList.remove("open")); }
document.addEventListener("click", closeMenus);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); });
function updateStatusBar() {
  $("stSite").textContent = current ? `${current.parcel.address} · ${current.parcel.lotplan}` : "No site selected";
  $("stPack").textContent = $("packInfo").textContent ?? "";
}
new MutationObserver(updateStatusBar).observe($("packInfo"), { childList: true, characterData: true, subtree: true });
setInterval(updateStatusBar, 1500);
updateStatusBar();
