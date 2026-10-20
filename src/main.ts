import { invoke, Channel } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { marked } from "marked";
import "./style.css";

type Hit = { pid: number; address: string; lotplan: string; suburb: string };
type Overlay = { dataset_id: string; title: string; props: Record<string, unknown>; coverage_pct: number | null; geom: any };
type Assessment = {
  parcel: { pid: number; lotplan: string; address: string; suburb: string; area_m2: number | null; geom: any };
  zones: { zone: { name: string; purpose: string; typical: string }; coverage_pct: number | null }[];
  flags: { rule: { title: string; code: string; note: string; checklist: string[] }; layers: string[] }[];
  overlays: Overlay[];
  manifest: Record<string, string>;
};
type ModelStatus = { id: string; name: string; file: string; size_gb: number; min_ram_gb: number; note: string; installed: boolean; active: boolean };
type Status = { datapack: Record<string, string> | null; models: ModelStatus[]; custom_models: string[]; active_model: string | null; disclaimer: string };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let current: Assessment | null = null;
let reportText = "";
let map: maplibregl.Map | null = null;

async function refreshStatus(): Promise<Status> {
  const s = await invoke<Status>("status");
  const p = s.datapack;
  $("packInfo").textContent = p ? `Data: ${p.region} · ${p.built_at}` : "No data pack: open Settings";
  $("packDetail").textContent = p
    ? `${p.region} · built ${p.built_at} · ${Number(p.parcels).toLocaleString()} lots · ${p.layers} City Plan layers. ${p.attribution}`
    : "No data pack installed yet. Download the latest datapack .sqlite.gz from the GitHub Releases page, then import it here.";
  $("disclaimer").textContent = s.disclaimer;
  renderModels(s);
  return s;
}

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

async function runSearch() {
  const q = ($("q") as HTMLInputElement).value.trim();
  const list = $("results");
  $("hint").classList.remove("err");
  if (q.length < 3) {
    list.innerHTML = "";
    return;
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
  loadSite(Number(li.dataset.pid));
});

// ---- Site ----
const PALETTE = ["#c2410c", "#0e7490", "#7c3aed", "#b91c1c", "#15803d", "#a16207", "#be185d", "#1d4ed8"];

async function loadSite(pid: number) {
  try {
    current = await invoke<Assessment>("assess", { pid });
  } catch (e) {
    return alertMsg(e);
  }
  const a = current;
  $("empty").hidden = true;
  $("site").hidden = false;
  $("siteAddr").textContent = a.parcel.address || a.parcel.lotplan;
  $("siteMeta").textContent = [a.parcel.lotplan, a.parcel.area_m2 ? `${Math.round(a.parcel.area_m2).toLocaleString()} m²` : "", a.parcel.suburb]
    .filter(Boolean)
    .join(" · ");
  $("zones").innerHTML = a.zones.length
    ? a.zones
        .map(
          (z) => `<div class="zone"><b>${esc(z.zone.name)}</b>${z.coverage_pct != null && z.coverage_pct < 99 ? ` <span class="pill">${z.coverage_pct}% of lot</span>` : ""}
          <p>${esc(z.zone.purpose)}</p></div>`
        )
        .join("")
    : `<p class="meta">Zone not identified from the data pack. Check the zoning layer attributes below.</p>`;
  $("flags").innerHTML = a.flags.length
    ? a.flags
        .map((f) => `<div class="flag"><b>${esc(f.rule.title)}</b><div class="meta">${esc(f.rule.code)}</div><p>${esc(f.rule.note)}</p></div>`)
        .join("")
    : `<p class="meta">No overlay constraints mapped on this lot.</p>`;
  $("ovSummary").textContent = `All mapped layers (${a.overlays.length})`;
  $("overlays").innerHTML = a.overlays
    .map(
      (o) => `<li><b>${esc(o.title)}</b>${o.coverage_pct != null ? ` · ${o.coverage_pct}%` : ""}
      <div class="meta">${Object.entries(o.props).slice(0, 6).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(" · ")}</div></li>`
    )
    .join("");
  reportText = "";
  $("report").innerHTML = "";
  $("saveBtn").hidden = true;
  drawMap(a);
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

function drawMap(a: Assessment) {
  map?.remove();
  map = new maplibregl.Map({
    container: "map",
    style: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#efece4" } }] },
    attributionControl: false,
  });
  map.on("load", () => {
    const m = map!;
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

// ---- Report ----
$("genBtn").addEventListener("click", async () => {
  if (!current) return;
  const gen = $("genBtn") as HTMLButtonElement;
  gen.disabled = true;
  gen.textContent = "Loading model…";
  $("stopBtn").hidden = false;
  $("saveBtn").hidden = true;
  reportText = "";
  $("report").innerHTML = "";
  const ch = new Channel<string>();
  ch.onmessage = (t) => {
    gen.textContent = "Writing…";
    reportText += t;
    $("report").innerHTML = marked.parse(reportText) as string;
  };
  try {
    await invoke("generate_report", { pid: current.parcel.pid, question: ($("question") as HTMLInputElement).value, onToken: ch });
    $("saveBtn").hidden = !reportText;
  } catch (e) {
    $("report").innerHTML = `<p class="err">${esc(e)}</p>`;
  }
  gen.disabled = false;
  gen.textContent = "Generate planner report";
  $("stopBtn").hidden = true;
});

$("stopBtn").addEventListener("click", () => invoke("cancel_report"));

$("saveBtn").addEventListener("click", async () => {
  if (!current) return;
  const name = (current.parcel.address || current.parcel.lotplan).replace(/[^\w]+/g, "_").slice(0, 60);
  const path = await save({ defaultPath: `Planning_report_${name}.html`, filters: [{ name: "HTML report", extensions: ["html"] }] });
  if (!path) return;
  const a = current;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Planning report: ${esc(a.parcel.address)}</title>
<style>body{font:15px/1.6 Georgia,serif;max-width:820px;margin:40px auto;padding:0 20px;color:#1f2937}h1{font-size:24px}h2{font-size:18px;margin-top:28px;border-bottom:1px solid #ddd}small,.d{color:#6b7280;font-size:12px}</style></head>
<body><h1>Planning assessment: ${esc(a.parcel.address || a.parcel.lotplan)}</h1>
<small>${esc(a.parcel.lotplan)} · Data pack ${esc(a.manifest.built_at)} · Generated ${new Date().toLocaleString("en-AU")}</small>
${marked.parse(reportText)}
<p class="d">${esc($("disclaimer").textContent)}<br>${esc(a.manifest.attribution)}</p></body></html>`;
  await invoke("save_text", { path, content: html });
});

refreshStatus().then((s) => {
  if (!s.datapack) ($("settings") as HTMLDialogElement).showModal();
});
