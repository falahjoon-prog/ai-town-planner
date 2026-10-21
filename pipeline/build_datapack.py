#!/usr/bin/env python3
"""Build the offline data pack (SQLite) used by the AI Town Planner app.

Sources (all open data, CC BY 4.0, (c) Brisbane City Council):
  * Property boundaries (parcels + addresses) - BCC ArcGIS FeatureServer
  * Every "cp14-*" City Plan 2014 spatial dataset - data.brisbane.qld.gov.au

Runs in GitHub Actions (needs internet). Output: datapack.sqlite
Usage: python3 build_datapack.py [out_path] [--limit-parcels N] [--only id1,id2]
"""
import datetime as dt
import json
import os
import sqlite3
import sys
import tempfile
import time
import urllib.parse
import urllib.request

import ijson

PARCELS_URL = ("https://services2.arcgis.com/dEKgZETqwmDAh1rP/arcgis/rest/services/"
               "property_boundaries_parcel/FeatureServer/0/query")
ODS = "https://data.brisbane.qld.gov.au/api/explore/v2.1"
PARCEL_FIELDS = ["OBJECTID", "LOT", "PLAN_", "LOTPLAN", "LOT_AREA", "HOUSE_NUMBER",
                 "HOUSE_NUMBER_SUFFIX", "UNIT_NUMBER", "CORRIDOR_NAME", "CORRIDOR_SUFFIX_CODE",
                 "SUBURB", "POSTCODE", "WARD_NAME", "TENURE_DESC", "PARCEL_TYP_DESC",
                 "PROPERTY_NAME_1"]
DROP_PROPS = {"geo_point_2d", "geo_shape", "objectid", "shape_area", "shape_length",
              "shape__area", "shape__length"}
UA = {"User-Agent": "ai-town-planner-datapack/1.0"}
QLD = "https://spatial-gis.information.qld.gov.au/arcgis/rest/services"
BNE_BBOX = "152.66,-27.77,153.47,-27.02"  # Brisbane LGA envelope (WGS84)
# (authority, MapServer, layer-name prefixes). Layers are resolved by name, so ID changes don't break the build.
STATE_LAYERS = [
    ("sara", f"{QLD}/Transportation/StateRoadInformation/MapServer", ["State controlled road"]),
    ("sara", f"{QLD}/Environment/KoalaPlan/MapServer", ["Koala priority area", "Core koala habitat area", "Locally refined koala habitat area"]),
    ("sara", f"{QLD}/Environment/WetlandProtection/MapServer", ["Wetland protection area", "Wetlands of high ecological significance"]),
    ("sara", f"{QLD}/Biota/VegetationManagement/MapServer", ["RVM category A", "RVM category B", "RVM category C", "RVM category R", "Essential habitat map"]),
    ("sara", f"{QLD}/PlanningCadastre/CoastalManagement/MapServer", ["Coastal management district", "Erosion prone area", "High hazard area", "Medium hazard area"]),
    ("pda", f"{QLD}/PlanningCadastre/StatePlanning/MapServer", ["Priority development areas"]),
    ("state", f"{QLD}/PlanningCadastre/StatePlanning/MapServer", ["SEQ regional land use category"]),
    ("other", f"{QLD}/Biota/VegetationManagement/MapServer", ["Protected plants trigger map"]),
    # National electricity infrastructure (Geoscience Australia), wider SEQ window for "nearest" searches
    ("infra", "https://services.ga.gov.au/gis/rest/services/National_Electricity_Infrastructure/MapServer",
     ["Transmission Lines", "Transmission Substations", "Power Generation"]),
]
SEQ_BBOX = "152.3,-28.1,153.6,-26.6"


def get(url, params=None, retries=5):
    if params:
        url += "?" + urllib.parse.urlencode(params)
    for i in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if i == retries - 1:
                raise
            print(f"  retry {i + 1} {url[:120]}: {e}", flush=True)
            time.sleep(5 * (i + 1))


def download(url, path, retries=4):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=1800) as r, open(path, "wb") as f:
                while chunk := r.read(1 << 20):
                    f.write(chunk)
            return
        except Exception as e:  # noqa: BLE001
            if i == retries - 1:
                raise
            print(f"  retry {i + 1}: {e}", flush=True)
            time.sleep(10 * (i + 1))


def rnd(c):
    """Round coordinates to 6 dp (~0.1 m) to shrink the pack."""
    if isinstance(c, (list, tuple)):
        return [rnd(x) for x in c]
    return round(float(c), 6)


def bbox(coords):
    xs, ys = [], []

    def walk(c):
        if c and isinstance(c[0], (int, float)):
            xs.append(c[0]); ys.append(c[1])
        else:
            for x in c:
                walk(x)
    walk(coords)
    return (min(xs), max(xs), min(ys), max(ys)) if xs else None


def clean_geom(g):
    if not g or "coordinates" not in g or not g["coordinates"]:
        return None, None
    coords = rnd(g["coordinates"])
    b = bbox(coords)
    return (json.dumps({"type": g["type"], "coordinates": coords}, separators=(",", ":")), b) if b else (None, None)


def clean_props(p):
    out = {}
    for k, v in (p or {}).items():
        if k.lower() in DROP_PROPS or v in (None, ""):
            continue
        if isinstance(v, str) and len(v) > 400:
            v = v[:400] + "…"
        out[k] = v if isinstance(v, (str, int, float, bool)) else str(v)
    return out


def schema(db):
    db.executescript("""
    PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
    CREATE TABLE manifest(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE parcels(pid INTEGER PRIMARY KEY, lotplan TEXT, address TEXT, suburb TEXT,
        search TEXT, area REAL, props TEXT, geom TEXT);
    CREATE INDEX parcels_lotplan ON parcels(lotplan);
    CREATE TABLE layers(lid INTEGER PRIMARY KEY, dataset_id TEXT UNIQUE, title TEXT, n INTEGER, authority TEXT);
    CREATE TABLE features(fid INTEGER PRIMARY KEY, lid INTEGER, props TEXT, geom TEXT);
    CREATE VIRTUAL TABLE feature_idx USING rtree(fid, minx, maxx, miny, maxy);
    CREATE VIRTUAL TABLE parcel_idx USING rtree(pid, minx, maxx, miny, maxy);
    """)


def address(a):
    num = f"{a.get('HOUSE_NUMBER') or ''}{a.get('HOUSE_NUMBER_SUFFIX') or ''}"
    unit = a.get("UNIT_NUMBER")
    if unit and num:
        num = f"{unit}/{num}"
    street = " ".join(x for x in [a.get("CORRIDOR_NAME"), a.get("CORRIDOR_SUFFIX_CODE")] if x)
    first = " ".join(x for x in [num, street] if x).strip()
    sub = " ".join(str(x) for x in [a.get("SUBURB"), "QLD", a.get("POSTCODE")] if x)
    return ", ".join(x for x in [first, sub] if x) or a.get("LOTPLAN") or ""


def load_parcels(db, limit=None):
    last, n = -1, 0
    while True:
        body = get(PARCELS_URL, {"where": f"OBJECTID>{last}", "outFields": ",".join(PARCEL_FIELDS),
                                 "outSR": 4326, "f": "geojson", "orderByFields": "OBJECTID",
                                 "resultRecordCount": 2000})
        feats = json.loads(body).get("features", [])
        if not feats:
            break
        rows, idx = [], []
        for f in feats:
            a = f.get("properties") or {}
            last = max(last, int(a.get("OBJECTID", last)))
            g, b = clean_geom(f.get("geometry"))
            if not g:
                continue
            addr = address(a)
            lp = a.get("LOTPLAN") or ""
            props = clean_props({k: v for k, v in a.items() if k != "OBJECTID"})
            rows.append((a["OBJECTID"], lp, addr, a.get("SUBURB") or "",
                         f"{addr} {lp}".upper(), a.get("LOT_AREA"), json.dumps(props), g))
            idx.append((a["OBJECTID"], *b))
        db.executemany("INSERT OR REPLACE INTO parcels VALUES(?,?,?,?,?,?,?,?)", rows)
        db.executemany("INSERT OR REPLACE INTO parcel_idx VALUES(?,?,?,?,?)", idx)
        n += len(rows)
        print(f"  parcels: {n}", flush=True)
        if limit and n >= limit:
            break
    return n


def cp14_datasets():
    out, offset = [], 0
    while True:
        res = json.loads(get(f"{ODS}/catalog/datasets", {"limit": 100, "offset": offset}))
        items = res.get("results", [])
        for d in items:
            did = d.get("dataset_id", "")
            if not did.startswith("cp14"):
                continue
            types = {f.get("type") for f in d.get("fields", [])}
            if "geo_shape" not in types:
                continue
            title = ((d.get("metas") or {}).get("default") or {}).get("title") or did
            out.append((did, title))
        offset += len(items)
        if not items or offset >= res.get("total_count", 0):
            return out


def insert_features(db, lid, feats):
    n, rows, idx = 0, [], []
    next_fid = (db.execute("SELECT COALESCE(MAX(fid),0) FROM features").fetchone()[0]) + 1
    for f in feats:
        g, b = clean_geom(f.get("geometry"))
        if not g:
            continue
        rows.append((next_fid, lid, json.dumps(clean_props(f.get("properties"))), g))
        idx.append((next_fid, *b))
        next_fid += 1
        n += 1
        if len(rows) >= 5000:
            db.executemany("INSERT INTO features VALUES(?,?,?,?)", rows)
            db.executemany("INSERT INTO feature_idx VALUES(?,?,?,?,?)", idx)
            rows, idx = [], []
    db.executemany("INSERT INTO features VALUES(?,?,?,?)", rows)
    db.executemany("INSERT INTO feature_idx VALUES(?,?,?,?,?)", idx)
    return n


def load_layer(db, lid, did, title, tmpdir):
    path = os.path.join(tmpdir, f"{did}.geojson")
    download(f"{ODS}/catalog/datasets/{did}/exports/geojson", path)
    with open(path, "rb") as fh:
        n = insert_features(db, lid, ijson.items(fh, "features.item", use_float=True))
    db.execute("INSERT INTO layers VALUES(?,?,?,?,?)", (lid, did, title, n, "council"))
    os.remove(path)
    return n


def arcgis_features(url, oid, bbox=BNE_BBOX):
    """Page through a statewide ArcGIS layer, limited to the Brisbane envelope."""
    last = -1
    while True:
        body = get(f"{url}/query", {"where": f"{oid}>{last}", "geometry": bbox,
                                    "geometryType": "esriGeometryEnvelope", "inSR": 4326,
                                    "spatialRel": "esriSpatialRelIntersects", "outFields": "*",
                                    "outSR": 4326, "f": "geojson", "orderByFields": oid,
                                    "resultRecordCount": 1000, "geometryPrecision": 6})
        feats = json.loads(body).get("features", [])
        if not feats:
            return
        for f in feats:
            props = f.get("properties") or {}
            v = props.get(oid, f.get("id"))
            if v is not None:
                last = max(last, int(v))
            yield f
        if len(feats) < 1000:
            return


def load_state_layers(db, start_lid):
    lid, failed = start_lid, []
    for authority, svc, wanted in STATE_LAYERS:
        try:
            meta = json.loads(get(svc, {"f": "json"}))
        except Exception as e:  # noqa: BLE001
            failed.append(svc); print(f"  FAILED {svc}: {e}", flush=True); continue
        layers = meta.get("layers", [])
        by_id = {l["id"]: l for l in layers}

        def leaves(l):  # group layers expand to their data sublayers
            subs = l.get("subLayerIds") or []
            return [x for s in subs if s in by_id for x in leaves(by_id[s])] if subs else [l]

        for w in wanted:
            exact = [l for l in layers if l.get("name", "").lower() == w.lower()]
            match = exact or [l for l in layers if l.get("name", "").lower().startswith(w.lower())][:1]
            # Leaf layers of a group keep the group name so rules can still recognise them.
            targets = [(x, x["name"] if x is l else f"{l['name']} — {x['name']}") for l in match for x in leaves(l)]
            if not targets:
                failed.append(w); print(f"  NOT FOUND {w}", flush=True)
            for layer, name in targets:
                lid += 1
                if not load_one(db, svc, layer, name, authority, lid, SEQ_BBOX if authority == "infra" else BNE_BBOX):
                    failed.append(layer.get("name", w))
    return lid - start_lid, failed


def load_one(db, svc, layer, name, authority, lid, bbox):
    url = f"{svc}/{layer['id']}"
    try:
        info = json.loads(get(url, {"f": "json"}))
        oid = info.get("objectIdField") or next((f["name"] for f in info.get("fields", [])
                                                 if f.get("type") == "esriFieldTypeOID"), "OBJECTID")
        n = insert_features(db, lid, arcgis_features(url, oid, bbox))
        did = f"qld:{layer['id']}:" + name.lower().replace(" ", "-")[:80]
        prefix = "Australia" if authority == "infra" else "Queensland"
        db.execute("INSERT INTO layers VALUES(?,?,?,?,?)", (lid, did, f"{prefix} — {name}", n, authority))
        db.commit()
        print(f"  [{authority}] {name}: {n}", flush=True)
        return True
    except Exception as e:  # noqa: BLE001
        print(f"  FAILED {name}: {e}", flush=True)
        return False


def main():
    args = sys.argv[1:]
    out = args[0] if args and not args[0].startswith("--") else "datapack.sqlite"
    limit = int(args[args.index("--limit-parcels") + 1]) if "--limit-parcels" in args else None
    only = set(args[args.index("--only") + 1].split(",")) if "--only" in args else None
    if os.path.exists(out):
        os.remove(out)
    db = sqlite3.connect(out)
    schema(db)
    print("Parcels…", flush=True)
    np_ = load_parcels(db, limit)
    db.commit()
    sets = cp14_datasets()
    if only:
        sets = [s for s in sets if s[0] in only]
    print(f"{len(sets)} City Plan spatial datasets", flush=True)
    failed = []
    with tempfile.TemporaryDirectory() as tmp:
        for lid, (did, title) in enumerate(sets, 1):
            try:
                n = load_layer(db, lid, did, title, tmp)
                print(f"  [{lid}/{len(sets)}] {did}: {n}", flush=True)
            except Exception as e:  # noqa: BLE001
                failed.append(did)
                print(f"  FAILED {did}: {e}", flush=True)
            db.commit()
    print("Queensland state layers…", flush=True)
    n_state, failed_state = load_state_layers(db, len(sets) + 1)
    meta = {
        "built_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d"),
        "region": "Brisbane City Council",
        "parcels": str(np_),
        "layers": str(len(sets) - len(failed) + n_state),
        "failed_layers": ",".join(failed + failed_state),
        "attribution": "Contains data (c) Brisbane City Council and (c) State of Queensland, licensed under CC BY 4.0.",
        "sources": "data.brisbane.qld.gov.au (City Plan 2014); BCC property_boundaries_parcel; QSpatial (state planning, SARA trigger, koala, wetland, vegetation, coastal layers)",
    }
    db.executemany("INSERT INTO manifest VALUES(?,?)", meta.items())
    db.commit()
    db.execute("VACUUM")
    db.close()
    print(json.dumps(meta, indent=1))
    if failed and len(failed) > len(sets) // 2:
        sys.exit("Too many layers failed")


if __name__ == "__main__":
    main()
