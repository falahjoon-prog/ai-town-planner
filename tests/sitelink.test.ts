// Run: npm test  (bundles with esbuild, runs on node). Covers the lot/plan formatter and the resolve flow with mocked lookups.
import assert from "node:assert/strict";
import { loganLotPlan, resolverFor, resolveLotUrl, destLabel, deviUrl, loganPropertyKey } from "../src/sitelink";

for (const [lp, want] of [["9RP148066", "Lot 9 RP 148066"], ["12SP123456", "Lot 12 SP 123456"], ["101CP901234", "Lot 101 CP 901234"], ["1BUP1234", "Lot 1 BUP 1234"], ["9rp148066", "Lot 9 RP 148066"], [" 9 RP 148066 ", "Lot 9 RP 148066"]] as const)
  assert.equal(loganLotPlan(lp), want, lp);
for (const bad of ["", "RP148066", "9RP", "9/RP148066", "SP123"]) assert.equal(loganLotPlan(bad), null, bad);

assert.equal(resolverFor("https://developmenti.brisbane.qld.gov.au/"), "devi");
assert.equal(resolverFor("https://developmenti.evil.com/"), null);
assert.equal(resolverFor("https://www.logan.qld.gov.au/planning-and-development/pd-hub"), "logan");
assert.equal(resolverFor("https://ipswich.isoplan.com.au/eplan"), null);
assert.equal(deviUrl("h.x", "10881172"), "https://h.x/Home/FilterDirect?filters=LandNumber=10881172");
assert.equal(destLabel("DA", { url: "https://www.logan.qld.gov.au/x", copy: "address" }, true), "DA (opens at this lot)");
assert.equal(destLabel("DA", { url: "https://www.logan.qld.gov.au/x", copy: "address" }, false), "DA");
assert.equal(destLabel("DA", { url: "https://www.moretonbay.qld.gov.au/x", copy: "address" }, true), "DA (copies address)");

const site = { lotplan: "32RP850593", address: "28 Eden Elm Street, Calamvale QLD 4116", lng: 0, lat: 0 };
const calls: string[] = [];
const devi = (m: Record<string, string | null>) => async (h: string, t: string) => { calls.push(`${h}|${t}`); return m[t] ?? null; };
const d = (h: string) => ({ url: `https://${h}/` });

(async () => {
  assert.equal(await resolveLotUrl(d("developmenti.brisbane.qld.gov.au"), site, { devi: devi({ "32RP850593": "10881172" }) }), "https://developmenti.brisbane.qld.gov.au/Home/FilterDirect?filters=LandNumber=10881172");
  calls.length = 0; // lot/plan empty -> retry with address
  assert.equal(await resolveLotUrl(d("developmenti.redland.qld.gov.au"), site, { devi: devi({ [site.address]: "111168" }) }), "https://developmenti.redland.qld.gov.au/Home/FilterDirect?filters=LandNumber=111168");
  assert.deepEqual(calls, ["developmenti.redland.qld.gov.au|32RP850593", `developmenti.redland.qld.gov.au|${site.address}`]);
  assert.equal(await resolveLotUrl(d("developmenti.ipswich.qld.gov.au"), site, { devi: devi({ "32RP850593": "92879" }) }), "https://developmenti.ipswich.qld.gov.au/Home/FilterDirect?filters=LandNumber=92879");
  assert.equal(await resolveLotUrl(d("developmenti.ipswich.qld.gov.au"), site, { devi: devi({}) }), null);
  assert.equal(await resolveLotUrl(d("developmenti.ipswich.qld.gov.au"), site, { devi: async () => { throw new Error("offline"); } }), null);

  let sent = "";
  const arc = (features: unknown[]) => (async (u: string) => { sent = decodeURIComponent(String(u)); return { json: async () => ({ features }) }; }) as unknown as typeof fetch;
  const logan = { lotplan: "9RP148066", address: "6 Gable Street, Rochedale South", lng: 0, lat: 0 };
  const dl = { url: "https://www.logan.qld.gov.au/planning-and-development/pd-hub" };
  assert.equal(await resolveLotUrl(dl, logan, { devi: devi({}), fetchFn: arc([{ attributes: { Property_Key: 111, Address_Type: "X" } }, { attributes: { Property_Key: 220766, Address_Type: "P" } }]) }), "https://pdhub.logan.qld.gov.au/property-report/?propertyKey=220766");
  assert.ok(sent.includes("where=Formatted_Lot_Plan='Lot 9 RP 148066'"), sent);
  assert.equal(await loganPropertyKey("9RP148066", arc([{ attributes: { Property_Key: 5, Address_Type: "X" } }])), "5");
  assert.equal(await loganPropertyKey("9RP148066", arc([])), null);
  assert.equal(await resolveLotUrl(dl, { ...logan, lotplan: "bad" }, { devi: devi({}), fetchFn: arc([]) }), null);
  assert.equal(await resolveLotUrl(dl, logan, { devi: devi({}), fetchFn: (async () => { throw new Error("offline"); }) as unknown as typeof fetch }), null);
  console.log("sitelink tests passed");
})();
