//! Modular data packs: a Base pack per council plus add-on topics, merged into the installed pack.
use rusqlite::Connection;
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

fn e<T: ToString>(x: T) -> String { x.to_string() }

pub fn valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 60 && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// Tag must match ^modpack-[A-Za-z0-9._-]+$
pub fn valid_tag(t: &str) -> bool {
    t.strip_prefix("modpack-").is_some_and(|r| !r.is_empty() && r.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)))
}

/// (tag, catalogue url) of the newest published modular release.
pub fn find_modpack(list: &Value) -> Option<(String, String)> {
    for r in list.as_array()? {
        let tag = r["tag_name"].as_str().unwrap_or("");
        if !valid_tag(tag) || r["draft"].as_bool() == Some(true) { continue; }
        if let Some(url) = r["assets"].as_array().and_then(|a| a.iter().find(|a| a["name"] == "modules.json")).and_then(|a| a["browser_download_url"].as_str()) {
            return Some((tag.to_string(), url.to_string()));
        }
    }
    None
}

fn run(c: &Connection, sql: &str) -> Result<(), String> { c.execute_batch(sql).map_err(e) }
fn count(c: &Connection, sql: &str, id: &str) -> i64 { c.query_row(sql, [id], |r| r.get(0)).unwrap_or(0) }

/// Adds the module file (an uncompressed pack) to the open read-write pack. Layers and lots already there are skipped.
pub fn merge(c: &Connection, module: &Path, id: &str) -> Result<(), String> {
    c.busy_timeout(Duration::from_secs(60)).map_err(e)?;
    c.execute("ATTACH DATABASE ?1 AS m", [module.to_string_lossy().as_ref()]).map_err(e)?;
    let r = (|| -> Result<(), String> {
        run(c, "BEGIN")?;
        run(c, "CREATE TEMP TABLE newl AS SELECT lid FROM m.layers WHERE lid NOT IN (SELECT lid FROM main.layers) AND dataset_id NOT IN (SELECT dataset_id FROM main.layers)")?;
        run(c, "INSERT INTO main.layers SELECT * FROM m.layers WHERE lid IN (SELECT lid FROM newl)")?;
        run(c, "INSERT INTO main.features SELECT * FROM m.features WHERE lid IN (SELECT lid FROM newl)")?;
        run(c, "INSERT INTO main.feature_idx SELECT * FROM m.feature_idx WHERE fid IN (SELECT fid FROM m.features WHERE lid IN (SELECT lid FROM newl))")?;
        run(c, "INSERT INTO main.parcel_idx SELECT * FROM m.parcel_idx WHERE pid NOT IN (SELECT pid FROM main.parcels)")?;
        run(c, "INSERT INTO main.parcels SELECT * FROM m.parcels WHERE pid NOT IN (SELECT pid FROM main.parcels)")?;
        run(c, "DROP TABLE newl")?;
        // manifest: union of councils (counts recomputed), module list
        let get = |db: &str, k: &str| -> Option<String> { c.query_row(&format!("SELECT value FROM {db}.manifest WHERE key=?1"), [k], |r| r.get(0)).ok() };
        let parse = |s: Option<String>| -> Vec<Value> { s.and_then(|s| serde_json::from_str::<Vec<Value>>(&s).ok()).unwrap_or_default() };
        let mut list = parse(get("main", "councils"));
        for n in parse(get("m", "councils")) {
            if !list.iter().any(|x| x["id"] == n["id"]) { list.push(n); }
        }
        for x in list.iter_mut() {
            let cid = x["id"].as_str().unwrap_or("").to_string();
            x["parcels"] = count(c, "SELECT count(*) FROM main.parcels WHERE council=?1", &cid).into();
            x["layers"] = count(c, "SELECT count(*) FROM main.layers WHERE council=?1", &cid).into();
        }
        let names: Vec<&str> = list.iter().filter_map(|x| x["name"].as_str()).collect();
        let mut mods: Vec<String> = get("main", "modules").or_else(|| get("main", "module")).unwrap_or_default().split(',').filter(|s| !s.is_empty()).map(String::from).collect();
        if !mods.iter().any(|x| x == id) { mods.push(id.to_string()); }
        let tot = |t: &str| -> i64 { c.query_row(&format!("SELECT count(*) FROM main.{t}"), [], |r| r.get(0)).unwrap_or(0) };
        for (k, v) in [
            ("councils", serde_json::to_string(&list).map_err(e)?), ("region", names.join(", ")),
            ("parcels", tot("parcels").to_string()), ("layers", tot("layers").to_string()), ("modules", mods.join(",")),
        ] {
            c.execute("INSERT OR REPLACE INTO main.manifest VALUES(?1,?2)", [k, v.as_str()]).map_err(e)?;
        }
        run(c, "COMMIT")
    })();
    if r.is_err() { let _ = run(c, "ROLLBACK"); }
    let _ = run(c, "DETACH DATABASE m");
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(path: &Path, build: &str, councils: &str, layers: &[(i64, &str, &str)], parcels: &[(i64, &str)]) {
        let _ = std::fs::remove_file(path);
        let c = Connection::open(path).unwrap();
        c.execute_batch("CREATE TABLE manifest(key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE parcels(pid INTEGER PRIMARY KEY, lotplan TEXT, address TEXT, suburb TEXT, search TEXT, area REAL, props TEXT, geom TEXT, council TEXT);
            CREATE TABLE layers(lid INTEGER PRIMARY KEY, dataset_id TEXT UNIQUE, title TEXT, n INTEGER, authority TEXT, council TEXT);
            CREATE TABLE features(fid INTEGER PRIMARY KEY, lid INTEGER, props TEXT, geom TEXT);
            CREATE VIRTUAL TABLE feature_idx USING rtree(fid, minx, maxx, miny, maxy);
            CREATE VIRTUAL TABLE parcel_idx USING rtree(pid, minx, maxx, miny, maxy);").unwrap();
        c.execute("INSERT INTO manifest VALUES('build',?1)", [build]).unwrap();
        c.execute("INSERT INTO manifest VALUES('councils',?1)", [councils]).unwrap();
        c.execute("INSERT INTO manifest VALUES('module','x-base')", []).unwrap();
        for (lid, did, co) in layers {
            c.execute("INSERT INTO layers VALUES(?1,?2,?2,1,'council',?3)", rusqlite::params![lid, did, co]).unwrap();
            c.execute("INSERT INTO features VALUES(?1,?2,'{}','{}')", [lid * 10, *lid]).unwrap();
            c.execute("INSERT INTO feature_idx VALUES(?1,0,1,0,1)", [lid * 10]).unwrap();
        }
        for (pid, co) in parcels {
            c.execute("INSERT INTO parcels VALUES(?1,'L','a','s','x',1.0,'{}','{}',?2)", rusqlite::params![pid, co]).unwrap();
            c.execute("INSERT INTO parcel_idx VALUES(?1,0,1,0,1)", [pid]).unwrap();
        }
    }

    #[test]
    fn merges_addon_and_skips_duplicates() {
        let d = std::env::temp_dir();
        let (a, b) = (d.join("mod_test_main.sqlite"), d.join("mod_test_add.sqlite"));
        mk(&a, "b1", r#"[{"id":"logan","name":"Logan City Council"}]"#, &[(1, "zoning", "logan")], &[(1, "logan"), (2, "logan")]);
        mk(&b, "b1", r#"[{"id":"logan","name":"Logan City Council"},{"id":"ipswich","name":"Ipswich City Council"}]"#,
            &[(1, "zoning", "logan"), (2, "flood", "logan")], &[(2, "logan"), (3, "ipswich")]);
        let c = Connection::open(&a).unwrap();
        merge(&c, &b, "logan-flood").unwrap();
        let n = |t: &str| -> i64 { c.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0)).unwrap() };
        assert_eq!((n("layers"), n("features"), n("feature_idx")), (2, 2, 2));
        assert_eq!((n("parcels"), n("parcel_idx")), (3, 3));
        let m = |k: &str| -> String { c.query_row("SELECT value FROM manifest WHERE key=?1", [k], |r| r.get(0)).unwrap() };
        assert_eq!(m("parcels"), "3");
        assert_eq!(m("layers"), "2");
        assert_eq!(m("modules"), "x-base,logan-flood");
        assert_eq!(m("region"), "Logan City Council, Ipswich City Council");
        drop(c);
        let _ = std::fs::remove_file(&a);
        let _ = std::fs::remove_file(&b);
    }

    #[test]
    fn finds_catalogue() {
        let v = serde_json::json!([
            {"tag_name":"datapack-1"},
            {"tag_name":"modpack-b1","assets":[{"name":"modules.json","browser_download_url":"u"}]}]);
        assert_eq!(find_modpack(&v), Some(("modpack-b1".into(), "u".into())));
        assert!(valid_id("logan-flood") && !valid_id("../x") && valid_tag("modpack-t20-1") && !valid_tag("datapack-1"));
    }
}
