import { render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallMapData } from "$lib/server/services/messages-types";

// Capture every MapLibre GL `Map` instantiation so the "WebGL available"
// path can be asserted without a real WebGL context. The dynamic
// `import("maplibre-gl")` inside the component resolves to this mock.
const constructedMaps: Array<{ options: unknown }> = [];
const removeMock = vi.fn();
const onMock = vi.fn();
const addSourceMock = vi.fn();
const addLayerMock = vi.fn();
const markerAddToMock = vi.fn();
const markerSetLngLatMock = vi.fn(() => ({ addTo: markerAddToMock }));

vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));
vi.mock("maplibre-gl", () => ({
	Map: class {
		constructor(options: unknown) {
			constructedMaps.push({ options });
		}
		on = onMock;
		remove = removeMock;
		addSource = addSourceMock;
		addLayer = addLayerMock;
	},
	Marker: class {
		setLngLat = markerSetLngLatMock;
	},
}));

import MapRouteCard from "./MapRouteCard.svelte";

function makeMap(overrides: Partial<ToolCallMapData> = {}): ToolCallMapData {
	return {
		bounds: {
			minLat: 52.5163,
			minLng: 13.3694,
			maxLat: 52.525,
			maxLng: 13.3777,
		},
		markers: [
			{ lat: 52.525, lng: 13.3694, label: "Berlin Hbf", kind: "origin" },
			{
				lat: 52.5163,
				lng: 13.3777,
				label: "Brandenburg Gate",
				kind: "destination",
			},
		],
		polyline: [
			[52.525, 13.3694],
			[52.52, 13.373],
			[52.5163, 13.3777],
		],
		distanceM: 2100,
		durationS: 1620,
		mode: "walk",
		originLabel: "Berlin Hbf",
		destinationLabel: "Brandenburg Gate",
		attribution: "© OpenStreetMap contributors",
		...overrides,
	};
}

// The project's global vitest setup (src/vitest-setup.ts) stubs
// HTMLCanvasElement.getContext to always return a truthy 2D-context-like
// object for Chart.js's benefit, ignoring the requested context type — so
// real jsdom's "no WebGL" behavior is masked by default in this suite.
// Each test here stubs getContext explicitly to the shape it needs instead
// of relying on either jsdom's or the global setup's default.
function stubWebgl(available: boolean) {
	const original = HTMLCanvasElement.prototype.getContext;
	// biome-ignore lint/suspicious/noExplicitAny: test stub, arbitrary context shape
	(HTMLCanvasElement.prototype as any).getContext = vi.fn((type: string) =>
		available && (type === "webgl" || type === "webgl2") ? {} : null,
	);
	return () => {
		HTMLCanvasElement.prototype.getContext = original;
	};
}

describe("MapRouteCard", () => {
	beforeEach(() => {
		constructedMaps.length = 0;
		removeMock.mockClear();
		onMock.mockClear();
		addSourceMock.mockClear();
		addLayerMock.mockClear();
		markerAddToMock.mockClear();
		markerSetLngLatMock.mockClear();
	});
	afterEach(() => {
		vi.clearAllMocks();
	});

	// Unified tool activity rows — this component is now only the map BODY of a
	// map_route activity row. The route line ("A → B") and the
	// distance/duration summary moved onto the row and its body summary line
	// (built by `tool-activity.ts`, covered by tool-activity.test.ts), so the
	// only text this component still owns is the attribution; the route name
	// survives here as the fallback drawing's accessible name.
	it("renders the OSM attribution and names the route on the fallback drawing", () => {
		const restore = stubWebgl(false);
		try {
			const { getByTestId, container } = render(MapRouteCard, {
				props: { map: makeMap() },
			});
			expect(getByTestId("map-route-card")).toBeTruthy();
			expect(container.textContent).toContain("© OpenStreetMap contributors");
			expect(getByTestId("map-route-fallback").getAttribute("aria-label")).toBe(
				"Berlin Hbf → Brandenburg Gate",
			);
		} finally {
			restore();
		}
	});

	it("no longer renders its own header chrome: no route line, no summary line", () => {
		const restore = stubWebgl(false);
		try {
			const { container } = render(MapRouteCard, { props: { map: makeMap() } });
			expect(container.textContent).not.toContain(
				"Berlin Hbf → Brandenburg Gate",
			);
			expect(container.textContent).not.toContain("2.1 km");
			expect(container.textContent).not.toContain("27 min");
		} finally {
			restore();
		}
	});

	it("skips the interactive map and renders the static SVG fallback when WebGL is unavailable", async () => {
		const restore = stubWebgl(false);
		try {
			const { queryByTestId, getByTestId } = render(MapRouteCard, {
				props: { map: makeMap() },
			});

			await waitFor(() => {
				expect(queryByTestId("map-route-canvas")).toBeNull();
			});
			const fallback = getByTestId("map-route-fallback");
			expect(fallback.tagName.toLowerCase()).toBe("svg");
			expect(
				fallback.classList.contains("map-route-card__fallback--screen-hidden"),
			).toBe(false);
			// Drawn from the simplified polyline: an M...L... path with 3 points.
			const path = fallback.querySelector("path");
			expect(path).toBeTruthy();
			expect(path?.getAttribute("d")).toMatch(
				/^M[\d.]+,[\d.]+ L[\d.]+,[\d.]+ L[\d.]+,[\d.]+$/,
			);
			// Start/end (+ any waypoint) markers as circles.
			expect(fallback.querySelectorAll("circle")).toHaveLength(2);
			// Never touches MapLibre when WebGL is unavailable.
			expect(constructedMaps).toHaveLength(0);
		} finally {
			restore();
		}
	});

	it("renders no path in the fallback when there is no polyline (still shows markers)", () => {
		const restore = stubWebgl(false);
		try {
			const { getByTestId } = render(MapRouteCard, {
				props: { map: makeMap({ polyline: undefined }) },
			});
			const fallback = getByTestId("map-route-fallback");
			expect(fallback.querySelector("path")).toBeNull();
			expect(fallback.querySelectorAll("circle")).toHaveLength(2);
		} finally {
			restore();
		}
	});

	it("mounts the interactive MapLibre map and hides the fallback when WebGL is available", async () => {
		const restore = stubWebgl(true);
		try {
			const { getByTestId, queryByTestId } = render(MapRouteCard, {
				props: { map: makeMap() },
			});

			await waitFor(() => {
				expect(constructedMaps).toHaveLength(1);
			});
			expect(queryByTestId("map-route-canvas")).toBeTruthy();
			const fallback = getByTestId("map-route-fallback");
			expect(
				fallback.classList.contains("map-route-card__fallback--screen-hidden"),
			).toBe(true);
		} finally {
			restore();
		}
	});
});

describe("MapRouteCard — highlighted stretch", () => {
	it("draws the hovered span on the fallback drawing", () => {
		const map = makeMap({
			polyline: [
				[52.525, 13.3694],
				[52.522, 13.372],
				[52.519, 13.375],
				[52.5163, 13.3777],
			],
		});
		const { getByTestId, queryByTestId, rerender } = render(MapRouteCard, {
			props: { map },
		});
		// Nothing highlighted until a step is hovered.
		expect(queryByTestId("map-route-highlight")).toBeNull();

		rerender({ map, highlightRange: [1, 2] as [number, number] });
		const highlight = getByTestId("map-route-highlight");
		// Two points -> one line segment.
		expect((highlight.getAttribute("d") ?? "").split("L")).toHaveLength(2);
	});

	it("ignores a span that no longer fits the drawn line", () => {
		const map = makeMap({
			polyline: [
				[52.525, 13.3694],
				[52.5163, 13.3777],
			],
		});
		const { queryByTestId } = render(MapRouteCard, {
			props: { map, highlightRange: [40, 90] as [number, number] },
		});
		expect(queryByTestId("map-route-highlight")).toBeNull();
	});
});
