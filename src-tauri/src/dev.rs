//! Development potential: lot dimensions, frontage, zone provisions (sourced), subdivision yield and sketch,
//! proposed-use fit, required forms, and contours (online, cached).
use crate::data::{e, geo_json, polys, to_geo, Parcel, Proj};
use crate::rules::Assessment;
use geo::{Area, BooleanOps, Coord, LineString, MultiPolygon, Polygon};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::OnceLock;

#[derive(Deserialize, Serialize, Clone)]
pub struct ProvItem {
    pub label: String,
    pub value: String,
    pub source: String,
    pub url: String,
    pub verify: bool,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub n: Option<f64>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct ProvSet {
    pub zone: Vec<String>,
    pub precinct: Vec<String>,
    pub title: String,
    pub items: Vec<ProvItem>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct UseDef {
    pub id: String,
    pub name: String,
    pub term: String,
    pub zones: Vec<String>,
    #[serde(default)]
    pub sources: Vec<Value>,
    pub checks: Vec<String>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct FormDef {
    pub id: String,
    pub name: String,
    pub to: String,
    pub when: String,
    pub url: String,
    pub lodge: String,
    pub lodge_url: String,
}

#[derive(Serialize, Clone)]
pub struct Edge {
    pub length_m: f64,
    /// [lon, lat] of the edge midpoint (for map labels)
    pub mid: [f64; 2],
    /// true = road/open boundary, false = shared with a neighbour, None = unknown (older data pack)
    pub frontage: Option<bool>,
}

#[derive(Serialize, Clone)]
pub struct SubLot {
    pub area_m2: f64,
    pub geom: Value,
}

#[derive(Serialize, Clone)]
pub struct UseFit {
    pub use_def: UseDef,
    pub zone_ok: Option<bool>,
    pub note: String,
}

#[derive(Serialize, Clone)]
pub struct FormNeed {
    pub form: FormDef,
    pub reason: String,
}

#[derive(Serialize, Clone)]
pub struct Potential {
    pub area_m2: f64,
    pub frontage_m: Option<f64>,
    pub depth_m: Option<f64>,
    pub edges: Vec<Edge>,
    pub provisions: Option<ProvSet>,
    pub subdivision: Vec<String>,
    pub lots_by_area: Option<u32>,
    pub sketch: Vec<SubLot>,
    pub use_fit: Option<UseFit>,
    pub forms: Vec<FormNeed>,
    pub pda: bool,
}

fn kb<T: for<'de> Deserialize<'de>>(cell: &'static OnceLock<Vec<T>>, src: &'static str) -> &'static Vec<T> {
    cell.get_or_init(|| serde_json::from_str(src).expect("knowledge file"))
}
pub fn provisions_kb() -> &'static Vec<ProvSet> {
    static C: OnceLock<Vec<ProvSet>> = OnceLock::new();
    kb(&C, include_str!("../knowledge/provisions.json"))
}
pub fn uses_kb() -> &'static Vec<UseDef> {
    static C: OnceLock<Vec<UseDef>> = OnceLock::new();
    kb(&C, include_str!("../knowledge/uses.json"))
}
fn forms_kb() -> &'static Vec<FormDef> {
    static C: OnceLock<Vec<FormDef>> = OnceLock::new();
    kb(&C, include_str!("../knowledge/forms.json"))
}

fn norm(s: &str) -> String {
    s.to_lowercase().replace(['-', '_', '—'], " ")
}

fn zone_text(a: &Assessment) -> String {
    let parts: Vec<String> = a
        .zones
        .iter()
        .filter(|z| z.authority == "council")
        .map(|z| format!("{} {}", z.zone.name, z.raw))
        .collect();
    norm(&parts.join(" "))
}

fn match_provisions(text: &str) -> Option<ProvSet> {
    let zone_hit = |p: &ProvSet| p.zone.iter().any(|z| text.contains(&norm(z)));
    provisions_kb()
        .iter()
        .find(|p| zone_hit(p) && !p.precinct.is_empty() && p.precinct.iter().any(|x| text.contains(&norm(x))))
        .or_else(|| provisions_kb().iter().find(|p| zone_hit(p) && p.precinct.is_empty()))
        .cloned()
}

fn num(p: &Option<ProvSet>, key: &str) -> Option<f64> {
    p.as_ref()?.items.iter().find(|i| i.key.as_deref() == Some(key)).and_then(|i| i.n)
}

/// Lot outline in local metres (largest polygon's exterior ring).
fn ring_m(pm: &MultiPolygon<f64>, pr: &Proj) -> Vec<(f64, f64)> {
    let poly = pm.0.iter().max_by(|a, b| a.unsigned_area().total_cmp(&b.unsigned_area()));
    poly.map(|p| p.exterior().0.iter().map(|c| pr.xy(*c)).collect()).unwrap_or_default()
}

/// Merges consecutive, nearly collinear segments so curved/densified boundaries become readable sides.
fn sides(ring: &[(f64, f64)]) -> Vec<((f64, f64), (f64, f64))> {
    let mut out: Vec<((f64, f64), (f64, f64))> = Vec::new();
    for w in ring.windows(2) {
        let (a, b) = (w[0], w[1]);
        if ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt() < 0.05 {
            continue;
        }
        if let Some(last) = out.last_mut() {
            let d1 = (last.1 .0 - last.0 .0).atan2(last.1 .1 - last.0 .1);
            let d2 = (b.0 - a.0).atan2(b.1 - a.1);
            let mut diff = (d1 - d2).abs();
            if diff > std::f64::consts::PI {
                diff = 2.0 * std::f64::consts::PI - diff;
            }
            if diff < 12f64.to_radians() {
                last.1 = b;
                continue;
            }
        }
        out.push((a, b));
    }
    out
}

fn seg_dist(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 { (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    ((p.0 - a.0 - t * dx).powi(2) + (p.1 - a.1 - t * dy).powi(2)).sqrt()
}

/// Boundary segments (metres) of neighbouring lots, from the parcel spatial index (None if the pack has no index).
fn neighbour_segments(c: &Connection, p: &Parcel, pm: &MultiPolygon<f64>, pr: &Proj) -> Option<Vec<((f64, f64), (f64, f64))>> {
    let rect = geo::BoundingRect::bounding_rect(pm)?;
    let (px, py) = (3.0 / pr.kx, 3.0 / pr.ky);
    let mut st = c
        .prepare(
            "SELECT p.pid, p.geom FROM parcel_idx i JOIN parcels p ON p.pid = i.pid
             WHERE i.minx <= ?2 AND i.maxx >= ?1 AND i.miny <= ?4 AND i.maxy >= ?3 AND p.pid <> ?5 LIMIT 400",
        )
        .ok()?;
    let rows = st
        .query_map(rusqlite::params![rect.min().x - px, rect.max().x + px, rect.min().y - py, rect.max().y + py, p.pid], |r| {
            Ok(r.get::<_, String>(1)?)
        })
        .ok()?;
    let self_c = geo::Centroid::centroid(pm).map(|c| pr.xy(c.0));
    let mut segs = Vec::new();
    for g in rows.flatten() {
        let Some(nm) = to_geo(&g).ok().and_then(|g| polys(&g)) else { continue };
        // Strata/unit records repeat the same base lot: skip identical geometry.
        let nc = geo::Centroid::centroid(&nm).map(|c| pr.xy(c.0));
        if let (Some(a), Some(b)) = (self_c, nc) {
            if ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt() < 1.0 {
                continue;
            }
        }
        for poly in &nm.0 {
            for w in poly.exterior().0.windows(2) {
                segs.push((pr.xy(w[0]), pr.xy(w[1])));
            }
        }
    }
    Some(segs)
}

fn to_lonlat(pr: &Proj, x: f64, y: f64) -> Coord<f64> {
    Coord { x: x / pr.kx, y: y / pr.ky }
}

fn poly_m(pm: &MultiPolygon<f64>, pr: &Proj) -> MultiPolygon<f64> {
    MultiPolygon(
        pm.0.iter()
            .map(|p| {
                let ring = |l: &LineString<f64>| LineString(l.0.iter().map(|c| { let (x, y) = pr.xy(*c); Coord { x, y } }).collect());
                Polygon::new(ring(p.exterior()), p.interiors().iter().map(ring).collect())
            })
            .collect(),
    )
}

/// Equal-area strips perpendicular to the frontage direction `u` (an indicative layout only).
fn strips(lot_m: &MultiPolygon<f64>, u: (f64, f64), n: usize, pr: &Proj) -> Vec<SubLot> {
    let v = (-u.1, u.0);
    let ts: Vec<f64> = lot_m.0.iter().flat_map(|p| p.exterior().0.iter().map(|c| c.x * u.0 + c.y * u.1)).collect();
    let (tmin, tmax) = ts.iter().fold((f64::MAX, f64::MIN), |(a, b), t| (a.min(*t), b.max(*t)));
    let big = 1.0e4;
    let slab = |t0: f64, t1: f64| {
        let pt = |t: f64, s: f64| Coord { x: u.0 * t + v.0 * s, y: u.1 * t + v.1 * s };
        MultiPolygon(vec![Polygon::new(LineString(vec![pt(t0, -big), pt(t1, -big), pt(t1, big), pt(t0, big), pt(t0, -big)]), vec![])])
    };
    let cut = |t0: f64, t1: f64| catch_unwind(AssertUnwindSafe(|| lot_m.intersection(&slab(t0, t1)))).ok();
    let total = lot_m.unsigned_area();
    let mut cuts = vec![tmin - 1.0];
    for k in 1..n {
        let target = total * k as f64 / n as f64;
        let (mut lo, mut hi) = (tmin, tmax);
        for _ in 0..40 {
            let mid = (lo + hi) / 2.0;
            let a = cut(tmin - 1.0, mid).map(|m| m.unsigned_area()).unwrap_or(0.0);
            if a < target { lo = mid } else { hi = mid }
        }
        cuts.push((lo + hi) / 2.0);
    }
    cuts.push(tmax + 1.0);
    cuts.windows(2)
        .filter_map(|w| cut(w[0], w[1]))
        .map(|m| {
            let area = m.unsigned_area();
            let ll = MultiPolygon(
                m.0.iter()
                    .map(|p| Polygon::new(LineString(p.exterior().0.iter().map(|c| to_lonlat(pr, c.x, c.y)).collect()), vec![]))
                    .collect(),
            );
            SubLot { area_m2: area.round(), geom: geo_json(&ll) }
        })
        .collect()
}

fn forms_for(a: &Assessment, use_id: &str, pda: bool) -> Vec<FormNeed> {
    let has = |id: &str| forms_kb().iter().find(|f| f.id == id).cloned();
    let mut out = Vec::new();
    let mut add = |id: &str, reason: &str| {
        if let Some(form) = has(id) {
            out.push(FormNeed { form, reason: reason.into() });
        }
    };
    let dev = use_id != "general";
    if pda {
        add("pda", "The site is in a Priority Development Area, so EDQ assesses applications instead of Council.");
    } else {
        add("daform1", if dev { "Needed for the development application." } else { "Needed if you lodge a development application." });
    }
    if matches!(use_id, "house" | "dual" | "md" | "commercial" | "industry" | "datacentre") {
        add("daform2", "If the building work is assessable against the planning scheme or needs referral.");
    }
    if a.flags.iter().any(|f| f.rule.authority == "sara") {
        let what: Vec<&str> = a.flags.iter().filter(|f| f.rule.authority == "sara").map(|f| f.rule.title.as_str()).collect();
        add("sara", &format!("State referral triggers mapped on this lot: {}.", what.join("; ")));
    }
    if matches!(use_id, "datacentre" | "industry") {
        add("era", "Generators, fuel burning or chemical storage may be environmentally relevant activities.");
    }
    if matches!(use_id, "dual" | "md" | "rol" | "commercial" | "industry" | "datacentre") {
        add("water", "New or intensified use needs water and sewer approval.");
    }
    if matches!(use_id, "md" | "rol" | "industry" | "datacentre") {
        add("power", "New or upgraded electricity supply.");
    }
    if dev {
        add("qleave", "Payable before approval if the work value meets the threshold.");
    }
    out
}

pub fn potential(c: &Connection, a: &Assessment, use_id: &str) -> Result<Potential, String> {
    let p = &a.parcel;
    let pg = to_geo(&p.geom.to_string())?;
    let pm = polys(&pg).ok_or("Lot geometry is not a polygon")?;
    let rect = geo::BoundingRect::bounding_rect(&pm).ok_or("Empty lot")?;
    let pr = Proj::new(rect.center().y);
    let lot_m = poly_m(&pm, &pr);
    let area = p.area_m2.filter(|x| *x > 0.0).unwrap_or_else(|| lot_m.unsigned_area());

    // Sides and frontage
    let neigh = neighbour_segments(c, p, &pm, &pr);
    let mut edges = Vec::new();
    let mut front_dirs: Vec<(f64, (f64, f64))> = Vec::new();
    let ring = ring_m(&pm, &pr);
    for (a0, a1) in sides(&ring) {
        let len = ((a1.0 - a0.0).powi(2) + (a1.1 - a0.1).powi(2)).sqrt();
        let frontage = neigh.as_ref().map(|segs| {
            let shared = [0.25, 0.5, 0.75].iter().filter(|t| {
                let q = (a0.0 + (a1.0 - a0.0) * *t, a0.1 + (a1.1 - a0.1) * *t);
                segs.iter().any(|(s0, s1)| seg_dist(q, *s0, *s1) < 1.0)
            });
            shared.count() < 2
        });
        if frontage == Some(true) && len > 0.0 {
            front_dirs.push((len, ((a1.0 - a0.0) / len, (a1.1 - a0.1) / len)));
        }
        let mid = to_lonlat(&pr, (a0.0 + a1.0) / 2.0, (a0.1 + a1.1) / 2.0);
        edges.push(Edge { length_m: (len * 10.0).round() / 10.0, mid: [mid.x, mid.y], frontage });
    }
    let frontage_m = neigh.as_ref().map(|_| front_dirs.iter().map(|(l, _)| l).sum::<f64>());
    let main = front_dirs.iter().cloned().max_by(|a, b| a.0.total_cmp(&b.0)).or_else(|| {
        sides(&ring).iter().map(|(a0, a1)| {
            let l = ((a1.0 - a0.0).powi(2) + (a1.1 - a0.1).powi(2)).sqrt();
            (l, ((a1.0 - a0.0) / l.max(1e-9), (a1.1 - a0.1) / l.max(1e-9)))
        }).max_by(|a, b| a.0.total_cmp(&b.0))
    });
    let depth_m = main.map(|(l, _)| (area / l * 10.0).round() / 10.0);

    // Provisions and subdivision
    let pda = a.zones.iter().any(|z| z.authority == "pda");
    let text = zone_text(a);
    let provisions = match_provisions(&text);
    let mut subdivision = Vec::new();
    let mut lots_by_area = None;
    if pda {
        subdivision.push("The site is in a Priority Development Area: lot sizes and density come from the PDA development scheme, not City Plan.".into());
    }
    match num(&provisions, "min_front") {
        Some(min) => {
            let n = (area / min).floor() as u32;
            lots_by_area = Some(n);
            if n >= 2 {
                subdivision.push(format!("By area, up to {n} lots of at least {min:.0} m² each (minimum frontage, shape and access requirements also apply)."));
            } else if let Some(rear) = num(&provisions, "min_rear").filter(|r| area >= min + r) {
                subdivision.push(format!("1 front lot ({min:.0} m²) + 1 rear lot ({rear:.0} m² excluding the access handle) may be possible by area."));
            } else {
                subdivision.push(format!("Not enough area for 2 lots: needs at least {:.0} m² (2 × {min:.0} m²); this lot is {area:.0} m².", 2.0 * min));
            }
            if let Some(cmin) = num(&provisions, "min_front_centre") {
                let k = (area / cmin).floor() as u32;
                if k > n && k >= 2 {
                    subdivision.push(format!("If within 300 m walking distance of a centre: up to {k} lots of {cmin:.0} m² (Council confirms walking distance and other criteria)."));
                }
            }
        }
        None if !pda => subdivision.push("No minimum lot size recorded for this zone in the app yet. Refer to the Subdivision code (Table of minimum lot sizes) in City Plan.".into()),
        None => {}
    }
    if let Some(d) = num(&provisions, "min_dual_occ") {
        subdivision.push(if area >= d { format!("Meets the {d:.0} m² minimum lot size for a dual occupancy (subject to criteria).") } else { format!("Below the {d:.0} m² minimum for a dual occupancy.") });
    }
    if let Some(d) = num(&provisions, "min_site_md") {
        subdivision.push(if area >= d { format!("Meets the {d:.0} m² minimum site for multiple dwellings, if in a Key Location.") } else { format!("Below the {d:.0} m² minimum site for multiple dwellings.") });
    }
    if let Some(f) = frontage_m {
        subdivision.push(format!("Measured open boundary (likely road frontage): {f:.1} m."));
    }
    let sketch = match (lots_by_area, main) {
        (Some(n), Some((_, u))) if n >= 2 && !pda => strips(&lot_m, u, n.min(8) as usize, &pr),
        _ => Vec::new(),
    };

    // Proposed use
    let use_fit = uses_kb().iter().find(|u| u.id == use_id && u.id != "general").map(|u| {
        let zone_ok = (!u.zones.is_empty()).then(|| u.zones.iter().any(|z| text.contains(&norm(z))));
        let note = match (pda, zone_ok) {
            (true, _) => "PDA site: check the PDA development scheme's land-use plan for this use.".to_string(),
            (_, Some(true)) => "The zone generally contemplates this use. The level of assessment depends on the precinct, scale and overlays.".to_string(),
            (_, Some(false)) => "This use is not typical in this zone. Expect impact assessment (public notification), and approval is less likely.".to_string(),
            _ => String::new(),
        };
        UseFit { use_def: u.clone(), zone_ok, note }
    });

    Ok(Potential {
        area_m2: area.round(),
        frontage_m: frontage_m.map(|f| (f * 10.0).round() / 10.0),
        depth_m,
        edges,
        provisions,
        subdivision,
        lots_by_area,
        sketch,
        use_fit,
        forms: forms_for(a, use_id, pda),
        pda,
    })
}

/// Facts for the AI (compact).
pub fn facts(pot: &Potential) -> Value {
    json!({
        "lot_area_m2": pot.area_m2, "frontage_m": pot.frontage_m, "approx_depth_m": pot.depth_m,
        "provisions": pot.provisions.as_ref().map(|p| json!({"set": p.title, "items": p.items.iter().map(|i| json!({"item": i.label, "value": i.value, "source": i.source, "verify": i.verify})).collect::<Vec<_>>()})),
        "subdivision": pot.subdivision,
        "indicative_lots": pot.sketch.iter().map(|s| s.area_m2).collect::<Vec<_>>(),
        "proposed_use": pot.use_fit.as_ref().map(|u| json!({"use": u.use_def.name, "planning_use_term": u.use_def.term, "zone_generally_supports": u.zone_ok, "note": u.note, "key_requirements": u.use_def.checks})),
        "forms_needed": pot.forms.iter().map(|f| json!({"form": f.form.name, "lodge_with": f.form.to, "why": f.reason})).collect::<Vec<_>>(),
    })
}

/// Contours from Queensland's state service (LiDAR 1 m, else 5 m), clipped around the lot. Needs internet.
pub async fn contours(p: &Parcel) -> Result<Value, String> {
    let pg = to_geo(&p.geom.to_string())?;
    let pm = polys(&pg).ok_or("Lot geometry is not a polygon")?;
    let rect = geo::BoundingRect::bounding_rect(&pm).ok_or("Empty lot")?;
    let pr = Proj::new(rect.center().y);
    let (px, py) = (30.0 / pr.kx, 30.0 / pr.ky);
    let env = format!("{},{},{},{}", rect.min().x - px, rect.min().y - py, rect.max().x + px, rect.max().y + py);
    let base = "https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Elevation/Contours/MapServer";
    for (layer, label) in [(30, "LiDAR 1 m contours"), (20, "LiDAR 5 m contours"), (10, "10 m contours")] {
        let url = format!(
            "{base}/{layer}/query?where=1%3D1&geometry={env}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&outSR=4326&f=geojson&resultRecordCount=2000"
        );
        let body = reqwest::get(&url).await.map_err(|_| "Contours need an internet connection.".to_string())?.text().await.map_err(e)?;
        let v: Value = serde_json::from_str(&body).map_err(e)?;
        let feats = v["features"].as_array().cloned().unwrap_or_default();
        if feats.is_empty() {
            continue;
        }
        // Elevation attribute name varies by dataset: take the first numeric field that looks like elevation.
        let elev = |f: &Value| -> Option<f64> {
            f["properties"].as_object()?.iter().find_map(|(k, v)| {
                let k = k.to_lowercase();
                (k.contains("elev") || k.contains("contour") || k.contains("height") || k == "value").then(|| v.as_f64()).flatten()
            })
        };
        let on_lot: Vec<f64> = feats
            .iter()
            .filter(|f| {
                serde_json::from_value::<geojson::Geometry>(f["geometry"].clone())
                    .ok()
                    .and_then(|g| geo::Geometry::<f64>::try_from(g.value).ok())
                    .map(|g| geo::Intersects::intersects(&pm, &g))
                    .unwrap_or(false)
            })
            .filter_map(elev)
            .collect();
        let (lo, hi) = on_lot.iter().fold((f64::MAX, f64::MIN), |(a, b), x| (a.min(*x), b.max(*x)));
        let diag = {
            let (a, b) = (pr.xy(rect.min()), pr.xy(rect.max()));
            ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt()
        };
        let stats = (!on_lot.is_empty()).then(|| {
            json!({"min_m": lo, "max_m": hi, "fall_m": ((hi - lo) * 10.0).round() / 10.0,
                   "approx_slope_pct": if diag > 0.0 { ((hi - lo) / diag * 1000.0).round() / 10.0 } else { 0.0 }})
        });
        let lines: Vec<Value> = feats.iter().map(|f| json!({"type": "Feature", "properties": {"elev": elev(f)}, "geometry": f["geometry"]})).collect();
        return Ok(json!({"source": label, "stats": stats, "features": lines}));
    }
    Err("No contour data found for this area.".into())
}
