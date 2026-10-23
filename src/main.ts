import { invoke, Channel } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { marked } from "marked";
import MAPS from "./maps.json";
import FORMS from "../src-tauri/knowledge/forms.json";
import SETBACKS_DATA from "../src-tauri/knowledge/setbacks.json";
import "./style.css";

type Hit = { pid: number; address: string; lotplan: string; suburb: string };
type Overlay = { authority: string; distance_m: number | null; dataset_id: string; title: string; props: Record<string, unknown>; coverage_pct: number | null; geom: any };
type Assessment = {
  parcel: { pid: number; lotplan: string; address: string; suburb: string; area_m2: number | null; geom: any };
  zones: { authority: string; zone: { name: string; purpose: string; typical: string }; coverage_pct: number | null }[];
  flags: { rule: { authority: string; title: string; code: string; note: string; checklist: string[] }; layers: string[] }[];
  overlays: Overlay[];
  manifest: Record<string, string>;
};
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
    ? `${p.region} · built ${p.built_at} · ${Number(p.parcels).toLocaleString()} lots · ${p.layers} City Plan layers. ${p.attribution}`
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

type Site = { pid: number; address: string; lotplan: string; ts: number; star?: boolean; note?: string; title?: string };
function sites(): Record<string, Site> {
  try { return JSON.parse(localStorage.getItem("sites") ?? "{}"); } catch { return {}; }
}
function saveSites(m: Record<string, Site>) {
  // keep every starred lot plus the 20 most recent others
  const all = Object.values(m).sort((x, y) => y.ts - x.ts);
  let n = 0;
  const keep: Record<string, Site> = {};
  for (const x of all) if (x.star || x.note || x.title || n++ < 20) keep[x.lotplan] = x;
  try { localStorage.setItem("sites", JSON.stringify(keep)); } catch { /* storage unavailable */ }
}
function touchSite(p: { pid: number; address: string; lotplan: string }, patch: Partial<Site> = {}) {
  const m = sites();
  m[p.lotplan] = { ...m[p.lotplan], pid: p.pid, address: p.address, lotplan: p.lotplan, ts: Date.now(), ...patch };
  saveSites(m);
}
function showRecents() {
  const r = Object.values(sites()).sort((x, y) => Number(!!y.star) - Number(!!x.star) || y.ts - x.ts);
  $("results").innerHTML = r
    .map((h) => `<li data-pid="${h.pid}" data-lp="${esc(h.lotplan)}"><b>${h.star ? "★ " : ""}${esc(h.address || h.lotplan)}</b><span>${esc(h.lotplan)}${h.note ? " · note" : ""}${h.title ? " · title" : ""}</span></li>`)
    .join("");
  $("hint").textContent = r.length ? "Saved and recent addresses" : "";
}

async function runSearch() {
  const q = ($("q") as HTMLInputElement).value.trim();
  const list = $("results");
  $("hint").classList.remove("err");
  if (q.length < 3) {
    showRecents();
    return;
  }
  if (hasGoogle) {
    try {
      const sg = await invoke<{ place_id: string; text: string }[]>("google_suggest", { q });
      if (sg.length) {
        list.innerHTML = sg.map((x) => `<li data-place="${esc(x.place_id)}"><b>${esc(x.text)}</b><span>Google</span></li>`).join("");
        $("hint").textContent = `${sg.length} suggestion${sg.length > 1 ? "s" : ""}`;
        return;
      }
    } catch (e) {
      $("hint").textContent = String(e); // fall back to the offline search below
    }
  }
  try {
    const hits = await invoke<Hit[]>("search", { q });
    list.innerHTML = hits
      .map((h) => `<li data-pid="${h.pid}"><b>${esc(h.address || h.lotplan)}</b><span>${esc(h.lotplan)}</span></li>`)
      .join("");
    $("hint").textContent = hits.length ? `${hits.length} result${hits.length > 1 ? "s" : ""}` : "No matches.";
  } catch (e) {
    alertMsg(e);
  }
}

$("results").addEventListener("click", (ev) => {
  const li = (ev.target as HTMLElement).closest("li");
  if (!li) return;
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

async function loadSite(pid: number) {
  try {
    current = await invoke<Assessment>("assess", { pid });
  } catch (e) {
    return alertMsg(e);
  }
  const a = current;
  try { localStorage.setItem("lastPid", String(a.parcel.pid)); } catch { /* storage unavailable */ }
  touchSite(a.parcel);
  renderSiteTools();
  $("empty").hidden = true;
  $("site").hidden = false;
  $("siteAddr").textContent = a.parcel.address || a.parcel.lotplan;
  $("siteMeta").textContent = [a.parcel.lotplan, a.parcel.area_m2 ? `${Math.round(a.parcel.area_m2).toLocaleString()} m²` : "", a.parcel.suburb]
    .filter(Boolean)
    .join(" · ");
  $("zones").innerHTML = a.zones.length
    ? a.zones
        .map(
          (z) => `<div class="zone"><span class="auth">${esc(AUTH[z.authority] ?? z.authority)}</span> <b>${esc(z.zone.name)}</b>${z.coverage_pct != null && z.coverage_pct < 99 ? ` <span class="pill">${z.coverage_pct}% of lot</span>` : ""}
          <p>${esc(z.zone.purpose)}</p></div>`
        )
        .join("")
    : `<p class="meta">Zone not identified from the data pack. Check the zoning layer attributes below.</p>`;
  $("flags").innerHTML = a.flags.length
    ? a.flags
        .map((f) => `<div class="flag"><span class="auth">${esc(AUTH[f.rule.authority] ?? f.rule.authority)}</span> <b>${esc(f.rule.title)}</b><div class="meta">${esc(f.rule.code)}</div><p>${esc(f.rule.note)}</p></div>`)
        .join("")
    : `<p class="meta">No overlay constraints mapped on this lot.</p>`;
  renderSetbacks(a);
  $("ovSummary").textContent = `All mapped layers (${a.overlays.length})`;
  $("overlays").innerHTML = a.overlays
    .map(
      (o) => `<li><span class="auth">${esc(AUTH[o.authority] ?? o.authority)}</span> <b>${esc(o.title)}</b>${o.coverage_pct != null ? ` · ${o.coverage_pct}% of lot` : ""}${o.distance_m != null ? ` · ${o.distance_m} m away` : ""}
      <div class="meta">${Object.entries(o.props).slice(0, 6).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(" · ")}</div></li>`
    )
    .join("");
  sections = [];
  activeTab = "";
  renderReport();
  chatHistory = [];
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

async function loadPotential() {
  if (!current) return;
  try {
    pot = await invoke<Pot>("potential", { pid: current.parcel.pid, useId: useId() });
  } catch (e) {
    $("pot").innerHTML = `<p class="err">${esc(e)}</p>`;
    return;
  }
  renderPotential();
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
        .map((i) => `<tr><td>${esc(i.label)}</td><td><b>${esc(i.value)}</b>${i.verify ? ` <span class="pill warn">verify</span>` : ""}</td><td class="meta">${link(i.url, i.source)}</td></tr>`)
        .join("")}</table>`
    : `<p class="meta">${p.pda ? "PDA site: limits come from the PDA development scheme (EDQ)." : "No sourced numeric provisions for this zone in the app yet. The AI report names the City Plan codes that set them."}</p>`;
  const fit = p.use_fit
    ? `<div class="${p.use_fit.zone_ok === false ? "flag" : "zone"}"><span class="auth">Proposal</span> <b>${esc(p.use_fit.use_def.name)}</b>
       <div class="meta">Planning use term: ${esc(p.use_fit.use_def.term)}</div><p>${esc(p.use_fit.note)}</p>
       ${p.use_fit.rule ? `<p><b>Level of assessment:</b> ${esc(p.use_fit.rule.level)}</p>
         <table class="ptable"><tbody>${p.use_fit.rule.items.map((i) => `<tr><td>${esc(i.label)}</td><td><b>${esc(i.value)}</b>${i.verify ? ' <span class="pill warn">verify</span>' : ""}</td><td class="meta">${i.url ? link(i.url, i.source) : esc(i.source)}</td></tr>`).join("")}</tbody></table>${chargeEstimate(p)}` : ""}
       <ul>${p.use_fit.use_def.checks.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
       ${(p.use_fit.use_def.sources ?? []).length ? `<div class="meta">Sources: ${p.use_fit.use_def.sources.map((x) => link(x.url, x.name)).join(" · ")}</div>` : ""}</div>`
    : "";
  $("pot").innerHTML = `<p>${facts}</p>${prov}<h4>Subdivision</h4><ul>${p.subdivision.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    ${p.power?.length ? `<h4>Nearest power infrastructure</h4><ul>${p.power.map((n) => `<li><b>${esc(n.kind)}</b>: ${km(n.distance_m)} <span class="meta">${esc(brief(n.props))}</span></li>`).join("")}</ul>
      <p class="meta">Source: Geoscience Australia national electricity infrastructure. Energex distribution lines/capacity, water, sewer, recycled water and fibre aren't open data: see Maps → Energex DAPR map and BYDA.</p>` : ""}
    ${p.sketch.length ? `<p class="meta">Indicative split: ${p.sketch.map((s) => `${Math.round(s.area_m2)} m²`).join(" + ")}. Concept only; a surveyor confirms the layout.</p>` : ""}${fit}`;
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

$("useSel").addEventListener("change", loadPotential);
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
  $("contBtn").textContent = "Loading…";
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
  $("contBtn").textContent = "Contours";
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
  $("floodBtn").textContent = on ? "Hide flood map" : "Flood map";
  $("floodBtn").classList.toggle("on", on);
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
  $("floodBtn").textContent = "Loading…";
  let feats: Overlay[];
  try {
    feats = await invoke<Overlay[]>("flood_map", { pid: current.parcel.pid });
  } catch (e) {
    setFloodUi(false);
    return alertMsg(e);
  }
  if (!feats.length) {
    setFloodUi(true, `<b>No mapped flooding within 400 m</b><div class="meta">Check Council's FloodWise Property Report to confirm.</div>`);
    return;
  }
  const titles = [...new Set(feats.map((f) => f.title))];
  const color = (t: string) => FLOOD_COLORS[titles.indexOf(t) % FLOOD_COLORS.length];
  m.addSource("flood", {
    type: "geojson",
    data: { type: "FeatureCollection", features: feats.map((f) => ({ type: "Feature", properties: { c: color(f.title) }, geometry: f.geom })) },
  });
  m.addLayer({ id: "flood", type: "fill", source: "flood", paint: { "fill-color": ["get", "c"], "fill-opacity": 0.35 } }, "lot");
  m.addLayer({ id: "flood-line", type: "line", source: "flood", paint: { "line-color": ["get", "c"], "line-width": 1 } }, "lot");
  const short = (t: string) => t.replace(/^City Plan 2014 — /, "").replace(/^Queensland — /, "State: ");
  setFloodUi(
    true,
    titles.map((t) => `<div><i style="background:${color(t)}"></i>${esc(short(t))}</div>`).join("") +
      `<div class="meta">Mapped flood planning areas. Levels: FloodWise Property Report.</div>`
  );
  fitTo([current.parcel.geom, ...feats.map((f) => f.geom)]);
});

function drawMap(a: Assessment) {
  map?.remove();
  setFloodUi(false);
  map = new maplibregl.Map({
    container: "map",
    style: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#efece4" } }] },
    attributionControl: { compact: true },
    canvasContextAttributes: { preserveDrawingBuffer: true }, // lets the PDF include a map snapshot
  });
  map.on("load", () => {
    const m = map!;
    setBase(baseKind());
    a.overlays.forEach((o, i) => {
      const id = `o${i}`;
      const color = PALETTE[i % PALETTE.length];
      m.addSource(id, { type: "geojson", data: { type: "Feature", properties: {}, geometry: o.geom } });
      const t = o.geom?.type ?? "";
      if (t.includes("Polygon")) m.addLayer({ id, type: "fill", source: id, paint: { "fill-color": color, "fill-opacity": 0.22 } });
      else if (t.includes("Line")) m.addLayer({ id, type: "line", source: id, paint: { "line-color": color, "line-width": 3 } });
      else m.addLayer({ id, type: "circle", source: id, paint: { "circle-color": color, "circle-radius": 5 } });
    });
    m.addSource("lot", { type: "geojson", data: { type: "Feature", properties: {}, geometry: a.parcel.geom } });
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
  toolUi("measDBtn", measMode === "d"); toolUi("measABtn", measMode === "a");
  measReset();
  ($("measOut") as HTMLElement).hidden = !measMode;
  document.querySelector(".maplibregl-canvas")?.classList.toggle("meas", !!measMode);
  if (measMode) measDraw();
}
$("measDBtn").addEventListener("click", () => measSet("d"));
$("measABtn").addEventListener("click", () => measSet("a"));
$("measUndo").addEventListener("click", measUndo);
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
    log.innerHTML = `<p class="meta">Ask follow-up questions or test options, e.g. "What if I reduce it to 2 storeys?" or "How do I avoid the SARA referral?"</p>`;
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
  if (!q || !current) return;
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
  const report = sections.map((x) => `## ${x.title}\n${x.text}`).join("\n\n");
  try {
    await invoke("chat", { pid: current.parcel.pid, report, history: chatHistory.slice(0, -1), onToken: ch });
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
  try { if (full && map) mapImg = `<img class="rmap" src="${map.getCanvas().toDataURL("image/png")}" alt="Site map">`; } catch { /* map not ready */ }
  const byAuth = (k: string) => a.flags.filter((f) => f.rule.authority === k);
  const auths: [string, string][] = [["council", "Council"], ["sara", "State (SARA)"], ["pda", "Economic Development Queensland (PDA)"], ["state", "State interests"], ["other", "Other agencies and services"]];
  const head = b.logo || b.company
    ? `<div class="rbrand">${b.logo ? `<img src="${b.logo}" alt="">` : ""}<div><b>${esc(b.company ?? "")}</b>${b.by ? `<br><small>Prepared by ${esc(b.by)}</small>` : ""}</div></div>` : "";
  return `${head}<h1>Planning assessment: ${esc(a.parcel.address || a.parcel.lotplan)}</h1>
<small>${esc(a.parcel.lotplan)}${a.parcel.area_m2 ? ` · ${Math.round(a.parcel.area_m2).toLocaleString()} m²` : ""} · Data pack ${esc(a.manifest.built_at)} · ${new Date().toLocaleDateString("en-AU")}</small>
${mapImg}
${full ? `<h2>Zoning</h2><ul>${a.zones.map((z) => `<li><b>${esc(z.zone.name)}</b> (${esc(z.authority)})${z.coverage_pct != null ? ` – ${Math.round(z.coverage_pct)}% of lot` : ""}</li>`).join("")}</ul>
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
  const path = await save({ defaultPath: `Planning_report_${name}.html`, filters: [{ name: "HTML report", extensions: ["html"] }] });
  if (!path) return;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Planning report: ${esc(current.parcel.address)}</title>
<style>body{${REPORT_CSS};max-width:820px;margin:40px auto;padding:0 20px}h1{font-size:24px}h2{font-size:18px;margin-top:28px;border-bottom:1px solid #ddd}small,.d{color:#6b7280;font-size:12px}</style></head>
<body>${reportBody(current)}</body></html>`;
  await invoke("save_text", { path, content: html });
});

// PDF: print only the report; choose "Save as PDF" / "Microsoft Print to PDF" in the print dialog.
$("pdfBtn").addEventListener("click", () => {
  if (!current) return;
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
  $("stateMaps").innerHTML = MAPS.state
    .filter((m) => ok(m.name))
    .map((m) => `<div class="mapitem"><div><b>${esc(m.name)}</b><div class="meta">${esc(m.desc)}</div></div><button type="button" data-url="${esc(m.url)}" data-title="${esc(m.name)}">Open</button></div>`)
    .join("");
  $("councilMaps").innerHTML = MAPS.councils
    .filter((c) => ok(c.name))
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
  try { last = Number(localStorage.getItem("lastPid")); } catch { /* storage unavailable */ }
  if (last > 0) void loadSite(last);
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
  $("starBtn").textContent = s?.star ? "★ Saved" : "☆ Save";
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
    tiles: ["https://spatial-img.information.qld.gov.au/arcgis/rest/services/Basemaps/LatestStateProgram_AllUsers/ImageServer/exportImage?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=jpg&f=image"],
    attribution: "Imagery © State of Queensland; © Planet Labs",
    maxzoom: 20,
  },
};
function baseKind(): string {
  let k: string | null = null;
  try { k = localStorage.getItem("base"); } catch { /* storage unavailable */ }
  return k && k in BASES ? k : "plain";
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
  return `<p class="meta"><b>Estimate:</b> ${n} lots = ${n - 1} additional × ${money(rate)} = <b>${money((n - 1) * rate)}</b> Council charge, plus Urban Utilities water and sewer. Before indexation and any credits.</p>`;
}

// ---- Nearby approvals: Brisbane's DA register (Development.i), address copied for pasting ----
$("daRegBtn").addEventListener("click", () => {
  if (!current) return;
  navigator.clipboard.writeText(current.parcel.address || current.parcel.lotplan).catch(() => {});
  openExternal("https://developmenti.brisbane.qld.gov.au/");
});

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
$("suburbBtn").addEventListener("click", async () => {
  if (!current) return;
  const sub = current.parcel.suburb;
  try {
    const r = await invoke<any>("suburb_stats", { suburb: sub });
    const lot = current.parcel.area_m2 ?? 0;
    $("suburbOut").innerHTML = `<table class="ptable"><tbody>
      <tr><td>Lots in ${esc(r.suburb)}</td><td><b>${r.lots.toLocaleString()}</b></td></tr>
      <tr><td>Median lot size</td><td><b>${r.median_m2} m²</b> (middle half ${r.p25_m2}–${r.p75_m2} m²)</td></tr>
      <tr><td>This lot</td><td><b>${Math.round(lot)} m²</b> – ${lot >= r.median_m2 ? "larger" : "smaller"} than the suburb median</td></tr>
      <tr><td>Lots 600 m² or more</td><td>${r.pct_600}%</td></tr>
      <tr><td>Lots 800 m² or more</td><td>${r.pct_800}%</td></tr>
      <tr><td>Lots 900 m² or more (2 × 450 m² by area)</td><td>${r.pct_900}% (${r.count_900.toLocaleString()} lots)</td></tr>
      <tr><td>Lots 1,000 m² or more</td><td>${r.pct_1000}%</td></tr></tbody></table>
      <p class="meta">From the Brisbane cadastre in the data pack. Population, income and housing: ${link("https://www.abs.gov.au/census/find-census-data/quickstats", "ABS Census QuickStats")} (search "${esc(sub)}").</p>`;
  } catch (e) {
    alertMsg(e);
  }
});

// ---- Compare 2–3 sites ----
$("cmpBtn").addEventListener("click", () => {
  const list = Object.values(sites()).sort((x, y) => Number(!!y.star) - Number(!!x.star) || y.ts - x.ts);
  $("cmpPick").innerHTML = list.length
    ? list.map((h) => `<label class="mapitem"><span><input type="checkbox" value="${esc(h.lotplan)}" data-pid="${h.pid}"> ${h.star ? "★ " : ""}<b>${esc(h.address || h.lotplan)}</b></span><span class="meta">${esc(h.lotplan)}</span></label>`).join("")
    : `<p class="meta">Open a few addresses first – they appear here.</p>`;
  $("cmpOut").innerHTML = "";
  ($("cmpDlg") as HTMLDialogElement).showModal();
});
$("cmpGo").addEventListener("click", async () => {
  const picked = [...document.querySelectorAll<HTMLInputElement>("#cmpPick input:checked")].slice(0, 3);
  if (picked.length < 2) return alertMsg("Pick 2 or 3 addresses.");
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
    <tr><td>Zone</td>${cell((r) => esc(r.a.zones.map((z) => z.zone.name).join(", ") || "–"))}</tr>
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
  const rows: string[][] = [["input", "matched address", "lot/plan", "area m2", "zone(s)", "number of constraints", "constraint titles"]];
  const shown: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.innerHTML = `<p class="meta">Checking ${i + 1} of ${lines.length}…</p>${shown.join("")}`;
    const q = lines[i];
    try {
      const h = (await invoke<Hit[]>("search", { q }))[0];
      if (!h) throw new Error("no match");
      const a = await invoke<Assessment>("assess", { pid: h.pid });
      rows.push([q, a.parcel.address, a.parcel.lotplan, a.parcel.area_m2 != null ? String(Math.round(a.parcel.area_m2)) : "",
        a.zones.map((z) => z.zone.name).join("; "), String(a.flags.length), a.flags.map((f) => f.rule.title).join("; ")]);
      shown.push(`<div class="mapitem"><span><b>${esc(a.parcel.address || a.parcel.lotplan)}</b> <span class="meta">${esc(q)}</span></span><span class="meta">${a.flags.length} constraint(s)</span></div>`);
    } catch {
      rows.push([q, "", "", "", "", "", ""]);
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
type SetbackSet = { title: string; min_area_m2: number; note: string; source: string; rows: { label: string; value: string; ref: string }[]; check: string };
const SETBACKS = SETBACKS_DATA as Record<string, SetbackSet>;
/** The setback set for this lot, only when its zone is covered and the lot is at least the set's minimum area. */
function setbackSet(a: Assessment): SetbackSet | undefined {
  const set = a.zones.map((z) => SETBACKS[z.zone.name]).find(Boolean);
  const area = a.parcel.area_m2;
  return set && area != null && area >= set.min_area_m2 ? set : undefined;
}
function renderSetbacks(a: Assessment) {
  const zones = a.zones.map((z) => z.zone.name);
  const set = setbackSet(a);
  const area = a.parcel.area_m2;
  const fact = `<button type="button" class="ghost" data-url="https://www.brisbane.qld.gov.au/planning-building/planning-guidelines-tools/brisbane-city-plan-2014/fact-sheets/residential-development-suburban-zones">Open the City Plan fact sheet</button>`;
  if (!set) {
    $("setbacks").innerHTML = `<div class="card"><div class="meta">Zone: ${esc(zones.join(", ") || "not identified")}${area != null ? ` · ${Math.round(area)} m²` : ""}</div>
      <p>Setback distances for this zone and lot size aren't in the app yet, so none are shown. Check with council.</p>${fact}</div>`;
    return;
  }
  $("setbacks").innerHTML = `<div class="card"><div class="meta">${esc(set.title)} · <span class="pill warn">verify</span></div>
    <table class="ptable"><tbody>${set.rows.map((r) => `<tr><td>${esc(r.label)}<div class="meta">${esc(r.ref)}</div></td><td><b>${esc(r.value)}</b></td></tr>`).join("")}</tbody></table>
    <p class="meta">${esc(set.note)}</p><p class="meta">${esc(set.check)}</p>
    <button type="button" class="ghost" data-url="${esc(set.source)}">Open the code</button> ${fact}</div>`;
}

// ==== Setbacks tool: buildable area inset from the lot by the ground-floor setbacks (indicative only) ====
let setbackOn = false;
let setbackMarkers: maplibregl.Marker[] = [];
type XY = [number, number];
const SETBACK_ROWS = { front: "Front, primary frontage (building wall)", side: "Side, ground floor or wall up to 4.5 m", rear: "Rear, ground floor or wall up to 4.5 m" };

function clearSetbackLayer() {
  setbackMarkers.forEach((m) => m.remove());
  setbackMarkers = [];
  if (map?.getLayer("setb")) { map.removeLayer("setb"); map.removeSource("setb"); }
}
function resetSetbackTool() {
  measMode = ""; measPts = []; measMarks = []; toolUi("measDBtn", false); toolUi("measABtn", false); ($("measOut") as HTMLElement).hidden = true;
  setbackOn = false;
  toolUi("setbackBtn", false);
  setbackMarkers = []; // the map is rebuilt on a new site, which removes the layer
}

/** Buildable polygon (lon/lat ring) and labels, or a reason it can't be drawn. */
function setbackEnvelope(a: Assessment, p: Pot): { ring: XY[]; labels: { ll: XY; text: string }[] } | string {
  const set = setbackSet(a);
  if (!set) return "Setback distances for this zone and lot size aren't in the app.";
  const val = (label: string) => parseFloat(set.rows.find((r) => r.label === label)?.value ?? "");
  const txt = (label: string) => set.rows.find((r) => r.label === label)?.value ?? "";
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
  if (fronts.length !== 1) return "The front edge couldn't be identified reliably (corner lot or no clear street edge).";
  const fi = fronts[0];
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
  for (let i = 0; i < n; i++) if (i !== fi && (ri < 0 || depthOf(i) > depthOf(ri))) ri = i;
  const fd = dirOf(fi), rd = dirOf(ri);
  if (Math.abs(fd[0] * rd[0] + fd[1] * rd[1]) < Math.cos((30 * Math.PI) / 180)) return "No clear rear edge opposite the front.";
  // Intersect the half-planes: clip the lot by each edge moved inward by its setback.
  let poly: XY[] = sides.map((sd) => sd[0]);
  const lines: { a: XY; nrm: XY; off: number }[] = [];
  for (let i = 0; i < n; i++) {
    const off = i === fi ? d.front : i === ri ? d.rear : d.side;
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
    if (poly.length < 3) return "The setbacks leave no buildable area on this lot.";
  }
  if (Math.abs(shoe(poly)) < 1) return "The setbacks leave no buildable area on this lot.";
  const labels: { ll: XY; text: string }[] = [];
  lines.forEach((ln, i) => {
    const on = poly.filter((q) => Math.abs((q[0] - ln.a[0]) * ln.nrm[0] + (q[1] - ln.a[1]) * ln.nrm[1] - ln.off) < 0.01);
    if (on.length < 2) return;
    const u = dirOf(i), t = (q: XY) => q[0] * u[0] + q[1] * u[1];
    const [lo, hi] = [on.reduce((x, y) => (t(y) < t(x) ? y : x)), on.reduce((x, y) => (t(y) > t(x) ? y : x))];
    if (Math.hypot(hi[0] - lo[0], hi[1] - lo[1]) < 1) return;
    const kind = i === fi ? "front" : i === ri ? "rear" : "side";
    labels.push({ ll: toLL([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2]), text: `${kind} ${txt(SETBACK_ROWS[kind])}` });
  });
  return { ring: [...poly, poly[0]].map(toLL), labels };
}

function drawSetbacks() {
  if (!map) return;
  clearSetbackLayer();
  if (!setbackOn) return setFloodUi(floodOn);
  const res = current && pot ? setbackEnvelope(current, pot) : "Lot measurements aren't loaded yet.";
  if (typeof res === "string") return setFloodUi(floodOn, `<b>Can't draw setbacks for this lot</b><div class="meta">${esc(res)}</div>`);
  map.addSource("setb", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: res.ring } } });
  map.addLayer({ id: "setb", type: "line", source: "setb", paint: { "line-color": "#0f5e4b", "line-width": 2, "line-dasharray": [3, 2] } });
  for (const l of res.labels) {
    const el = document.createElement("div");
    el.className = "dim front";
    el.textContent = l.text;
    setbackMarkers.push(new maplibregl.Marker({ element: el }).setLngLat(l.ll).addTo(map));
  }
  setFloodUi(floodOn, `<b>Setbacks (indicative)</b><div class="meta">Ground-floor building wall setbacks from the Queensland Housing Code, applied to the measured lot. Verify with council before designing.</div>`);
}
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

function drag(el: HTMLElement, side: "l" | "r") {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const px = side === "l" ? clampN(ev.clientX - 6, 120, 320) : clampN(innerWidth - ev.clientX - 6, 220, 520);
      document.documentElement.style.setProperty(side === "l" ? "--left" : "--right", `${px}px`);
      resizeMap();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", () => {
      el.removeEventListener("pointermove", move);
      try { localStorage.setItem(side === "l" ? "colLeft" : "colRight", document.documentElement.style.getPropertyValue(side === "l" ? "--left" : "--right")); } catch { /* storage unavailable */ }
    }, { once: true });
  });
}
drag($("gripL"), "l");
drag($("gripR"), "r");

// Restore remembered layout (column widths, Full map)
try {
  const l = localStorage.getItem("colLeft"), r = localStorage.getItem("colRight");
  if (l && /^\d+(\.\d+)?px$/.test(l)) document.documentElement.style.setProperty("--left", l);
  if (r && /^\d+(\.\d+)?px$/.test(r)) document.documentElement.style.setProperty("--right", r);
  if (localStorage.getItem("fullmap") === "1") app.classList.add("fullmap");
} catch { /* storage unavailable */ }

// ---- Backup and restore (Settings) ----
const BACKUP_KEYS = ["sites", "brand", MAP_KEY, "base", "theme"];
$("backupBtn").addEventListener("click", async () => {
  const data: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (BACKUP_KEYS.includes(k) || k.startsWith("daform1:"))) data[k] = localStorage.getItem(k) ?? "";
    }
  } catch { /* storage unavailable */ }
  try {
    const path = await save({ defaultPath: `Town_planner_backup_${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "Backup", extensions: ["json"] }] });
    if (!path) return;
    await invoke("save_text", { path, content: JSON.stringify({ app: "ai-town-planner", version: 1, data }) });
    $("backupMsg").textContent = `Backed up ${Object.keys(data).length} items.`;
  } catch (e) { $("backupMsg").textContent = String(e); }
});
$("restoreBtn").addEventListener("click", async () => {
  try {
    const path = await open({ multiple: false, filters: [{ name: "Backup", extensions: ["json"] }] });
    if (typeof path !== "string") return;
    const parsed = JSON.parse(await invoke<string>("read_backup", { path }));
    const data: Record<string, unknown> = parsed && typeof parsed.data === "object" && parsed.data ? parsed.data : {};
    let n = 0;
    for (const [k, v] of Object.entries(data)) {
      if ((BACKUP_KEYS.includes(k) || k.startsWith("daform1:")) && typeof v === "string") { localStorage.setItem(k, v); n++; }
    }
    if (!n) throw new Error("No data found in that file.");
    location.reload();
  } catch (e) { $("backupMsg").textContent = `Restore failed: ${e}`; }
});

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
    assessor: "Brisbane City Council",
    loc_lga: "Brisbane City Council",
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
    "TASK: Help the applicant complete the Queensland DA Form 1 (version 1.3). Explain questions in plain words, say what to check with council or City Plan, and suggest wording when asked. Do not tick declarations, do not fill in Part 9, and do not say an answer is correct.",
    `SITE: ${current?.parcel.address ?? ""} · ${current?.parcel.lotplan ?? ""}${current?.parcel.area_m2 ? ` · ${Math.round(current.parcel.area_m2)} m²` : ""}`,
    `ZONES: ${current?.zones.map((z) => z.zone.name).join(", ") || "not identified"}`,
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
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && app.classList.contains("formsmode") && !document.querySelector("dialog[open]")) closeFormView(); });
// any map tool or map style button returns to the map
document.querySelectorAll<HTMLElement>(".toolstack > button").forEach((b) => {
  if (b.id !== "formsBtn") b.addEventListener("click", () => { if (app.classList.contains("formsmode") && ["dimBtn","subBtn","setbackBtn","measDBtn","measABtn","contBtn","floodBtn","powerBtn","envBtn"].includes(b.id)) closeFormView(); });
});

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
$("footReport").addEventListener("click", () => $("genBtn").click());
$("footPdf").addEventListener("click", () => $("pdfBtn").click());

// Clicking outside a window (on the dimmed backdrop) closes it.
document.querySelectorAll<HTMLDialogElement>("dialog").forEach((d) => d.addEventListener("click", (ev) => { if (ev.target === d) d.close(); }));
