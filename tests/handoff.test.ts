// Run: npm test. The DesignAI site hand-off: built only from the given fields, limits read the same way as the design check.
import assert from "node:assert/strict";
import SETBACKS from "../src-tauri/knowledge/setbacks.json";
import { buildHandoff, handoffName, HANDOFF_FORMAT } from "../src/handoff";

const item = (label: string, value: string) => ({ label, value, source: "test source v1", url: "https://example.test", verify: false });
const set = (SETBACKS as any)["Low density residential zone"];
const h = buildHandoff({
  createdAt: "2026-11-11T01:02:03.000Z", scheme: "Brisbane City Plan 2014", councilId: "brisbane",
  parcel: { lotplan: "1RP12345", address: "1 Test St", suburb: "Testville", council: "Brisbane", area_m2: 600 },
  frontageM: 15, depthM: 40, origin: [153.01, -27.47],
  ring: [[-7.5, -20], [7.5, -20], [7.5, 20], [-7.5, 20]],
  edges: [{ a: [-7.5, -20], b: [7.5, -20], kind: "front" }, { a: [7.5, -20], b: [7.5, 20], kind: "side" }, { a: [7.5, 20], b: [-7.5, 20], kind: "rear" }, { a: [-7.5, 20], b: [-7.5, -20], kind: "side" }],
  edgesWhy: "", zones: [{ name: "Low density residential zone", precinct: null, authority: "council", source: "City Plan", url: "", verify: false }],
  setbacks: set ? { title: set.title, source: set.source, rows: set.rows } : null, setbacksWhy: "none",
  items: [item("Building height", "9.5 m and 2 storeys (over 9.5 m = code assessment)"), item("Site cover", "50%"), item("Plot ratio", "Where applicable, outside the zone")],
  overlays: [{ title: "Flood", authority: "Council", distance_m: 0, coverage_pct: 30, polys: [[[[0, 0], [5, 0], [5, 5], [0, 5]]]], lines: [] }],
});
assert.equal(h.format, HANDOFF_FORMAT);
assert.equal(h.version, 1);
assert.deepEqual(h.lot.ring[0], [-7.5, -20]);
assert.equal(h.lot.edges![0].kind, "front");
assert.equal(h.lot.edges![0].lengthM, 15);
assert.equal(h.limits.height!.value, 9.5);
assert.equal(h.limits.height!.unit, "m");
assert.equal(h.limits.siteCover!.value, 50);
assert.equal(h.limits.siteCover!.source, "test source v1");
assert.equal(h.limits.storeys!.value, 2); // same reading as the design check (the height row)
assert.equal(h.limits.parking, null);
assert.equal(h.limits.plotRatio!.value, null); // conditional text is passed on as text, no number
assert.ok(h.limits.plotRatio!.text);
assert.equal(h.items.length, 3);
assert.equal(h.overlays[0].polys[0][0].length, 4);
assert.equal(h.frame.origin.lat, -27.47);
assert.equal(h.setbacks?.rows.length, set.rows.length);
const noEdges = buildHandoff({ ...({} as any), createdAt: "2026-01-01T00:00:00Z", scheme: "s", councilId: "c", parcel: { lotplan: "x", address: "", suburb: "", council: null, area_m2: null }, frontageM: null, depthM: null, origin: [0, 0], ring: [], edges: null, edgesWhy: "Lot measurements aren't loaded yet.", zones: [], setbacks: null, setbacksWhy: "n", items: [], overlays: [] });
assert.equal(noEdges.lot.edges, null);
assert.equal(noEdges.lot.edgesNote, "Lot measurements aren't loaded yet.");
assert.equal(noEdges.limits.height, null);
assert.equal(handoffName("1/RP 12345", "2026-11-11T01:02:03Z"), "site_1-RP-12345_2026-11-11.json");
console.log("handoff tests passed");
