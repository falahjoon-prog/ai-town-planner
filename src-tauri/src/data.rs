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

pub fn search(c: &Connection, q: &str) -> Result<Vec<ParcelHit>, String> {
    let toks: Vec<String> = q
        .to_uppercase()
        .replace(',', " ")
        .split_whitespace()
        .map(|t| t.chars().filter(|ch| !"%_*?[]".contains(*ch)).collect::<String>())
        .filter(|t| !t.is_empty())
        .take(8)
        .collect();
    if toks.is_empty() {
        return Ok(vec![]);
    }
    let mut sql = String::from("SELECT pid, address, lotplan, suburb FROM parcels WHERE 1=1");
    let mut ps: Vec<String> = Vec::new();
    for t in &toks {
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
    pub dataset_id: String,
    pub title: String,
    pub props: Value,
    /// % of the lot covered (polygon layers only)
    pub coverage_pct: Option<f64>,
    /// Feature geometry clipped to the lot (polygons) or as-is (lines/points)
    pub geom: Value,
}

fn to_geo(s: &str) -> Result<Geometry<f64>, String> {
    let g: geojson::Geometry = s.parse().map_err(e)?;
    Geometry::<f64>::try_from(g.value).map_err(e)
}

fn polys(g: &Geometry<f64>) -> Option<MultiPolygon<f64>> {
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

fn geo_json(m: &MultiPolygon<f64>) -> Value {
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

pub fn overlays(c: &Connection, p: &Parcel) -> Result<Vec<OverlayHit>, String> {
    let pg = to_geo(&p.geom.to_string())?;
    let pm = polys(&pg).ok_or("Lot geometry is not a polygon")?;
    let parea = pm.unsigned_area();
    let rect = geo::BoundingRect::bounding_rect(&pm).ok_or("Empty lot geometry")?;
    let mut st = c
        .prepare(
            "SELECT l.dataset_id, l.title, f.props, f.geom FROM feature_idx i
             JOIN features f ON f.fid = i.fid JOIN layers l ON l.lid = f.lid
             WHERE i.minx <= ?2 AND i.maxx >= ?1 AND i.miny <= ?4 AND i.maxy >= ?3",
        )
        .map_err(e)?;
    let rows = st
        .query_map(
            rusqlite::params![rect.min().x, rect.max().x, rect.min().y, rect.max().y],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)),
        )
        .map_err(e)?;
    let mut hits = Vec::new();
    for row in rows {
        let (dataset_id, title, props, geom) = row.map_err(e)?;
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
                hits.push(OverlayHit { dataset_id, title, props, coverage_pct: Some((pct * 10.0).round() / 10.0), geom: geo_json(&inter) });
            }
            None => {
                if !pg.intersects(&fg) {
                    continue;
                }
                let geom = serde_json::from_str(&geom).unwrap_or(Value::Null);
                hits.push(OverlayHit { dataset_id, title, props, coverage_pct: None, geom });
            }
        }
    }
    hits.sort_by(|a, b| a.title.cmp(&b.title));
    Ok(hits)
}
