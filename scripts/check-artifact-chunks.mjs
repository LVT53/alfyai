// Build guard: an artifact editor's libraries stay in ITS lazy chunk.
//
// WHY THIS EXISTS. The Canvas is a Svelte Flow board, and Svelte Flow (plus the
// pen and the PNG export) is far too heavy for the chat page or the knowledge
// page to pay for on every visit. The panel loads the board with a dynamic
// `import()` (`artifact-bodies.ts`), so the library lands in that chunk only —
// until someone adds one static import from the chat shell, or a shared helper
// that both the editor and a route pull in, and the bundler quietly moves the
// library into a chunk the idle shell loads. Nothing fails at build time; the
// chat just gets a few hundred kB heavier. This guard makes that a build error.
// It is parameterised by the chunk's NAME so the Slides editor reuses it as is.
//
// THE METHOD (what "only in the lazy chunk" means, and how it is checked):
//   1. The build's own manifest (`.vite/manifest.json`) is the chunk graph:
//      every chunk, the chunks it imports STATICALLY (loaded with it), and the
//      ones it imports dynamically (loaded on demand — these do not count).
//   2. The lazy TARGET is every manifest entry whose name, key or source path
//      contains `--name` (default `CanvasEditor`). Its static closure — the
//      target plus what it statically imports — is what loads when the editor
//      opens.
//   3. A package is found by FINGERPRINT: strings its code keeps through
//      minification (CSS class names, property names, error messages), all of
//      which must appear in one chunk's text (its JS and its CSS) for the chunk
//      to count as containing the package.
//   4. A package is CONFINED when every chunk that contains it is in the
//      target's static closure and in NO other manifest entry's static closure
//      (the app entries, the route nodes — chat and knowledge among them — and
//      every other lazy entry). A chunk that fails the first half is somewhere
//      the editor's chunk does not reach ("outside"); one that fails the second
//      is loaded with something else ("leak"), and the report names what.
//   5. `--allow-entry NAME` names a lazy PART of the editor (the comments, the
//      export, the drawing layer): it may share chunks with the editor, it does
//      not count as somebody else loading a library, and a confined package may
//      live in its own closure — it is the editor's, loaded when it is needed.
//   6. `--max-gzip BYTES` caps the gzip size of what the target loads that
//      nothing else does (its exclusive closure). This is the honest reading of
//      "the editor's chunk": what opening the editor downloads, its own chunk AND
//      the chunks it statically pulls in, with a chunk it shares with one of its own
//      lazy parts counted as its own. The bare size of the one target chunk falls
//      whenever a module moves into a chunk a lazy part also imports, though the
//      same bytes load, so it is printed but never the number that is held.
//   6b. `--max-target-gzip BYTES` caps the gzip size of the target chunk ALONE (the
//      chunk the manifest names for it). The spec's own reading of the budget; kept
//      beside the honest one so a move of modules into a chunk a lazy part shares,
//      which makes this number fall while the bytes loaded do not, is visible.
//   7. `--forbid PACKAGE` names a package that must NOT be in any chunk the editor
//      loads when it opens (Chart.js and MapLibre load on demand, in the chat's own
//      chunks, and must stay out of the editor's first paint).
//   8. `--chat-route ID --chat-baseline BYTES` holds the chat page's own first
//      load: the gzip size of the route's root layout, layouts and page with
//      everything they statically import (never a lazy chunk, so never an open
//      editor) may not grow more than `--chat-tolerance` (default 2 KiB) past the
//      baseline. Re-baseline on purpose when the chat itself gets heavier.
// A package found in no chunk is reported as absent, never as guarded: it is
// either not imported yet or tree-shaken, and a green line for it would be a lie.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

/** SvelteKit's generated route table: which nodes (layouts, page) a route is made of. */
const DEFAULT_ROUTES = join(
	".svelte-kit",
	"generated",
	"client-optimized",
	"app.js",
);

const DEFAULT_MANIFEST = join(
	".svelte-kit",
	"output",
	"client",
	".vite",
	"manifest.json",
);

/**
 * What each package's code keeps through minification, all of it required in one
 * chunk. Class names and property names survive; identifiers do not.
 */
export const PACKAGE_FINGERPRINTS = {
	"@xyflow": ["svelte-flow__pane"],
	"perfect-freehand": ["simulatePressure", "runningLength"],
	// What html-to-image 1.11.11 keeps through minification: its own error messages.
	"html-to-image": [
		"Error inlining remote css file",
		"externalResourcesRequired",
	],
	// The two libraries the chat loads on demand and the editor must not load when it opens.
	"chart.js": ["chartjs-", "_adapters"],
	"maplibre-gl": ["maplibregl-canvas", "maplibregl-map"],
};

/** What is confined to the editor when the CLI is not told which packages. */
const DEFAULT_CONFINE = ["@xyflow", "perfect-freehand", "html-to-image"];

/** The manifest keys a `--name` selects: its `name`, its key, or its source path contains it. */
export function findTargetKeys(manifest, name) {
	return Object.entries(manifest)
		.filter(
			([key, chunk]) =>
				key.includes(name) ||
				(typeof chunk.name === "string" && chunk.name.includes(name)) ||
				(typeof chunk.src === "string" && chunk.src.includes(name)),
		)
		.map(([key]) => key);
}

/** The chunks loaded together with `startKeys`: themselves and everything they import statically. Cycles are fine. */
export function staticClosure(manifest, startKeys) {
	const seen = new Set();
	const queue = [...startKeys];
	while (queue.length > 0) {
		const key = queue.pop();
		if (seen.has(key) || !manifest[key]) continue;
		seen.add(key);
		for (const imported of manifest[key].imports ?? []) queue.push(imported);
	}
	return seen;
}

function hasAll(text, fingerprints) {
	return fingerprints.every((fingerprint) => text.includes(fingerprint));
}

function gzipSize(text) {
	return gzipSync(Buffer.from(text, "utf8")).length;
}

/**
 * @param {object} params
 * @param {Record<string, any>} params.manifest the build's manifest
 * @param {(chunk: any) => string} params.readChunk a chunk's JS plus its CSS, as text
 * @param {string} params.name selects the lazy target
 * @param {string[]} params.confine package names (keys of `fingerprints`) that must stay in the target
 * @param {Record<string, string[]>} [params.fingerprints]
 * @param {number} [params.maxGzip] cap on the target's exclusive closure, gzip bytes
 * @param {number} [params.maxTargetGzip] cap on the target chunk alone, gzip bytes
 * @param {string[]} [params.allowEntries] lazy parts of the editor (by name): they may share its chunks, and a confined package may live in their closure
 * @param {string[]} [params.forbid] packages that must not be in any chunk the target loads when it opens
 */
export function checkArtifactChunks({
	manifest,
	readChunk,
	name,
	confine,
	fingerprints = PACKAGE_FINGERPRINTS,
	maxGzip,
	maxTargetGzip,
	allowEntries = [],
	forbid = [],
}) {
	const violations = [];
	const targetKeys = findTargetKeys(manifest, name);
	if (targetKeys.length === 0) {
		return {
			ok: false,
			violations: [
				{
					kind: "no-target",
					message: `no chunk in the build matches "${name}", so nothing can be vouched for`,
				},
			],
			targetFiles: [],
			packages: [],
			numbers: null,
		};
	}

	const allowedKeys = new Set(
		allowEntries.flatMap((allowed) => findTargetKeys(manifest, allowed)),
	);
	const targetClosure = staticClosure(manifest, targetKeys);
	// The editor and its lazy parts: where a confined package may live.
	const familyClosure = new Set([
		...targetClosure,
		...staticClosure(manifest, [...allowedKeys]),
	]);
	// What can be loaded on its own: the app's entries, the route nodes and every
	// other lazy entry. A shared chunk is only ever loaded BY one of these, so it
	// is not a root (it would otherwise "load itself").
	const otherRoots = Object.keys(manifest).filter(
		(key) =>
			(manifest[key].isEntry || manifest[key].isDynamicEntry) &&
			!targetKeys.includes(key) &&
			!allowedKeys.has(key),
	);
	// Which other entries load a chunk statically: computed once per entry.
	const closureOf = new Map(
		otherRoots.map((key) => [key, staticClosure(manifest, [key])]),
	);
	const loadedBy = (chunkKey) =>
		otherRoots.filter((root) => closureOf.get(root)?.has(chunkKey));

	const texts = new Map();
	const textOf = (key) => {
		if (!texts.has(key)) texts.set(key, readChunk(manifest[key]));
		return texts.get(key);
	};

	const packages = [];
	for (const pkg of confine) {
		const marks = fingerprints[pkg];
		if (!marks) throw new Error(`no fingerprint is known for "${pkg}"`);
		const containing = Object.keys(manifest).filter((key) =>
			hasAll(textOf(key), marks),
		);
		const report = { pkg, chunks: containing.map((key) => manifest[key].file) };
		packages.push(report);
		for (const key of containing) {
			const file = manifest[key].file;
			if (!familyClosure.has(key)) {
				violations.push({
					kind: "outside",
					pkg,
					file,
					message: `${pkg} is in ${file}, which the ${name} chunk does not load`,
				});
				continue;
			}
			const roots = loadedBy(key);
			if (roots.length > 0) {
				violations.push({
					kind: "leak",
					pkg,
					file,
					roots,
					message: `${pkg} is in ${file}, which is also loaded statically by ${roots
						.slice(0, 3)
						.join(
							", ",
						)}${roots.length > 3 ? ` and ${roots.length - 3} more` : ""}`,
				});
			}
		}
	}

	// What the editor must not load when it opens, whatever else does.
	for (const pkg of forbid) {
		const marks = fingerprints[pkg];
		if (!marks) throw new Error(`no fingerprint is known for "${pkg}"`);
		for (const key of targetClosure) {
			if (!hasAll(textOf(key), marks)) continue;
			violations.push({
				kind: "forbidden",
				pkg,
				file: manifest[key].file,
				message: `${pkg} is in ${manifest[key].file}, which the ${name} chunk loads when it opens (it must load on demand)`,
			});
		}
	}

	// What loads only because the editor opened: its own chunks, shared with nothing else.
	const exclusive = [...targetClosure].filter(
		(key) => loadedBy(key).length === 0,
	);
	// Also downloaded when the editor opens, though not counted above because
	// another entry loads it: a chunk only OTHER lazy entries share (a helper both
	// editors use, a library another feature loads on demand) is not the shell's, so
	// opening the editor from a page that has not loaded it fetches it. Reported,
	// never held: it is not the editor's own weight, and saying so is the point.
	const routeRoots = otherRoots.filter(
		(key) => manifest[key].isEntry && !manifest[key].isDynamicEntry,
	);
	const lazyShared = [...targetClosure].filter(
		(key) =>
			!exclusive.includes(key) &&
			!routeRoots.some((root) => closureOf.get(root)?.has(key)),
	);
	const numbers = {
		targetFiles: targetKeys.map((key) => manifest[key].file),
		targetRawBytes: targetKeys.reduce(
			(sum, key) => sum + Buffer.byteLength(textOf(key)),
			0,
		),
		targetGzipBytes: targetKeys.reduce(
			(sum, key) => sum + gzipSize(textOf(key)),
			0,
		),
		exclusiveChunks: exclusive.length,
		exclusiveRawBytes: exclusive.reduce(
			(sum, key) => sum + Buffer.byteLength(textOf(key)),
			0,
		),
		exclusiveGzipBytes: exclusive.reduce(
			(sum, key) => sum + gzipSize(textOf(key)),
			0,
		),
		sharedChunks: targetClosure.size - exclusive.length,
		lazySharedChunks: lazyShared.length,
		lazySharedGzipBytes: lazyShared.reduce(
			(sum, key) => sum + gzipSize(textOf(key)),
			0,
		),
	};
	if (maxGzip !== undefined && numbers.exclusiveGzipBytes > maxGzip) {
		violations.push({
			kind: "budget",
			message: `what the ${name} chunk loads on its own is ${numbers.exclusiveGzipBytes} bytes gzip, over the ${maxGzip} allowed`,
		});
	}

	if (maxTargetGzip !== undefined && numbers.targetGzipBytes > maxTargetGzip) {
		violations.push({
			kind: "budget",
			message: `the ${name} chunk alone is ${numbers.targetGzipBytes} bytes gzip, over the ${maxTargetGzip} allowed`,
		});
	}

	return {
		ok: violations.length === 0,
		violations,
		targetFiles: numbers.targetFiles,
		packages,
		numbers,
	};
}

/** The generated route table's nodes for one route: the root layout, the route's layouts and its page, as node indexes. Null for a route the table does not have. */
export function parseRouteNodes(appJsText, routeId) {
	const escaped = routeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const entry = new RegExp(
		`"${escaped}"\\s*:\\s*\\[([^\\]]*(?:\\[[^\\]]*\\])?[^\\]]*)\\]`,
	).exec(appJsText);
	if (!entry) return null;
	const numbers = [...entry[1].matchAll(/\d+/g)].map((match) =>
		Number(match[0]),
	);
	// The first number is the page, the rest are its layouts; the root layout (node 0) is always loaded.
	const [page, ...layouts] = numbers;
	return [...new Set([0, ...layouts, page])];
}

/**
 * The chat page's own first load: the gzip size of the route's nodes with every
 * chunk they import statically, each counted once. A chunk loaded on demand is
 * not part of it, so an artifact panel that was never opened never is.
 */
export function checkChatRoute({
	manifest,
	readChunk,
	nodes,
	baseline,
	tolerance = 2048,
}) {
	const keys = nodes.map(
		(index) => `.svelte-kit/generated/client-optimized/nodes/${index}.js`,
	);
	const missing = nodes.filter((_, position) => !manifest[keys[position]]);
	if (missing.length > 0) {
		return {
			ok: false,
			chunks: 0,
			gzipBytes: 0,
			baseline,
			message: `the chat route's node ${missing.join(", ")} is not in the build, so its weight cannot be held`,
		};
	}
	const closure = staticClosure(manifest, keys);
	let gzipBytes = 0;
	for (const key of closure) gzipBytes += gzipSize(readChunk(manifest[key]));
	const growth = gzipBytes - baseline;
	const ok = growth <= tolerance;
	return {
		ok,
		chunks: closure.size,
		gzipBytes,
		baseline,
		message: ok
			? `${closure.size} chunk(s), ${gzipBytes} bytes gzip (${growth >= 0 ? "+" : ""}${growth} against the baseline of ${baseline}, ${tolerance} allowed)`
			: `the chat route's first load grew to ${gzipBytes} bytes gzip, ${growth} over its baseline of ${baseline} (${tolerance} allowed): it must not get heavier because of an artifact editor`,
	};
}

/** The report the CLI prints. */
export function formatReport(name, result) {
	const lines = [];
	if (result.numbers) {
		const n = result.numbers;
		const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;
		lines.push(
			`[artifact-chunks] ${name}: ${n.targetFiles.join(", ")} — ${kb(n.targetRawBytes)} raw, ${kb(n.targetGzipBytes)} gzip; ` +
				`loads ${n.exclusiveChunks} chunk(s) of its own (${kb(n.exclusiveRawBytes)} raw, ${kb(n.exclusiveGzipBytes)} gzip) and ${n.sharedChunks} shared`,
		);
	}
	if (result.numbers?.lazySharedChunks > 0) {
		const n = result.numbers;
		lines.push(
			`[artifact-chunks]   also loads ${n.lazySharedChunks} chunk(s) (${(n.lazySharedGzipBytes / 1024).toFixed(1)} kB gzip) shared only with other lazy entries: not counted above`,
		);
	}
	for (const { pkg, chunks } of result.packages) {
		lines.push(
			chunks.length === 0
				? `[artifact-chunks]   ${pkg}: not in this build (not imported yet, or tree-shaken) — nothing to guard`
				: `[artifact-chunks]   ${pkg}: ${chunks.join(", ")}`,
		);
	}
	for (const violation of result.violations) {
		lines.push(
			`[artifact-chunks] FAIL (${violation.kind}) ${violation.message}`,
		);
	}
	return lines.join("\n");
}

/** The chunk's JS and its CSS, as one text: a library's stylesheet is part of what loads with it. */
export function chunkReader(clientDir) {
	return (chunk) => {
		const files = [chunk.file, ...(chunk.css ?? [])];
		return files
			.map((file) => {
				try {
					return readFileSync(join(clientDir, file), "utf8");
				} catch {
					return "";
				}
			})
			.join("\n");
	};
}

function parseArgs(argv) {
	const args = {
		name: "CanvasEditor",
		confine: [],
		allowEntries: [],
		manifest: DEFAULT_MANIFEST,
		routes: DEFAULT_ROUTES,
		maxGzip: undefined,
		maxTargetGzip: undefined,
		forbid: [],
		chatRoute: undefined,
		chatBaseline: undefined,
		chatTolerance: undefined,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (flag === "--name") args.name = value;
		else if (flag === "--confine") args.confine.push(value);
		else if (flag === "--allow-entry") args.allowEntries.push(value);
		else if (flag === "--manifest") args.manifest = value;
		else if (flag === "--max-gzip") args.maxGzip = Number(value);
		else if (flag === "--max-target-gzip") args.maxTargetGzip = Number(value);
		else if (flag === "--forbid") args.forbid.push(value);
		else if (flag === "--routes") args.routes = value;
		else if (flag === "--chat-route") args.chatRoute = value;
		else if (flag === "--chat-baseline") args.chatBaseline = Number(value);
		else if (flag === "--chat-tolerance") args.chatTolerance = Number(value);
		else continue;
		i += 1;
	}
	if (args.confine.length === 0) args.confine = DEFAULT_CONFINE;
	return args;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const manifestPath = resolve(args.manifest);
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		console.error(
			`[artifact-chunks] No build manifest at ${manifestPath} — run \`npm run build\` first.`,
		);
		process.exit(1);
	}
	// The manifest sits in `<client>/.vite/`; the chunks are under `<client>/`.
	const result = checkArtifactChunks({
		manifest,
		readChunk: chunkReader(dirname(dirname(manifestPath))),
		name: args.name,
		confine: args.confine,
		maxGzip: args.maxGzip,
		maxTargetGzip: args.maxTargetGzip,
		allowEntries: args.allowEntries,
		forbid: args.forbid,
	});
	let report = formatReport(args.name, result);
	let ok = result.ok;
	if (args.chatRoute !== undefined) {
		let nodes = null;
		try {
			nodes = parseRouteNodes(
				readFileSync(resolve(args.routes), "utf8"),
				args.chatRoute,
			);
		} catch {
			// Reported below: no route table, no weight held.
		}
		if (!nodes || args.chatBaseline === undefined) {
			ok = false;
			report += `\n[artifact-chunks] FAIL (chat-route) the route "${args.chatRoute}" or its baseline is not known (${args.routes})`;
		} else {
			const chat = checkChatRoute({
				manifest,
				readChunk: chunkReader(dirname(dirname(manifestPath))),
				nodes,
				baseline: args.chatBaseline,
				...(args.chatTolerance === undefined
					? {}
					: { tolerance: args.chatTolerance }),
			});
			ok = ok && chat.ok;
			report += `\n[artifact-chunks] ${chat.ok ? "chat route" : "FAIL (chat-route)"} ${args.chatRoute}: ${chat.message}`;
		}
	}
	if (ok) console.log(report);
	else console.error(report);
	process.exit(ok ? 0 : 1);
}

// Only run when executed directly, so the unit test can import the helpers.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	main();
}
