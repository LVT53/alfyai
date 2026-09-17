import { beforeEach, describe, expect, it, vi } from "vitest";

// Records the order of everything the loader does to the library, so the test
// can prove the worker URL is in place *before* anyone can build a Map.
const calls: string[] = [];
const setWorkerUrlMock = vi.fn((url: string) => {
	calls.push(`setWorkerUrl:${url}`);
});

vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));
vi.mock("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url", () => ({
	default: "/mock-maplibre-worker.js",
}));
vi.mock("maplibre-gl", () => ({
	setWorkerUrl: (url: string) => setWorkerUrlMock(url),
	Map: class {
		constructor() {
			calls.push("new Map");
		}
	},
}));

import { loadMapLibre, resetMapLibreLoaderForTests } from "./maplibre-loader";

describe("loadMapLibre", () => {
	beforeEach(() => {
		resetMapLibreLoaderForTests();
		calls.length = 0;
		setWorkerUrlMock.mockClear();
	});

	// The bug this whole module exists for: with no worker URL set, MapLibre 6.x
	// derives one from its own chunk's `import.meta.url` with a runtime-built
	// filename, which Vite cannot see and therefore never emits — a 404 and a
	// route line that silently never draws.
	it("points MapLibre at the bundled worker asset, and does so before the module is usable", async () => {
		const maplibregl = await loadMapLibre();

		expect(setWorkerUrlMock).toHaveBeenCalledWith("/mock-maplibre-worker.js");
		// Nothing was constructed before the URL was set — the caller only gets
		// the module after `setWorkerUrl` has run.
		expect(calls).toEqual(["setWorkerUrl:/mock-maplibre-worker.js"]);

		new maplibregl.Map({} as never);
		expect(calls).toEqual(["setWorkerUrl:/mock-maplibre-worker.js", "new Map"]);
	});

	it("loads once for the page no matter how many cards mount", async () => {
		const [first, second] = await Promise.all([loadMapLibre(), loadMapLibre()]);
		await loadMapLibre();

		expect(first).toBe(second);
		expect(setWorkerUrlMock).toHaveBeenCalledTimes(1);
	});
});
