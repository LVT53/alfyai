// The guard that keeps extraction out of the upload request.
//
// Phase 3's whole claim is that an upload returns when the bytes are stored,
// not when a backend has finished reading the document. The single easiest way
// to lose that is for someone to reach for `extractDocumentText` again from a
// knowledge service or an upload route — it is one import away and it looks
// like a convenience. So: nothing under `services/knowledge/**` or
// `routes/api/knowledge/**` may reference the extraction client at all. The
// only production importer left in `src/` is
// `extraction/extractors/legacy-mineru3.ts`, which is the adapter that exists
// precisely so no one else needs it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, "../../../..");

const SCANNED_ROOTS = [
	"lib/server/services/knowledge",
	"routes/api/knowledge",
] as const;

/** The one adapter allowed to talk to the extraction client. */
const ALLOWED_IMPORTERS = new Set([
	"lib/server/services/extraction/extractors/legacy-mineru3.ts",
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

function referencesExtractionClient(specifier: string): boolean {
	// `services/document-extraction.ts`, however it is spelled from the
	// importing file: relative, aliased, with or without the extension.
	return /(^|\/)document-extraction(\.ts)?$/.test(specifier);
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

	it("leaves exactly one production importer of the extraction client", () => {
		const importers = listSourceFiles(path.join(srcRoot, "lib"))
			.concat(listSourceFiles(path.join(srcRoot, "routes")))
			.filter((absolute) => !/\.test\.ts$/.test(absolute))
			.filter((absolute) =>
				importSpecifiers(readFileSync(absolute, "utf8")).some(
					referencesExtractionClient,
				),
			)
			.map((absolute) => path.relative(srcRoot, absolute))
			// `chat-files.ts` is slice S5's to move; until it lands it is a known,
			// named exception rather than a silent one.
			.filter((relative) => relative !== "lib/server/services/chat-files.ts");

		for (const importer of importers) {
			expect(ALLOWED_IMPORTERS.has(importer), `${importer} imports it`).toBe(
				true,
			);
		}
	});
});
