// IFC import for the design check: storeys, footprint per storey (plan projection of walls, floor slabs and columns),
// overall height, spaces (GFA, car parking, private open space). Uses web-ifc; geometry comes back in metres
// (web-ifc applies the file's IfcSIUnit / conversion factor), plan = IFC X/Y, height = IFC Z.
import * as W from "web-ifc";
import { union, polyArea, bboxCentre, type DesignModel, type Poly, type Storey, type XY } from "./design";

const FOOT = new Set([W.IFCWALL, W.IFCWALLSTANDARDCASE, W.IFCCURTAINWALL, W.IFCSLAB, W.IFCCOLUMN]);
const r3 = (v: number) => Math.round(v * 1000) / 1000;
let shared: W.IfcAPI | null = null;
/** One web-ifc instance for the app, loaded from the bundled wasm (works offline). */
export async function ifcApi(wasmUrl: string): Promise<W.IfcAPI> {
  if (!shared) { const a = new W.IfcAPI(); await a.Init(() => wasmUrl, true); shared = a; }
  return shared;
}

/** File length unit as text (e.g. "mm", "m"), from IfcSIUnit; "" if not found. */
function lengthUnit(api: W.IfcAPI, id: number): string {
  const ids = api.GetLineIDsWithType(id, W.IFCSIUNIT);
  for (let i = 0; i < ids.size(); i++) {
    const u = api.GetLine(id, ids.get(i));
    if (u.UnitType?.value !== "LENGTHUNIT") continue;
    const pre: Record<string, string> = { MILLI: "mm", CENTI: "cm", DECI: "dm", KILO: "km" };
    return pre[u.Prefix?.value ?? ""] ?? "m";
  }
  return api.GetLineIDsWithType(id, W.IFCCONVERSIONBASEDUNIT).size() ? "imperial" : "";
}

export function parseIfc(api: W.IfcAPI, bytes: Uint8Array, name: string): DesignModel & { unit: string } {
  const id = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });
  try {
    const unit = lengthUnit(api, id);
    const vec = (t: number) => { const v = api.GetLineIDsWithType(id, t); return Array.from({ length: v.size() }, (_, i) => v.get(i)); };
    const storeyIds = vec(W.IFCBUILDINGSTOREY);
    const storeyName = new Map(storeyIds.map((s) => [s, String(api.GetLine(id, s).Name?.value ?? `Level ${s}`)]));
    const owner = new Map<number, number>(); // element -> storey
    for (const r of vec(W.IFCRELCONTAINEDINSPATIALSTRUCTURE)) {
      const l = api.GetLine(id, r);
      if (storeyName.has(l.RelatingStructure?.value)) for (const e of l.RelatedElements ?? []) owner.set(e.value, l.RelatingStructure.value);
    }
    for (const r of vec(W.IFCRELAGGREGATES)) {
      const l = api.GetLine(id, r);
      if (storeyName.has(l.RelatingObject?.value)) for (const e of l.RelatedObjects ?? []) owner.set(e.value, l.RelatingObject.value);
    }
    const roofSlab = new Set(vec(W.IFCSLAB).filter((s) => api.GetLine(id, s).PredefinedType?.value === "ROOF"));
    const spaceText = new Map(vec(W.IFCSPACE).map((s) => { const l = api.GetLine(id, s); return [s, [l.Name?.value, l.LongName?.value, l.ObjectType?.value].filter(Boolean).join(" ")]; }));
    type El = { type: number; minY: number; maxY: number; tris: Poly[] };
    const els = new Map<number, El>();
    let top = -Infinity;
    const onMesh = (mesh: W.FlatMesh) => {
      const eid = mesh.expressID, type = api.GetLineType(id, eid);
      if (type === W.IFCSITE || type === W.IFCOPENINGELEMENT) return;
      const el: El = els.get(eid) ?? { type, minY: Infinity, maxY: -Infinity, tris: [] };
      els.set(eid, el);
      const plan = (FOOT.has(type) && !roofSlab.has(eid)) || type === W.IFCSPACE;
      const all: Poly[] = [];
      for (let gi = 0; gi < mesh.geometries.size(); gi++) {
        const pg = mesh.geometries.get(gi);
        const g = api.GetGeometry(id, pg.geometryExpressID);
        const v = api.GetVertexArray(g.GetVertexData(), g.GetVertexDataSize());
        const ix = api.GetIndexArray(g.GetIndexData(), g.GetIndexDataSize());
        const m = pg.flatTransformation;
        const n = v.length / 6, P = new Float64Array(n * 3), Ny = new Float64Array(n);
        for (let k = 0; k < n; k++) {
          const [x, y, z] = [v[k * 6], v[k * 6 + 1], v[k * 6 + 2]];
          P[k * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
          P[k * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
          P[k * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
          Ny[k] = m[1] * v[k * 6 + 3] + m[5] * v[k * 6 + 4] + m[9] * v[k * 6 + 5];
          el.minY = Math.min(el.minY, P[k * 3 + 1]); el.maxY = Math.max(el.maxY, P[k * 3 + 1]);
        }
        g.delete();
        if (!plan) continue;
        for (let t = 0; t + 2 < ix.length; t += 3) {
          const q = [ix[t], ix[t + 1], ix[t + 2]];
          const tri = q.map((k) => [r3(P[k * 3]), r3(-P[k * 3 + 2])] as XY); // web-ifc is Y-up: plan (x, -z) = IFC (x, y)
          const a2 = (tri[1][0] - tri[0][0]) * (tri[2][1] - tri[0][1]) - (tri[2][0] - tri[0][0]) * (tri[1][1] - tri[0][1]);
          if (Math.abs(a2) < 2e-4) continue; // vertical faces
          const p: Poly = [a2 > 0 ? tri : tri.reverse()];
          all.push(p);
          if (Ny[q[0]] + Ny[q[1]] + Ny[q[2]] > 0.03) el.tris.push(p); // upward faces cover the plan of a closed solid
        }
      }
      if (plan && !el.tris.length) el.tris.push(...all);
      if (type !== W.IFCSPACE) top = Math.max(top, el.maxY);
    };
    api.StreamAllMeshes(id, onMesh);
    if (spaceText.size) api.StreamAllMeshesWithTypes(id, [W.IFCSPACE], onMesh); // web-ifc leaves spaces out of StreamAllMeshes
    // Storeys: the walls / floor slabs / columns they contain (by relationship, else by level).
    const levels = storeyIds.map((s) => ({ s, els: [...els.entries()].filter(([e, x]) => owner.get(e) === s && x.tris.length) }));
    const real = levels.filter((l) => l.els.some(([, x]) => FOOT.has(x.type)) || l.els.some(([, x]) => x.type === W.IFCSPACE));
    const structOf = (list: [number, El][]) => { const s = list.filter(([, x]) => FOOT.has(x.type)); return s.length ? s : list; };
    const baseOf = (l: (typeof real)[number]) => Math.min(...structOf(l.els).map(([, x]) => x.minY));
    const loose = [...els.entries()].filter(([e, x]) => !owner.has(e) && x.tris.length && x.type !== W.IFCSPACE && FOOT.has(x.type));
    if (!real.length && loose.length) real.push({ s: -1, els: loose }); // no storeys in the file: one level
    else for (const [e, x] of loose) { // unassigned elements go to the highest storey at or below them
      const l = real.filter((q) => baseOf(q) <= x.minY + 0.05).sort((p, q) => baseOf(q) - baseOf(p))[0] ?? real[0];
      l?.els.push([e, x]);
    }
    real.sort((p, q) => baseOf(p) - baseOf(q));
    if (!real.length) throw new Error("No walls, floor slabs or spaces found in this IFC file.");
    const ground = baseOf(real[0]);
    const unite = (list: [number, El][]) => union(list.flatMap(([, x]) => { try { return union(x.tris); } catch { return []; } }));
    const storeys: Storey[] = real.map((l, i) => {
      const use = structOf(l.els);
      const walls = l.els.filter(([, x]) => x.type === W.IFCWALL || x.type === W.IFCWALLSTANDARDCASE || x.type === W.IFCCURTAINWALL);
      return { name: l.s >= 0 ? storeyName.get(l.s)! : `Level ${i + 1}`, base: r3(baseOf(l) - ground), top: r3(Math.max(...(walls.length ? walls : use).map(([, x]) => x.maxY)) - ground), polys: unite(use) };
    }).filter((s) => s.polys.length);
    // Spaces: GFA (garage/parking and private open space left out), car spaces, private open space
    const spaces = [...els.entries()].filter(([, x]) => x.type === W.IFCSPACE && x.tris.length).map(([e, x]) => ({ text: spaceText.get(e) ?? "", polys: unite([[e, x]]) }));
    const isCar = (t: string) => /car|garage|parking/i.test(t), isPos = (t: string) => /private open space|\bPOS\b/i.test(t);
    const area = (ps: Poly[]) => ps.reduce((t, p) => t + polyArea(p), 0);
    const cars = spaces.filter((s) => isCar(s.text));
    const pos = spaces.filter((s) => isPos(s.text));
    const living = spaces.filter((s) => !isCar(s.text) && !isPos(s.text));
    const gfa = living.length ? area(living.flatMap((s) => s.polys)) : storeys.reduce((t, s) => t + area(s.polys), 0);
    return {
      name, unit, storeys, height: r3(top - ground),
      gfa: Math.round(gfa * 10) / 10, gfaFrom: living.length ? "from spaces, garage excluded" : "from floor outlines",
      cars: cars.length ? cars.reduce((t, s) => t + Math.max(1, Math.floor(area(s.polys) / 15)), 0) : null,
      carPolys: cars.flatMap((s) => s.polys),
      pos: pos.length ? Math.round(area(pos.flatMap((s) => s.polys)) * 10) / 10 : null,
      centre: bboxCentre(storeys.flatMap((s) => s.polys)),
    };
  } finally {
    api.CloseModel(id);
  }
}
