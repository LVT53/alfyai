<script lang="ts">
// The map BODY of a completed map_route activity row. Reduced (unified tool
// activity rows) from the former standalone card: the route label and the
// distance/duration summary now live on the activity row itself and in the
// body's own summary line, so this component renders only the map surface and
// its attribution — no header, no card border of its own. It is dynamic-
// imported by ToolActivityRow, never mounted eagerly.
//
// MapLibre GL is heavy and needs a live DOM/WebGL context, so — same
// discipline as Chart.svelte (chart.js/auto) and Mermaid.svelte (mermaid) —
// it is dynamic-imported LAZILY inside a client-only effect, never at module
// top-level, keeping it out of the entry bundle. Its tiles come from the
// server-side proxy at /api/map-tiles/[z]/[x]/[y].png (no self-hosted tile
// server yet — see that route's header comment for the one-line swap).
//
// A static SVG fallback (drawn from the already-simplified `map.polyline`)
// covers two cases with the SAME markup: (1) WebGL is unavailable in this
// browser — the interactive map never mounts and the SVG is shown instead;
// (2) printing — a WebGL canvas doesn't reliably rasterize on print, so the
// SVG fallback is always present in the DOM and a print stylesheet swaps it
// in regardless of WebGL support.
import { onMount } from "svelte";
import { t } from "$lib/i18n";
import type { ToolCallMapData } from "$lib/server/services/messages-types";

let {
	map,
	highlightRange = null,
	focusRange = null,
}: {
	map: ToolCallMapData;
	// [firstIndex, lastIndex] into `map.polyline`: the stretch the reader is
	// hovering in the directions list, drawn on top of the route line.
	highlightRange?: [number, number] | null;
	// The stretch they CLICKED, which the map pans and zooms to.
	focusRange?: [number, number] | null;
} = $props();

let container: HTMLDivElement | null = $state(null);
let mounted = $state(false);
// Flipped once the interactive map's style has loaded and its layers exist —
// the highlight effect below must never touch a source that is not there yet.
let mapLoaded = $state(false);
let webglAvailable = $state(false);
let renderFailed = $state(false);
let renderToken = 0;

type MapLibreModule = typeof import("maplibre-gl");
type MapLibreMapInstance = InstanceType<MapLibreModule["Map"]>;
let mapInstance: MapLibreMapInstance | null = null;

function detectWebgl(): boolean {
	if (typeof document === "undefined") return false;
	try {
		const canvas = document.createElement("canvas");
		return Boolean(
			canvas.getContext("webgl2") ||
				canvas.getContext("webgl") ||
				canvas.getContext("experimental-webgl"),
		);
	} catch {
		return false;
	}
}

// Reads the app's real accent token so the route line/markers follow the
// current theme (light `#c15f3c` / dark `#d4836b`) instead of a hardcoded
// hex baked into this component.
function themeColor(name: string, fallback: string): string {
	if (typeof getComputedStyle === "undefined") return fallback;
	const value = getComputedStyle(document.documentElement)
		.getPropertyValue(name)
		.trim();
	return value || fallback;
}

function accentColor(): string {
	return themeColor("--accent", "#c15f3c");
}

// The accessible name of the fallback drawing — the same origin -> destination
// route the activity row above it names.
let headerRoute = $derived(
	map.originLabel && map.destinationLabel
		? `${map.originLabel} → ${map.destinationLabel}`
		: (map.originLabel ?? map.destinationLabel ?? ""),
);

// Projects a [lat,lng] point into a 0..100 viewBox box (north-up, padded)
// using the map's own bounds — shared by the SVG path and the marker dots.
function project(lat: number, lng: number): [number, number] {
	const { minLat, minLng, maxLat, maxLng } = map.bounds;
	const latSpan = Math.max(maxLat - minLat, 1e-6);
	const lngSpan = Math.max(maxLng - minLng, 1e-6);
	const pad = 0.1;
	const x = (pad + (1 - 2 * pad) * ((lng - minLng) / lngSpan)) * 100;
	const y = (pad + (1 - 2 * pad) * (1 - (lat - minLat) / latSpan)) * 100;
	return [x, y];
}

let fallbackPathD = $derived.by(() => {
	const points = map.polyline ?? [];
	if (points.length < 2) return "";
	return points
		.map(([lat, lng], index) => {
			const [x, y] = project(lat, lng);
			return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
		})
		.join(" ");
});

let fallbackMarkers = $derived(
	(map.markers ?? []).map((marker) => {
		const [x, y] = project(marker.lat, marker.lng);
		return { x, y, kind: marker.kind ?? "point" };
	}),
);

// The hovered stretch, clamped to the drawn line. A range that no longer fits
// the polyline (a card persisted before its geometry was simplified further,
// say) yields no highlight rather than a line drawn to the wrong place.
function slicePolyline(
	range: [number, number] | null | undefined,
): [number, number][] {
	const points = map.polyline ?? [];
	if (!range || points.length < 2) return [];
	const start = Math.max(0, Math.min(range[0], range[1]));
	const end = Math.min(points.length - 1, Math.max(range[0], range[1]));
	if (end <= start) return [];
	return points.slice(start, end + 1);
}

let highlightPoints = $derived(slicePolyline(highlightRange));
let focusPoints = $derived(slicePolyline(focusRange));

let highlightPathD = $derived.by(() => {
	if (highlightPoints.length < 2) return "";
	return highlightPoints
		.map(([lat, lng], index) => {
			const [x, y] = project(lat, lng);
			return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
		})
		.join(" ");
});

async function instantiateMap() {
	const token = ++renderToken;
	if (!container) return;
	try {
		const [maplibregl] = await Promise.all([
			import("maplibre-gl"),
			import("maplibre-gl/dist/maplibre-gl.css"),
		]);
		if (token !== renderToken || !container) return;
		mapInstance?.remove();
		mapInstance = null;

		const accent = accentColor();
		const style: import("maplibre-gl").StyleSpecification = {
			version: 8,
			sources: {
				osm: {
					type: "raster",
					tiles: [`${window.location.origin}/api/map-tiles/{z}/{x}/{y}.png`],
					tileSize: 256,
					attribution: "",
				},
			},
			layers: [{ id: "osm", type: "raster", source: "osm" }],
		};
		const instance = new maplibregl.Map({
			container,
			style,
			bounds: [
				[map.bounds.minLng, map.bounds.minLat],
				[map.bounds.maxLng, map.bounds.maxLat],
			],
			fitBoundsOptions: { padding: 24 },
			attributionControl: false,
			interactive: false,
		});
		instance.on("load", () => {
			if (token !== renderToken) return;
			const polyline = map.polyline ?? [];
			if (polyline.length >= 2) {
				// The highlight rides ABOVE the route line, in the text colour, so
				// the hovered manoeuvre reads as "this bit" against the accent.
				instance.addSource("route-highlight", {
					type: "geojson",
					data: { type: "FeatureCollection", features: [] },
				});
				instance.addSource("route", {
					type: "geojson",
					data: {
						type: "Feature",
						properties: {},
						geometry: {
							type: "LineString",
							coordinates: polyline.map(([lat, lng]) => [lng, lat]),
						},
					},
				});
				instance.addLayer({
					id: "route-line",
					type: "line",
					source: "route",
					layout: { "line-join": "round", "line-cap": "round" },
					paint: { "line-color": accent, "line-width": 4 },
				});
				instance.addLayer({
					id: "route-highlight-line",
					type: "line",
					source: "route-highlight",
					layout: { "line-join": "round", "line-cap": "round" },
					paint: {
						"line-color": themeColor("--text-primary", "#1a1a1a"),
						"line-width": 6,
					},
				});
			}
			for (const marker of map.markers ?? []) {
				new maplibregl.Marker({ color: accent })
					.setLngLat([marker.lng, marker.lat])
					.addTo(instance);
			}
			if (token !== renderToken) return;
			mapLoaded = true;
		});
		instance.on("error", () => {
			if (token !== renderToken) return;
			renderFailed = true;
		});
		mapInstance = instance;
	} catch {
		if (token !== renderToken) return;
		renderFailed = true;
	}
}

onMount(() => {
	mounted = true;
	webglAvailable = detectWebgl();
	return () => {
		renderToken++;
		mapInstance?.remove();
		mapInstance = null;
	};
});

// Client-only: rebuilds the interactive map when it first becomes eligible
// (mounted + WebGL available + not already failed) and the container is
// bound. Guarded by `renderToken` the same way Chart.svelte guards its
// instantiate() against a superseded/unmounted async completion.
$effect(() => {
	if (!mounted || !webglAvailable || renderFailed) return;
	if (!container) return;
	void instantiateMap();
});

// Hovering a manoeuvre in the directions list paints its stretch on the map;
// clicking one also flies the viewport to it. Both are no-ops until the style
// has loaded, and both are wrapped because MapLibre throws on a source that a
// re-instantiation has already removed.
$effect(() => {
	const instance = mapInstance;
	const points = highlightPoints;
	if (!instance || !mapLoaded) return;
	try {
		const source = instance.getSource("route-highlight") as
			| import("maplibre-gl").GeoJSONSource
			| undefined;
		if (!source?.setData) return;
		source.setData(
			points.length >= 2
				? {
						type: "Feature",
						properties: {},
						geometry: {
							type: "LineString",
							coordinates: points.map(([lat, lng]) => [lng, lat]),
						},
					}
				: { type: "FeatureCollection", features: [] },
		);
	} catch {
		// A superseded map instance — nothing to update.
	}
});

$effect(() => {
	const instance = mapInstance;
	const points = focusPoints;
	if (!instance || !mapLoaded || points.length < 2) return;
	const lats = points.map(([lat]) => lat);
	const lngs = points.map(([, lng]) => lng);
	try {
		instance.fitBounds(
			[
				[Math.min(...lngs), Math.min(...lats)],
				[Math.max(...lngs), Math.max(...lats)],
			],
			{ padding: 40, maxZoom: 16, duration: 400 },
		);
	} catch {
		// Same guard as above.
	}
});
</script>

<div class="map-route-card" data-testid="map-route-card">
	<div class="map-route-card__body">
		{#if webglAvailable && !renderFailed}
			<div
				class="map-route-card__map"
				bind:this={container}
				data-testid="map-route-canvas"
			></div>
		{/if}
		<svg
			class="map-route-card__fallback"
			class:map-route-card__fallback--screen-hidden={webglAvailable &&
				!renderFailed}
			viewBox="0 0 100 100"
			preserveAspectRatio="xMidYMid meet"
			role="img"
			aria-label={headerRoute}
			data-testid="map-route-fallback"
		>
			{#if fallbackPathD}
				<path
					d={fallbackPathD}
					fill="none"
					stroke="var(--accent)"
					stroke-width="1.5"
					stroke-linecap="round"
					stroke-linejoin="round"
					vector-effect="non-scaling-stroke"
				/>
			{/if}
			{#if highlightPathD}
				<path
					d={highlightPathD}
					fill="none"
					stroke="var(--text-primary)"
					stroke-width="2.5"
					stroke-linecap="round"
					stroke-linejoin="round"
					vector-effect="non-scaling-stroke"
					data-testid="map-route-highlight"
				/>
			{/if}
			{#each fallbackMarkers as marker, index (index)}
				<circle cx={marker.x} cy={marker.y} r="2.2" fill="var(--accent)" />
			{/each}
		</svg>
	</div>
	<div class="map-route-card__attribution">{$t('mapCard.attribution')}</div>
</div>

<style>
	.map-route-card {
		width: 100%;
		min-width: 0;
	}

	.map-route-card__body {
		position: relative;
		width: 100%;
		height: 180px;
		border: 1px solid var(--border-subtle);
		border-radius: 5px;
		overflow: hidden;
		background: var(--surface-code, var(--surface-page));
	}

	.map-route-card__map {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}

	.map-route-card__fallback {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}

	.map-route-card__fallback--screen-hidden {
		display: none;
	}

	.map-route-card__attribution {
		padding: 2px 0 0;
		font-size: 10px;
		color: var(--text-muted);
	}

	/* A WebGL canvas doesn't reliably rasterize on print — always fall back to
	   the SVG rendering there, regardless of on-screen WebGL support. */
	@media print {
		.map-route-card__map {
			display: none !important;
		}
		.map-route-card__fallback {
			display: block !important;
		}
	}
</style>
