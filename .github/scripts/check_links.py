"""Checks every link in src/maps.json; failures become build annotations (warnings, not errors)."""
import json, urllib.request
d = json.load(open("src/maps.json"))
urls = [(s["name"], s["url"]) for s in d["state"]] + [(c["name"], u) for c in d["councils"] for u in (c["website"], c.get("map")) if u]
import glob
for f in glob.glob("src-tauri/knowledge/*.json"):  # every URL in the knowledge files
    def walk(v):
        if isinstance(v, dict):
            for k, x in v.items():
                if isinstance(x, str) and x.startswith("http") and k in ("url", "lodge_url"):
                    urls.append((f, x))
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
    walk(json.load(open(f)))
urls = list(dict.fromkeys(urls))
bad = []
for name, url in urls:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        urllib.request.urlopen(req, timeout=20).close()
    except Exception as e:
        code = getattr(e, "code", None)
        if code in (401, 403, 405, 429):  # reachable but blocks bots
            continue
        bad.append(f"{name} {url} -> {e}")
print(f"{len(urls)} links checked, {len(bad)} broken")
if bad:  # one annotation (GitHub caps annotations per step)
    print("::warning title=Broken map links::" + "%0A".join(bad))
