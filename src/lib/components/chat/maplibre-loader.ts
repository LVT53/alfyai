// The single place MapLibre GL is loaded from, so every map surface in the app
// gets the same worker wiring.
//
// WHY THIS EXISTS. MapLibre GL 6.x resolves its own worker at runtime with
//
//     const here = import.meta.url;
//     const name = here.endsWith('-dev.mjs')
//         ? 'maplibre-gl-worker-dev.mjs'
//         : 'maplibre-gl-worker.mjs';
//     return new URL(`./${name}`, here).href;
//
// — a TEMPLATE literal whose filename is chosen at runtime. Vite only emits an
// asset for the statically analysable `new URL("literal", import.meta.url)`
// form, so it never emitted `maplibre-gl-worker.mjs` into the client build; the
// bundled maplibre chunk then asked the server for a sibling file that did not
// exist and got a 404. The map still drew raster tiles and DOM markers (no
// worker needed) but the GeoJSON route line never appeared, and MapLibre
// swallowed the failure, so nothing was logged.
//
// THE FIX. `?worker&url` makes Vite bundle the worker entry — including its
// `./maplibre-gl-shared.mjs` import, which a plain `?url` would have left
// dangling — into a real hashed asset under `_app/immutable/` and hand us its
// URL. We pass that to the library's documented `setWorkerUrl()` escape hatch
// before the first Map is constructed.
//
// CSP. The URL is same-origin, so MapLibre takes its `new Worker(url, {type:
// 'module'})` branch directly: no cross-origin fetch, and above all no
// `URL.createObjectURL(new Blob([...]))` shim built from a source string. That
// keeps us inside `worker-src 'self' blob:` with no `'unsafe-eval'` (see the
// `kit.csp` block in svelte.config.js and the runtime CSP_MODE switch in
// src/hooks.server.ts). MapLibre 6.x ships no `-csp` dist variant any more —
// its dist is maplibre-gl.mjs / -shared.mjs / -worker.mjs only — and it does
// not need one: the blob path is only a fallback for a CROSS-ORIGIN worker
// URL, which a self-hosted, Vite-emitted asset never is.
//
// Everything stays lazy: this module is only ever dynamic-imported from a
// client-side code path, so neither MapLibre nor the worker asset is pulled
// into the entry bundle, and SSR never evaluates the `?worker&url` import.
import type * as MapLibreGl from "maplibre-gl";

type MapLibreModule = typeof MapLibreGl;

let maplibrePromise: Promise<MapLibreModule> | null = null;

/**
 * Dynamic-imports MapLibre GL, its stylesheet and its worker asset, points the
 * library at the worker, and returns the module. Memoised: the worker URL is
 * set exactly once per page, before any Map exists.
 */
export function loadMapLibre(): Promise<MapLibreModule> {
	if (!maplibrePromise) {
		maplibrePromise = (async () => {
			const [maplibregl, workerUrl] = await Promise.all([
				import("maplibre-gl"),
				import("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url").then(
					(module) => module.default,
				),
				import("maplibre-gl/dist/maplibre-gl.css"),
			]);
			// Must happen before the first `new maplibregl.Map(...)`: the worker
			// pool is spun up on the first map and caches the URL it resolved.
			maplibregl.setWorkerUrl(workerUrl);
			return maplibregl;
		})().catch((error) => {
			// Don't cache a rejected promise — a transient chunk-load failure
			// should not permanently disable every map on the page.
			maplibrePromise = null;
			throw error;
		});
	}

	return maplibrePromise;
}

/** Test seam: drops the memoised module so a spec can observe a fresh load. */
export function resetMapLibreLoaderForTests(): void {
	maplibrePromise = null;
}
