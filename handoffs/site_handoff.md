# Site hand-off file (Town Planner -> DesignAI)

Written by the "Send to DesignAI" button (Design check section). Desktop: `Documents\RHC\handoff\site_<lotplan>_<date>.json`. Web/phone: a download.
Built in `src/handoff.ts` from the loaded site only; nothing is filled in. Screening aid only: not certified, not for construction.

JSON, UTF-8, `format: "rhc-site-handoff"`, `version: 1`. Metres, x east, y north, origin = `frame.origin` (lon/lat).

| Key | Content |
|---|---|
| `createdAt`, `notice`, `scheme {name, council}` | ISO time; the screening note; planning scheme name and council id |
| `site` | `lotplan, address, suburb, council, areaM2, frontageM, depthM` (null when not loaded) |
| `frame` | `units, axes, origin {lon, lat}` |
| `lot.ring` | open lot ring in metres |
| `lot.edges` | `[{a, b, kind: front/side/rear, lengthM}]`, or null with `lot.edgesNote` saying why |
| `zones` | `[{name, precinct, authority, source, url, verify}]` |
| `setbacks` | `{title, source, rows:[{label, value, ref}]}` raw rows from the knowledge data (the right row depends on wall height and lot depth), or null with `setbacksNote` |
| `limits` | `height (m), storeys, siteCover (%), plotRatio (:1), parking (spaces), privateOpenSpace (m2)`: each `{value, unit, text, label, rule, source, url, verify}` or null. `value` is set only when the rule is one clear number; otherwise `value` is null and `text` holds the rule |
| `items` | every raw rule row `{label, value, source, url, verify}` |
| `overlays` | `[{title, authority, distanceM, coveragePct, polys, lines}]` in metres |

`verify: true` means the row is flagged "verify" in the app; keep it visible.
