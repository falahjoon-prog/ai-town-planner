// One backend for the UI: the Tauri core on the desktop, the web server's `POST /api/<command>` in a browser.
// Same arguments, results and error text (a plain string) either way.
import { invoke as tauriInvoke, Channel } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

/** True in a browser (phone web app), false inside the desktop app. */
export const isWeb = !(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

type Filter = { name: string; extensions: string[] };

// ---- Web only: AI and Google keys stay in this browser and go with each request ----
const WEB_AI = "webAi";
const keyName = (provider: string) => `webKey.${provider}`;
const stored = (k: string) => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } };
function store(k: string, v: string) {
  try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* storage unavailable */ }
}
function webAi(): Record<string, string> {
  try { return JSON.parse(stored(WEB_AI) || "{}"); } catch { return {}; }
}
const webProvider = () => (webAi().provider === "openai" ? "openai" : "anthropic");
function webHeaders(): Record<string, string> {
  const ai = webAi();
  const p = webProvider();
  const h: Record<string, string> = { "Content-Type": "application/json", "X-AI-Provider": p };
  const key = stored(keyName(p));
  if (key) h["X-AI-Key"] = key;
  const model = (p === "openai" ? ai.openai_model : ai.anthropic_model) ?? "";
  if (model) h["X-AI-Model"] = model;
  const g = stored(keyName("google"));
  if (g) h["X-Google-Key"] = g;
  return h;
}

/** Commands answered in the browser itself (settings and keys live on the phone). */
function webLocal(cmd: string, args: Record<string, unknown>): { v: unknown } | null {
  if (cmd === "set_api_key") { store(keyName(String(args.provider)), String(args.key ?? "").trim()); return { v: null }; }
  if (cmd === "save_ai_settings") { store(WEB_AI, JSON.stringify(args.settings ?? {})); return { v: null }; }
  if (cmd === "open_external") { window.open(String(args.url), "_blank", "noopener"); return { v: null }; }
  if (cmd === "cancel_report") { streams.forEach((c) => c.abort()); return { v: null }; }
  return null;
}

async function post(cmd: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  let r: Response;
  try {
    r = await fetch(`/api/${cmd}`, { method: "POST", headers: webHeaders(), body: JSON.stringify(args), signal });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw "Could not reach the server. Check your internet connection.";
  }
  if (!r.ok) {
    const j = await r.json().catch(() => null);
    throw (j && typeof j.error === "string" ? j.error : `Server error ${r.status}`);
  }
  return r;
}

export async function invoke<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isWeb) return tauriInvoke<T>(cmd, args);
  const local = webLocal(cmd, args);
  if (local) return local.v as T;
  const v = await (await post(cmd, args)).json();
  if (cmd === "status") {
    // The server knows nothing about this phone's AI choice and keys: fill them in from local storage.
    v.ai = { ...v.ai, ...webAi(), provider: webProvider() };
    v.has_anthropic_key = !!stored(keyName("anthropic"));
    v.has_openai_key = !!stored(keyName("openai"));
    v.has_google_key = !!stored(keyName("google"));
  }
  return v as T;
}

const streams = new Set<AbortController>();

/** Streaming command: each message goes to `onMessage`. Desktop: a Tauri Channel passed as `channelArg`.
 *  Web: Server-Sent Events (`data: <JSON>`, `event: error`, `event: done`); Stop aborts the request. */
export async function invokeStream<T>(cmd: string, args: Record<string, unknown>, onMessage: (m: T) => void, channelArg = "onToken"): Promise<void> {
  if (!isWeb) {
    const ch = new Channel<T>();
    ch.onmessage = onMessage;
    await tauriInvoke(cmd, { ...args, [channelArg]: ch });
    return;
  }
  const ctl = new AbortController();
  streams.add(ctl);
  try {
    const body = (await post(cmd, args, ctl.signal)).body;
    if (!body) return;
    const rd = body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await rd.read();
      if (done) return;
      buf += value;
      let cut: number;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        let ev = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (!data.length) continue;
        if (ev === "done") return;
        const msg = JSON.parse(data.join("\n"));
        if (ev === "error") throw String(msg);
        onMessage(msg as T);
      }
    }
  } catch (e) {
    if ((e as Error)?.name !== "AbortError") throw e;
  } finally {
    streams.delete(ctl);
  }
}

/** Saves text or bytes. Desktop: Save dialog and the Rust core writes the file. Web: a browser download.
 *  Returns false when the user cancelled the dialog. */
export async function saveFile(defaultPath: string, filter: Filter, data: string | Uint8Array): Promise<boolean> {
  if (isWeb) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data as BlobPart]));
    a.download = defaultPath;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
    return true;
  }
  const path = await save({ defaultPath, filters: [filter] });
  if (!path) return false;
  if (typeof data === "string") await tauriInvoke("save_text", { path, content: data });
  else await tauriInvoke("save_bytes", { path, bytes: Array.from(data) });
  return true;
}

/** Lets the user pick a text file and returns its contents (null if cancelled). Desktop: Open dialog,
 *  then `readCmd` reads it in Rust. Web: a file picker. */
export async function openTextFile(filter: Filter, readCmd = "read_text_file"): Promise<string | null> {
  if (!isWeb) {
    const path = await pickPath(filter);
    return path ? tauriInvoke<string>(readCmd, { path }) : null;
  }
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = filter.extensions.map((x) => `.${x}`).join(",");
  const file = await new Promise<File | null>((res) => {
    inp.addEventListener("change", () => res(inp.files?.[0] ?? null), { once: true });
    inp.addEventListener("cancel", () => res(null), { once: true });
    inp.click();
  });
  return file ? file.text() : null;
}

/** Desktop only: a file path for the Rust core to read (data pack, model, title PDF). */
export async function pickPath(filter: Filter): Promise<string | null> {
  const path = await open({ multiple: false, filters: [filter] });
  return typeof path === "string" ? path : null;
}
