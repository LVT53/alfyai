// The guards that keep extraction where it belongs.
//
// Two separate claims are pinned here.
//
// 1. **Extraction never happens inside an upload request.** Phase 3's whole
//    claim is that an upload returns when the bytes are stored, not when a
//    backend has finished reading the document. Nothing under
//    `services/knowledge/**` or `routes/api/knowledge/**` may reach an
//    extraction client at all.
// 2. **There is exactly one extraction protocol.** `document-extraction.ts` —
//    the MinerU 3.x client — is DELETED, not reduced (D3). A mis-ordered merge
//    across the three phases that touched that file is the one way the 3.x
//    client could come back, silently, and the app would then speak a protocol
//    the rest of this migration assumes is gone. So: the file must not exist,
//    it must have no importers, and `services/mineru/**` must be reachable at
//    RUNTIME only from the handful of modules that are supposed to reach it.
//
// Type-only imports are excluded from the `services/mineru/**` rule on purpose.
// The rule exists to stop `jszip`, `node:fs` and a backend HTTP client from
// being dragged into a request path's bundle; an `import type` emits nothing
// and cannot do that. `persist.ts` narrowing the structured payload against a
// type from `mineru/result.ts` is the intended case.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, "../../../..");
const repoRoot = path.resolve(srcRoot, "..");

const SCANNED_ROOTS = [
	"lib/server/services/knowledge",
	"routes/api/knowledge",
] as const;

/**
 * Every module allowed to reach the MinerU protocol at runtime.
 *
 * The extractor is the seam. The rest are the surfaces that legitimately need
 * one piece of it, and each is here for a reason that is worth reading before
 * adding a sixth:
 *
 *  - the admin status card's endpoint reads the server's capabilities;
 *  - the figure endpoint serves a byte out of a parse bundle;
 *  - artifact deletion is the only place that removes one;
 *  - `persist.ts` stamps the normalized artifact's id into the manifest the
 *    extractor wrote, and turns the parsed blocks into a chunk plan — it is
 *    the one module that holds both the parse and the artifact;
 *  - the re-extract endpoint validates the requested tier against the tiers
 *    the server actually serves, before it writes a job;
 *  - `chunk-sync.ts` and `read-generated-file.ts` read the structure-chunking
 *    flag and the page index respectively;
 *  - `format-availability.ts` (phase5-6 spec §3.5) reads the same cached
 *    capabilities/status read as the admin card, to decide the upload-time
 *    MinerU-4 gate. It never probes the network itself — see its own
 *    docstring — it only reads what `capabilities.ts` already cached;
 *  - `task-state/artifacts.ts` reads the same page index to put `[p. N]`
 *    markers into the full text of a document too small to have chunk rows,
 *    which is the only way such a document can cite a page at all. It reads
 *    the index, verifies the bundle digest and nothing else — no client, no
 *    zip.
 *
 * Everything else that wants a MinerU type imports it with `import type`,
 * which this rule ignores.
 */
const ALLOWED_MINERU_IMPORTERS = new Set([
	"lib/server/services/extraction/extractors/mineru4.ts",
	"lib/server/services/extraction/persist.ts",
	"lib/server/services/knowledge/format-availability.ts",
	"lib/server/services/knowledge/store/cleanup.ts",
	"lib/server/services/normal-chat-tools/read-generated-file.ts",
	"lib/server/services/task-state/artifacts.ts",
	"lib/server/services/task-state/chunk-sync.ts",
	"routes/api/admin/mineru-status/+server.ts",
	"routes/api/knowledge/[id]/figure/[name]/+server.ts",
	"routes/api/knowledge/extraction/[artifactId]/reextract/+server.ts",
]);

function listSourceFiles(absoluteDir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(absoluteDir)) {
		const absolute = path.join(absoluteDir, entry);
		if (statSync(absolute).isDirectory()) {
			found.push(...listSourceFiles(absolute));
			continue;
		}
		if (/\.(ts|svelte)$/.test(entry)) found.push(absolute);
	}
	return found;
}

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function importSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	for (const match of stripComments(source).matchAll(
		/(?:^import\s[^;]*?from\s+|\bimport\(\s*|\brequire\(\s*)["']([^"']+)["']/gm,
	)) {
		specifiers.push(match[1]);
	}
	return specifiers;
}

/** `import type … from "x"` and `import { type A } from "x"` emit no code. */
function valueImportSpecifiers(source: string): string[] {
	const stripped = stripComments(source)
		// Whole-clause type imports.
		.replace(/^import\s+type\s[^;]*?from\s+["'][^"']+["']/gm, "")
		// `import { type A, type B } from "x"` — every named binding is a type.
		.replace(
			/^import\s*\{\s*(?:type\s+[^,}]+\s*,\s*)*type\s+[^,}]+\s*,?\s*\}\s*from\s+["'][^"']+["']/gm,
			"",
		);
	return importSpecifiers(stripped);
}

function referencesExtractionClient(specifier: string): boolean {
	// `services/document-extraction.ts`, however it is spelled from the
	// importing file: relative, aliased, with or without the extension.
	return /(^|\/)document-extraction(\.ts)?$/.test(specifier);
}

function referencesMineruService(specifier: string): boolean {
	return (
		/(^|\/)services\/mineru(\/|$)/.test(specifier) ||
		/(^|\/)\.\.\/mineru\//.test(specifier)
	);
}

function allSourceFiles(): string[] {
	return listSourceFiles(path.join(srcRoot, "lib")).concat(
		listSourceFiles(path.join(srcRoot, "routes")),
	);
}

describe("no inline extraction in the upload path", () => {
	const scanned = SCANNED_ROOTS.flatMap((relative) =>
		listSourceFiles(path.join(srcRoot, relative)),
	);

	it("scans a non-empty set of files", () => {
		// A refactor that moves or renames these directories must fail loudly
		// rather than leave a guard that quietly checks nothing.
		expect(scanned.length).toBeGreaterThan(20);
	});

	it.each(
		SCANNED_ROOTS,
	)("keeps %s off the extraction client", (relativeRoot) => {
		const offenders = listSourceFiles(path.join(srcRoot, relativeRoot))
			.filter((absolute) =>
				importSpecifiers(readFileSync(absolute, "utf8")).some(
					referencesExtractionClient,
				),
			)
			.map((absolute) => path.relative(srcRoot, absolute));

		expect(offenders).toEqual([]);
	});
});

describe("the MinerU 3.x client is retired", () => {
	it("no longer exists on disk", () => {
		expect(
			existsSync(
				path.join(repoRoot, "src/lib/server/services/document-extraction.ts"),
			),
		).toBe(false);
		expect(
			existsSync(
				path.join(
					repoRoot,
					"src/lib/server/services/document-extraction.test.ts",
				),
			),
		).toBe(false);
		expect(
			existsSync(
				path.join(
					repoRoot,
					"src/lib/server/services/extraction/extractors/legacy-mineru3.ts",
				),
			),
		).toBe(false);
	});

	it("has zero importers anywhere in src/, tests included", () => {
		// Equality against an empty list, not a loop of truthy assertions: a loop
		// over a list that came back empty passes while asserting nothing, which
		// is precisely what happens the day the scan is pointed at the wrong
		// directory.
		const importers = allSourceFiles()
			.filter((absolute) =>
				importSpecifiers(readFileSync(absolute, "utf8")).some(
					referencesExtractionClient,
				),
			)
			.map((absolute) => path.relative(srcRoot, absolute));

		expect(importers).toEqual([]);
	});

	it("leaves no trace of the 3.x request shape in src/", () => {
		// Assembled from fragments, and this file excluded, so the guard cannot
		// match its own source: a self-matching grep is a guard that fails for a
		// reason that has nothing to do with the code it watches.
		const pattern = new RegExp(
			["file", "parse"].join("_") +
				"|hybrid-auto-engine|return" +
				"_md|extractDocument" +
				"Text",
		);
		const self = path.relative(srcRoot, fileURLToPath(import.meta.url));
		const offenders = allSourceFiles()
			.map((absolute) => path.relative(srcRoot, absolute))
			.filter((relative) => relative !== self)
			.filter((relative) =>
				// Comments stripped: the removal is described in prose in several
				// files, and a guard that cannot tell a call from a changelog note
				// is a guard nobody is allowed to write a comment near.
				pattern.test(
					stripComments(readFileSync(path.join(srcRoot, relative), "utf8")),
				),
			);
		expect(offenders).toEqual([]);
	});
});

describe("the MinerU 4 protocol stays behind its seam", () => {
	it("is imported at runtime only from the modules that own a piece of it", () => {
		const importers = allSourceFiles()
			.filter((absolute) => !/\.test\.ts$/.test(absolute))
			.filter(
				(absolute) =>
					!path
						.relative(srcRoot, absolute)
						.startsWith("lib/server/services/mineru/"),
			)
			.filter((absolute) =>
				valueImportSpecifiers(readFileSync(absolute, "utf8")).some(
					referencesMineruService,
				),
			)
			.map((absolute) => path.relative(srcRoot, absolute));

		expect(importers.sort()).toEqual(
			Array.from(ALLOWED_MINERU_IMPORTERS).sort(),
		);
	});

	it("is the only extractor the registry hands the mineru route", () => {
		const registry = readFileSync(
			path.join(
				srcRoot,
				"lib/server/services/extraction/extractors/registry.ts",
			),
			"utf8",
		);
		expect(registry).toContain("mineru4Extractor");
		expect(registry).not.toContain("legacyMineru3Extractor");
	});
});
