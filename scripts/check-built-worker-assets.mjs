// Build guard: every Web Worker a client chunk can ask for must actually be
// emitted into the client build.
//
// WHY THIS EXISTS. MapLibre GL and pdf.js both resolve their worker script by
// NAME at runtime — `new URL(\`./${name}\`, import.meta.url)` with the name
// picked from a variable. Vite can only emit an asset for the statically
// analysable form, so a bundle can happily ship a chunk that asks the server
// for `maplibre-gl-worker.mjs` while no such file was ever written to
// build/client. Nothing fails at build time; at runtime the browser gets a 404
// and the library swallows it (MapLibre's raster tiles and markers still draw,
// only the GeoJSON route line silently disappears). That shipped once — see
// src/lib/components/chat/maplibre-loader.ts — and this guard is what makes it
// impossible to ship again.
//
// WHAT IT CHECKS. Scan every built client script for worker-looking filename
// literals, then require that each one has a matching EMITTED file. Matching is
// by family rather than by exact name, because the emitted asset is
// content-hashed (`maplibre-gl-worker.B1c2D3e4.js`) while the reference in the
// library's fallback path is the bare package filename
// (`maplibre-gl-worker.mjs`). A family is the reference's basename with:
//   - the extension dropped,
//   - a `-dev` / `.dev` suffix dropped: those are the libraries' development
//     twins, only ever chosen when the importing module's own URL ends in
//     `-dev.mjs`, which a hashed production chunk never does,
//   - `.min` dropped, since a package may ship `x.worker.mjs` and
//     `x.worker.min.mjs` as the same worker.
// A reference passes when some emitted file's family equals it, or extends it
// with a `.`/`-` separated hash segment.
//
// This deliberately does NOT try to prove a given literal is reachable. The
// question it answers is the one that broke production: "this build mentions a
// worker by name — did the build emit that worker at all?"
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";

const DEFAULT_CLIENT_DIR = join("build", "client");

// Filename literals that look like a worker script: anything with "worker" in
// the basename and a JS extension, optionally preceded by a path.
const WORKER_REFERENCE = /[\w.@/-]*worker[\w.-]*\.(?:mjs|cjs|js)/gi;
const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

async function listFiles(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const full = join(dir, entry.name);
			return entry.isDirectory() ? listFiles(full) : [full];
		}),
	);
	return files.flat();
}

/** `maplibre-gl-worker-dev.mjs` -> `maplibre-gl-worker`; `a.worker.min.mjs` -> `a.worker`. */
export function workerFamily(reference) {
	let name = basename(reference.split("?")[0].split("#")[0]);
	const extension = extname(name);
	if (extension) name = name.slice(0, -extension.length);
	name = name.replace(/[.-]min$/i, "");
	name = name.replace(/[.-]dev$/i, "");
	return name;
}

/** True when `emitted` is the reference's family, or that family plus a hash segment. */
export function satisfies(emittedFamily, referenceFamily) {
	return (
		emittedFamily === referenceFamily ||
		emittedFamily.startsWith(`${referenceFamily}.`) ||
		emittedFamily.startsWith(`${referenceFamily}-`)
	);
}

/**
 * @param {string} clientDir directory of the built client (build/client)
 * @returns {Promise<{references: Map<string, string[]>, missing: Array<{reference: string, from: string[]}>, emitted: string[]}>}
 */
export async function checkBuiltWorkerAssets(clientDir) {
	const files = await listFiles(clientDir);
	const emittedFamilies = files.map((file) => workerFamily(file));

	/** @type {Map<string, Set<string>>} reference literal -> chunks mentioning it */
	const references = new Map();
	for (const file of files) {
		if (!SCRIPT_EXTENSIONS.has(extname(file))) continue;
		const source = await readFile(file, "utf8");
		for (const match of source.matchAll(WORKER_REFERENCE)) {
			const reference = match[0];
			if (!references.has(reference)) references.set(reference, new Set());
			references.get(reference).add(relative(clientDir, file));
		}
	}

	const missing = [];
	for (const [reference, from] of references) {
		const family = workerFamily(reference);
		if (emittedFamilies.some((emitted) => satisfies(emitted, family))) continue;
		missing.push({ reference, from: [...from].sort() });
	}

	return {
		references: new Map(
			[...references].map(([reference, from]) => [reference, [...from].sort()]),
		),
		missing: missing.sort((a, b) => a.reference.localeCompare(b.reference)),
		emitted: files
			.filter((file) => /worker/i.test(basename(file)))
			.map((file) => relative(clientDir, file))
			.sort(),
	};
}

async function main() {
	const clientDir = resolve(process.argv[2] ?? DEFAULT_CLIENT_DIR);

	try {
		const info = await stat(clientDir);
		if (!info.isDirectory()) throw new Error("not a directory");
	} catch {
		console.error(
			`[worker-assets] No client build at ${clientDir} — run \`npm run build\` first.`,
		);
		process.exit(1);
	}

	const { references, missing, emitted } =
		await checkBuiltWorkerAssets(clientDir);

	if (references.size === 0) {
		console.log(
			"[worker-assets] No worker references found in the client build.",
		);
		return;
	}

	if (missing.length > 0) {
		console.error(
			`[worker-assets] ${missing.length} worker script(s) referenced by the client build were never emitted:`,
		);
		for (const { reference, from } of missing) {
			console.error(`  - ${reference}`);
			for (const chunk of from) console.error(`      referenced by ${chunk}`);
		}
		console.error(
			`[worker-assets] Emitted worker files: ${emitted.length > 0 ? emitted.join(", ") : "(none)"}`,
		);
		console.error(
			"[worker-assets] Import the worker with Vite's `?worker&url` (or `?url`) suffix and hand the URL to the library, the way src/lib/components/chat/maplibre-loader.ts does.",
		);
		process.exit(1);
	}

	console.log(
		`[worker-assets] OK — ${references.size} worker reference(s), all emitted: ${emitted.join(", ")}`,
	);
}

// Only run when executed directly, so the unit test can import the helpers.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error("[worker-assets] Check failed:", error);
		process.exit(1);
	});
}
