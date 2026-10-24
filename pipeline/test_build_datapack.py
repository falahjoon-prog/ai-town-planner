"""Offline checks of the council registry pipeline with tiny fixtures (no network).
Run: python3 -m unittest pipeline/test_build_datapack.py
"""
import json
import os
import sqlite3
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_datapack as b  # noqa: E402

ROOT = "https://example.test/server/rest/services/Hub"
SQ = [[153.0, -27.0], [153.001, -27.0], [153.001, -27.001], [153.0, -27.001], [153.0, -27.0]]
SQ2 = [[153.001, -27.0], [153.002, -27.0], [153.002, -27.001], [153.001, -27.001], [153.001, -27.0]]


def poly(c):
    return {"type": "Polygon", "coordinates": [c]}


FIX = {
    ROOT: {"services": [{"name": "Hub/Plan_v9_1_20241030", "type": "MapServer"}, {"name": "Hub/Plan_v9_2_20250527", "type": "MapServer"},
                        {"name": "Hub/Plan_v9_2_OverlaysOnly_20250527", "type": "MapServer"}]},
    "https://example.test/server/rest/services/Hub/Plan_v9_2_20250527/MapServer": {"layers": [
        {"id": 0, "name": "Overlays (Part 8)", "parentLayerId": -1, "subLayerIds": [1]},
        {"id": 1, "name": "OM-05.01 Flood hazard area", "parentLayerId": 0},
        {"id": 2, "name": "Zones and Precincts (Part 6)", "parentLayerId": -1, "subLayerIds": [3, 4]},
        {"id": 3, "name": "Zones", "parentLayerId": 2},
        {"id": 4, "name": "Zone labels", "parentLayerId": 2},
        {"id": 5, "name": "LGIP (Part 4)", "parentLayerId": -1, "subLayerIds": [6]},
        {"id": 6, "name": "Priority infrastructure area", "parentLayerId": 5}]},
}
LAYER_INFO = {"type": "Feature Layer", "objectIdField": "OBJECTID", "maxRecordCount": 1000, "supportedQueryFormats": "JSON, geoJSON",
              "fields": [{"name": "OBJECTID", "type": "esriFieldTypeOID"}, {"name": "ZONE_NAME", "type": "esriFieldTypeString"},
                         {"name": "PRECINCT", "type": "esriFieldTypeString"}]}
FEATS = {1: [{"type": "Feature", "properties": {"OBJECTID": 1, "CATEGORY": "Flood hazard area"}, "geometry": poly(SQ)}],
         3: [{"type": "Feature", "properties": {"OBJECTID": 7, "ZONE_NAME": "Low density residential", "PRECINCT": "Suburban precinct"}, "geometry": poly(SQ)}]}
CAD = [{"type": "Feature", "properties": {"objectid": 11, "lot": "6", "plan": "RP1", "lotplan": "6RP1", "lot_area": 600.0, "tenure": "Freehold",
                                          "parcel_typ": "Lot Type Parcel", "locality": "ROCHEDALE SOUTH", "shire_name": "Logan City"}, "geometry": poly(SQ)},
       {"type": "Feature", "properties": {"objectid": 12, "lot": "0", "plan": "SP9", "lotplan": "0SP9", "lot_area": 900.0, "tenure": "Freehold",
                                          "parcel_typ": "Lot Type Parcel", "locality": "ROCHEDALE SOUTH", "shire_name": "Logan City"}, "geometry": poly(SQ2)}]
ADDR = [{"type": "Feature", "properties": {"objectid": 1, "lotplan": "6RP1", "street_number": "6", "street_name": "GABLE", "street_type": "STREET",
                                           "locality": "ROCHEDALE SOUTH", "local_authority": "Logan City"}, "geometry": {"type": "Point", "coordinates": [153.0005, -27.0005]}},
        {"type": "Feature", "properties": {"objectid": 2, "lotplan": "1BUP9", "unit_number": "1", "street_number": "8", "street_name": "GABLE",
                                           "street_type": "STREET", "locality": "ROCHEDALE SOUTH", "local_authority": "Logan City"},
         "geometry": {"type": "Point", "coordinates": [153.0015, -27.0005]}}]


# Registry sources of the T20 councils are run against fixtures that mimic their service lists.
REG = {c["id"]: c for c in b.load_registry()}
RL_ROOT = REG["redland"]["pipeline"]["layers"][0]["root"]
GC_ROOT = REG["gold_coast"]["pipeline"]["layers"][0]["root"]
RL = f"{RL_ROOT}/Current_Version_14_City_Plan_Zones_and_Overlays/FeatureServer"
GC = f"{GC_ROOT}/City_Plan_Version_13_Open_Data/FeatureServer"
FIX.update({
    RL_ROOT: {"services": [{"name": "Current_Version_13_City_Plan_Zones_and_Overlays", "type": "FeatureServer"},
                           {"name": "Current_Version_14_City_Plan_Zones_and_Overlays", "type": "FeatureServer"},
                           {"name": "Minjerribah_site_specific_land_use_AGOL", "type": "FeatureServer"}]},
    RL: {"layers": [{"id": 13, "name": "City Plan - Bushfire Hazard Overlay", "parentLayerId": -1},
                    {"id": 43, "name": "City Plan - Zones - Precinct Boundary", "parentLayerId": -1},
                    {"id": 44, "name": "City Plan - Zones", "parentLayerId": -1}]},
    GC_ROOT: {"services": [{"name": f"City_Plan_Version_{v}_Open_Data", "type": "FeatureServer"} for v in (8, 12, 13)]
              + [{"name": "Flood_Risk_Overlay_2026", "type": "FeatureServer"}]},
    GC: {"layers": [{"id": 0, "name": "Property boundaries - October 2024", "parentLayerId": -1},
                    {"id": 1, "name": "Context", "parentLayerId": -1},
                    {"id": 4, "name": "Zone", "parentLayerId": -1},
                    {"id": 101, "name": "Minimum lot size", "parentLayerId": -1}]},
})
FEATS.update({
    13: FEATS[1], 44: [{"type": "Feature", "properties": {"OBJECTID": 5, "QPP_Zone": "LDR", "QPP_Description": "Low Density Residential", "QPP_Precinct": "LDR2"}, "geometry": poly(SQ)}],
    4: [{"type": "Feature", "properties": {"OBJECTID": 9, "LVL1_ZONE": "Low density residential", "ZONE_PRECINCT": "Large lot precinct", "ZONE": "Low density residential, Large lot precinct"}, "geometry": poly(SQ)}],
    101: [{"type": "Feature", "properties": {"OBJECTID": 2, "MLS": "400m\u00b2"}, "geometry": poly(SQ)}],
})


def fake_get_json(url, params=None, retries=5):
    if url in FIX:
        return FIX[url]
    if url.endswith("/query"):
        base = url[: -len("/query")]
        last = int(params["where"].rsplit(">", 1)[1])
        if base == b.CADASTRE_URL:
            src, oid = CAD, "objectid"
        elif base == b.ADDRESS_URL:
            src, oid = ADDR, "objectid"
        else:
            src, oid = FEATS.get(int(base.rsplit("/", 1)[1]), []), "OBJECTID"
        return {"features": [f for f in src if f["properties"][oid] > last]}
    return LAYER_INFO


class RegistryTest(unittest.TestCase):
    def setUp(self):
        self._g = b.get_json
        b.get_json = fake_get_json

    def tearDown(self):
        b.get_json = self._g

    def test_registry_file(self):
        reg = b.load_registry()
        ids = [c["id"] for c in reg]
        self.assertEqual(ids[0], "brisbane")  # index 0 keeps Brisbane's parcel ids unchanged
        for c in reg:
            for k in ("name", "short", "scheme", "scheme_url", "bbox"):
                self.assertIn(k, c, f"{c['id']} lacks {k}")
            self.assertEqual(len(c["bbox"]), 4)
        self.assertEqual([c["id"] for c in b.select_councils(reg, "logan,moreton_bay")], ["logan", "moreton_bay"])

    def test_t20_registry_entries(self):
        ids = [c["id"] for c in b.load_registry()]
        self.assertEqual(ids, ["brisbane", "logan", "moreton_bay", "ipswich", "redland", "gold_coast", "mackay"])  # appended: earlier parcel ids unchanged
        lga = {"ipswich": "Ipswich City", "redland": "Redland City", "gold_coast": "Gold Coast City", "mackay": "Mackay Regional"}
        for cid, name in lga.items():
            ps = REG[cid]["pipeline"]["parcels"]
            self.assertEqual((ps["kind"], ps["lga"]), ("qld_cadastre", [name]))
            bx = REG[cid]["bbox"]
            self.assertTrue(bx[0] < bx[2] and bx[1] < bx[3] and 138 < bx[0] < 154 and -29.5 < bx[1] < -9)
            tb = REG[cid]["pipeline"]["test"]["bbox"]
            self.assertTrue(bx[0] <= tb[0] < tb[2] <= bx[2] and bx[1] <= tb[1] < tb[3] <= bx[3], f"{cid} test bbox outside its bbox")
        # Mackay is far outside SEQ: its own envelope, and no council zone or overlay source
        self.assertGreater(REG["mackay"]["bbox"][0], 140)
        self.assertLess(REG["mackay"]["bbox"][2], 150)
        for cid in ("ipswich", "mackay"):
            self.assertEqual(REG[cid]["pipeline"]["layers"], [])
            self.assertIs(REG[cid]["zones_loaded"], False)
            self.assertTrue(REG[cid]["maps_url"].startswith("https://"))
        for cid in ("redland", "gold_coast"):
            self.assertNotIn("zones_loaded", REG[cid])
        self.assertNotIn("cp14-heritage-overlay", REG["brisbane"]["pipeline"]["test"]["only"])  # renamed in the catalogue
        self.assertIn("cp14-heritage-overlay-local-heritage-area", REG["brisbane"]["pipeline"]["test"]["only"])

    def test_redland_source(self):
        src = REG["redland"]["pipeline"]["layers"][0]
        self.assertEqual(b.resolve_services(src), [RL])  # newest version only
        db = sqlite3.connect(":memory:")
        b.schema(db)
        ok, failed, total = b.load_arcgis_council(db, REG["redland"], src, None)
        self.assertEqual((ok, failed, total), (2, [], 2))  # precinct boundary layer skipped
        rows = db.execute("SELECT dataset_id, title FROM layers ORDER BY lid").fetchall()
        self.assertEqual(rows[0][1], "Redland — Bushfire Hazard Overlay")
        self.assertTrue(rows[0][0].startswith("redland:overlay:" + b.slug("Current_Version_14_City_Plan_Zones_and_Overlays", 40)), rows[0][0])
        self.assertTrue(rows[1][0].startswith("redland:zoning:") and rows[1][0].endswith(":44:zones"), rows[1][0])
        props = json.loads(db.execute("SELECT props FROM features f JOIN layers l ON l.lid=f.lid WHERE l.dataset_id LIKE 'redland:zoning:%'").fetchone()[0])
        self.assertEqual((props["zone"], props["precinct"]), ("Low Density Residential", "LDR2"))

    def test_gold_coast_source(self):
        src = REG["gold_coast"]["pipeline"]["layers"][0]
        self.assertEqual(b.resolve_services(src), [GC])  # v13 beats v8 and v12; Flood_Risk_Overlay_2026 is not a City Plan service
        db = sqlite3.connect(":memory:")
        b.schema(db)
        ok, failed, total = b.load_arcgis_council(db, REG["gold_coast"], src, None)
        self.assertEqual((ok, failed, total), (2, [], 2))  # council cadastre copy and Context skipped
        rows = db.execute("SELECT dataset_id, title FROM layers ORDER BY lid").fetchall()
        self.assertTrue(rows[0][0].startswith("gold_coast:zoning:") and rows[0][0].endswith(":4:zone"), rows[0][0])
        self.assertEqual(rows[1][1], "Gold Coast — Minimum lot size")
        props = json.loads(db.execute("SELECT props FROM features f JOIN layers l ON l.lid=f.lid WHERE l.dataset_id LIKE 'gold_coast:zoning:%'").fetchone()[0])
        self.assertEqual((props["zone"], props["precinct"]), ("Low density residential", "Large lot precinct"))

    def test_lots_only_councils(self):
        for cid, lga in (("ipswich", "Ipswich City"), ("mackay", "Mackay Regional")):
            db = sqlite3.connect(":memory:")
            b.schema(db)
            cad = [{**f, "properties": {**f["properties"], "shire_name": lga}} for f in CAD]
            old = CAD[:]
            CAD[:] = cad
            try:
                n = b.load_parcels_cadastre(db, cid, 3, REG[cid]["pipeline"]["parcels"], [152.9, -27.1, 153.1, -26.9])
            finally:
                CAD[:] = old
            self.assertEqual(n, 2)
            self.assertEqual(db.execute("SELECT DISTINCT council FROM parcels").fetchall(), [(cid,)])
            self.assertGreater(db.execute("SELECT MIN(pid) FROM parcels").fetchone()[0], 3 * b.PID_STRIDE)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM layers").fetchone()[0], 0)

    def test_council_rules_file(self):
        """Every sourced row has a source name and URL; council rule ids are unique; uses refer to known use ids."""
        with open(os.path.join(b.HERE, "..", "src-tauri", "knowledge", "council_rules.json"), encoding="utf-8") as fh:
            kb = json.load(fh)
        known = {c["id"] for c in b.load_registry()}
        self.assertTrue(set(kb) <= known)
        for cid in ("ipswich", "redland", "gold_coast", "mackay"):
            self.assertIn(cid, kb)
        for cid, k in kb.items():
            ids = [r["id"] for r in k.get("rules", [])]
            self.assertEqual(len(ids), len(set(ids)), f"duplicate rule ids in {cid}")
        # rules that only match on a keyword must not share an id with another council's keyword rule (flags are merged by id)
        other = [r["id"] for cid, k in kb.items() for r in k.get("rules", []) if r["id"] != "water"]
        self.assertEqual(len(other), len(set(other)), "duplicate council rule ids across councils")
        uses = {"house", "dual", "md", "rol", "commercial", "industry", "datacentre", "general"}

        def rows(k):
            for z in k.get("zones", []):
                yield z
            for p in k.get("provisions", []):
                yield from p["items"]
            for u in k.get("uses", {}).values():
                for r in u["rules"]:
                    yield from r["items"]
        for cid, k in kb.items():
            self.assertTrue(set(k.get("uses", {})) <= uses, cid)
            for r in k.get("rules", []):
                self.assertTrue(r["url"].startswith("http") and r["checklist"] and r["title"] and r["code"], f"{cid}/{r['id']}")
            for x in rows(k):
                self.assertTrue(x.get("source") and x.get("url", "").startswith("http"), f"{cid}: {x.get('label') or x.get('name')}")
        # third-party and secondary sources stay labelled and to be verified
        for cid in ("ipswich", "redland", "gold_coast", "mackay"):
            for x in rows(kb[cid]):
                self.assertIs(x["verify"], True, f"{cid}: {x.get('label') or x.get('name')}")
        for cid in ("gold_coast",):
            for x in rows(kb[cid]):
                if "landintel" in x["source"] or "third" in x["source"].lower() or "ITP26009" in x["source"]:
                    self.assertTrue(x["verify"])

    def test_resolve_newest_and_groups(self):
        src = {"kind": "arcgis", "root": ROOT, "services": [r"Hub/Plan_v\d+_\d+_\d{8}"], "service_type": "MapServer", "pick": "newest"}
        svcs = b.resolve_services(src)
        self.assertEqual(svcs, ["https://example.test/server/rest/services/Hub/Plan_v9_2_20250527/MapServer"])
        leaves = b.leaf_layers(FIX[svcs[0]], ["Zones and Precincts", "Overlays"])
        self.assertEqual([l["name"] for l, _ in leaves], ["OM-05.01 Flood hazard area", "Zones", "Zone labels"])

    def test_load_council_layers_and_zone_fields(self):
        db = sqlite3.connect(":memory:")
        b.schema(db)
        c = {"id": "logan", "short": "Logan", "title_prefix": "Logan — "}
        src = {"kind": "arcgis", "root": ROOT, "services": [r"Hub/Plan_v\d+_\d+_\d{8}"], "service_type": "MapServer", "pick": "newest",
               "groups": ["Zones and Precincts", "Overlays"], "zoning": ["^Zones$"], "skip": ["(?i)label"]}
        ok, failed, total = b.load_arcgis_council(db, c, src, None)
        self.assertEqual((ok, failed, total), (2, [], 2))
        rows = db.execute("SELECT dataset_id, title, council, authority FROM layers ORDER BY lid").fetchall()
        self.assertTrue(rows[0][0].startswith("logan:overlay:") and "zoning" not in rows[0][0])
        self.assertTrue(rows[1][0].startswith("logan:zoning:"))
        self.assertEqual(rows[1][1:], ("Logan — Zones and Precincts — Zones", "logan", "council"))
        props = json.loads(db.execute("SELECT props FROM features f JOIN layers l ON l.lid=f.lid WHERE l.dataset_id LIKE 'logan:zoning:%'").fetchone()[0])
        self.assertEqual((props["zone"], props["precinct"]), ("Low density residential", "Suburban precinct"))

    def test_cadastre_parcels_with_addresses(self):
        db = sqlite3.connect(":memory:")
        b.schema(db)
        n = b.load_parcels_cadastre(db, "logan", 1, {"lga": ["Logan City"]}, [152.9, -27.1, 153.1, -26.9])
        self.assertEqual(n, 2)
        r = db.execute("SELECT pid, address, suburb, council, search, props FROM parcels ORDER BY pid").fetchall()
        self.assertEqual(r[0][0], b.PID_STRIDE + 11)
        self.assertEqual(r[0][1:4], ("6 GABLE STREET, ROCHEDALE SOUTH QLD", "ROCHEDALE SOUTH", "logan"))
        # unit address on a building format plan joins to the base lot by location
        self.assertEqual(r[1][1], "8 GABLE STREET, ROCHEDALE SOUTH QLD")
        self.assertIn("1/8 GABLE STREET", r[1][4])
        p = json.loads(r[0][5])
        self.assertEqual((p["LOTPLAN"], p["TENURE_DESC"], p["LOT_AREA"]), ("6RP1", "Freehold", 600.0))

    def test_esri_rings(self):
        g = b.esri_to_geojson({"rings": [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]], [[5, 5], [5, 6], [6, 6], [6, 5], [5, 5]]]})
        self.assertEqual(g["type"], "MultiPolygon")
        self.assertEqual(b.esri_to_geojson({"paths": [[[0, 0], [1, 1]]]})["type"], "LineString")

    def test_labels(self):
        self.assertEqual(b.layer_label("Flood planning areas", "OM-05.04 Flood planning areas"), "OM-05.04 Flood planning areas")
        self.assertEqual(b.layer_label("MBRC_PlanningScheme_OM_ScenicAmenity", None, "^(MBRC_PlanningScheme_(OM_)?)"), "Scenic Amenity")
        self.assertEqual(b.layer_label("Precinct area", "Local Plans (Part 7)"), "Local Plans (Part 7) — Precinct area")


if __name__ == "__main__":
    unittest.main()
