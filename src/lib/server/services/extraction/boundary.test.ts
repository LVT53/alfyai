// Import-graph guards.
//
// The kind's definition and its read model are imported from request paths that
// only touch rows — a poll endpoint, a library page load, the send gate. If either
// ever reached an extractor, those requests would drag `node:fs` and a backend
// HTTP client into their bundle, and every one of them would pay for a
// dependency it never calls. The handler is loaded by the job engine on the first
// claim (a dynamic `import()` in the definition), never statically. Same idea as
// `file-production/obsolete-surfaces.test.ts`.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, "../../../..");

function read(relative: string): string {
	return readFileSync(path.join(srcRoot, relative), "utf8");
}

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function staticImportSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	const pattern = /^import\s[^;]*?from\s+"([^"]+)"/gm;
	for (const match of source.matchAll(pattern)) {
		specifiers.push(match[1]);
	}
	return specifiers;
}

const FORBIDDEN = [
	"document-extraction",
	"chat-files",
	"./extractors",
	"./extraction-runner",
	"./intake",
];

type StaticReference = {
	specifier: string;
	typeOnly: boolean;
};

type BoundaryViolation = {
	importer: string;
	specifier: string;
	target: string;
	forbidden: string;
};

/**
 * What the poll path must never reach at RUNTIME.
 *
 * Roots are comparable project-relative paths: `store.ts`, `store/core.ts` and
 * the `store/` directory all normalise to the same `knowledge/store` root, so a
 * relative `./store` — which the old raw-substring check could never see — is
 * caught.
 */
const FORBIDDEN_RUNTIME_ROOTS = [
	{
		forbidden: "the knowledge store",
		root: "lib/server/services/knowledge/store",
	},
	{
		forbidden: "the extraction extractors",
		root: "lib/server/services/extraction/extractors",
	},
	{
		forbidden: "the extraction runner",
		root: "lib/server/services/extraction/extraction-runner",
	},
	{
		forbidden: "the extraction intake",
		root: "lib/server/services/extraction/intake",
	},
	{ forbidden: "the MinerU service", root: "lib/server/services/mineru" },
] as const;

/**
 * Every static module reference in a source file: `import ... from`,
 * `import "..."`, and value `export ... from` alike. Type-only references are
 * flagged but never followed — TypeScript erases them, so they cannot pull a
 * module into a bundle.
 */
function staticReferences(source: string): StaticReference[] {
	const references: StaticReference[] = [];

	for (const match of source.matchAll(
		/^(import|export)(\s+type)?\s[^;]*?from\s+["']([^"']+)["']/gm,
	)) {
		references.push({
			specifier: match[3],
			typeOnly: Boolean(match[2]),
		});
	}

	for (const match of source.matchAll(/^import\s+["']([^"']+)["']/gm)) {
		references.push({ specifier: match[1], typeOnly: false });
	}

	return references;
}

function isAtOrUnder(target: string, root: string): boolean {
	return target === root || target.startsWith(`${root}/`);
}

/**
 * `store/core.ts`, `store/index.ts`, `store.ts` and a bare `store` all collapse
 * to `.../store`, so directory imports and file imports answer the same root.
 */
function comparableTarget(target: string): string {
	const withoutIndex = target.replace(/\/index\.(ts|js)$/, "");
	return withoutIndex.replace(/\.(ts|js)$/, "");
}

/**
 * Resolve a project-local specifier against the importing file's directory.
 *
 * `$lib` is the repository's one source alias (`$lib` -> `src/lib`). Anything
 * else (a package, `$app/...`, `$env/...`) is external to this graph and
 * returns null; `node:fs` is caught by the raw specifier before this runs.
 */
function resolveSpecifierTarget(
	importer: string,
	specifier: string,
): string | null {
	if (specifier.startsWith(".")) {
		return path.posix.normalize(
			path.posix.join(path.posix.dirname(importer), specifier),
		);
	}
	if (specifier === "$lib") return "lib";
	if (specifier.startsWith("$lib/")) {
		return path.posix.normalize(`lib/${specifier.slice("$lib/".length)}`);
	}
	return null;
}

function resolveProjectFile(
	target: string,
	overrides: ReadonlyMap<string, string>,
): string | null {
	for (const candidate of [
		target,
		`${target}.ts`,
		`${target}.js`,
		`${target}/index.ts`,
		`${target}/index.js`,
	]) {
		if (overrides.has(candidate)) return candidate;
		const absolute = path.join(srcRoot, candidate);
		if (existsSync(absolute) && statSync(absolute).isFile()) return candidate;
	}
	return null;
}

function detectBoundaryViolation(
	importer: string,
	reference: StaticReference,
): BoundaryViolation | null {
	if (reference.typeOnly) return null;

	if (/^node:fs(\/|$)/.test(reference.specifier)) {
		return {
			importer,
			specifier: reference.specifier,
			target: reference.specifier,
			forbidden: "node:fs",
		};
	}

	const target = resolveSpecifierTarget(importer, reference.specifier);
	if (target === null) return null;

	const comparable = comparableTarget(target);
	const hit = FORBIDDEN_RUNTIME_ROOTS.find((entry) =>
		isAtOrUnder(comparable, entry.root),
	);
	return hit
		? {
				importer,
				specifier: reference.specifier,
				target,
				forbidden: hit.forbidden,
			}
		: null;
}

/**
 * Walk the static module graph from an entry file and collect every forbidden
 * hop. Dynamic `import()` is deliberately not followed: the intake and the
 * handler are lazy precisely so a poll never loads them.
 *
 * `overrides` lets a test provide a synthetic graph without a violating file
 * existing on disk.
 */
function reachableBoundaryViolations(
	entry: string,
	overrides: ReadonlyMap<string, string> = new Map(),
): BoundaryViolation[] {
	const violations: BoundaryViolation[] = [];
	const seen = new Set<string>();
	const queue: string[] = [entry];

	while (queue.length > 0) {
		const importer = queue.shift();
		if (importer === undefined || seen.has(importer)) continue;
		seen.add(importer);

		// Only runtime server modules are parsed. A `.svelte` component or a
		// declaration file cannot be followed safely with a regex scanner.
		if (!importer.endsWith(".ts") || importer.endsWith(".test.ts")) continue;

		const rawSource =
			overrides.get(importer) ??
			readFileSync(path.join(srcRoot, importer), "utf8");
		const source = stripComments(rawSource);

		for (const reference of staticReferences(source)) {
			const violation = detectBoundaryViolation(importer, reference);
			if (violation) {
				violations.push(violation);
				continue;
			}
			if (reference.typeOnly) continue;

			const target = resolveSpecifierTarget(importer, reference.specifier);
			if (target === null) continue;
			const file = resolveProjectFile(target, overrides);
			if (file !== null && !seen.has(file)) queue.push(file);
		}
	}

	return violations;
}

function describeBoundaryViolation(violation: BoundaryViolation): string {
	return `${violation.importer} imports ${violation.specifier} (${violation.target}), reaching ${violation.forbidden}`;
}

describe("extraction module boundaries", () => {
	it.each([
		"lib/server/services/extraction/extraction-job.ts",
		"lib/server/services/extraction/read-model.ts",
	])("keeps %s off every extractor and worker module", (relative) => {
		const specifiers = staticImportSpecifiers(read(relative));
		for (const specifier of specifiers) {
			for (const forbidden of FORBIDDEN) {
				expect(
					specifier.includes(forbidden),
					`${relative} imports ${specifier}`,
				).toBe(false);
			}
		}
	});

	it("keeps the read model off the knowledge store", () => {
		// `knowledge/store/**` reaches the parse bundle (deleting an artifact
		// removes it), so a convenience import of
		// `getNormalizedArtifactForSource` would pull a zip reader and `node:fs`
		// into a poll endpoint.
		const specifiers = staticImportSpecifiers(
			read("lib/server/services/extraction/read-model.ts"),
		);
		expect(
			specifiers.some((specifier) => specifier.includes("knowledge/store")),
		).toBe(false);
	});

	it("loads the handler and the intake lazily", () => {
		const facade = read("lib/server/services/extraction/index.ts");
		const specifiers = staticImportSpecifiers(facade);
		expect(specifiers).not.toContain("./extraction-runner");
		expect(specifiers).not.toContain("./intake");
		expect(facade).toContain('import("./intake")');
		// The job engine loads the handler on the first claim: the definition names
		// it with a dynamic import, so a route that only reads, retries or cancels
		// never imports an extractor.
		const definition = read("lib/server/services/extraction/extraction-job.ts");
		expect(staticImportSpecifiers(definition)).not.toContain(
			"./extraction-runner",
		);
		expect(definition).toContain('import("./extraction-runner")');
	});

	it("keeps registering the readback sink free of the handler", () => {
		// `readback.ts` is on the boot import path (chat-files imports it) and
		// registers its sink when it is imported: the slot is a module of its own so
		// that costs nothing.
		const specifiers = staticImportSpecifiers(
			read("lib/server/services/extraction/readback.ts"),
		);
		expect(specifiers).toContain("./readback-sink");
		expect(specifiers).not.toContain("./extraction-runner");
	});

	it("keeps the seam and the shared status off the MinerU protocol", () => {
		// The extractor is the ONLY module outside `services/mineru/` that may
		// import the protocol. The seam files are the two that would be most
		// tempting to "just" reach through, and the two whose bundles travel
		// furthest — `extraction-status.ts` reaches Svelte components.
		for (const relative of [
			"lib/server/services/extraction/contracts.ts",
			"lib/server/services/extraction/extraction-job.ts",
			"lib/server/services/extraction/read-model.ts",
			"lib/shared/extraction-status.ts",
		]) {
			const specifiers = staticImportSpecifiers(read(relative));
			for (const specifier of specifiers) {
				expect(
					/services\/mineru(\/|$)/.test(specifier),
					`${relative} imports ${specifier}`,
				).toBe(false);
			}
		}
	});

	it("never reaches a specific extraction backend from the seam", () => {
		// The seam is what lets a backend be swapped by editing one registry
		// entry. The word "mineru" is allowed: it is the shared file-type
		// registry's ROUTE name, part of the public intake vocabulary. What must
		// not appear is a backend's own surface — its client, its config, its
		// versioned name.
		for (const relative of [
			"lib/server/services/extraction/contracts.ts",
			"lib/shared/extraction-status.ts",
		]) {
			const source = stripComments(read(relative)).toLowerCase();
			expect(source, relative).not.toMatch(/mineru\d/);
			expect(source, relative).not.toMatch(/mineru_/);
			expect(source, relative).not.toMatch(/document-extraction"/);
			expect(source, relative).not.toMatch(/mineruapiurl|minerutimeoutms/);
		}
	});

	it("keeps the shared status vocabulary out of $lib/server", () => {
		const shared = stripComments(read("lib/shared/extraction-status.ts"));
		expect(shared).not.toMatch(/\$lib\/server/);
	});
});

const RUNTIME_BOUNDARY_ENTRIES = [
	"lib/server/services/knowledge/readiness.ts",
	"routes/api/knowledge/extraction/+server.ts",
] as const;

describe("extraction poll runtime boundary", () => {
	it.each(
		RUNTIME_BOUNDARY_ENTRIES,
	)("keeps %s off the parse bundle, transitively", (relative) => {
		// `knowledge/readiness.ts` is on the poll route and the route is the
		// poll. Either may read rows and evaluate text, but neither may reach
		// the knowledge store (which reaches the parse bundle), an extractor,
		// the runner, intake, MinerU, or `node:fs` — a poll that only asks
		// whether a finished document's text is usable must not load a zip
		// reader or a backend HTTP client.
		const violations = reachableBoundaryViolations(relative);
		expect(violations.map(describeBoundaryViolation)).toEqual([]);
	});

	it("resolves a relative ./store import the raw-substring check missed", () => {
		const [reference] = staticReferences(
			'import { getArtifactsForUser } from "./store/core";',
		);
		expect(reference).toBeDefined();
		const violation = reference
			? detectBoundaryViolation(
					"lib/server/services/knowledge/readiness.ts",
					reference,
				)
			: null;
		expect(violation).toMatchObject({
			target: "lib/server/services/knowledge/store/core",
			forbidden: "the knowledge store",
		});
	});

	it("scans value re-exports, not only import lines", () => {
		const [reference] = staticReferences(
			'export { startUploadExtraction } from "$lib/server/services/extraction/intake";',
		);
		expect(reference).toBeDefined();
		const violation = reference
			? detectBoundaryViolation(
					"routes/api/knowledge/extraction/+server.ts",
					reference,
				)
			: null;
		expect(violation).toMatchObject({ forbidden: "the extraction intake" });
	});

	it("catches node:fs and its subpaths", () => {
		const [reference] = staticReferences(
			'import { readFile } from "node:fs/promises";',
		);
		expect(reference).toBeDefined();
		const violation = reference
			? detectBoundaryViolation(
					"lib/server/services/knowledge/readiness.ts",
					reference,
				)
			: null;
		expect(violation).toMatchObject({ forbidden: "node:fs" });
	});

	it("catches a transitive hop, not only a direct import", () => {
		const overrides = new Map([
			[
				"lib/server/services/knowledge/readiness.ts",
				'import { logAttachmentTrace } from "../attachment-trace";',
			],
			[
				"lib/server/services/attachment-trace.ts",
				'import { mapArtifact } from "$lib/server/services/knowledge/store/core";',
			],
		]);

		const violations = reachableBoundaryViolations(
			"lib/server/services/knowledge/readiness.ts",
			overrides,
		);

		expect(violations.map(describeBoundaryViolation)).toEqual([
			"lib/server/services/attachment-trace.ts imports $lib/server/services/knowledge/store/core (lib/server/services/knowledge/store/core), reaching the knowledge store",
		]);
	});

	it("does not follow type-only references", () => {
		const [reference] = staticReferences(
			'import type { Artifact } from "$lib/server/services/knowledge/store/core";',
		);
		expect(reference?.typeOnly).toBe(true);

		const overrides = new Map([
			[
				"lib/server/services/knowledge/readiness.ts",
				'import type { Artifact } from "$lib/server/services/knowledge/store/core";',
			],
		]);
		expect(
			reachableBoundaryViolations(
				"lib/server/services/knowledge/readiness.ts",
				overrides,
			),
		).toEqual([]);
	});
});
