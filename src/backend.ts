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

// ---- Web only: Trade AI sign-in (licensing/README.md). The phone signs in to Supabase itself; the server
// checks the token and the townplanner trial / licence on every /api call. ----
type Session = { access_token: string; refresh_token: string; expires_at: number; email: string };
type AuthConfig = { configured: boolean; url: string; anon_key: string; product: string };
const SESSION = "tpSession";
let authCfg: Promise<AuthConfig> | null = null;
function session(): Session | null {
  try { return JSON.parse(stored(SESSION) || "null"); } catch { return null; }
}
function deviceId(): string {
  let id = stored("tpDevice");
  if (!id) { id = (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`); store("tpDevice", id); }
  return id;
}
function config(): Promise<AuthConfig> {
  authCfg ??= fetch("/api/auth_config", { method: "POST" }).then((r) => r.json()).catch((e) => { authCfg = null; throw e; });
  return authCfg;
}
/** Licence answers (both apps): see src-tauri/src/licence.rs LicenceState. */
export type Licence = { configured: boolean; signed_in: boolean; ok: boolean; state: string; email: string; plan: string; days_left: number | null; message: string; offline: boolean };
const signedOut = (message = ""): Licence => ({ configured: true, signed_in: false, ok: false, state: "signed_out", email: "", plan: "", days_left: null, message, offline: false });
/** Called when the server refuses a call (401 sign in / 402 licence): the app shows the sign-in page. */
export const licenceEvents = new EventTarget();

async function supabase(path: string, body: unknown, token?: string): Promise<Record<string, unknown>> {
  const c = await config();
  let r: Response;
  try {
    r = await fetch(c.url + path, { method: "POST", headers: { "Content-Type": "application/json", apikey: c.anon_key, Authorization: `Bearer ${token ?? c.anon_key}` }, body: JSON.stringify(body) });
  } catch {
    throw "Can't reach the Trade AI sign-in service. Check your internet connection and try again.";
  }
  const j = await r.json().catch(() => ({}));
  if (r.ok) return j;
  const code = String(j.error_code ?? j.error ?? j.code ?? "");
  const msg = String(j.msg ?? j.message ?? j.error_description ?? "");
  if (code === "invalid_credentials" || code === "invalid_grant" || msg.includes("Invalid login credentials")) throw "That e-mail and password don't match. Check them, or use 'Forgot password?'.";
  if (code === "email_not_confirmed") throw "Please confirm your e-mail first - open the link we sent you, then sign in.";
  if (code === "user_already_exists" || code === "email_exists") throw "There's already an account with this e-mail. Sign in instead.";
  if (code === "weak_password") throw "Please choose a stronger password (at least 8 characters).";
  if (code === "over_email_send_rate_limit") throw "We've just sent you an e-mail. Please wait a minute before asking again.";
  if (r.status === 429) throw "Too many tries. Please wait a minute and try again.";
  throw msg && msg.length < 200 ? msg : `The Trade AI sign-in service answered with an error (${r.status}). Please try again.`;
}
function keep(j: Record<string, unknown>, email: string) {
  const s: Session = {
    access_token: String(j.access_token), refresh_token: String(j.refresh_token ?? ""),
    expires_at: Number(j.expires_at) || Math.floor(Date.now() / 1000) + (Number(j.expires_in) || 3600),
    email: String((j.user as { email?: string } | undefined)?.email ?? email),
  };
  store(SESSION, JSON.stringify(s));
}
/** A current access token (refreshed a minute before it runs out), or null when signed out. */
async function token(): Promise<string | null> {
  const s = session();
  if (!s) return null;
  if (s.expires_at > Date.now() / 1000 + 60) return s.access_token;
  try {
    keep(await supabase("/auth/v1/token?grant_type=refresh_token", { refresh_token: s.refresh_token }), s.email);
  } catch (e) {
    if (String(e).startsWith("Can't reach")) return s.access_token; // offline: the server will say
    store(SESSION, "");
    return null;
  }
  return session()?.access_token ?? null;
}
async function webLicence(): Promise<Licence> {
  let c: AuthConfig;
  try { c = await config(); } catch { return { ...signedOut("Could not reach the server. Check your internet connection."), state: "offline", configured: true }; }
  if (!c.configured) return { ...signedOut("Sign-in is not set up on this server yet."), configured: false, state: "not_configured" };
  const t = await token();
  if (!t) return signedOut();
  let r: Response;
  try {
    r = await fetch("/api/licence_state", { method: "POST", headers: { Authorization: `Bearer ${t}`, "X-Device-Id": deviceId() } });
  } catch {
    return { ...signedOut("Could not reach the server. Check your internet connection."), signed_in: true, state: "offline", email: session()?.email ?? "" };
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { store(SESSION, ""); return signedOut(j.error ?? ""); }
  if (!r.ok) return { ...signedOut(j.error ?? `Server error ${r.status}`), signed_in: true, state: "error", email: session()?.email ?? "" };
  return { configured: true, signed_in: true, ok: j.ok === true, state: String(j.state ?? ""), email: session()?.email ?? "", plan: String(j.plan ?? ""), days_left: j.days_left ?? null, message: String(j.message ?? ""), offline: false };
}
async function webAuth(cmd: string, a: Record<string, unknown>): Promise<unknown> {
  const email = String(a.email ?? "").trim().toLowerCase();
  if (cmd === "licence_state") return webLicence();
  if (cmd === "auth_sign_in") {
    keep(await supabase("/auth/v1/token?grant_type=password", { email, password: a.password }), email);
    return webLicence();
  }
  if (cmd === "auth_sign_up") {
    const j = await supabase("/auth/v1/signup", { email, password: a.password, data: { full_name: String(a.fullName ?? "").trim() } });
    if (j.access_token) { keep(j, email); return webLicence(); }
    const u = (j.user ?? j) as { identities?: unknown[] };
    if (Array.isArray(u.identities) && !u.identities.length) throw "There's already an account with this e-mail. Sign in instead.";
    return null;
  }
  if (cmd === "auth_reset") { await supabase("/auth/v1/recover", { email }); return null; }
  // auth_sign_out: the server gives this phone's seat back, then the session ends
  const t = session()?.access_token;
  if (t) {
    await fetch("/api/auth_sign_out", { method: "POST", headers: { Authorization: `Bearer ${t}`, "X-Device-Id": deviceId() } }).catch(() => null);
    await supabase("/auth/v1/logout", {}, t).catch(() => null);
  }
  store(SESSION, "");
  return null;
}
const AUTH_CMDS = ["licence_state", "auth_sign_in", "auth_sign_up", "auth_reset", "auth_sign_out"];

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
    const t = await token();
    const h = { ...webHeaders(), "X-Device-Id": deviceId(), ...(t ? { Authorization: `Bearer ${t}` } : {}) };
    r = await fetch(`/api/${cmd}`, { method: "POST", headers: h, body: JSON.stringify(args), signal });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw "Could not reach the server. Check your internet connection.";
  }
  if (!r.ok) {
    const j = await r.json().catch(() => null);
    if (r.status === 401 || r.status === 402) licenceEvents.dispatchEvent(new CustomEvent("refused", { detail: j }));
    throw (j && typeof j.error === "string" ? j.error : `Server error ${r.status}`);
  }
  return r;
}

export async function invoke<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isWeb) return tauriInvoke<T>(cmd, args);
  if (AUTH_CMDS.includes(cmd)) return (await webAuth(cmd, args)) as T;
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
