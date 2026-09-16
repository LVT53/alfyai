# Maps And Routing

AlfyAI answers distance, route, travel-time, and transit questions with the app-owned `map_route`
tool, and renders inline map cards backed by a tile proxy. The exact environment variables are in
[docs/configuration.md](configuration.md#maps-and-routing); this document explains how the pieces fit
together.

## The `map_route` tool

`map_route` is registered only when `ORS_BASE_URL` is set. `ORS_BASE_URL` is a self-hosted
OpenRouteService v2 API base **including** the path prefix, e.g. `http://127.0.0.1:8088/ors`. Empty
means the tool is not registered at all.

- `GEOCODER_BASE_URL` points at a Nominatim `/search` endpoint so the model can route by place name.
  Without it, the model must pass explicit lat/lng coordinates.
- `ORS_COVERAGE_LABEL` (e.g. `Hungary`) is shown to the model so it can explain an out-of-coverage
  miss instead of reporting routing as "unavailable".

## Inline map cards and the tile proxy

Map cards are drawn with `maplibre-gl`. Raster tiles are served through the app's own proxy at
`GET /api/map-tiles/[z]/[x]/[y]`, which fetches from `MAP_TILE_UPSTREAM_BASE_URL` (default
`https://tile.openstreetmap.org`) and caches tiles on disk in `MAP_TILES_DIR` (2GB / 30-day cap).

There is no self-hosted tile server today, so this proxies OSM's standard raster tiles. To move to a
self-hosted tile server later, change only `MAP_TILE_UPSTREAM_BASE_URL`. When using OSM's public
tiles, set `MAP_TILE_CONTACT` (an email or URL) so the proxy sends an identifying User-Agent, and
respect OSM's tile usage policy: no bulk prefetch, visible attribution, identifying UA.

## On-demand routing coverage

By default routing covers only the fixed region behind `ORS_BASE_URL`. With
`ROUTING_ON_DEMAND_ENABLED=true`, a point outside every loaded region triggers a download of the
matching Geofabrik extract and a graph build in a dedicated OpenRouteService container, managed via
Docker.

- The app talks to Docker through `DOCKER_HOST`. Point it at a filtered docker-socket-proxy (see
  [deploy/README.md](../deploy/README.md#routing-coverage--sandbox-infrastructure)) so the app user
  needs no docker-group (root-equivalent) access.
- The fixed `ORS_BASE_URL` instance stays registered as the legacy region
  (`ROUTING_LEGACY_REGION_ID`, a Geofabrik id such as `hungary`); the app never starts or stops that
  container.
- Each on-demand region runs in its own `alfyai-ors-<region>` container, published on the
  `ROUTING_REGION_PORT_RANGE` (default `127.0.0.1:8300-8399`). A non-resident region is stopped after
  `ROUTING_REGION_IDLE_MINUTES` without use and restarted on demand (the graph stays on disk, so a
  restart takes a minute or two). Regions listed in `ROUTING_RESIDENT_REGION_IDS` are built on start
  and never stopped.
- Extracts are stored in `ROUTING_REGIONS_DIR` and built with the `ROUTING_ORS_IMAGE` image, each
  container sized to `ROUTING_REGION_XMX`. `ROUTING_REGION_MAX_PBF_MB` caps a single extract; above
  the cap is a permanent failure, not a retry.
- `ROUTING_GEOCODER_IMPORT_CONTAINER` names a running Nominatim container that each new region is
  `nominatim add-data`'d into (its `/regions` mount must be `ROUTING_REGIONS_DIR`).

### Extract mirrors

Geofabrik is the primary extract source and is verified against its published `.md5`. When
`download.geofabrik.de` cannot serve the `.osm.pbf` (its index can stay up while the extracts 502 —
that happened for days in September 2026), the app falls back to `ROUTING_EXTRACT_MIRRORS`
(default `https://download.openstreetmap.fr/extracts`), tried in order. The region name is remapped
for each mirror (hyphens become underscores, plus a small alias table, e.g.
`ireland-and-northern-ireland` → `ireland`). Mirrors publish no checksum, so their `Content-Length`
must match exactly. Not every Geofabrik region exists on every mirror (osm.fr has no `hungary`).

## Public transport timetables (GTFS)

`map_route`'s `transit` / `timetable` actions are served by an ORS `public-transport` profile built
from GTFS feeds. `ROUTING_GTFS_FEEDS` controls which feeds each region uses.

**Leave `ROUTING_GTFS_FEEDS` empty (or set it to `catalogue`)** to use the shipped feed catalogue in
[`src/lib/server/services/routing/gtfs-catalogue.ts`](../src/lib/server/services/routing/gtfs-catalogue.ts),
which provides national coverage for the three regions it covers:

| Region | Coverage |
|---|---|
| `hungary` | 21 feeds — MÁV/GYSEV rail, Volánbusz coaches, BKK Budapest, and the city operators. Hungary publishes no single national feed, so this bundle **is** one. |
| `ireland-and-northern-ireland` | The NTA's combined 104-agency feed (Republic only — Translink publishes none). |
| `netherlands` | OVapi's national feed, including NS rail. |

To take control, list regions explicitly with the syntax `regionId=url|url,regionId=url`, where `|`
separates the feeds of one region and `,` separates regions. `regionId=catalogue` opts one region back
into the shipped catalogue. Example:

```
ROUTING_GTFS_FEEDS=hungary=catalogue,austria=https://a.test/a.zip|https://a.test/b.zip
```

A region you name explicitly gets exactly those feeds; a region you do not name gets none. ORS takes a
single `gtfs_file` string, but GraphHopper 4.14 comma-splits it and loads each path as its own feed,
so the profile is built from the comma-joined list of the feeds that downloaded. (Adding feeds to the
region behind `ORS_BASE_URL` promotes it to a managed container.)

### Feed exclusions and the MÁV licence note

`ROUTING_GTFS_FEED_EXCLUDE` drops feeds from whatever the line above resolves to, as `regionId:feedId`
pairs (`regionId:*` drops a whole region).

**Licence note:** the Hungarian rail feed `mav-gysev` is MÁV's own data relayed by `menetbrand.com`,
and MÁV asks GTFS users to file its (free) request form. Set
`ROUTING_GTFS_FEED_EXCLUDE=hungary:mav-gysev` unless you have filed that form. Excluding it drops rail
from Hungarian journeys; Volánbusz coaches and the city networks stay.

### Refresh and size limits

- `ROUTING_GTFS_REFRESH_DAYS` (default `7`) is the default staleness before a feed is re-downloaded
  and its public-transport graph rebuilt. A catalogue feed's own cadence wins (BKK daily, small city
  feeds fortnightly). Because a rebuild restarts the region's container, it is only ever *started*
  between 03:00 and 05:00 local time; an admin "Refresh timetable" ignores that window. Refreshes send
  `If-None-Match` / `If-Modified-Since`, so an unchanged feed costs a 304, not a transfer.
- `ROUTING_GTFS_MAX_MB` (default `600`) caps a single GTFS download. Feeds publish no checksum, so
  integrity rests on an exact `Content-Length` match *when the server sends one* (several Hungarian
  city feeds are generated per request and send none) plus the zip magic number. A feed that fails
  costs only that operator's trips — the region still builds from the rest.

## Host setup

The Docker socket proxy and self-hosted Nominatim that back on-demand routing are installed once with
`sudo bash deploy/install-routing-infra.sh`. See
[deploy/README.md](../deploy/README.md#routing-coverage--sandbox-infrastructure) for the full host
setup and the `.env` values it expects.
