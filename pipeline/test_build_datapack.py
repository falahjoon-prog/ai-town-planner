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
                                          "parcel_typ": "Lot Type Parcel", "locality": "ROCHEDALE SOUTH", "shire_name": "LOGAN CITY"}, "geometry": poly(SQ)},
       {"type": "Feature", "properties": {"objectid": 12, "lot": "0", "plan": "SP9", "lotplan": "0SP9", "lot_area": 900.0, "tenure": "Freehold",
                                          "parcel_typ": "Lot Type Parcel", "locality": "ROCHEDALE SOUTH", "shire_name": "LOGAN CITY"}, "geometry": poly(SQ2)}]
ADDR = [{"type": "Feature", "properties": {"objectid": 1, "lotplan": "6RP1", "street_number": "6", "street_name": "GABLE", "street_type": "STREET",
                                           "locality": "ROCHEDALE SOUTH", "local_authority": "LOGAN CITY"}, "geometry": {"type": "Point", "coordinates": [153.0005, -27.0005]}},
        {"type": "Feature", "properties": {"objectid": 2, "lotplan": "1BUP9", "unit_number": "1", "street_number": "8", "street_name": "GABLE",
                                           "street_type": "STREET", "locality": "ROCHEDALE SOUTH", "local_authority": "LOGAN CITY"},
         "geometry": {"type": "Point", "coordinates": [153.0015, -27.0005]}}]


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
        n = b.load_parcels_cadastre(db, "logan", 1, {"lga": ["LOGAN CITY"]}, [152.9, -27.1, 153.1, -26.9])
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
