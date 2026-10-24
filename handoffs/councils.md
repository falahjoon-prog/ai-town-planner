# Council data sources and the council registry

Researched 24 Oct 2026 (T19). Each council is one entry in `src-tauri/knowledge/councils.json`, which both the
data pack pipeline (`pipeline/build_datapack.py`) and the app read. Rule data for councils other than Brisbane is
in `src-tauri/knowledge/council_rules.json`. Brisbane keeps its own files (zones.json, rules.json,
provisions.json, uses.json, setbacks.json).

## Statewide sources (all councils)

| Data | Endpoint | Licence | Fields used |
|---|---|---|---|
| Cadastral parcels | `https://spatial-gis.information.qld.gov.au/arcgis/rest/services/PlanningCadastre/LandParcelPropertyFramework/MapServer/4` (maxRecordCount 4000, GeoJSON) | CC BY 4.0, State of Queensland | lot, plan, lotplan, tenure, lot_area, parcel_typ, cover_typ, locality, shire_name, feat_name |
| Address points | same service, layer `0` (Addresses) | CC BY 4.0, State of Queensland | lotplan, unit_number, street_number / street_no_1(+suffix) / street_no_2, street_name, street_type, street_suffix, locality, local_authority |
| State layers | `STATE_LAYERS` in the pipeline (SARA triggers, koala, wetlands, vegetation, coastal, PDA, SEQ land use, protected plants, easements, GA electricity) | CC BY 4.0 | resolved by layer name |

LGA names as they appear in the data (checked with the discover runs): `shire_name` / `local_authority` =
"Brisbane City", "Logan City", "Moreton Bay City", "Ipswich City", "Redland City", "Gold Coast City", "Mackay Regional". The pipeline matches these values exactly (with upper- and title-case variants).

## Brisbane City Council (unchanged)

- Parcels: BCC `property_boundaries_parcel` FeatureServer (services2.arcgis.com/dEKgZETqwmDAh1rP), CC BY 4.0.
- Layers: every `cp14-*` dataset on data.brisbane.qld.gov.au (Opendatasoft API), CC BY 4.0.
- Scheme: Brisbane City Plan 2014. Rules: existing Brisbane knowledge files.

## Logan City Council

- Planning scheme: Logan Planning Scheme 2015, v9.2 (July 2025) with TLPI No. 1/2024 (flood, from 6 March 2025).
  The map service list also has `Logan_Planning_Scheme_v9_2_TLPI_No_1_2026_20261015`, i.e. a TLPI No. 1/2026 from
  October 2026; the pipeline picks the newest service automatically. Draft "Logan Plan" is not in effect.
- Scheme documents (PDF and Word, per part): `https://s3-ap-southeast-2.amazonaws.com/lcc-docs-planning/root/Logan%20Planning%20Scheme%202015/LPS%202015%20V9.2%20(July%202025)/Documents%20(LPS%20V9.2)/`
- Map service: `https://arcgis.lcc.wspdigital.com/server/rest/services/LoganHub` folder, services
  `Logan_Planning_Scheme_v<ver>[_TLPI_No_1_<year>]_<yyyymmdd>` (MapServer, maxRecordCount 2000, GeoJSON).
  Registry pattern `LoganHub/Logan_Planning_Scheme_v\d+_\d+(_TLPI_No_1_\d{4})?_\d{8}`, newest by date suffix
  (OverlaysOnly, Superseded and DRAFT services are excluded by the pattern).
- Licence: ArcGIS item 12cfd36ecb7540e093c22a64090a11b6 ("Logan Planning Scheme 2015 v9.2 TLPI No.1 2024"):
  Creative Commons Attribution 3.0 Australia; copyright text "LCC Business Branches". Council says the PDF maps prevail.
  Logan's open data hub (data-logancity.opendata.arcgis.com) lists the same overlays.
- Layers loaded: top-level groups "Zones and Precincts (Part 6)", "Overlays (Part 8)", "Local Plans (Part 7)";
  figure labels, lineage, locations, streetscape and place-making figures are skipped.
  - Zones: `ZM-01.00 Zone map`, field `Zone` (e.g. "Centre", "Low density residential").
  - Precincts: `ZM-02.00 Precinct map`, fields `Precinct`, `Precinct_Code`, `Description` (precinct role, merged into the zone in the app).
  - Overlays (Part 8): OM-01 Acid sulfate soils, OM-02 Biodiversity areas (vegetation management, corridors incl. koala corridor,
    locally significant vegetation, MSES/MLES), OM-03 Bushfire hazard, OM-04 Extractive resources, OM-05.01–05.04 flood
    (isolation areas, Meadowbrook, localised flood assessment areas, flood planning areas `FPA`), OM-06 Greenbank Training Area,
    OM-07 Heritage, OM-08 Landslide hazard and steep slopes, OM-09 Regional infrastructure (substations, powerlines, pipelines,
    SEQWater, wastewater), OM-10 Residential overlay, OM-11 Strategic airport environs, OM-12 Transport noise corridors,
    OM-13 Water resource catchments, OM-14 Waterways, wetlands, erosion prone areas. Overlay fields: `Cat_Desc`, `Ovl_Cat`,
    `Ovl2_Desc`, `Ovl2_Cat`, `OM_Desc` (flood: `FPA`).
  - Local plans: `Local plan boundary` (`Local_Plan`), `Precinct area` (`Local_Plan`, `Local_Plan_Precinct`, `Precinct_Code`),
    local plan precinct and building-height figures.
- Not loaded: LGIP (Part 4), PSP figures (Schedule 6), development code figures (Part 9).

## City of Moreton Bay

- Planning scheme: MBRC Planning Scheme 2016, version 7 (Better Housing Amendment, from 30 October 2024; v7.1 administrative
  amendment from 23 June 2025). Council resolved in January 2026 to replace it; the new scheme has not commenced.
- Services: `https://services-ap1.arcgis.com/152ojN3Ts9H3cdtl/arcgis/rest/services` (FeatureServer, maxRecordCount 1000).
- Licence: Creative Commons Attribution 4.0 International (ArcGIS item 9e142c14e15a43cfac2cc5bae953ea62 "MBRC Planning
  Scheme - Zones", owner moretonbaygis; access information "MBRC 2020"). Also listed on data.gov.au as "City of Moreton Bay's Data Hub".
- Layers loaded (service name patterns in the registry):
  - Zones: `ZM_Zones_Dissolved_WebMercator_OpenData` layer 0, fields `LVL1_ZONE` (zone), `ZONE_PREC` (precinct), `LP`, `LP_PREC`
    (local plan and its precinct). (`ZM_Zones_WebMercator_OpenData` is the same split by lot and is much larger;
    `ZM_Zones_Precincts_WebMercator_OpenData` has only `ZONE_PREC`.)
  - Local plans: `MBRC_PlanningScheme_ZM_LocalPlanBoundary` (`LP`, `OM_Label`), `MBRC_PlanningScheme_ZM_LocalPlanPrecincts`.
  - Overlays `OM_*_WebMercator_OpenData`: Building heights, Coastal hazard (storm tide), Community activities and neighbourhood
    hubs, Environmental areas, Flood hazard, Infrastructure buffers (lines, points, polygons), Overland flow path, Riparian and
    wetland setbacks, Road hierarchy, Rural residential lot sizes.
  - Overlays `MBRC_PlanningScheme_*`: Environmental offsets, Extractive resources, Flood hazard DIA, Heritage areas, Significant
    trees, Landslide hazard, North Lakes locality, Acid sulfate soils, Active transport, Building height exceptions, Bushfire
    hazard, Centre walking distance, Coastal hazard (erosion prone area), Walking distance (train station), Waterways, Scenic
    amenity, Strategic framework place types, Stormwater catchments, Transport noise.
  - `PlanningScheme_Temporary_Local_Planning_Instruments` (TLPI 01/2026 and 02/2026, Narangba East).
- Scheme text: the PDF parts on moretonbay.qld.gov.au could not be opened from this workspace (blocked; owner away);
  rule rows use council info sheets (`.../Planning-Schemes/MBRC/Info-Sheets/...`) and are all `verify: true`.

## Ipswich City Council (T20: lots and addresses only)

- Planning scheme: Ipswich City Plan 2025 (commenced 1 July 2025), online in ISOPlan (`ipswich.isoplan.com.au/eplan`).
- Parcels and addresses: Queensland cadastre filtered by `Ipswich City`. Bbox from the state LGA layer (lga_code 3960).
- No zone or overlay endpoint: the council's ArcGIS server was not reachable and data.gov.au only has the superseded 2006 scheme.
  Registry `zones_loaded: false` and `layers: []`; the app shows "Zone not loaded for this council yet" with a link to the ISOPlan map.
- Rules: secondary dwelling and dual occupancy summaries from the council "Housing in Ipswich" page (not scheme text, verify). An always-on rule lists the
  overlays to check by hand. Part 5, zone codes and the Dwelling and Dual Occupancy Code were not readable.

## Redland City Council (T20)

- Planning scheme: Redland City Plan, Version 14 (commenced 10 November 2025); the new Redlands Coast City Plan is not in effect.
- Parcels and addresses: Queensland cadastre filtered by `Redland City`.
- Zones and overlays: Redland open data FeatureServer `Current_Version_<n>_City_Plan_Zones_and_Overlays` on `services7.arcgis.com/VGRM775aS3HJEeB7`
  (newest version picked). Zone layer `City Plan - Zones` (`QPP_Description` zone, `QPP_Precinct` precinct such as LDR2); all other layers are overlays
  (bushfire, flood and storm tide, landslide, coastal, environmental significance, waterways and wetlands, heritage, airport, noise, extractive, catchments,
  regional infrastructure). The precinct boundary layer is skipped. Licence is not stated on the service: confirm with council before redistributing.
- Rules: council zone checklists, a 2019 minor-amendment report and the MDR code review; every row verify. Part 5, 6 and 9 of the scheme PDF were not readable.

## City of Gold Coast (T20)

- Planning scheme: Gold Coast City Plan Version 13 (commenced 9 December 2025). A third-party site claims a Version 14: not confirmed.
- Parcels and addresses: Queensland cadastre filtered by `Gold Coast City` (the council's cadastre copy is dated October 2024 and is not used).
- Zones and overlays: `City_Plan_Version_<n>_Open_Data` FeatureServer on `services-ap1.arcgis.com/lnVW0dLI3fvST2hd` (newest version), CC BY 4.0. Zone layer `Zone`
  (`LVL1_ZONE`, `ZONE_PRECINCT`); the property boundaries layer and Context are skipped; all other layers are overlays, including Minimum lot size (`MLS`),
  Residential density (`RESIDENTIAL_DENSITY`), Building height (`HEIGHT_IN_METRES`), Dwelling house overlay area, Flood assessment required, Bushfire hazard area, Heritage place.
- Not loaded: the non-statutory Flood Risk Overlay 2026, Bushfire_Risk_2026 and Landslide_Susceptibility_Extent_2026 services (licence not stated).
- Rules: council Dwellings page and a consultant report quoting the scheme (Neighbourhood centre); third-party (landintel.com.au) rows are labelled and verify.

## Mackay Regional Council (T20: lots and addresses only)

- Planning scheme: Mackay Region Planning Scheme 2017, version 5.0 (commenced 15 June 2026).
- Parcels and addresses: Queensland cadastre filtered by `Mackay Regional`. The research bbox (148.149..152.678) includes offshore sea, so it is clipped to
  [148.15, -21.77, 149.7, -20.37]; state layers are loaded for that envelope only.
- No zone or overlay endpoint (MiMAPS has no public REST service; zone and overlay maps are PDFs). Registry `zones_loaded: false`; the app links to MiMAPS.
- Rules: council user guides (secondary summaries), shown zone by zone under each proposed use because the lot's zone is unknown; all rows verify.

## Brisbane v37 (T20)

- Heritage overlay datasets in the catalogue are now `cp14-heritage-overlay-state-heritage-area`, `...-local-heritage-area` and `...-area-adjoining`
  (the old `cp14-heritage-overlay` id is gone); the Brisbane test build uses the local heritage area one.
- `council_rules.json` has a `brisbane` entry for values the main files have no row for (dwelling house in Medium density residential, multiple dwellings and
  reconfiguring a lot in Low-medium density residential, lot-size thresholds in Low density and Rural residential, Queensland Housing Code setbacks for
  Low-medium and Medium density lots of 450 m² and over). The app only uses them where uses.json / setbacks.json have no zone-specific row; existing
  Brisbane data is never overwritten.

## Other leads

- Gold Coast, Ipswich, Redland and Mackay are in the registry (above). Any other council: follow "Adding a council".

## Registry format (`src-tauri/knowledge/councils.json`)

One object per council; the array order sets parcel ids (`pid = index * 100,000,000 + source object id`; Brisbane must stay first).

| Key | Used by | Meaning |
|---|---|---|
| `id` | both | Short id stored on parcels and layers (`council` column) |
| `name`, `short` | app | Full and short council name (site header, badges, search results) |
| `scheme`, `scheme_url`, `scheme_docs_url` | app | Planning scheme name and links ("Not loaded yet – see …") |
| `maps_url`, `maps_name`, `website` | app | Maps dialog entry for the site's council |
| `da_url`, `da_name` | app | DA register button |
| `lodge_name`, `lodge_url` | app (dev.rs) | DA Form 1/2 lodgement text and link |
| `water` `{name,url}` | app (dev.rs) | Water and sewer provider for the forms list and charge note |
| `zones_loaded` | app, dev.rs | `false` when the council has no zone or overlay data in the pack (Ipswich, Mackay): the app says "Zone not loaded for this council yet" and links `maps_url` |
| `licence`, `attribution` | pipeline manifest, docs | Licence summary |
| `title_prefix` | both | Prefix of layer titles (e.g. "Logan — "); the flood legend strips it |
| `bbox` `[minx,miny,maxx,maxy]` | pipeline | WGS84 envelope; parcels are filtered by LGA name inside it, and state layers are loaded once per council bbox (so a council outside SEQ, e.g. Mackay, just needs its own bbox) |
| `pipeline.parcels` | pipeline | `{"kind":"bcc"}` or `{"kind":"qld_cadastre","lga":["Logan City"]}` (exact names as in `shire_name`/`local_authority`; matched without upper() so the server index is used) |
| `pipeline.layers[]` | pipeline | `{"kind":"bcc_cp14"}` or an `arcgis` source (below) |
| `pipeline.test` | pipeline | `{"bbox":[…]}` small area for `--test` (council layers and parcels clipped to it), or Brisbane's `parcel_limit` / `only` |
| `samples` | discover | Address lookups printed by `--discover` |

`arcgis` source keys: `root` (services folder URL), `services` (regexes matched against the folder's service names) or
`service` (explicit URL list), `service_type` (MapServer/FeatureServer), `pick` (`newest` = one service with the latest
8-digit date / version, or `all`), `groups` (top-level group names to include; empty = all), `zoning` / `precincts` (regexes
on layer, group or service name that mark the zone layer and a separate precinct layer), `zone_field` / `precinct_field`
(optional; otherwise guessed from field names), `skip` (regexes on layer or group name), `title_strip` (regex removed from
layer names). Layers are resolved by name at build time, so id changes don't break builds.

Data pack output: `parcels.council`, `layers.council` (NULL for state layers), `layers.dataset_id` =
`<council>:<zoning|precinct|overlay>:<service>:<layer id>:<label>`, zoning/precinct features get `zone` / `precinct`
props, parcels from the cadastre get BCC-style props (`LOT`, `PLAN_`, `LOTPLAN`, `LOT_AREA`, `SUBURB`, `TENURE_DESC`,
`PARCEL_TYP_DESC`, `OTHER_ADDRESSES`). Manifest `councils` = JSON list with id, name, scheme, parcels, layers.

## Rule data format (`src-tauri/knowledge/council_rules.json`)

`{ "<council id>": { "zones": [...], "rules": [...], "provisions": [...], "uses": {...}, "setbacks": {...} } }`

- `zones`: `{name, keywords, purpose, typical, source, url, verify}`; matched by the longest keyword in the zone + precinct text.
  Zones with no entry show the data's zone name and "Not loaded yet – see <scheme>".
- `rules`: same shape as rules.json plus `url`; they apply only to the council's own lots. An always-on `water` rule names
  the council's water provider.
- `provisions`: same shape as provisions.json (`zone`, `precinct` keywords, `items` with `source`, `url`, `verify`,
  optional `key`/`n`: `min_front`, `min_rear`, `min_dual_occ`, `min_site_md`).
- `uses`: per use id (`house`, `dual`, `md`, …) `{zones, checks, sources, rules:[{zone, level, items}]}`; first rule whose zone
  keywords match (zone, precinct or zone attributes) wins; `zone: []` matches any zone.
- `setbacks`: zone name → set (or list of sets with `precinct` keywords), same shape as setbacks.json.

Every row needs a source name and URL; use `verify: true` unless the text was read directly in the scheme. Never add
numbers that are not in a cited source.

## Adding a council

1. Add the registry entry (ids, names, links, bbox, parcel `lga` names, layer sources). Run the "Build data pack" workflow
   with `discover: true` and the council id: it publishes a `discover-*` release with the resolved services, layers,
   fields, sample rows, LGA names and sample address lookups.
2. Adjust `zoning` / `precincts` / `zone_field` / `skip` until the discover output is right, then run `test: true`.
3. Add sourced rule data under the council id in council_rules.json (optional; without it the app shows the zone names and
   overlays with "Not loaded yet" for numbers).
4. Releases: test builds are tagged `testpack-*`, full builds from a branch `branchpack-*`; only full builds from `main`
   are tagged `datapack-*`, which is the tag the app downloads.
