#!/usr/bin/env python3
"""Build the offline data pack (SQLite) used by the AI Town Planner app.

Councils come from the registry src-tauri/knowledge/councils.json (the app reads the same file).
Each council has a parcel source, a list of planning-scheme layer sources and a bbox; adding a
council is a registry entry (plus optional rule data files), not a code change. Source kinds:
  parcels: "bcc" (Brisbane property_boundaries_parcel) | "qld_cadastre" (statewide cadastre +
           address points, filtered to the LGA name)
  layers:  "bcc_cp14" (every cp14-* dataset on data.brisbane.qld.gov.au) | "arcgis" (services in an
           ArcGIS REST folder resolved by name pattern; layers resolved by name, so ids can change)
State layers (STATE_LAYERS) are loaded once per council bbox and de-duplicated.

Runs in GitHub Actions (needs internet). Output: datapack.sqlite
Usage: python3 build_datapack.py [out_path] [--councils a,b] [--test] [--discover]
       [--limit-parcels N] [--only id1,id2]   (Brisbane cp14 options, kept for compatibility)
"""
import datetime as dt
import json
import os
import re
import sqlite3
import sys
import tempfile
import time
import urllib.parse
import urllib.request

try:
    import ijson
except ImportError:  # only needed for Brisbane cp14 exports
    ijson = None

HERE = os.path.dirname(os.path.abspath(__file__))
REGISTRY = os.path.join(HERE, "..", "src-tauri", "knowledge", "councils.json")

PARCELS_URL = ("https://services2.arcgis.com/dEKgZETqwmDAh1rP/arcgis/rest/services/"
               "property_boundaries_parcel/FeatureServer/0/query")
ODS = "https://data.brisbane.qld.gov.au/api/explore/v2.1"
PARCEL_FIELDS = ["OBJECTID", "LOT", "PLAN_", "LOTPLAN", "LOT_AREA", "HOUSE_NUMBER",
                 "HOUSE_NUMBER_SUFFIX", "UNIT_NUMBER", "CORRIDOR_NAME", "CORRIDOR_SUFFIX_CODE",
                 "SUBURB", "POSTCODE", "WARD_NAME", "TENURE_DESC", "PARCEL_TYP_DESC",
                 "PROPERTY_NAME_1"]
DROP_PROPS = {"geo_point_2d", "geo_shape", "objectid", "shape_area", "shape_length",
              "shape__area", "shape__length", "st_area(shape)", "st_perimeter(shape)",
              "st_area(shape)_", "st_length(shape)", "globalid"}
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) ai-town-planner-datapack/1.0", "Accept": "application/json,*/*"}
QLD = "https://spatial-gis.information.qld.gov.au/arcgis/rest/services"
LPPF = f"{QLD}/PlanningCadastre/LandParcelPropertyFramework/MapServer"
CADASTRE_URL = f"{LPPF}/4"   # Cadastral parcels (lot, plan, lotplan, tenure, lot_area, parcel_typ, locality, shire_name)
ADDRESS_URL = f"{LPPF}/0"    # Addresses (points; lotplan, street parts, locality, local_authority)
PID_STRIDE = 100_000_000      # pid = council index * stride + source object id (Brisbane index 0 keeps BCC ids)
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
    # Easement boundaries (Queensland cadastre); purpose and beneficiary are only on the title search
    ("other", f"{QLD}/PlanningCadastre/QSCF_LandParcelPropertyFramework_TimeAware/FeatureServer", ["Easement parcels"]),
    # National electricity infrastructure (Geoscience Australia), wider window for "nearest" searches
    # GA has moved this service before: try each candidate; layers are matched by keyword ("~" prefix).
    ("infra", ["https://services.ga.gov.au/gis/rest/services/Foundation_Electricity_Infrastructure/MapServer",
               "https://services.ga.gov.au/gis/rest/services/National_Electricity_Infrastructure/MapServer",
               "https://services.ga.gov.au/gis/rest/services/Electricity_Infrastructure/MapServer"],
     ["~line", "~substation", "~power station"]),
]
INFRA_PAD = 0.4  # degrees added around each council bbox for the electricity layers (~40 km)


def load_registry(path=REGISTRY):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


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


def get_json(url, params=None, retries=5):
    d = json.loads(get(url, params, retries))
    if isinstance(d, dict) and "error" in d and not d.get("features"):
        raise RuntimeError(f"{url[:120]}: {d['error']}")
    return d


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


def bbox_str(b):
    return ",".join(str(x) for x in b)


# ---------------------------------------------------------------- Esri JSON -> GeoJSON (fallback)
def _ring_area(r):
    return sum(r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1] for i in range(len(r) - 1)) / 2.0


def _in_ring(pt, ring):
    x, y, inside = pt[0], pt[1], False
    for i in range(len(ring) - 1):
        (x1, y1), (x2, y2) = ring[i][:2], ring[i + 1][:2]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-300) + x1:
            inside = not inside
    return inside


def esri_to_geojson(g):
    """Esri JSON geometry -> GeoJSON geometry (rings: clockwise = outer, as Esri defines)."""
    if not g:
        return None
    if "x" in g and "y" in g:
        return {"type": "Point", "coordinates": [g["x"], g["y"]]}
    if "points" in g:
        return {"type": "MultiPoint", "coordinates": g["points"]}
    if "paths" in g:
        p = g["paths"]
        return {"type": "LineString", "coordinates": p[0]} if len(p) == 1 else {"type": "MultiLineString", "coordinates": p}
    if "rings" in g:
        outers, holes = [], []
        for r in g["rings"]:
            if len(r) < 4:
                continue
            (outers if _ring_area(r) < 0 else holes).append(r)
        if not outers:  # counter-clockwise only: treat all as outers
            outers, holes = holes, []
        polys = [[o[::-1]] for o in outers]  # GeoJSON exterior counter-clockwise
        for h in holes:
            for poly in polys:
                if _in_ring(h[0], poly[0]):
                    poly.append(h[::-1]); break
        return {"type": "Polygon", "coordinates": polys[0]} if len(polys) == 1 else {"type": "MultiPolygon", "coordinates": polys}
    return None


# ---------------------------------------------------------------- schema
def schema(db):
    db.executescript("""
    PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
    CREATE TABLE manifest(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE parcels(pid INTEGER PRIMARY KEY, lotplan TEXT, address TEXT, suburb TEXT,
        search TEXT, area REAL, props TEXT, geom TEXT, council TEXT);
    CREATE INDEX parcels_lotplan ON parcels(lotplan);
    CREATE TABLE layers(lid INTEGER PRIMARY KEY, dataset_id TEXT UNIQUE, title TEXT, n INTEGER, authority TEXT, council TEXT);
    CREATE TABLE features(fid INTEGER PRIMARY KEY, lid INTEGER, props TEXT, geom TEXT);
    CREATE VIRTUAL TABLE feature_idx USING rtree(fid, minx, maxx, miny, maxy);
    CREATE VIRTUAL TABLE parcel_idx USING rtree(pid, minx, maxx, miny, maxy);
    """)


def next_lid(db):
    return db.execute("SELECT COALESCE(MAX(lid),0) FROM layers").fetchone()[0] + 1


# ---------------------------------------------------------------- Brisbane parcels
def address(a):
    num = f"{a.get('HOUSE_NUMBER') or ''}{a.get('HOUSE_NUMBER_SUFFIX') or ''}"
    unit = a.get("UNIT_NUMBER")
    if unit and num:
        num = f"{unit}/{num}"
    street = " ".join(x for x in [a.get("CORRIDOR_NAME"), a.get("CORRIDOR_SUFFIX_CODE")] if x)
    first = " ".join(x for x in [num, street] if x).strip()
    sub = " ".join(str(x) for x in [a.get("SUBURB"), "QLD", a.get("POSTCODE")] if x)
    return ", ".join(x for x in [first, sub] if x) or a.get("LOTPLAN") or ""


def load_parcels_bcc(db, cid, limit=None):
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
                         f"{addr} {lp}".upper(), a.get("LOT_AREA"), json.dumps(props), g, cid))
            idx.append((a["OBJECTID"], *b))
        db.executemany("INSERT OR REPLACE INTO parcels VALUES(?,?,?,?,?,?,?,?,?)", rows)
        db.executemany("INSERT OR REPLACE INTO parcel_idx VALUES(?,?,?,?,?)", idx)
        n += len(rows)
        print(f"  parcels: {n}", flush=True)
        if limit and n >= limit:
            break
    return n


# ---------------------------------------------------------------- ArcGIS paging
def layer_info(url):
    info = get_json(url, {"f": "json"})
    oid = info.get("objectIdField") or next((f["name"] for f in info.get("fields") or []
                                             if f.get("type") == "esriFieldTypeOID"), "OBJECTID")
    page = min(int(info.get("maxRecordCount") or 1000), 2000)
    fmts = (info.get("supportedQueryFormats") or "JSON").lower()
    return info, oid, page, "geojson" in fmts


def arcgis_features(url, oid=None, bbox=None, where="1=1", page=None, geojson=None, fields="*"):
    """Page through an ArcGIS layer by object id, optionally limited to a WGS84 envelope.
    Uses GeoJSON output when the server supports it, otherwise converts Esri JSON."""
    if oid is None or page is None or geojson is None:
        _, oid2, page2, gj2 = layer_info(url)
        oid, page, geojson = oid or oid2, page or page2, gj2 if geojson is None else geojson
    last = -1
    while True:
        q = {"where": f"({where}) AND {oid}>{last}", "outFields": fields, "outSR": 4326,
             "f": "geojson" if geojson else "json", "orderByFields": oid,
             "resultRecordCount": page, "geometryPrecision": 6, "returnGeometry": "true"}
        if bbox:
            q.update({"geometry": bbox, "geometryType": "esriGeometryEnvelope", "inSR": 4326,
                      "spatialRel": "esriSpatialRelIntersects"})
        d = get_json(f"{url}/query", q)
        feats = d.get("features", [])
        if not feats:
            return
        before = last
        for f in feats:
            if not geojson:
                f = {"type": "Feature", "properties": f.get("attributes") or {},
                     "geometry": esri_to_geojson(f.get("geometry"))}
            props = f.get("properties") or {}
            v = props.get(oid, f.get("id"))
            if v is None:  # case differences between oid field and attributes
                v = next((props[k] for k in props if k.lower() == oid.lower()), None)
            if v is not None:
                last = max(last, int(v))
            yield f
        if len(feats) < page and not d.get("exceededTransferLimit") and not (d.get("properties") or {}).get("exceededTransferLimit"):
            return
        if last <= before:  # object ids missing from the output: stop rather than loop on the same page
            print(f"::warning title=Paging stopped::{url}: object id field {oid} not in the output", flush=True)
            return


def insert_features(db, lid, feats, transform=None):
    n, rows, idx = 0, [], []
    next_fid = (db.execute("SELECT COALESCE(MAX(fid),0) FROM features").fetchone()[0]) + 1
    for f in feats:
        g, b = clean_geom(f.get("geometry"))
        if not g:
            continue
        props = clean_props(f.get("properties"))
        if transform:
            props = transform(props)
        rows.append((next_fid, lid, json.dumps(props), g))
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


# ---------------------------------------------------------------- Queensland cadastre parcels
def _addr_text(a):
    def s(k):
        v = a.get(k)
        return str(v).strip() if v not in (None, "") else ""
    num = s("street_number") or "".join([s("street_no_1"), s("street_no_1_suffix")]) + (
        f"-{s('street_no_2')}{s('street_no_2_suffix')}" if s("street_no_2") else "")
    unit = "".join([s("unit_number"), s("unit_suffix")])
    if unit and num:
        num = f"{unit}/{num}"
    street = " ".join(x for x in [s("street_name"), s("street_type"), s("street_suffix")] if x) or s("street_full")
    first = " ".join(x for x in [num, street] if x).strip()
    loc = " ".join(x for x in [s("locality"), "QLD"] if x)
    text = ", ".join(x for x in [first, loc] if x)
    return text or s("address")


def _addr_key(a):
    """Sort key: base address (no unit) first, then lowest street number."""
    num = re.match(r"\d+", str(a.get("street_no_1") or a.get("street_number") or "")) or None
    return (1 if a.get("unit_number") else 0, int(num.group()) if num else 10**9)


def cadastre_where(field, names):
    """Exact match on the LGA name as stored (e.g. "Logan City"); no upper() so the server can use its index."""
    vals = sorted({v for n in names for v in (n, n.upper(), n.title())})
    return f"{field} IN (" + ",".join("'" + v.replace("'", "''") + "'" for v in vals) + ")"


def load_addresses(lga, bbox):
    """lotplan -> sorted address list, plus points without a matching lot (for a spatial join)."""
    by_lp, n = {}, 0
    for f in arcgis_features(ADDRESS_URL, "objectid", bbox_str(bbox), cadastre_where("local_authority", lga), 2000, True):
        a = f.get("properties") or {}
        lp = (a.get("lotplan") or "").upper().strip()
        g = f.get("geometry") or {}
        pt = g.get("coordinates") if g.get("type") == "Point" else None
        by_lp.setdefault(lp, []).append((_addr_key(a), _addr_text(a), a.get("locality") or "", pt))
        n += 1
        if n % 50000 == 0:
            print(f"  addresses: {n}", flush=True)
    print(f"  addresses: {n} on {len(by_lp)} lot/plans", flush=True)
    for v in by_lp.values():
        v.sort(key=lambda x: x[0])
    return by_lp


def _pip(pt, geom):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]] if geom["type"] == "Polygon" else []
    return any(_in_ring(pt, p[0]) and not any(_in_ring(pt, h) for h in p[1:]) for p in polys)


def load_parcels_cadastre(db, cid, cidx, src, bbox, limit=None):
    lga = src["lga"]
    addrs = load_addresses(lga, bbox)
    used, n, rows, idx = set(), 0, [], []
    for f in arcgis_features(CADASTRE_URL, "objectid", bbox_str(bbox), cadastre_where("shire_name", lga), 2000, True,
                             "objectid,lot,plan,lotplan,tenure,lot_area,excl_area,parcel_typ,cover_typ,locality,shire_name,feat_name"):
        a = f.get("properties") or {}
        g, b = clean_geom(f.get("geometry"))
        if not g:
            continue
        lp = (a.get("lotplan") or "").upper().strip()
        al = addrs.get(lp, [])
        if al:
            used.add(lp)
        addr = al[0][1] if al else ""
        suburb = (a.get("locality") or (al[0][2] if al else "") or "").upper()
        if not addr:  # no address point: lot/plan, or the road or feature name for unlotted parcels
            first = lp or (f"{a['feat_name']} ({a.get('parcel_typ') or 'parcel'})" if a.get("feat_name") else "")
            addr = ", ".join(x for x in [first, f"{suburb} QLD" if suburb else ""] if x)
        others = [x[1] for x in al[1:]]
        props = clean_props({"LOT": a.get("lot"), "PLAN_": a.get("plan"), "LOTPLAN": lp, "LOT_AREA": a.get("lot_area"),
                             "SUBURB": suburb, "TENURE_DESC": a.get("tenure"), "PARCEL_TYP_DESC": a.get("parcel_typ"),
                             "COVER_TYP": a.get("cover_typ"), "PROPERTY_NAME_1": a.get("feat_name"),
                             "LGA": a.get("shire_name"), "OTHER_ADDRESSES": "; ".join(others[:8]) + (" …" if len(others) > 8 else "")})
        pid = cidx * PID_STRIDE + int(a["objectid"])
        search = " ".join([addr] + others[:40] + [lp]).upper() if lp else ""  # roads and unlotted land are not search results
        rows.append((pid, lp, addr, suburb, search, a.get("lot_area"), json.dumps(props), g, cid))
        idx.append((pid, *b))
        n += 1
        if len(rows) >= 5000:
            db.executemany("INSERT OR REPLACE INTO parcels VALUES(?,?,?,?,?,?,?,?,?)", rows)
            db.executemany("INSERT OR REPLACE INTO parcel_idx VALUES(?,?,?,?,?)", idx)
            rows, idx = [], []
            print(f"  parcels: {n}", flush=True)
        if limit and n >= limit:
            break
    db.executemany("INSERT OR REPLACE INTO parcels VALUES(?,?,?,?,?,?,?,?,?)", rows)
    db.executemany("INSERT OR REPLACE INTO parcel_idx VALUES(?,?,?,?,?)", idx)
    joined = spatial_join_addresses(db, cid, {k: v for k, v in addrs.items() if k not in used})
    print(f"  parcels: {n}; addresses matched by lot/plan on {len(used)} lots, by location {joined}", flush=True)
    return n


def spatial_join_addresses(db, cid, rest):
    """Addresses whose lot/plan has no polygon (units, building format plans): attach to the lot under the point."""
    extra = {}
    for lst in rest.values():
        for _, text, _, pt in lst:
            if not pt:
                continue
            cands = db.execute("SELECT p.pid, p.geom, p.props FROM parcel_idx i JOIN parcels p ON p.pid=i.pid "
                               "WHERE i.minx<=? AND i.maxx>=? AND i.miny<=? AND i.maxy>=? AND p.council=?",
                               (pt[0], pt[0], pt[1], pt[1], cid)).fetchall()
            for pid, gj, props in cands:
                if "EASEMENT" in props.upper():
                    continue
                if _pip(pt, json.loads(gj)):
                    extra.setdefault(pid, []).append(text)
                    break
    for pid, texts in extra.items():
        addr, search, props = db.execute("SELECT address, search, props FROM parcels WHERE pid=?", (pid,)).fetchone()
        p = json.loads(props)
        first_is_lp = addr.split(",")[0].strip().upper() == (p.get("LOTPLAN") or "").upper()
        if first_is_lp:  # the lot had no address of its own: show the first unit's street address
            addr = re.sub(r"^[^/]+/", "", texts[0])
        p["OTHER_ADDRESSES"] = "; ".join(texts[:8]) + (" …" if len(texts) > 8 else "")
        search = " ".join([search] + texts[:60]).upper()
        db.execute("UPDATE parcels SET address=?, search=?, props=? WHERE pid=?", (addr, search, json.dumps(p), pid))
    return sum(len(t) for t in extra.values())


# ---------------------------------------------------------------- Brisbane cp14 layers
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


def load_cp14(db, cid, only, tmpdir):
    sets = cp14_datasets()
    if only:
        sets = [s for s in sets if s[0] in only]
    print(f"{len(sets)} City Plan spatial datasets", flush=True)
    ok, failed = 0, []
    for i, (did, title) in enumerate(sets, 1):
        try:
            lid = next_lid(db)
            path = os.path.join(tmpdir, f"{did}.geojson")
            download(f"{ODS}/catalog/datasets/{did}/exports/geojson", path)
            with open(path, "rb") as fh:
                n = insert_features(db, lid, ijson.items(fh, "features.item", use_float=True))
            db.execute("INSERT INTO layers VALUES(?,?,?,?,?,?)", (lid, did, title, n, "council", cid))
            os.remove(path)
            ok += 1
            print(f"  [{i}/{len(sets)}] {did}: {n}", flush=True)
        except Exception as e:  # noqa: BLE001
            failed.append(did)
            print(f"  FAILED {did}: {e}", flush=True)
        db.commit()
    return ok, failed, len(sets)


# ---------------------------------------------------------------- ArcGIS council layers
def natural_key(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def services_root(url):
    i = url.find("/rest/services")
    return url[: i + len("/rest/services")] if i >= 0 else url


def resolve_services(src):
    """Service URLs for an "arcgis" source: explicit "service" URLs, or names in "root" matching "services" regexes."""
    if src.get("service"):
        return [src["service"]] if isinstance(src["service"], str) else list(src["service"])
    cat = get_json(src["root"], {"f": "json"}).get("services", [])
    typ = src.get("service_type")
    out = []
    for pat in src["services"]:
        hits = sorted({s["name"] for s in cat if re.fullmatch(pat, s["name"]) and (not typ or s.get("type") == typ)}, key=natural_key)
        if not hits:
            print(f"::warning title=Council service not found::{pat} in {src['root']}", flush=True)
            continue
        if src.get("pick", "all") == "newest":
            hits = [max(hits, key=lambda n: (re.findall(r"\d{8}", n)[-1:] or ["0"], natural_key(n)))]
        for h in hits:
            u = f"{services_root(src['root'])}/{h}/{typ or 'MapServer'}"
            if u not in out:
                out.append(u)
    return out


def leaf_layers(meta, groups=None):
    """(layer, parent group name) for data layers; when groups are given, only those under matching top-level groups."""
    layers = meta.get("layers", [])
    by_id = {l["id"]: l for l in layers}

    def leaves(l, parent):  # parent = the nearest group (it names the overlay), without "(Part 8)"-style suffixes
        subs = l.get("subLayerIds") or []
        if subs:
            return [x for s in subs if s in by_id for x in leaves(by_id[s], re.sub(r"\s*\(Part \d+\)$", "", l["name"]))]
        return [(l, parent)]

    tops = [l for l in layers if l.get("parentLayerId", -1) in (-1, None)]
    if groups:
        tops = [l for l in tops if any(l.get("name", "").lower().startswith(g.lower()) for g in groups)]
    out = []
    for t in tops:
        out += leaves(t, None)
    return out


def slug(s, n=60):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:n]


def pick_field(fields, patterns):
    for pat in patterns:
        for f in fields:
            if re.search(pat, f, re.I):
                return f
    return None


def zone_transform(src, info, role="zoning"):
    """Adds normalised "zone" / "precinct" props to zoning and precinct features (field names from the registry or guessed)."""
    names = [f["name"] for f in info.get("fields") or [] if f.get("type") == "esriFieldTypeString"]
    zf = None if role == "precinct" else src.get("zone_field") or pick_field(names, [r"^zone_?name$", r"^zone_?desc", r"zone.*(name|desc)", r"^zone$", r"^lvl1_zone$", r"^lps_?zone", r"zone(?!.*(code|prec))", r"zone"])
    pf = src.get("precinct_field") or pick_field(names, [r"^precinct_?name$", r"precinct.*(name|desc)", r"^precinct$", r"^zone_prec$", r"precinct(?!.*code)"])

    def t(props):
        low = {k.lower(): v for k, v in props.items()}
        if zf and low.get(zf.lower()):
            props["zone"] = str(low[zf.lower()])
        if pf and low.get(pf.lower()):
            props["precinct"] = str(low[pf.lower()])
        return props
    return t, zf, pf


def pretty(s, strip=None):
    """Readable layer name: registry prefix removed, underscores and CamelCase split."""
    if strip:
        s = re.sub(strip, "", s)
    s = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", s.replace("_", " "))
    return re.sub(r"\s+", " ", s).strip()


def layer_label(name, parent, strip=None):
    name, parent = pretty(name, strip), pretty(parent, strip) if parent else None
    if not parent or parent.lower() in name.lower():
        return name
    return parent if name.lower() in parent.lower() and len(name) * 2 > len(parent) else f"{parent} — {name}"


def load_arcgis_council(db, c, src, bbox):
    cid, prefix = c["id"], c.get("title_prefix") or f"{c['short']} — "
    ok, failed, total = 0, [], 0
    for svc in resolve_services(src):
        try:
            meta = get_json(svc, {"f": "json"})
        except Exception as e:  # noqa: BLE001
            failed.append(svc); print(f"::warning title=Council service failed::{svc}: {e}", flush=True); continue
        sname = svc.rstrip("/").split("/")[-2]
        print(f"  service {sname}", flush=True)
        for layer, parent in leaf_layers(meta, src.get("groups")):
            name = layer.get("name", str(layer["id"]))
            if any(re.search(p, x) for p in src.get("skip", []) for x in (name, parent or "")):
                continue
            total += 1
            url = f"{svc}/{layer['id']}"
            try:
                info, oid, page, gj = layer_info(url)
                if info.get("type") not in (None, "Feature Layer"):
                    total -= 1
                    continue
                hit = lambda key: any(re.search(p, x) for p in src.get(key, []) for x in (name, parent or "", sname))  # noqa: E731
                role = "zoning" if hit("zoning") else "precinct" if hit("precincts") else "overlay"
                tf, zf, pf = zone_transform(src, info, role) if role != "overlay" else (None, None, None)
                lid = next_lid(db)
                n = insert_features(db, lid, arcgis_features(url, oid, bbox_str(bbox) if bbox else None, "1=1", page, gj), tf)
                label = layer_label(name, parent, src.get("title_strip"))
                did = f"{cid}:{role}:{slug(sname, 40)}:{layer['id']}:" + slug(label).replace("zoning", "zones")
                db.execute("INSERT INTO layers VALUES(?,?,?,?,?,?)", (lid, did, f"{prefix}{label}", n, "council", cid))
                db.commit()
                ok += 1
                print(f"   [{role}] {label}: {n}" + (f" (zone field {zf}, precinct field {pf})" if tf else ""), flush=True)
            except Exception as e:  # noqa: BLE001
                failed.append(f"{sname}/{name}")
                print(f"::warning title=Council layer failed::{sname}/{name}: {e}", flush=True)
    return ok, failed, total


# ---------------------------------------------------------------- state layers (one pass per council bbox)
def load_state_layers(db, boxes):
    """boxes: list of (bbox list) – features are de-duplicated across boxes by object id."""
    failed, n_layers = [], 0
    for authority, svcs, wanted in STATE_LAYERS:
        meta, svc = {}, None
        for cand in ([svcs] if isinstance(svcs, str) else svcs):
            try:
                m = json.loads(get(cand, {"f": "json"}, retries=2))
            except Exception as e:  # noqa: BLE001
                print(f"  {cand}: {e}", flush=True)
                continue
            if m.get("layers"):
                meta, svc = m, cand
                break
        if not svc:
            failed.append(str(svcs)); print(f"::warning title=Data pack layer failed::no working service in {svcs}", flush=True); continue
        layers = meta.get("layers", [])
        done_ids = set()
        by_id = {l["id"]: l for l in layers}

        def leaves(l):  # group layers expand to their data sublayers
            subs = l.get("subLayerIds") or []
            return [x for s in subs if s in by_id for x in leaves(by_id[s])] if subs else [l]

        for w in wanted:
            if w.startswith("~"):  # keyword match, any position
                match = [l for l in layers if w[1:] in l.get("name", "").lower().replace("_", " ") and l["id"] not in done_ids][:1]
            else:
                exact = [l for l in layers if l.get("name", "").lower() == w.lower()]
                match = exact or [l for l in layers if l.get("name", "").lower().startswith(w.lower())][:1]
            # Leaf layers of a group keep the group name so rules can still recognise them.
            targets = [(x, x["name"] if x is l else f"{l['name']} — {x['name']}") for l in match for x in leaves(l)]
            if not targets:
                failed.append(w); print(f"::warning title=Data pack layer not found::{w}", flush=True)
            for layer, name in targets:
                if layer["id"] in done_ids:
                    continue
                done_ids.add(layer["id"])
                pad = INFRA_PAD if authority == "infra" else 0
                bxs = [[b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad] for b in boxes]
                if load_one(db, svc, layer, name, authority, bxs):
                    n_layers += 1
                else:
                    failed.append(layer.get("name", w))
    return n_layers, failed


def load_one(db, svc, layer, name, authority, boxes):
    url = f"{svc}/{layer['id']}"
    try:
        info, oid, page, gj = layer_info(url)
        seen = set()

        def feats():
            for b in boxes:
                for f in arcgis_features(url, oid, bbox_str(b), "1=1", min(page, 1000), gj):
                    p = f.get("properties") or {}
                    k = p.get(oid, f.get("id"))
                    if k is not None:
                        if k in seen:
                            continue
                        seen.add(k)
                    yield f
        lid = next_lid(db)
        n = insert_features(db, lid, feats())
        did = f"qld:{layer['id']}:" + name.lower().replace(" ", "-")[:80]
        prefix = "Australia" if authority == "infra" else "Queensland"
        db.execute("INSERT INTO layers VALUES(?,?,?,?,?,?)", (lid, did, f"{prefix} — {name}", n, authority, None))
        db.commit()
        print(f"  [{authority}] {name}: {n}", flush=True)
        return True
    except Exception as e:  # noqa: BLE001
        print(f"::warning title=Data pack layer failed::{name}: {e}", flush=True)
        return False


# ---------------------------------------------------------------- discovery (prints what the registry resolves to)
def discover(councils):
    for c in councils:
        p = c.get("pipeline") or {}
        tb = (p.get("test") or {}).get("bbox") or c["bbox"]
        print(f"\n==== {c['id']}: {c['name']} (test bbox {tb})", flush=True)
        try:
            d = get_json(f"{CADASTRE_URL}/query", {"where": "1=1", "geometry": bbox_str(tb), "geometryType": "esriGeometryEnvelope",
                                                    "inSR": 4326, "outFields": "shire_name", "returnDistinctValues": "true",
                                                    "returnGeometry": "false", "f": "json"})
            print("  cadastre shire_name values:", sorted({f["attributes"].get("shire_name") for f in d.get("features", [])}))
            d = get_json(f"{ADDRESS_URL}/query", {"where": "1=1", "geometry": bbox_str(tb), "geometryType": "esriGeometryEnvelope",
                                                   "inSR": 4326, "outFields": "local_authority", "returnDistinctValues": "true",
                                                   "returnGeometry": "false", "f": "json"})
            print("  address local_authority values:", sorted({f["attributes"].get("local_authority") for f in d.get("features", [])}))
            for s in c.get("samples", []):
                w = " AND ".join(x for x in [f"street_name='{s['street']}'" if s.get("street") else "",
                                              f"street_number='{s['number']}'" if s.get("number") else "",
                                              f"locality='{s['locality']}'" if s.get("locality") else ""] if x)
                d = get_json(f"{ADDRESS_URL}/query", {"where": w, "outFields": "lotplan,address,locality,local_authority,latitude,longitude",
                                                       "returnGeometry": "false", "resultRecordCount": 5, "f": "json"})
                print(f"  sample {w}:", [f["attributes"] for f in d.get("features", [])][:5])
        except Exception as e:  # noqa: BLE001
            print("  cadastre/address check failed:", e)
        for src in p.get("layers", []):
            if src.get("kind") == "bcc_cp14":
                try:
                    for did, title in cp14_datasets():
                        print(f"   {did}: {title}")
                except Exception as e:  # noqa: BLE001
                    print("  cp14 catalogue failed:", e)
                continue
            if src.get("kind") != "arcgis":
                print(f"  source kind {src.get('kind')} (built in)")
                continue
            try:
                svcs = resolve_services(src)
            except Exception as e:  # noqa: BLE001
                print("  resolve failed:", e); continue
            for svc in svcs:
                print(f"\n  SERVICE {svc}", flush=True)
                try:
                    meta = get_json(svc, {"f": "json"})
                    print("   copyright:", (meta.get("copyrightText") or "")[:200])
                    for layer, parent in leaf_layers(meta, src.get("groups")):
                        url = f"{svc}/{layer['id']}"
                        try:
                            info = get_json(url, {"f": "json"})
                            flds = [f"{f['name']}:{f.get('type', '').replace('esriFieldType', '')}" for f in info.get("fields") or []]
                            cnt = get_json(f"{url}/query", {"where": "1=1", "returnCountOnly": "true", "f": "json"}).get("count")
                            smp = get_json(f"{url}/query", {"where": "1=1", "outFields": "*", "returnGeometry": "false", "f": "json",
                                                            "geometry": bbox_str(tb), "geometryType": "esriGeometryEnvelope", "inSR": 4326,
                                                            "spatialRel": "esriSpatialRelIntersects", "resultRecordCount": 3}).get("features", [])
                            print(f"   [{layer['id']}] {parent or ''} / {layer.get('name')} type={info.get('type')} geom={info.get('geometryType')} n={cnt} max={info.get('maxRecordCount')}")
                            print(f"       fields: {', '.join(flds)}")
                            for s in smp:
                                print("       sample:", json.dumps(clean_props(s.get("attributes")))[:300])
                        except Exception as e:  # noqa: BLE001
                            print(f"   [{layer['id']}] {layer.get('name')}: {e}")
                except Exception as e:  # noqa: BLE001
                    print("   failed:", e)


# ---------------------------------------------------------------- main
def select_councils(reg, ids):
    if not ids:
        return [c for c in reg if c.get("pipeline")]
    want = [x.strip() for x in ids.split(",") if x.strip()]
    unknown = [x for x in want if x not in {c["id"] for c in reg}]
    if unknown:
        sys.exit(f"Unknown council id(s): {', '.join(unknown)}")
    return [c for c in reg if c["id"] in want and c.get("pipeline")]


def main():
    args = sys.argv[1:]
    opt = lambda k: args[args.index(k) + 1] if k in args else None  # noqa: E731
    out = args[0] if args and not args[0].startswith("--") else "datapack.sqlite"
    test = "--test" in args
    reg = load_registry(opt("--registry") or REGISTRY)
    councils = select_councils(reg, opt("--councils"))
    if "--discover" in args:
        discover(councils)
        return
    limit = int(opt("--limit-parcels")) if opt("--limit-parcels") else None
    only = set(opt("--only").split(",")) if opt("--only") else None
    if os.path.exists(out):
        os.remove(out)
    db = sqlite3.connect(out)
    schema(db)
    index = {c["id"]: i for i, c in enumerate(reg)}
    summary, failed, boxes = [], [], []
    with tempfile.TemporaryDirectory() as tmp:
        for c in councils:
            cid, p = c["id"], c["pipeline"]
            t = p.get("test") or {}
            box = t.get("bbox") if test and t.get("bbox") else c["bbox"]
            clip = box if test and t.get("bbox") else None  # council layers are only clipped in test mode
            boxes.append(box)
            print(f"== {c['name']} ({cid})", flush=True)
            plimit = limit or (t.get("parcel_limit") if test else None)
            ps = p["parcels"]
            if ps["kind"] == "bcc":
                n_p = load_parcels_bcc(db, cid, plimit)
            elif ps["kind"] == "qld_cadastre":
                n_p = load_parcels_cadastre(db, cid, index[cid], ps, box, plimit)
            else:
                sys.exit(f"Unknown parcel source kind {ps['kind']}")
            db.commit()
            n_ok, n_total = 0, 0
            for src in p.get("layers", []):
                if src["kind"] == "bcc_cp14":
                    o, f, tot = load_cp14(db, cid, only or (set(t.get("only", [])) if test else None), tmp)
                elif src["kind"] == "arcgis":
                    o, f, tot = load_arcgis_council(db, c, src, clip)
                else:
                    sys.exit(f"Unknown layer source kind {src['kind']}")
                n_ok, n_total = n_ok + o, n_total + tot
                failed += f
            summary.append({"id": cid, "name": c["name"], "scheme": c.get("scheme", ""), "parcels": n_p, "layers": n_ok})
            if n_total and n_ok < n_total / 2:
                sys.exit(f"Too many layers failed for {cid}: {n_ok}/{n_total}")
    print("Queensland state layers…", flush=True)
    n_state, failed_state = load_state_layers(db, boxes)
    names = [s["name"] for s in summary]
    meta = {
        "built_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d"),
        "region": ", ".join(names),
        "councils": json.dumps(summary),
        "parcels": str(sum(s["parcels"] for s in summary)),
        "layers": str(sum(s["layers"] for s in summary) + n_state),
        "failed_layers": ",".join(failed + failed_state),
        "test": "1" if test else "",
        "attribution": "Contains data " + ", ".join(c.get("attribution", c["name"]) for c in councils)
                       + " and (c) State of Queensland, licensed under Creative Commons Attribution (see each council's licence).",
        "sources": "; ".join(f"{c['short']}: {c.get('scheme', '')}" for c in councils)
                   + "; QSpatial (cadastre, addresses, state planning, SARA trigger, koala, wetland, vegetation, coastal layers)",
    }
    db.executemany("INSERT INTO manifest VALUES(?,?)", meta.items())
    db.commit()
    db.execute("VACUUM")
    db.close()
    print(json.dumps(meta, indent=1))


if __name__ == "__main__":
    main()
