# Deep links (T22)

Rule: every external button opens the exact page/result for its purpose. A parameterised link is used only where there is evidence for the format. Otherwise the app copies the address or lot/plan to the clipboard, opens the most specific page, and shows the toast "<Address|Lot/plan> copied – paste it into <field>". The button label says "(copies address)" / "(copies lot/plan)" / "(opens at this lot)". Code: `src/sitelink.ts`; destinations are data in `councils.json` (`maps_*`, `da_*`) and `maps.json` (`copy`, `field`). Checked 25 Oct 2026 (web search and fetch; direct HTTP to council hosts is blocked from the workspace).

## Verified parameterised deep link
| Target | Link | Evidence |
|---|---|---|
| Redland Red-e-map (zoomed to lot) | `https://redlandcity.maps.arcgis.com/apps/webappviewer/index.html?id=b3e7c450b99c4aa281ce24a9c747728f&marker={lng},{lat},,,,{address}&level=19` | Council page `redland.qld.gov.au/Planning-building-and-development/Development-tools-and-advice/Red-e-map` answers HTTP 302 to the `webappviewer/index.html?id=b3e7...` URL (observed). It is an ArcGIS Web AppBuilder viewer; `marker=x,y,wkid,title,icon,label` and `level=` are documented at https://doc.arcgis.com/en/web-appbuilder/latest/manage-apps/app-url-parameters.htm ("The map centers on the point, and level= zooms in"). Not seen: that the app's LOD table reaches level 19 (clamped if lower). |
| Queensland Globe, Property topic | `https://qldglobe.information.qld.gov.au/?topic=property` | Globe helpful hints (qldglobe.information.qld.gov.au/info/helpful-hints.html) names the `?topic=property` link; `?topic=land-valuations-information-on-queensland-globe` is on business.qld.gov.au Globe land valuations page. The Globe documents no parameter for a lot, address or coordinates (help-info/search.html: typed search only, lot on plan e.g. `1SP217659`), so the lot/plan is copied. |

## Fallback: copy + most specific page
| Button | Opens | Copies | Evidence for the page / why no deep link |
|---|---|---|---|
| Brisbane DA register (site panel, Approvals) | developmenti.brisbane.qld.gov.au/ | house number + street name ("10 Fenton") | Only `Home/FilterDirect?filters=DANumber%3DA006792403` (search by DA number) was found in the wild; no property/address filter is documented. brisbane.qld.gov.au "development near me (Development.i)" says to type the address, suburb or lot number in the location search; third-party guides (steffanharries.au, urpec.com.au) say to enter only "10 Fenton", not the full address. |
| Ipswich, Redland DA register | developmenti.ipswich.qld.gov.au/, developmenti.redland.qld.gov.au/ | same | Same Development.i product (Toowoomba's developmenti.tr.qld.gov.au page has the same Location search / Application search tabs). |
| Logan DA register | logan.qld.gov.au/planning-and-development/pd-hub (replaces the old pd-online page) | address | Council PD Hub page: "Development enquiry tool" and property search by address, lot/plan or property key. The page links no URL for the tools and documents no parameters. |
| Moreton Bay DA register (new) | moretonbay.qld.gov.au/Services/Building-Development/DA-Tracker | address | Page title "DA Tracker - City of Moreton Bay" returned by search on the council domain. The page body fetched had no tool link or parameters. |
| Gold Coast DA register | integrations.goldcoast.qld.gov.au/pdonline/ | address | Kept from T20. No parameters documented. |
| Mackay DA register | mackay.qld.gov.au/.../Mapping-and-Online-Services/eApplications | address | Kept from T20. |
| Brisbane City Plan online | cityplan.brisbane.qld.gov.au/eplan/ | address | layeredgeo.com.au guide: search bar with an Address / lot on plan drop-down; no URL parameter. The Development.i "Property Report" link points at this URL. |
| Logan ePlan / PD Hub map | logan.qld.gov.au/.../logan-eplan | address | Logan ePlan help guide: property search by typing in the search bar; it mentions a "Share link" but not its format. |
| Moreton Bay planning scheme map, Ipswich ePlan (ISOPlan), Mackay MiMAPS | existing registry pages | address | No documented URL parameter (MiMAPS: help guide is inside the app). |
| Gold Coast map | cityplan.goldcoast.qld.gov.au/eplan/ (replaces the generic "Planning our city" page) | address | URL taken from the T20 research; listed as "City Plan ePlan" by townplanning.com.au. |
| Queensland Globe | see above | lot/plan | |
| State planning mapping (SARA DAMS and SPP IMS) | planning.qld.gov.au/planning-framework/mapping | lot/plan | The page holds the DAMS and SPP IMS launch tiles; their target URLs and any parameters could not be read (tiles are images; no source documents a deep link). |
| FloodCheck Queensland | floodcheck.information.qld.gov.au/ | address | No parameter documentation found. |
| Title search (Info Broker by address / by lot-plan, Landchecker) | existing order pages | address or lot/plan | Order pages without documented parameters. |
| Suburb report, ABS | abs.gov.au/census/find-census-data/search-by-area | suburb | QuickStats URLs need an ABS SAL code (`quickstats/2021/SAL30420`); the app has no SAL code. |

## Non-site links made specific (found by search on the owner's or provider's own domain)
| Was | Now |
|---|---|
| Unitywater `/` (water rule, Moreton Bay) | unitywater.com/building-and-developing/developing/connecting-to-our-network |
| Logan water `/` | logan.qld.gov.au/planning-and-building/water-and-sewerage-development |
| Redland water `/` | redland.qld.gov.au/Water-supply-and-sewerage/Water-and-sewerage-connections |
| Gold Coast water `/` | goldcoast.qld.gov.au/Services/Water-sewerage/Water-sewerage-connections/Connecting-to-the-City%E2%80%99s-water-sewerage-network |
| Mackay water `/` | mackay.qld.gov.au/Residents/Water-and-Sewer/Water-and-Wastewater-Infrastructure (closest page found; not a connections page) |
| BYDA `/` | byda.com.au/before-you-dig/guide-to-free-plans/ |
| Urban Utilities `/` | the standard-connections page already used in councils.json |
| Powerlink `/` | powerlink.com.au/network-connections |
| Covered councils' "Website" buttons | removed (home pages); the registry `website` field is deleted |

## Not made specific
- "Website" and "DA applications" buttons for the ~70 other Queensland councils in maps.json (home pages or generic pages; not researched one by one).
- Queensland Heritage Register, QSpatial catalogue, EPBC Protected Matters Search: tool landing pages with no documented parameters; the heritage register URL is an old `environment.ehp.qld.gov.au` address that was not re-checked.
- Moreton Bay "My Property Look Up" (`moretonbay.qld.gov.au/mbrc-planning-scheme/mplu/`) is listed by a third party but could not be opened here, so it is not used.

## T23 verified lot-level links (live-tested 2026-10-25; resolved at click time, copy + open fallback on any failure)
| Target | Lookup | Opens | Notes |
|---|---|---|---|
| Brisbane, Redland, Ipswich DA registers (Development.i; site panel and Approvals) | Rust command `devi_land_number(host, term)` (no CORS): `GET https://<host>/Geo/AddressCompoundSearch?searchTerm=<lotplan>` -> `LotPlan[0].id`; if empty, the same search with the address (and the short "10 Fenton" form) -> `Address[0].id`. Host limited to the three developmenti.*.qld.gov.au hosts. | `https://<host>/Home/FilterDirect?filters=LandNumber=<id>` | Verified Brisbane 32RP850593 -> 10881172 ("28 Eden Elm St Calamvale"), Redland 111168 ("5 Bayford St Birkdale"). Ipswich lookup returns ids (1A Brisbane St -> 92879); FilterDirect assumed identical (same product). |
| Logan DA register and council map buttons | ArcGIS `Property_Report_LPS2015/FeatureServer/0/query` (CORS ok, TS fetch): `where=Formatted_Lot_Plan='Lot 9 RP 148066'` (app lotplan 9RP148066; prefer `Address_Type='P'`) -> `Property_Key` | `https://pdhub.logan.qld.gov.au/property-report/?propertyKey=<key>` | Verified 6 Gable St Rochedale South -> 220766: full property report (zoning, overlays, applications, survey plan, flood report). |
| Moreton Bay My Property Look Up / DA Tracker | none | copy + open | CMS page with captcha form; no deep link found. |

Code: `src/sitelink.ts` (`resolverFor`, `loganLotPlan`, `loganPropertyKey`, `resolveLotUrl`), `go()` in `src/main.ts`, `devi_land_number` in `src-tauri/src/lib.rs`. Tests: `npm test`.
