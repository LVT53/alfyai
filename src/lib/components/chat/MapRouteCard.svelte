<script lang="ts">
// Inline map card for a completed map_route tool call — styled like the
// chart/CSV cards (Chart.svelte, CsvTable.svelte). Renders BELOW the tool
// line in the message body (wired in MessageBubble.svelte), never inside
// ThinkingBlock's panel.
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
import type { I18nKey } from "$lib/i18n";
import { t } from "$lib/i18n";
import type { ToolCallMapData } from "$lib/server/services/messages-types";

let { map }: { map: ToolCallMapData } = $props();

let container: HTMLDivElement | null = $state(null);
let mounted = $state(false);
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
function accentColor(): string {
	if (typeof getComputedStyle === "undefined") return "#c15f3c";
	const value = getComputedStyle(document.documentElement)
		.getPropertyValue("--accent")
		.trim();
	return value || "#c15f3c";
}

function modeKey(mode: ToolCallMapData["mode"]): I18nKey | null {
	if (mode === "drive") return "mapCard.mode.drive";
	if (mode === "walk") return "mapCard.mode.walk";
	if (mode === "bike") return "mapCard.mode.bike";
	return null;
}

function formatDistance(meters: number | undefined): string {
	if (meters == null || !Number.isFinite(meters)) return "";
	if (meters < 1000) return `${Math.round(meters)} m`;
	return `${(meters / 1000).toFixed(1)} km`;
}

function formatDuration(seconds: number | undefined): string {
	if (seconds == null || !Number.isFinite(seconds)) return "";
	const mins = Math.round(seconds / 60);
	if (mins < 60) return `${mins} min`;
	const hours = Math.floor(mins / 60);
	const rem = mins % 60;
	return rem > 0 ? `${hours} h ${rem} min` : `${hours} h`;
}

let headerRoute = $derived(
	map.originLabel && map.destinationLabel
		? `${map.originLabel} → ${map.destinationLabel}`
		: (map.originLabel ?? map.destinationLabel ?? ""),
);

let headerSummary = $derived(
	[
		formatDistance(map.distanceM),
		formatDuration(map.durationS),
		(() => {
			const key = modeKey(map.mode);
			return key ? $t(key) : "";
		})(),
	]
		.filter((part) => part.length > 0)
		.join(" · "),
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
			}
			for (const marker of map.markers ?? []) {
				new maplibregl.Marker({ color: accent })
					.setLngLat([marker.lng, marker.lat])
					.addTo(instance);
			}
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
</script>

<div class="map-route-card" data-testid="map-route-card">
	<div class="map-route-card__header">
		<span class="map-route-card__route">{headerRoute}</span>
		{#if headerSummary}
			<span class="map-route-card__summary">{headerSummary}</span>
		{/if}
	</div>
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
			{#each fallbackMarkers as marker, index (index)}
				<circle cx={marker.x} cy={marker.y} r="2.2" fill="var(--accent)" />
			{/each}
		</svg>
	</div>
	<div class="map-route-card__attribution">{$t('mapCard.attribution')}</div>
</div>

<style>
	.map-route-card {
		margin: var(--space-sm) 0;
		border: 1px solid var(--border-default);
		border-radius: 0.5rem;
		background: var(--surface-page);
		overflow: hidden;
	}

	.map-route-card__header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-sm);
		padding: 0.5rem 0.75rem;
		font-size: 0.84rem;
		border-bottom: 1px solid var(--border-default);
	}

	.map-route-card__route {
		font-weight: 600;
		color: var(--text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.map-route-card__summary {
		color: var(--text-muted);
		white-space: nowrap;
		flex-shrink: 0;
	}

	.map-route-card__body {
		position: relative;
		width: 100%;
		height: 260px;
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
		padding: 0.25rem 0.5rem;
		text-align: right;
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
