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
    CREATE TABLE layers(lid INTEGER PRIMARY KEY, dataset_id TEXT UNIQUE, title TEXT, n INTEGER);
    CREATE TABLE features(fid INTEGER PRIMARY KEY, lid INTEGER, props TEXT, geom TEXT);
    CREATE VIRTUAL TABLE feature_idx USING rtree(fid, minx, maxx, miny, maxy);
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
        rows = []
        for f in feats:
            a = f.get("properties") or {}
            last = max(last, int(a.get("OBJECTID", last)))
            g, _ = clean_geom(f.get("geometry"))
            if not g:
                continue
            addr = address(a)
            lp = a.get("LOTPLAN") or ""
            props = clean_props({k: v for k, v in a.items() if k != "OBJECTID"})
            rows.append((a["OBJECTID"], lp, addr, a.get("SUBURB") or "",
                         f"{addr} {lp}".upper(), a.get("LOT_AREA"), json.dumps(props), g))
        db.executemany("INSERT OR REPLACE INTO parcels VALUES(?,?,?,?,?,?,?,?)", rows)
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


def load_layer(db, lid, did, title, tmpdir):
    path = os.path.join(tmpdir, f"{did}.geojson")
    download(f"{ODS}/catalog/datasets/{did}/exports/geojson", path)
    n, rows, idx = 0, [], []
    next_fid = (db.execute("SELECT COALESCE(MAX(fid),0) FROM features").fetchone()[0]) + 1
    with open(path, "rb") as fh:
        for f in ijson.items(fh, "features.item", use_float=True):
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
    db.execute("INSERT INTO layers VALUES(?,?,?,?)", (lid, did, title, n))
    os.remove(path)
    return n


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
    meta = {
        "built_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d"),
        "region": "Brisbane City Council",
        "parcels": str(np_),
        "layers": str(len(sets) - len(failed)),
        "failed_layers": ",".join(failed),
        "attribution": "Contains data (c) Brisbane City Council, licensed under CC BY 4.0.",
        "sources": "data.brisbane.qld.gov.au (City Plan 2014 datasets); BCC property_boundaries_parcel",
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
