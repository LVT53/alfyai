import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs build script, no type declarations
import { checkBuiltWorkerAssets } from "./check-built-worker-assets.mjs";

const dirs: string[] = [];

function makeClientDir(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "worker-assets-"));
	dirs.push(root);
	for (const [relative, contents] of Object.entries(files)) {
		const full = join(root, relative);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, contents, "utf8");
	}
	return root;
}

// The exact shape MapLibre GL 6.x compiles to: the worker filename is picked at
// runtime, so the bundler cannot see it and never emits the file.
const MAPLIBRE_CHUNK = `function u(){let e=import.meta.url;let t=e.endsWith("-dev.mjs")?"maplibre-gl-worker-dev.mjs":"maplibre-gl-worker.mjs";return new URL("./"+t,e).href}`;

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("checkBuiltWorkerAssets", () => {
	it("flags a worker the build references but never emitted", async () => {
		const root = makeClientDir({
			"_app/immutable/chunks/maplibre.js": MAPLIBRE_CHUNK,
		});

		const { missing } = await checkBuiltWorkerAssets(root);

		expect(
			missing.map((entry: { reference: string }) => entry.reference),
		).toEqual(["maplibre-gl-worker-dev.mjs", "maplibre-gl-worker.mjs"]);
		expect(missing[0].from).toEqual(["_app/immutable/chunks/maplibre.js"]);
	});

	it("passes once the hashed worker asset is emitted", async () => {
		const root = makeClientDir({
			"_app/immutable/chunks/maplibre.js": MAPLIBRE_CHUNK,
			"_app/immutable/workers/maplibre-gl-worker-TyRVyR1X.js":
				"(function(){})()",
		});

		const { missing, emitted } = await checkBuiltWorkerAssets(root);

		expect(missing).toEqual([]);
		expect(emitted).toEqual([
			"_app/immutable/workers/maplibre-gl-worker-TyRVyR1X.js",
		]);
	});

	// pdf.js has the same runtime fallback (`./pdf.worker.mjs`) while the app
	// emits and wires the minified build — one family, two spellings.
	it("treats a .min build as the same worker as its unminified fallback name", async () => {
		const root = makeClientDir({
			"_app/immutable/chunks/pdf.js":
				'let s=new URL("./pdf.worker.mjs",import.meta.url).href;',
			"_app/immutable/chunks/pdf-url.js":
				'export default "../assets/pdf.worker.min.iDqQPrd3.mjs";',
			"_app/immutable/assets/pdf.worker.min.iDqQPrd3.mjs": "// worker",
		});

		const { missing } = await checkBuiltWorkerAssets(root);

		expect(missing).toEqual([]);
	});

	it("reports nothing for a build with no workers at all", async () => {
		const root = makeClientDir({ "_app/immutable/chunks/app.js": "export{}" });

		const { references, missing } = await checkBuiltWorkerAssets(root);

		expect(references.size).toBe(0);
		expect(missing).toEqual([]);
	});
});
