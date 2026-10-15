// Import-graph guards.
//
// The kind's definition and its read model are imported from request paths that
// only touch rows — a poll endpoint, a library page load, the send gate. If either
// ever reached an extractor, those requests would drag `node:fs` and a backend
// HTTP client into their bundle, and every one of them would pay for a
// dependency it never calls. The handler is loaded by the job engine on the first
// claim (a dynamic `import()` in the definition), never statically. Same idea as
// `file-production/obsolete-surfaces.test.ts`.

import { readFileSync } from "node:fs";
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
