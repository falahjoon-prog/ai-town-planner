// "Send to DesignAI": builds the site hand-off file (pure, no DOM). Every value comes from the loaded site;
// a limit that isn't one clear number is passed on as text, and nothing is filled in. Format: handoffs/site_handoff.md
import { heightLimit, storeyLimit, coverLimit, plotRatioLimit, parkingLimit, posLimit, type Item, type Kind, type Poly, type SetRows, type XY } from "./design";

export const HANDOFF_FORMAT = "rhc-site-handoff";
export const HANDOFF_VERSION = 1;
export const HANDOFF_NOTE = "Screening aid only: not certified, not for construction. Verify against the current planning scheme.";

type Lim = { v: number; item: Item } | { text: string; item: Item } | null;
export type HandoffLimit = { value: number | null; unit: string; text: string | null; label: string; rule: string; source: string; url: string; verify: boolean };
export type HandoffInput = {
  createdAt: string; scheme: string; councilId: string;
  parcel: { lotplan: string; address: string; suburb: string; council: string | null; area_m2: number | null };
  frontageM: number | null; depthM: number | null;
  origin: [number, number]; // lon, lat of the metre frame's (0,0)
  ring: XY[]; // open lot ring in metres, x east, y north
  edges: { a: XY; b: XY; kind: Kind }[] | null; edgesWhy: string;
  zones: { name: string; precinct: string | null; authority: string; source: string; url: string; verify: boolean }[];
  setbacks: SetRows | null; setbacksWhy: string;
  items: Item[];
  overlays: { title: string; authority: string; distance_m: number | null; coverage_pct: number | null; polys: Poly[]; lines: XY[][] }[];
};

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const lim = (l: Lim, unit: string, rule: string): HandoffLimit | null =>
  l ? { value: "v" in l ? l.v : null, unit, text: "text" in l ? l.text : null, label: l.item.label, rule: l.item.value, source: l.item.source, url: l.item.url, verify: l.item.verify } : null;

export function buildHandoff(i: HandoffInput) {
  const it = i.items;
  return {
    format: HANDOFF_FORMAT,
    version: HANDOFF_VERSION,
    app: "AI Town Planner",
    createdAt: i.createdAt,
    notice: HANDOFF_NOTE,
    scheme: { name: i.scheme, council: i.councilId },
    site: { lotplan: i.parcel.lotplan, address: i.parcel.address, suburb: i.parcel.suburb, council: i.parcel.council ?? null, areaM2: i.parcel.area_m2, frontageM: i.frontageM, depthM: i.depthM },
    frame: { units: "m", axes: "x east, y north", origin: { lon: i.origin[0], lat: i.origin[1] } },
    lot: {
      ring: i.ring.map((p) => [r3(p[0]), r3(p[1])]),
      edges: i.edges ? i.edges.map((e) => ({ a: [r3(e.a[0]), r3(e.a[1])], b: [r3(e.b[0]), r3(e.b[1])], kind: e.kind, lengthM: r3(Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1])) })) : null,
      edgesNote: i.edges ? "" : i.edgesWhy,
    },
    zones: i.zones,
    setbacks: i.setbacks ? { title: i.setbacks.title, source: i.setbacks.source, rows: i.setbacks.rows } : null,
    setbacksNote: i.setbacks ? "" : i.setbacksWhy,
    limits: {
      height: lim(heightLimit(it), "m", "height"),
      storeys: lim(storeyLimit(it), "storeys", "storeys"),
      siteCover: lim(coverLimit(it), "%", "site cover"),
      plotRatio: lim(plotRatioLimit(it), ":1", "plot ratio"),
      parking: lim(parkingLimit(it), "spaces", "parking"),
      privateOpenSpace: lim(posLimit(it), "m2", "private open space"),
    },
    items: it.map((x) => ({ label: x.label, value: x.value, source: x.source, url: x.url, verify: x.verify })),
    overlays: i.overlays.map((o) => ({ title: o.title, authority: o.authority, distanceM: o.distance_m, coveragePct: o.coverage_pct, polys: o.polys.map((p) => p.map((r) => r.map((q) => [r3(q[0]), r3(q[1])]))), lines: o.lines.map((l) => l.map((q) => [r3(q[0]), r3(q[1])])) })),
  };
}
export type Handoff = ReturnType<typeof buildHandoff>;

/** File name: lotplan and the date, letters, digits and dashes only. */
export const handoffName = (lotplan: string, createdAt: string) => `site_${lotplan.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "lot"}_${createdAt.slice(0, 10)}.json`;
