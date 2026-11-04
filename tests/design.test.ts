// Run: npm test. Design check: plan geometry, limits read from knowledge rows, the checks, and the IFC import (tests/fixtures/design_house.ifc).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { IfcAPI } from "web-ifc";
import SETBACKS from "../src-tauri/knowledge/setbacks.json";
import { checkDesign, setbackLimit, heightLimit, storeyLimit, coverLimit, plotRatioLimit, parkingLimit, edgeDistance, unionArea, placeFn, placePolys, frontRotation, type CheckInput, type Item, type Poly, type Storey, type XY } from "../src/design";
import { parseIfc } from "../src/ifc";

const near = (a: number, b: number, msg = "", tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} != ${b}`);
const item = (label: string, value: string): Item => ({ label, value, source: "test source v1", url: "", verify: false });
const set = SETBACKS["Low density residential zone"];

// Setback rows by wall height (Queensland Housing Code rows in setbacks.json)
const lim = (k: "front" | "side" | "rear", h: number) => { const l = setbackLimit(set, k, h, null); return l && "v" in l ? l.v : null; };
assert.equal(lim("front", 3), 5);
assert.equal(lim("side", 3), 1.5);
assert.equal(lim("side", 6), 1.5);
assert.equal(lim("side", 9), 2.5);
assert.equal(lim("rear", 3), 4);
assert.equal(lim("rear", 6), 3);

// Limits: one clear number only; conditional text is "cannot check"
const hv = (v: string) => { const l = heightLimit([item("Height", v)]); return l && "v" in l ? l.v : "text"; };
assert.equal(hv("9.5 m and 2 storeys (over 9.5 m = code assessment)"), 9.5);
assert.equal(hv("Up to 8.5 metres"), 8.5);
assert.equal(hv("Up to 3 storeys and 11.5 m (outside Key Locations)"), "text");
assert.equal(hv("2 storeys / 9.5m (2 storey mix); 3 storeys / 11.5m (3 or 4 storey mix)"), "text");
assert.equal(heightLimit([item("Minimum lot size", "450 m²")]), null);
const sv = storeyLimit([item("Height", "9.5 m and 2 storeys")]);
assert.ok(sv && "v" in sv && sv.v === 2);
const cv = (v: string) => { const l = coverLimit([item("Site cover", v)]); return l && "v" in l ? l.v : "text"; };
assert.equal(cv("60% for all lot sizes"), 60);
assert.equal(cv("55% for lots under 180 m²"), "text");
assert.equal(cv("80%"), 80);
const pr = plotRatioLimit([item("Height / plot ratio, Township (multiple dwelling)", "8.5m (2 storeys); plot ratio 0.3:1; min site 1,000m2")]);
assert.ok(pr && "v" in pr && pr.v === 0.3);
const pk = parkingLimit([item("Car parking (version 7 precincts)", "2 spaces, plus 1 for any secondary dwelling (tandem allowed)")]);
assert.ok(pk && "v" in pk && pk.v === 2);

// Geometry
const rect = (x0: number, y0: number, x1: number, y1: number): Poly => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]];
const lot: XY[] = [[0, 0], [20, 0], [20, 30], [0, 30]]; // 600 m², street along y = 0
near(unionArea([rect(0, 0, 12, 15), rect(6, 0, 18, 15)]), 270, "union area");
near(edgeDistance([rect(4, 7.5, 16, 22.5)], [0, 0], [20, 0], lot).d, 7.5, "front distance");
near(edgeDistance([rect(-1, 7.5, 11, 22.5)], [0, 30], [0, 0], lot).d, -1, "outside the lot is negative");
near(frontRotation([0, 0], [20, 0], lot), 0, "front rotation");
near(Math.abs(frontRotation([20, 0], [20, 30], lot)), 90, "side street rotation");
const tf = placeFn([6, 7.5], { x: 10, y: 15, rot: 90 });
assert.deepEqual(tf([6, 7.5]).map((v) => Math.round(v * 1e6) / 1e6), [10, 15]);
assert.deepEqual(tf([12, 7.5]).map((v) => Math.round(v * 1e6) / 1e6), [10, 21]);

// Whole check: 12 x 15 m, 2 storeys, 6.3 m high, on the 20 x 30 m lot
const house = (x: number): Storey[] => [{ name: "Ground floor", base: 0, top: 3, polys: [rect(x - 6, 7.5, x + 6, 22.5)] }, { name: "First floor", base: 3, top: 6, polys: [rect(x - 6, 7.5, x + 6, 22.5)] }];
const input = (x: number): CheckInput => ({
  storeys: house(x), carPolys: [rect(x - 6, 7.5, x, 13.5)], height: 6.3, gfa: 324, gfaFrom: "from spaces", cars: 2, pos: null,
  lotRing: lot, lotArea: 600, depth: 30, edgesWhy: "",
  edges: [{ a: [0, 0], b: [20, 0], kind: "front" }, { a: [20, 0], b: [20, 30], kind: "side" }, { a: [20, 30], b: [0, 30], kind: "rear" }, { a: [0, 30], b: [0, 0], kind: "side" }],
  setbacks: set, setbacksWhy: "", items: [item("Height", "9.5 m and 2 storeys"), item("Site cover", "50%")],
  overlays: [{ title: "Flood", polys: [rect(0, 25, 20, 30)], lines: [] }, { title: "Sewer", polys: [], lines: [[[0, 5], [20, 5]]] }],
});
const ok = checkDesign(input(10));
const row = (o: typeof ok, r: string) => o.rows.find((x) => x.rule === r)!;
assert.equal(row(ok, "Front setback · Ground floor (walls to 3 m)").design, "7.50 m");
assert.equal(row(ok, "Front setback · Ground floor (walls to 3 m)").result, "Pass");
assert.equal(row(ok, "Side setback · First floor (walls to 6 m)").design, "4.00 m");
assert.equal(row(ok, "Rear setback · Ground floor (walls to 3 m)").limit, "4 m");
assert.equal(row(ok, "Front setback · garage or carport").result, "Pass");
assert.equal(row(ok, "Building height").result, "Pass");
assert.equal(row(ok, "Storeys").result, "Pass");
assert.equal(row(ok, "Site cover").design, "30 %");
assert.equal(row(ok, "Site cover").result, "Pass");
assert.equal(row(ok, "Private open space").result, "Cannot check");
assert.equal(row(ok, "Plot ratio (GFA ÷ site area)").result, "Cannot check");
assert.equal(row(ok, "Overlays").result, "Pass");
assert.ok(ok.marks.length === 4 && ok.marks.every((m) => !m.fail));
assert.ok(!ok.coverFail && !ok.heightFail);
assert.ok(ok.rows.every((r) => r.result === "Cannot check" || r.result === "Pass"), "all pass at the centre");

const bad = checkDesign(input(6.8)); // 0.8 m from the left side
assert.equal(row(bad, "Side setback · Ground floor (walls to 3 m)").design, "0.80 m");
assert.equal(row(bad, "Side setback · Ground floor (walls to 3 m)").result, "Fail");
const fail = bad.marks.filter((m) => m.fail);
assert.equal(fail.length, 1);
near(fail[0].d, 0.8, "fail mark distance");
near(fail[0].a[0], 0.8, "mark starts on the footprint");
near(fail[0].b[0], 0, "mark ends on the boundary");

const tall = checkDesign({ ...input(10), height: 10.2, items: [item("Height", "9.5 m and 2 storeys"), item("Site cover", "25%")] });
assert.equal(row(tall, "Building height").result, "Fail");
assert.equal(row(tall, "Site cover").result, "Fail");
assert.ok(tall.coverFail && tall.heightFail);

const ov = checkDesign({ ...input(10), storeys: [{ name: "Ground floor", base: 0, top: 3, polys: [rect(4, 3, 16, 26)] }] });
assert.ok(ov.rows.some((r) => r.rule === "Overlay: Flood" && r.result === "Verify"));
assert.ok(ov.rows.some((r) => r.rule === "Overlay: Sewer" && r.result === "Verify"));

const none = checkDesign({ ...input(10), setbacks: null, setbacksWhy: "Not in the app", items: [] });
assert.equal(row(none, "Setbacks").result, "Cannot check");
assert.equal(row(none, "Building height").result, "Cannot check");
assert.equal(row(none, "Building height").limit, "Not in the app for this zone");

// IFC import: 2 storeys, millimetre units, 6.3 m to the top of the roof slab, 12 x 15 m footprint
(async () => {
  const api = new IfcAPI();
  await api.Init(undefined, true);
  const d = parseIfc(api, new Uint8Array(readFileSync(`${process.cwd()}/tests/fixtures/design_house.ifc`)), "design_house.ifc");
  assert.equal(d.unit, "mm");
  assert.deepEqual(d.storeys.map((s) => [s.name, s.base, s.top]), [["Ground floor", 0, 3], ["First floor", 3, 6]]);
  near(d.height, 6.3, "height", 1e-3);
  near(unionArea(d.storeys[0].polys), 180, "footprint", 1e-3);
  near(d.gfa!, 324, "GFA without the garage", 0.1);
  assert.equal(d.cars, 2);
  near(unionArea(d.carPolys), 36, "garage area", 1e-3);
  assert.deepEqual(d.centre, [6, 7.5]);
  // placed on the 20 x 30 m lot at its centre: 7.5 m front, 4 m sides
  const t = placeFn(d.centre, { x: 10, y: 15, rot: 0 });
  near(edgeDistance(placePolys(d.storeys[0].polys, t), [0, 0], [20, 0], lot).d, 7.5, "IFC front distance", 1e-3);
  console.log("design tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
