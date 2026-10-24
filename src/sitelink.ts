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

/** Honest button label: says when the lot is copied for pasting. */
export function destLabel(base: string, d: Dest, hasSite: boolean): string {
  if (!hasSite) return base;
  if (d.site_url) return `${base} (opens at this lot)`;
  return d.copy ? `${base} (copies ${COPY_WHAT[d.copy].toLowerCase()})` : base;
}
