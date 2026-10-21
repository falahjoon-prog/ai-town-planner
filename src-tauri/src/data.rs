//! Offline data pack access: parcel search and parcel/overlay intersection.
use geo::{Area, BooleanOps, Geometry, Intersects, MultiPolygon};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;

pub fn e<E: std::fmt::Display>(x: E) -> String {
    x.to_string()
}

pub fn open(path: &Path) -> Result<Connection, String> {
    let c = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(e)?;
    manifest(&c)?; // validates the file is a data pack
    Ok(c)
}

pub fn manifest(c: &Connection) -> Result<BTreeMap<String, String>, String> {
    let mut st = c.prepare("SELECT key, value FROM manifest").map_err(e)?;
    let rows = st
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(e)?;
    rows.collect::<Result<_, _>>().map_err(e)
}

#[derive(Serialize)]
pub struct ParcelHit {
    pub pid: i64,
    pub address: String,
    pub lotplan: String,
    pub suburb: String,
}

/// Street-type words users type vs the abbreviations used in council data.
fn abbr(t: &str) -> Option<&'static str> {
    Some(match t {
        "STREET" => "ST",
        "ROAD" => "RD",
        "AVENUE" => "AV",
        "DRIVE" => "DR",
        "COURT" => "CT",
        "PLACE" => "PL",
        "CRESCENT" => "CR",
        "PARADE" => "PDE",
        "TERRACE" => "TCE",
        "LANE" => "LA",
        "CLOSE" => "CL",
        "HIGHWAY" => "HWY",
        "BOULEVARD" => "BVD",
        "ESPLANADE" => "ESP",
        "CIRCUIT" => "CCT",
        _ => return None,
    })
}

fn tokens(q: &str) -> Vec<String> {
    q.to_uppercase()
        .replace(',', " ")
        .split_whitespace()
        .map(|t| t.chars().filter(|ch| !"%_*?[]".contains(*ch)).collect::<String>())
        .filter(|t| !t.is_empty())
        .take(8)
        .collect()
}

fn run_search(c: &Connection, toks: &[String]) -> Result<Vec<ParcelHit>, String> {
    let mut sql = String::from("SELECT pid, address, lotplan, suburb FROM parcels WHERE 1=1");
    let mut ps: Vec<String> = Vec::new();
    for t in toks {
        ps.push(format!("%{t}%"));
        match abbr(t) {
            Some(a) => {
                ps.push(format!("* {a}[ ,]*"));
                sql.push_str(&format!(" AND (search LIKE ?{} OR search GLOB ?{})", ps.len() - 1, ps.len()));
            }
            None => sql.push_str(&format!(" AND search LIKE ?{}", ps.len())),
        }
    }
    sql.push_str(" ORDER BY length(address) LIMIT 40");
    let mut st = c.prepare(&sql).map_err(e)?;
    let rows = st
        .query_map(rusqlite::params_from_iter(ps.iter()), |r| {
            Ok(ParcelHit { pid: r.get(0)?, address: r.get(1)?, lotplan: r.get(2)?, suburb: r.get(3)? })
        })
        .map_err(e)?;
    rows.collect::<Result<_, _>>().map_err(e)
}

fn edit_distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i; b.len() + 1];
        for j in 1..=b.len() {
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + usize::from(a[i - 1] != b[j - 1]));
        }
        prev = cur;
    }
    prev[b.len()]
}

/// Suburb and street-name words, built once, used to correct typos.
static VOCAB: std::sync::Mutex<Option<std::sync::Arc<Vec<String>>>> = std::sync::Mutex::new(None);

/// Forget the cached words (call after the data pack is replaced).
pub fn reset_vocab() {
    if let Ok(mut g) = VOCAB.lock() { *g = None; }
}

fn vocab(c: &Connection) -> std::sync::Arc<Vec<String>> {
    let mut g = VOCAB.lock().unwrap_or_else(|p| p.into_inner());
    g.get_or_insert_with(|| {
        let mut set = std::collections::BTreeSet::new();
        if let Ok(mut st) = c.prepare("SELECT address, suburb FROM parcels") {
            if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))) {
                let mut last = String::new();
                for (addr, sub) in rows.flatten() {
                    let key = format!("{addr}|{sub}");
                    if key == last { continue; }
                    last = key;
                    for w in addr.split(|ch: char| !ch.is_alphabetic()).chain(sub.split(|ch: char| !ch.is_alphabetic())) {
                        if w.len() >= 4 { set.insert(w.to_uppercase()); }
                    }
                }
            }
        }
        std::sync::Arc::new(set.into_iter().collect())
    })
    .clone()
}

/// Replace words that look misspelled with the closest suburb or street word.
fn correct(c: &Connection, toks: &[String]) -> Vec<String> {
    let v = vocab(c);
    toks.iter()
        .map(|t| {
            if t.len() < 4 || !t.chars().all(|ch| ch.is_alphabetic()) || v.binary_search(t).is_ok() {
                return t.clone();
            }
            let max = if t.len() >= 7 { 2 } else { 1 };
            v.iter()
                .filter(|w| w.len().abs_diff(t.len()) <= max)
                .map(|w| (edit_distance(t, w), w))
                .filter(|(d, _)| *d <= max)
                .min_by_key(|(d, _)| *d)
                .map(|(_, w)| w.clone())
                .unwrap_or_else(|| t.clone())
        })
        .collect()
}

pub fn search(c: &Connection, q: &str) -> Result<Vec<ParcelHit>, String> {
    let toks = tokens(q);
    if toks.is_empty() {
        return Ok(vec![]);
    }
    let hits = run_search(c, &toks)?;
    if !hits.is_empty() {
        return Ok(hits);
    }
    let fixed = correct(c, &toks); // nothing matched: try again with typos corrected
    if fixed == toks { Ok(hits) } else { run_search(c, &fixed) }
}

#[derive(Serialize, Clone)]
pub struct Parcel {
    pub pid: i64,
    pub lotplan: String,
    pub address: String,
    pub suburb: String,
    pub area_m2: Option<f64>,
    pub props: Value,
    pub geom: Value,
}

#[derive(Serialize, Clone)]
pub struct OverlayHit {
    /// council | sara | pda | state | other
    pub authority: String,
    pub dataset_id: String,
    pub title: String,
    pub props: Value,
    /// % of the lot covered (polygon layers only)
    pub coverage_pct: Option<f64>,
    /// Distance from the lot boundary in metres (line/point layers, within 25 m)
    pub distance_m: Option<f64>,
    /// Feature geometry clipped to the lot (polygons) or as-is (lines/points)
    pub geom: Value,
}

pub(crate) fn to_geo(s: &str) -> Result<Geometry<f64>, String> {
    let g: geojson::Geometry = s.parse().map_err(e)?;
    Geometry::<f64>::try_from(g.value).map_err(e)
}

pub(crate) fn polys(g: &Geometry<f64>) -> Option<MultiPolygon<f64>> {
    match g {
        Geometry::Polygon(p) => Some(MultiPolygon(vec![p.clone()])),
        Geometry::MultiPolygon(m) => Some(m.clone()),
        Geometry::GeometryCollection(gc) => {
            let v: Vec<_> = gc.0.iter().filter_map(polys).flat_map(|m| m.0).collect();
            (!v.is_empty()).then(|| MultiPolygon(v))
        }
        _ => None,
    }
}

pub(crate) fn geo_json(m: &MultiPolygon<f64>) -> Value {
    serde_json::to_value(geojson::Geometry::new(geojson::Value::from(m))).unwrap_or(Value::Null)
}

pub fn parcel(c: &Connection, pid: i64) -> Result<Parcel, String> {
    c.query_row(
        "SELECT pid, lotplan, address, suburb, area, props, geom FROM parcels WHERE pid = ?1",
        [pid],
        |r| {
            let props: String = r.get(5)?;
            let geom: String = r.get(6)?;
            Ok(Parcel {
                pid: r.get(0)?,
                lotplan: r.get(1)?,
                address: r.get(2)?,
                suburb: r.get(3)?,
                area_m2: r.get(4)?,
                props: serde_json::from_str(&props).unwrap_or(Value::Null),
                geom: serde_json::from_str(&geom).unwrap_or(Value::Null),
            })
        },
    )
    .map_err(e)
}

/// Lines/points within this distance of the lot count as affecting it (e.g. SARA's 25 m state-controlled road trigger).
const NEAR_M: f64 = 25.0;

/// Local equirectangular projection to metres (accurate enough at lot scale).
pub(crate) struct Proj {
    pub kx: f64,
    pub ky: f64,
}
impl Proj {
    pub fn new(lat: f64) -> Self {
        Proj { kx: 111_320.0 * lat.to_radians().cos(), ky: 110_540.0 }
    }
    pub fn xy(&self, c: geo::Coord<f64>) -> (f64, f64) {
        (c.x * self.kx, c.y * self.ky)
    }
}

fn seg_point(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len2 = dx * dx + dy * dy;
    let t = if len2 > 0.0 { (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / len2).clamp(0.0, 1.0) } else { 0.0 };
    ((p.0 - a.0 - t * dx).powi(2) + (p.1 - a.1 - t * dy).powi(2)).sqrt()
}

fn segments(g: &Geometry<f64>, pr: &Proj) -> Vec<((f64, f64), (f64, f64))> {
    use geo::CoordsIter;
    let mut out = Vec::new();
    let mut push_line = |cs: Vec<geo::Coord<f64>>| {
        if cs.len() == 1 {
            out.push((pr.xy(cs[0]), pr.xy(cs[0])));
        }
        for w in cs.windows(2) {
            out.push((pr.xy(w[0]), pr.xy(w[1])));
        }
    };
    match g {
        Geometry::LineString(l) => push_line(l.0.clone()),
        Geometry::MultiLineString(m) => m.0.iter().for_each(|l| push_line(l.0.clone())),
        Geometry::Polygon(p) => {
            push_line(p.exterior().0.clone());
            p.interiors().iter().for_each(|l| push_line(l.0.clone()));
        }
        Geometry::MultiPolygon(m) => m.0.iter().for_each(|p| {
            push_line(p.exterior().0.clone());
            p.interiors().iter().for_each(|l| push_line(l.0.clone()));
        }),
        other => other.coords_iter().for_each(|c| push_line(vec![c])),
    }
    out
}

/// Minimum distance in metres between two geometries (0 if they intersect).
pub(crate) fn distance_m(a: &Geometry<f64>, b: &Geometry<f64>, pr: &Proj) -> f64 {
    if a.intersects(b) {
        return 0.0;
    }
    let (sa, sb) = (segments(a, pr), segments(b, pr));
    let mut best = f64::MAX;
    for (a0, a1) in &sa {
        for (b0, b1) in &sb {
            let d = seg_point(*a0, *b0, *b1).min(seg_point(*a1, *b0, *b1)).min(seg_point(*b0, *a0, *a1)).min(seg_point(*b1, *a0, *a1));
            best = best.min(d);
        }
    }
    best
}

fn has_authority_column(c: &Connection) -> bool {
    c.prepare("SELECT authority FROM layers LIMIT 1").is_ok()
}

pub fn overlays(c: &Connection, p: &Parcel) -> Result<Vec<OverlayHit>, String> {
    let pg = to_geo(&p.geom.to_string())?;
    let pm = polys(&pg).ok_or("Lot geometry is not a polygon")?;
    let parea = pm.unsigned_area();
    let rect = geo::BoundingRect::bounding_rect(&pm).ok_or("Empty lot geometry")?;
    let pr = Proj::new(rect.center().y);
    let pad_x = (NEAR_M + 5.0) / pr.kx;
    let pad_y = (NEAR_M + 5.0) / pr.ky;
    let auth = if has_authority_column(c) { "COALESCE(l.authority, 'council')" } else { "'council'" };
    let mut st = c
        .prepare(&format!(
            "SELECT {auth}, l.dataset_id, l.title, f.props, f.geom FROM feature_idx i
             JOIN features f ON f.fid = i.fid JOIN layers l ON l.lid = f.lid
             WHERE i.minx <= ?2 AND i.maxx >= ?1 AND i.miny <= ?4 AND i.maxy >= ?3"
        ))
        .map_err(e)?;
    let rows = st
        .query_map(
            rusqlite::params![rect.min().x - pad_x, rect.max().x + pad_x, rect.min().y - pad_y, rect.max().y + pad_y],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            },
        )
        .map_err(e)?;
    let mut hits = Vec::new();
    for row in rows {
        let (authority, dataset_id, title, props, geom) = row.map_err(e)?;
        let Ok(fg) = to_geo(&geom) else { continue };
        let props = serde_json::from_str(&props).unwrap_or(Value::Null);
        match polys(&fg) {
            Some(fm) => {
                // Area overlap avoids false hits from neighbouring polygons that only touch the boundary.
                let inter = match catch_unwind(AssertUnwindSafe(|| pm.intersection(&fm))) {
                    Ok(i) => i,
                    Err(_) if pg.intersects(&fg) => pm.clone(),
                    Err(_) => continue,
                };
                let pct = if parea > 0.0 { inter.unsigned_area() / parea * 100.0 } else { 0.0 };
                if pct < 0.5 {
                    continue;
                }
                hits.push(OverlayHit {
                    authority,
                    dataset_id,
                    title,
                    props,
                    coverage_pct: Some((pct * 10.0).round() / 10.0),
                    distance_m: None,
                    geom: geo_json(&inter),
                });
            }
            None => {
                let d = distance_m(&pg, &fg, &pr);
                if d > NEAR_M {
                    continue;
                }
                let geom = serde_json::from_str(&geom).unwrap_or(Value::Null);
                hits.push(OverlayHit { authority, dataset_id, title, props, coverage_pct: None, distance_m: Some(d.round()), geom });
            }
        }
    }
    hits.sort_by(|a, b| a.title.cmp(&b.title));
    Ok(hits)
}

/// Flood-related features within `radius_m` of the lot, clipped to that window (for the flood map view).
pub fn flood_map(c: &Connection, p: &Parcel, radius_m: f64) -> Result<Vec<OverlayHit>, String> {
    let pg = to_geo(&p.geom.to_string())?;
    let rect = geo::BoundingRect::bounding_rect(&pg).ok_or("Empty lot geometry")?;
    let pr = Proj::new(rect.center().y);
    let (px, py) = (radius_m / pr.kx, radius_m / pr.ky);
    let (x0, x1, y0, y1) = (rect.min().x - px, rect.max().x + px, rect.min().y - py, rect.max().y + py);
    let window = MultiPolygon(vec![geo::Rect::new(geo::coord! { x: x0, y: y0 }, geo::coord! { x: x1, y: y1 }).to_polygon()]);
    let auth = if has_authority_column(c) { "COALESCE(l.authority, 'council')" } else { "'council'" };
    let mut st = c
        .prepare(&format!(
            "SELECT {auth}, l.dataset_id, l.title, f.props, f.geom FROM feature_idx i
             JOIN features f ON f.fid = i.fid JOIN layers l ON l.lid = f.lid
             WHERE i.minx <= ?2 AND i.maxx >= ?1 AND i.miny <= ?4 AND i.maxy >= ?3
               AND (lower(l.title) LIKE '%flood%' OR lower(l.title) LIKE '%overland%'
                    OR lower(l.title) LIKE '%storm tide%' OR lower(l.title) LIKE '%hazard area%')
             LIMIT 4000"
        ))
        .map_err(e)?;
    let rows = st
        .query_map(rusqlite::params![x0, x1, y0, y1], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?))
        })
        .map_err(e)?;
    let mut out = Vec::new();
    for row in rows {
        let (authority, dataset_id, title, props, geom) = row.map_err(e)?;
        let Ok(fg) = to_geo(&geom) else { continue };
        let geom = match polys(&fg) {
            Some(fm) => match catch_unwind(AssertUnwindSafe(|| window.intersection(&fm))) {
                Ok(clip) if !clip.0.is_empty() => geo_json(&clip),
                _ => continue,
            },
            None => serde_json::from_str(&geom).unwrap_or(Value::Null),
        };
        let props = serde_json::from_str(&props).unwrap_or(Value::Null);
        out.push(OverlayHit { authority, dataset_id, title, props, coverage_pct: None, distance_m: None, geom });
    }
    Ok(out)
}
