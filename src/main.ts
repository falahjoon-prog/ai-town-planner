import { invoke, Channel } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { marked } from "marked";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import MAPS from "./maps.json";
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
}

$("useSel").addEventListener("change", loadPotential);
// Links inside the potential/forms panels open in an in-app window.
document.querySelector(".pot-box")!.addEventListener("click", (ev) => {
  const el = (ev.target as HTMLElement).closest("[data-url]") as HTMLElement | null;
  if (!el) return;
  ev.preventDefault();
  openMap(el.dataset.url!, el.dataset.title!);
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
async function draft(letter: boolean) {
  if (!current) return;
  const btn = $(letter ? "letterBtn" : "formBtn") as HTMLButtonElement;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Drafting…";
  docText = "";
  $("docTitle").textContent = letter ? "Cover letter" : "DA Form 1 – Development application details";
  $("docBody").innerHTML = `<p class="meta">Drafting…</p>`;
  ($("docDlg") as HTMLDialogElement).showModal();
  const ch = new Channel<string>();
  ch.onmessage = (t) => {
    docText += t;
    $("docBody").innerHTML = letter ? renderLetter(docText) : renderForm(docText, false);
  };
  try {
    await invoke("draft_form", { pid: current.parcel.pid, useId: useId(), proposal: val("question"), letter, onToken: ch });
    if (!letter) $("docBody").innerHTML = renderForm(docText, true);
  } catch (e) {
    $("docBody").innerHTML = `<p class="err">${esc(e)}</p>`;
  }
  btn.disabled = false;
  btn.textContent = label;
}
$("formBtn").addEventListener("click", () => draft(false));
$("letterBtn").addEventListener("click", () => draft(true));

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
  });
}

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

refreshStatus().then((s) => {
  if (!s.datapack) ($("settings") as HTMLDialogElement).showModal();
});

// Light / dark theme (follows the system until the user picks one)
function setTheme(t: "light" | "dark") {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("theme", t); } catch { /* storage unavailable */ }
  $("themeBtn").textContent = t === "dark" ? "☀" : "☾";
}
{
  let t: string | null = null;
  try { t = localStorage.getItem("theme"); } catch { /* storage unavailable */ }
  setTheme(t === "light" || t === "dark" ? t : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
$("themeBtn").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));

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
  new WebviewWindow(`ext-${Date.now()}`, { url: a.dataset.url!, title: a.dataset.title ?? "Title search", width: 1100, height: 800 });
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
  new WebviewWindow(`ext-${Date.now()}`, { url: "https://developmenti.brisbane.qld.gov.au/", title: "Development.i – nearby applications", width: 1200, height: 850 });
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
