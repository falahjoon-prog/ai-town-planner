// Design check: pure plan geometry and rule checks (no DOM, no map). All coordinates are metres in plan.
// Limits come only from the knowledge rows passed in (setbacks.json / council_rules.json / provisions / uses); anything not encoded is "Cannot check".
import polygonClipping from "polygon-clipping";

export type XY = [number, number];
export type Ring = XY[]; // open ring (first point not repeated)
export type Poly = Ring[]; // outer ring, then holes
/** A storey: footprint polygons, base and top of its elements in metres above the lowest floor. */
export type Storey = { name: string; base: number; top: number; polys: Poly[] };
/** What the import keeps (design coordinates); saved with the site instead of the IFC file. */
export type DesignModel = {
  name: string; storeys: Storey[]; height: number;
  gfa: number | null; gfaFrom: string; cars: number | null; carPolys: Poly[]; pos: number | null;
  centre: XY;
};
/** Placement in the lot frame: metres east/north of the lot centre, rotation in degrees (counter-clockwise). */
export type Place = { x: number; y: number; rot: number };
export type Item = { label: string; value: string; source: string; url: string; verify: boolean };
export type SetRows = { title: string; source: string; rows: { label: string; value: string; ref: string }[] };
export type Kind = "front" | "side" | "rear";
export type LotEdge = { a: XY; b: XY; kind: Kind };
export type Result = "Pass" | "Fail" | "Cannot check" | "Verify";
export type Row = { rule: string; design: string; limit: string; result: Result; source: string; url: string; verify: boolean };
export type Mark = { a: XY; b: XY; d: number; fail: boolean };
export type CheckInput = {
  storeys: Storey[]; carPolys: Poly[]; height: number; gfa: number | null; gfaFrom: string; cars: number | null; pos: number | null;
  lotRing: Ring; lotArea: number; edges: LotEdge[] | null; edgesWhy: string; depth: number | null;
  setbacks: SetRows | null; setbacksWhy: string; items: Item[];
  overlays: { title: string; polys: Poly[]; lines: XY[][] }[];
};
export type CheckOut = { rows: Row[]; marks: Mark[]; coverFail: boolean; heightFail: boolean; cover: number };

// ---- geometry ----
export const ringArea = (r: Ring) => r.reduce((t, c, i) => t + c[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * c[1], 0) / 2;
export const polyArea = (p: Poly) => Math.abs(ringArea(p[0])) - p.slice(1).reduce((t, h) => t + Math.abs(ringArea(h)), 0);
const open = (r: XY[]): Ring => (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r);
/** Drop vertices that sit on a straight line between their neighbours. */
export function simplify(r: Ring, tol = 0.005): Ring {
  let out = r.slice();
  for (let changed = true; changed && out.length > 3; ) {
    changed = false;
    for (let i = 0; i < out.length && out.length > 3; i++) {
      const [a, b, c] = [out[(i + out.length - 1) % out.length], out[i], out[(i + 1) % out.length]];
      const l = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (l < 1e-9 || Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / l < tol) { out.splice(i, 1); changed = true; i--; }
    }
  }
  return out;
}
/** Union of polygons (overlaps counted once). */
export function union(polys: Poly[]): Poly[] {
  if (!polys.length) return [];
  const [first, ...rest] = polys as any[];
  const mp = polygonClipping.union(first, ...rest) as XY[][][];
  return mp.map((p) => p.map((r) => simplify(open(r)))).filter((p) => p[0].length >= 3 && polyArea(p) > 1e-4);
}
export const unionArea = (polys: Poly[]) => union(polys).reduce((t, p) => t + polyArea(p), 0);
export function intersectArea(a: Poly[], b: Poly[]): number {
  if (!a.length || !b.length) return 0;
  const mp = polygonClipping.intersection(a as any, b as any) as XY[][][];
  return mp.reduce((t, p) => t + polyArea(p.map(open)), 0);
}
export function pointInRing(p: XY, r: Ring): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function closestOnSeg(p: XY, a: XY, b: XY): XY {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return [a[0] + t * dx, a[1] + t * dy];
}
const cross = (o: XY, a: XY, b: XY) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
/** Shortest distance between segments ab and cd, with the closest points (p on ab, q on cd). */
export function segSeg(a: XY, b: XY, c: XY, d: XY): { d: number; p: XY; q: XY } {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    const t = d1 / (d1 - d2), x: XY = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    return { d: 0, p: x, q: x };
  }
  const cands: { d: number; p: XY; q: XY }[] = [];
  for (const [p, s0, s1, first] of [[a, c, d, true], [b, c, d, true], [c, a, b, false], [d, a, b, false]] as [XY, XY, XY, boolean][]) {
    const k = closestOnSeg(p, s0, s1);
    cands.push(first ? { d: Math.hypot(p[0] - k[0], p[1] - k[1]), p, q: k } : { d: Math.hypot(p[0] - k[0], p[1] - k[1]), p: k, q: p });
  }
  return cands.reduce((x, y) => (y.d < x.d ? y : x));
}
/** Distance from footprint polygons to a lot edge (segment). Negative when the footprint pokes out past that edge. */
export function edgeDistance(polys: Poly[], a: XY, b: XY, lot: Ring): { d: number; p: XY; q: XY } {
  let best = { d: Infinity, p: a, q: a };
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const inward: XY = pointInRing([(a[0] + b[0]) / 2 - (b[1] - a[1]) / len * 0.01, (a[1] + b[1]) / 2 + (b[0] - a[0]) / len * 0.01], lot) ? [-(b[1] - a[1]) / len, (b[0] - a[0]) / len] : [(b[1] - a[1]) / len, -(b[0] - a[0]) / len];
  for (const p of polys) for (const r of p) for (let i = 0; i < r.length; i++) {
    const s = segSeg(r[i], r[(i + 1) % r.length], a, b);
    if (s.d < best.d) best = s;
    const v = r[i], t = ((v[0] - a[0]) * (b[0] - a[0]) + (v[1] - a[1]) * (b[1] - a[1])) / (len * len);
    const sd = (v[0] - a[0]) * inward[0] + (v[1] - a[1]) * inward[1];
    if (sd < 0 && t >= 0 && t <= 1 && !pointInRing(v, lot) && sd < best.d) best = { d: sd, p: v, q: closestOnSeg(v, a, b) };
  }
  return best;
}
/** Design coordinates to lot-frame metres: rotate about the design centre, then move to the placement. */
export function placeFn(centre: XY, pl: Place): (p: XY) => XY {
  const r = (pl.rot * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return (p) => { const x = p[0] - centre[0], y = p[1] - centre[1]; return [x * c - y * s + pl.x, x * s + y * c + pl.y]; };
}
export const placePolys = (polys: Poly[], f: (p: XY) => XY): Poly[] => polys.map((p) => p.map((r) => r.map(f)));
/** Rotation that puts the design's +Y axis along the lot's inward normal of the front edge (plan bottom = street). */
export function frontRotation(a: XY, b: XY, lot: Ring): number {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let n: XY = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
  if (!pointInRing([(a[0] + b[0]) / 2 + n[0] * 0.01, (a[1] + b[1]) / 2 + n[1] * 0.01], lot)) n = [-n[0], -n[1]];
  return (Math.atan2(-n[0], n[1]) * 180) / Math.PI;
}
export function bboxCentre(polys: Poly[]): XY {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of polys) for (const [x, y] of p[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return isFinite(x0) ? [(x0 + x1) / 2, (y0 + y1) / 2] : [0, 0];
}
export function ringCentroid(r: Ring): XY {
  const A = ringArea(r);
  if (Math.abs(A) < 1e-9) return bboxCentre([[r]]);
  let cx = 0, cy = 0;
  r.forEach((p, i) => { const q = r[(i + 1) % r.length], f = p[0] * q[1] - q[0] * p[1]; cx += (p[0] + q[0]) * f; cy += (p[1] + q[1]) * f; });
  return [cx / (6 * A), cy / (6 * A)];
}

// ---- limits from knowledge rows (strict: one clear number, no conditions, else "Cannot check") ----
const COND = /\b(outside|inside|within|where|if|unless|depending|in certain|except|unconfirmed|third[- ]party|between|pre-v\d*)\b|\bfor lots?\b|or as shown/i;
const nums = (s: string, re: RegExp) => [...new Set([...s.matchAll(re)].map((m) => Number(m[1])))];
const M_RE = /(\d+(?:\.\d+)?)\s*(?:m|metres?)(?![²2\w])/gi;
type Lim = { v: number; item: Item } | { text: string; item: Item } | null;
/** First usable number across the rows that match; rows that disagree, or only conditional text, give "text" (cannot check). */
function pick(items: Item[], match: (i: Item) => boolean, read: (i: Item) => number[]): Lim {
  const hits = items.filter(match);
  if (!hits.length) return null;
  const ok = hits.map((i) => ({ i, n: COND.test(i.value.replace(/for all lot sizes/i, "")) || COND.test(i.label) ? [] : read(i) })).filter((x) => x.n.length === 1);
  const vals = [...new Set(ok.map((x) => x.n[0]))];
  return vals.length === 1 ? { v: vals[0], item: ok[0].i } : { text: hits.map((h) => h.value).join(" / "), item: hits[0] };
}
const isHeight = (i: Item) => /height/i.test(i.label) && !/transition|carport|outbuilding|secondary/i.test(i.label);
export const heightLimit = (items: Item[]) => pick(items, isHeight, (i) => nums(i.value, M_RE));
export const storeyLimit = (items: Item[]) => pick(items, (i) => isHeight(i) && /storey/i.test(i.value), (i) => nums(i.value, /(\d+)\s*storeys?/gi));
export const coverLimit = (items: Item[]) => pick(items, (i) => /site cover/i.test(i.label), (i) => nums(i.value, /(\d+(?:\.\d+)?)\s*%/g));
export const plotRatioLimit = (items: Item[]) => pick(items, (i) => /plot ratio/i.test(i.label + " " + i.value), (i) => nums(i.value, /(\d+(?:\.\d+)?)\s*:\s*1\b/g));
export const parkingLimit = (items: Item[]) => pick(items, (i) => /car park/i.test(i.label), (i) => { const m = i.value.match(/^\s*(\d+)\s+(?:car\s+)?spaces?\b/i); return m ? [Number(m[1])] : []; });
export const posLimit = (items: Item[]) => pick(items, (i) => /private open space/i.test(i.label), (i) => nums(i.value, /(\d+(?:\.\d+)?)\s*m(?:²|2)(?!\w)/g));

/** Setback row for an edge kind and wall height (metres above the lowest floor); null when none applies, text when it isn't a plain number. */
export function setbackLimit(set: SetRows, kind: Kind, wallH: number, depth: number | null): { v: number; label: string; ref: string } | { text: string; label: string; ref: string } | null {
  const want = kind === "front" ? /^(front\b|road boundary)/i : kind === "side" ? /^(side\b|side and rear)/i : /^(rear\b|side and rear)/i;
  const rows = set.rows.filter((r) => want.test(r.label) && !/garage|carport|shed|laundry|outbuilding|secondary|eaves/i.test(r.label)).filter((r) => {
    const lo = r.label.match(/wall over (\d+(?:\.\d+)?) m/i), hi = r.label.match(/up to (\d+(?:\.\d+)?) m/i);
    if (lo && !(wallH > Number(lo[1]))) return false;
    if (hi && !(wallH <= Number(hi[1]))) return false;
    const dOver = r.label.match(/lot depth over (\d+(?:\.\d+)?) m/i), dUpTo = r.label.match(/lot depth (\d+(?:\.\d+)?) m or less/i);
    if ((dOver || dUpTo) && depth == null) return false;
    if (dOver && !(depth! > Number(dOver[1]))) return false;
    if (dUpTo && !(depth! <= Number(dUpTo[1]))) return false;
    return true;
  });
  if (!rows.length) return null;
  const plain = rows.map((r) => ({ r, m: r.value.match(/^\s*(\d+(?:\.\d+)?)\s*m\s*$/) })).filter((x) => x.m);
  if (!plain.length) return { text: rows[0].value, label: rows[0].label, ref: rows[0].ref };
  const top = plain.reduce((x, y) => (Number(y.m![1]) > Number(x.m![1]) ? y : x)); // two rows apply: the larger distance
  return { v: Number(top.m![1]), label: top.r.label, ref: top.r.ref };
}

const f1 = (x: number) => (Math.round(x * 10) / 10).toLocaleString("en-AU");
const f2 = (x: number) => x.toFixed(2);
const KIND: Record<Kind, string> = { front: "Front", side: "Side", rear: "Rear" };
const NOT_IN = "Not in the app for this zone";

export function checkDesign(inp: CheckInput): CheckOut {
  const rows: Row[] = [];
  const marks: Mark[] = [];
  const itemRow = (rule: string, design: string, lim: Lim, unit: string, test: (v: number) => boolean | null, fmt = (v: number) => `${v}${unit}`): Row => {
    if (!lim) return { rule, design, limit: NOT_IN, result: "Cannot check", source: "", url: "", verify: false };
    const src = { source: lim.item.source, url: lim.item.url, verify: lim.item.verify };
    if (!("v" in lim)) return { rule, design, limit: lim.text, result: "Cannot check", ...src };
    const ok = test(lim.v);
    return { rule, design, limit: fmt(lim.v), result: ok == null ? "Cannot check" : ok ? "Pass" : "Fail", ...src };
  };
  // Setbacks: every storey against the row for its wall height, per lot edge kind.
  const sb = inp.setbacks;
  if (!sb || !inp.edges) {
    rows.push({ rule: "Setbacks", design: "–", limit: !sb ? inp.setbacksWhy : inp.edgesWhy, result: "Cannot check", source: sb?.title ?? "", url: sb?.source ?? "", verify: !!sb });
  } else {
    const edges = inp.edges;
    const best = new Map<number, Mark & { margin: number }>();
    const levels = inp.storeys.filter((s) => s.polys.length);
    for (const kind of ["front", "side", "rear"] as Kind[]) {
      const ks = edges.map((e, i) => ({ e, i })).filter((x) => x.e.kind === kind);
      if (!ks.length) continue;
      for (const s of levels) {
        const lim = setbackLimit(sb, kind, s.top, inp.depth);
        const ds = ks.map(({ e, i }) => ({ i, ...edgeDistance(s.polys, e.a, e.b, inp.lotRing) }));
        const dmin = ds.reduce((x, y) => (y.d < x.d ? y : x));
        const rule = `${KIND[kind]} setback · ${s.name} (walls to ${f1(s.top)} m)`;
        const design = dmin.d < 0 ? `${f2(dmin.d)} m (outside the lot)` : `${f2(dmin.d)} m`;
        if (!lim) { rows.push({ rule, design, limit: "No row for this wall height", result: "Cannot check", source: sb.title, url: sb.source, verify: true }); continue; }
        const src = `${sb.title}, ${lim.ref}`;
        if (!("v" in lim)) { rows.push({ rule, design, limit: lim.text, result: "Cannot check", source: src, url: sb.source, verify: true }); continue; }
        rows.push({ rule, design, limit: `${lim.v} m`, result: dmin.d >= lim.v - 0.005 ? "Pass" : "Fail", source: src, url: sb.source, verify: true });
        for (const x of ds) {
          const margin = x.d - lim.v, prev = best.get(x.i);
          if (!prev || margin < prev.margin) best.set(x.i, { a: x.p, b: x.q, d: x.d, fail: margin < -0.005, margin });
        }
      }
    }
    if (inp.carPolys.length) {
      const g = sb.rows.find((r) => /^front, garage or carport/i.test(r.label) && /^\s*\d+(\.\d+)?\s*m\s*$/.test(r.value));
      const fronts = edges.filter((e) => e.kind === "front");
      if (g && fronts.length) {
        const v = parseFloat(g.value), d = Math.min(...fronts.map((e) => edgeDistance(inp.carPolys, e.a, e.b, inp.lotRing).d));
        rows.push({ rule: "Front setback · garage or carport", design: `${f2(d)} m`, limit: `${v} m`, result: d >= v - 0.005 ? "Pass" : "Fail", source: `${sb.title}, ${g.ref}`, url: sb.source, verify: true });
      }
    }
    for (const m of best.values()) marks.push({ a: m.a, b: m.b, d: m.d, fail: m.fail });
  }
  // Height and storeys
  const nSt = inp.storeys.filter((s) => s.polys.length).length;
  const hRow = itemRow("Building height", `${f1(inp.height)} m`, heightLimit(inp.items), " m", (v) => inp.height <= v + 0.005);
  const sRow = itemRow("Storeys", String(nSt), storeyLimit(inp.items), "", (v) => nSt <= v, (v) => `${v} storeys`);
  rows.push(hRow, sRow);
  // Site cover: all storeys projected to plan (roof eaves not in the footprint)
  const cover = inp.lotArea > 0 ? (unionArea(inp.storeys.flatMap((s) => s.polys)) / inp.lotArea) * 100 : 0;
  const cRow = itemRow("Site cover", `${f1(cover)} %`, coverLimit(inp.items), " %", (v) => cover <= v + 0.05);
  rows.push(cRow);
  const pr = inp.gfa != null && inp.lotArea > 0 ? inp.gfa / inp.lotArea : null;
  rows.push(itemRow("Plot ratio (GFA ÷ site area)", pr != null ? `${pr.toFixed(2)}:1 (${f1(inp.gfa!)} m² ${inp.gfaFrom})` : "GFA not in the model", plotRatioLimit(inp.items), ":1", (v) => (pr == null ? null : pr <= v + 0.005), (v) => `${v}:1`));
  rows.push(itemRow("Car parking", inp.cars != null ? `${inp.cars} (from garage/parking spaces)` : "No car spaces named in the model", parkingLimit(inp.items), "", (v) => (inp.cars == null ? null : inp.cars >= v), (v) => `${v} spaces`));
  rows.push(itemRow("Private open space", inp.pos != null ? `${f1(inp.pos)} m²` : "No private open space named in the model", posLimit(inp.items), " m²", (v) => (inp.pos == null ? null : inp.pos >= v)));
  // Overlays under the footprint
  const all = inp.storeys.flatMap((s) => s.polys);
  const ground = union(all);
  const hits = inp.overlays.filter((o) => (o.polys.length && intersectArea(ground, o.polys) > 0.01) || o.lines.some((l) => l.some((p) => ground.some((g) => pointInRing(p, g[0]))) || l.some((p, i) => i > 0 && ground.some((g) => g[0].some((q, k) => segSeg(l[i - 1], p, q, g[0][(k + 1) % g[0].length]).d === 0)))));
  for (const o of hits) rows.push({ rule: `Overlay: ${o.title}`, design: "Footprint is on this layer", limit: "Check the overlay code", result: "Verify", source: "Data pack layer", url: "", verify: true });
  if (!hits.length) rows.push({ rule: "Overlays", design: inp.overlays.length ? "No mapped layer under the footprint" : "No mapped layers on this lot", limit: "–", result: "Pass", source: "Data pack layers", url: "", verify: false });
  return { rows, marks, coverFail: cRow.result === "Fail", heightFail: hRow.result === "Fail" || sRow.result === "Fail", cover };
}
