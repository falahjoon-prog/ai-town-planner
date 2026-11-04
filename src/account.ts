// Trade AI sign-in and the townplanner licence (licensing/README.md): the sign-in page on first open,
// the trial / licence check every 5 minutes, and Settings > Account. Same screens on the desktop and the phone.
import { invoke, licenceEvents, type Licence } from "./backend";

const BUY_URL = "https://trade-ai.com.au";
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let current: Licence | null = null;
let onReady: (() => void) | null = null;
let beat = 0;

function view(id: "gSignIn" | "gSignUp" | "gLocked") {
  for (const v of ["gSignIn", "gSignUp", "gLocked"]) $(v).hidden = v !== id;
  document.querySelectorAll<HTMLDialogElement>("dialog[open]").forEach((d) => d.close()); // modal dialogs sit above the page

  $("gate").hidden = false;
  document.documentElement.classList.add("gated");
  const first = $(id).querySelector<HTMLElement>("input, .gate-go");
  requestAnimationFrame(() => first?.focus());
}

const TITLES: Record<string, string> = {
  expired: "Licence needed", no_seat: "All seats are in use", disabled: "Account disabled",
  not_configured: "Sign-in not set up", offline: "You're offline", error: "Can't check your licence",
};

/** Shows the app (ok) or the right page of the sign-in screen. */
function apply(l: Licence) {
  current = l;
  const line = l.signed_in ? `Signed in as ${l.email || "your Trade AI account"}${l.message ? ` · ${l.message}` : ""}` : "Not signed in";
  $("acctLine").textContent = line;
  $("signOutBtn").hidden = !l.signed_in;
  const pill = $("stLicence");
  pill.textContent = l.ok && l.state === "trial" ? l.message : l.ok && l.offline ? "Offline" : "";
  pill.className = l.ok && (l.days_left ?? 99) <= 3 ? "pill warnpill" : pill.textContent ? "pill" : "";
  if (l.ok) {
    $("gate").hidden = true;
    document.documentElement.classList.remove("gated");
    const r = onReady; onReady = null; r?.();
    return;
  }
  if (!l.signed_in && l.state !== "not_configured") {
    $("gMsg").textContent = l.message;
    $("gMsg").classList.toggle("bad", !!l.message);
    view("gSignIn");
    return;
  }
  $("gLockTitle").textContent = TITLES[l.state] ?? "Licence needed";
  $("gLockMsg").textContent = l.message || "Licence needed — buy at trade-ai.com.au.";
  $("gWho").textContent = l.signed_in && l.email ? `Signed in as ${l.email}` : "";
  $("gBuy").hidden = !["expired", "no_seat"].includes(l.state);
  $("gOut").hidden = !l.signed_in;
  view("gLocked");
}

async function check() {
  try { apply(await invoke<Licence>("licence_state")); } catch (e) { apply({ configured: true, signed_in: !!current?.signed_in, ok: false, state: "error", email: current?.email ?? "", plan: "", days_left: null, message: String(e), offline: false }); }
}

function busy(form: HTMLElement, on: boolean) {
  form.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input").forEach((x) => (x.disabled = on));
}
function say(id: string, text: string, bad = false) {
  $(id).textContent = text;
  $(id).classList.toggle("bad", bad);
}
const validEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());

$("gSignIn").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const email = ($("gEmail") as HTMLInputElement).value, password = ($("gPass") as HTMLInputElement).value;
  if (!validEmail(email) || !password) return say("gMsg", "Enter your e-mail and password.", true);
  const f = $("gSignIn");
  busy(f, true); say("gMsg", "Signing in…");
  try {
    const l = await invoke<Licence>("auth_sign_in", { email, password });
    ($("gPass") as HTMLInputElement).value = "";
    say("gMsg", "");
    apply(l);
  } catch (e) { say("gMsg", String(e), true); } finally { busy(f, false); }
});

$("gForgot").addEventListener("click", async () => {
  const email = ($("gEmail") as HTMLInputElement).value;
  if (!validEmail(email)) return say("gMsg", "Type your e-mail above first, then tap Forgot password?", true);
  try { await invoke("auth_reset", { email }); say("gMsg", "If that e-mail has an account, a link to set a new password is on its way."); } catch (e) { say("gMsg", String(e), true); }
});

$("gSignUp").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const fullName = ($("gName") as HTMLInputElement).value.trim(), email = ($("gNewEmail") as HTMLInputElement).value, password = ($("gNewPass") as HTMLInputElement).value;
  if (!fullName) return say("gNewMsg", "Please enter your full name.", true);
  if (!validEmail(email)) return say("gNewMsg", "Please enter a valid e-mail address.", true);
  if (password.length < 8) return say("gNewMsg", "Use at least 8 characters for the password.", true);
  const f = $("gSignUp");
  busy(f, true); say("gNewMsg", "Creating your account…");
  try {
    const l = await invoke<Licence | null>("auth_sign_up", { email, password, fullName });
    ($("gNewPass") as HTMLInputElement).value = "";
    if (l) return apply(l);
    ($("gEmail") as HTMLInputElement).value = email.trim();
    view("gSignIn");
    say("gMsg", "Account created. Open the link we e-mailed you to confirm it, then sign in here.");
  } catch (e) { say("gNewMsg", String(e), true); } finally { busy(f, false); }
});

$("gToNew").addEventListener("click", () => { say("gNewMsg", ""); ($("gNewEmail") as HTMLInputElement).value = ($("gEmail") as HTMLInputElement).value; view("gSignUp"); });
$("gToSignIn").addEventListener("click", () => view("gSignIn"));
const buy = () => invoke("open_external", { url: BUY_URL }).catch(() => window.open(BUY_URL, "_blank", "noopener"));
$("gBuy").addEventListener("click", buy);
$("acctBuy").addEventListener("click", buy);
$("gRetry").addEventListener("click", async () => {
  const b = $("gRetry") as HTMLButtonElement;
  b.disabled = true; b.textContent = "Checking…";
  await check();
  b.disabled = false; b.textContent = "Check again";
});

async function signOut() {
  await invoke("auth_sign_out").catch(() => null);
  ($("settings") as HTMLDialogElement).close();
  apply({ configured: true, signed_in: false, ok: false, state: "signed_out", email: "", plan: "", days_left: null, message: "You're signed out.", offline: false });
}
$("gOut").addEventListener("click", signOut);
$("signOutBtn").addEventListener("click", signOut);

// A refused call (signed out elsewhere, trial ended, seat lost): check and show why.
licenceEvents.addEventListener("refused", () => { if (current?.ok) void check(); });

/** Resolves once the person is signed in with a trial or seat; keeps checking every 5 minutes after that. */
export function signedIn(): Promise<void> {
  if (!beat) beat = window.setInterval(() => void check(), 5 * 60_000);
  return new Promise((res) => {
    onReady = res;
    void check();
  });
}
