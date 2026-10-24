// Deep links to external sites for the current lot. Only formats with evidence are templated (see handoffs/deeplinks.md);
// everything else copies the address or lot/plan to the clipboard and opens the most specific search page.
export type CopyKind = "address" | "short" | "lotplan" | "suburb";
/** A destination: `url` is the page to open; `site_url` (a template with {lng} {lat} {address} {lotplan}) replaces it when a lot is open. */
export type Dest = { url: string; site_url?: string; copy?: CopyKind; field?: string };
export type SiteRef = { lotplan: string; address: string; suburb?: string; lng: number; lat: number };
export type SiteLink = { url: string; copyText: string; toast: string };

const STREET_TYPES = new Set("road rd street st avenue ave drive dr court ct place pl lane ln crescent cres terrace tce parade pde way close cl boulevard bvd circuit cct highway hwy esplanade esp grove gr".split(" "));

/** "10 Fenton Road, Yeronga" -> "10 Fenton" (Development.i advises house number and street name only). */
export function shortAddress(address: string): string {
  const first = (address.split(",")[0] ?? "").trim().replace(/^(unit|apt|apartment)\s+\S+\s*\/?/i, "").replace(/^\d+\s*\/\s*/, "");
  const w = first.split(/\s+/).filter(Boolean);
  if (w.length >= 3 && STREET_TYPES.has(w[w.length - 1].toLowerCase())) w.pop();
  return w.join(" ");
}

const COPY_WHAT: Record<CopyKind, string> = { address: "Address", short: "Address", lotplan: "Lot/plan", suburb: "Suburb" };

export function copyTextFor(kind: CopyKind, s: SiteRef): string {
  return kind === "lotplan" ? s.lotplan : kind === "suburb" ? s.suburb || s.address : kind === "short" ? shortAddress(s.address || s.lotplan) : s.address || s.lotplan;
}

/** Build the URL to open for a destination and the text to copy (empty when a deep link needs no paste). */
export function siteLink(d: Dest, s: SiteRef | null): SiteLink {
  if (!s) return { url: d.url, copyText: "", toast: "" };
  if (d.site_url) {
    const url = d.site_url
      .replaceAll("{lng}", s.lng.toFixed(6)).replaceAll("{lat}", s.lat.toFixed(6))
      .replaceAll("{address}", encodeURIComponent(s.address || s.lotplan)).replaceAll("{lotplan}", encodeURIComponent(s.lotplan));
    return { url, copyText: "", toast: "" };
  }
  if (!d.copy) return { url: d.url, copyText: "", toast: "" };
  const copyText = copyTextFor(d.copy, s);
  return { url: d.url, copyText, toast: `${COPY_WHAT[d.copy]} copied – paste it into ${d.field ?? "the search box"}` };
}

// ---- Verified lot-level links that need a lookup first (see handoffs/deeplinks.md) ----
export const DEVI_HOSTS = ["developmenti.brisbane.qld.gov.au", "developmenti.redland.qld.gov.au", "developmenti.ipswich.qld.gov.au"];
const LOGAN_HOST = "www.logan.qld.gov.au";
const LOGAN_REPORT = "https://pdhub.logan.qld.gov.au/property-report/?propertyKey=";
const LOGAN_LAYER = "https://services5.arcgis.com/ZUCWDRj8F77Xo351/ArcGIS/rest/services/Property_Report_LPS2015/FeatureServer/0/query";

/** Which lookup a destination page needs, from its host: Development.i registers or the Logan PD Hub. */
export function resolverFor(url: string): "devi" | "logan" | null {
  let h = "";
  try { h = new URL(url).hostname; } catch { return null; }
  return DEVI_HOSTS.includes(h) ? "devi" : h === LOGAN_HOST ? "logan" : null;
}

/** "9RP148066" -> "Lot 9 RP 148066" (Logan's Formatted_Lot_Plan); null when the lot/plan does not have that shape. */
export function loganLotPlan(lotplan: string): string | null {
  const m = /^(\d+)([A-Za-z]+)(\d+)$/.exec(lotplan.replace(/\s+/g, ""));
  return m ? `Lot ${m[1]} ${m[2].toUpperCase()} ${m[3]}` : null;
}

export const deviUrl = (host: string, landNumber: string) => `https://${host}/Home/FilterDirect?filters=LandNumber=${encodeURIComponent(landNumber)}`;

type LoganRow = { Property_Key?: string | number | null; Address_Type?: string | null };
/** Logan Property_Key for a lot/plan from the council ArcGIS layer (CORS-enabled); prefers Address_Type 'P'. */
export async function loganPropertyKey(lotplan: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const lp = loganLotPlan(lotplan);
  if (!lp) return null;
  const j = await (await fetchFn(`${LOGAN_LAYER}?f=json&returnGeometry=false&outFields=Property_Key,Formatted_Lot_Plan,Formatted_Address,Address_Type&where=${encodeURIComponent(`Formatted_Lot_Plan='${lp}'`)}`)).json();
  const rows: LoganRow[] = (j?.features ?? []).map((f: { attributes?: LoganRow }) => f.attributes ?? {}).filter((a: LoganRow) => a.Property_Key != null && a.Property_Key !== "");
  const row = rows.find((a) => a.Address_Type === "P") ?? rows[0];
  return row ? String(row.Property_Key) : null;
}

/** Lookups for `resolveLotUrl`; `devi` is the Rust command `devi_land_number` (the register has no CORS). */
export type Lookups = { devi: (host: string, term: string) => Promise<string | null>; fetchFn?: typeof fetch };
/** The page for this exact lot, or null when the lookup fails (caller falls back to copy + open). */
export async function resolveLotUrl(d: Dest, s: SiteRef, look: Lookups): Promise<string | null> {
  try {
    const r = resolverFor(d.url);
    if (r === "devi") {
      const host = new URL(d.url).hostname;
      let id = s.lotplan ? await look.devi(host, s.lotplan) : null;
      for (const t of s.address ? [s.address, shortAddress(s.address)] : []) if (!id && t) id = await look.devi(host, t);
      return id ? deviUrl(host, id) : null;
    }
    if (r === "logan") {
      const key = await loganPropertyKey(s.lotplan, look.fetchFn);
      return key ? LOGAN_REPORT + encodeURIComponent(key) : null;
    }
  } catch { /* offline or blocked: fall back */ }
  return null;
}

/** Honest button label: says when the lot is copied for pasting. */
export function destLabel(base: string, d: Dest, hasSite: boolean): string {
  if (!hasSite) return base;
  if (d.site_url || resolverFor(d.url)) return `${base} (opens at this lot)`;
  return d.copy ? `${base} (copies ${COPY_WHAT[d.copy].toLowerCase()})` : base;
}
