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
//   5. Optionally `--max-gzip BYTES` caps the gzip size of what the target
//      loads that nothing else does (its exclusive closure).
// A package found in no chunk is reported as absent, never as guarded: it is
// either not imported yet or tree-shaken, and a green line for it would be a lie.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

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
	"html-to-image": ["Failed to clone iframe"],
};

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
 * @param {string[]} [params.allowEntries] other lazy entries (by name) that may share the target's chunks
 */
export function checkArtifactChunks({
	manifest,
	readChunk,
	name,
	confine,
	fingerprints = PACKAGE_FINGERPRINTS,
	maxGzip,
	allowEntries = [],
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
			if (!targetClosure.has(key)) {
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

	// What loads only because the editor opened: its own chunks, shared with nothing else.
	const exclusive = [...targetClosure].filter(
		(key) => loadedBy(key).length === 0,
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
	};
	if (maxGzip !== undefined && numbers.exclusiveGzipBytes > maxGzip) {
		violations.push({
			kind: "budget",
			message: `what the ${name} chunk loads on its own is ${numbers.exclusiveGzipBytes} bytes gzip, over the ${maxGzip} allowed`,
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
		maxGzip: undefined,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (flag === "--name") args.name = value;
		else if (flag === "--confine") args.confine.push(value);
		else if (flag === "--allow-entry") args.allowEntries.push(value);
		else if (flag === "--manifest") args.manifest = value;
		else if (flag === "--max-gzip") args.maxGzip = Number(value);
		else continue;
		i += 1;
	}
	if (args.confine.length === 0)
		args.confine = Object.keys(PACKAGE_FINGERPRINTS);
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
		allowEntries: args.allowEntries,
	});
	const report = formatReport(args.name, result);
	if (result.ok) console.log(report);
	else console.error(report);
	process.exit(result.ok ? 0 : 1);
}

// Only run when executed directly, so the unit test can import the helpers.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
	main();
}
