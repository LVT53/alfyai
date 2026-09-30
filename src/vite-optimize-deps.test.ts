import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Vite's dependency optimizer scans from the route files. It does not follow an
// import() written inside a .svelte file, and it does not look at the hooks, so a
// package that only those reach is found by the first page or panel that needs
// it instead: that re-optimizes and reloads the page, which on a dev server with
// an empty cache aborts the first navigation and breaks hydration with two copies
// of Svelte's runtime (the first e2e test of a fresh server used to fail that
// way). `optimizeDeps.entries` starts the scan from those places as well, so
// what they import is in the first pass and a new import there needs no list.

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** Where a package is hidden from the route scan, and what hides it. */
const HIDDEN_FROM_THE_ROUTE_SCAN = [
	{
		file: "src/hooks.client.ts",
		why: "the client hooks import @sentry/sveltekit",
	},
	{
		file: "src/lib/components/artifacts/document/document-editor.ts",
		why: "DocumentBody.svelte loads the editor, and all of TipTap with it, through import()",
	},
];

/** The bare package names a source file imports: not `$` aliases, not relative, not node's own. */
function packagesImportedBy(source: string): string[] {
	const found = new Set<string>();
	for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
		const specifier = match[1];
		if (
			specifier.startsWith(".") ||
			specifier.startsWith("$") ||
			specifier.startsWith("node:")
		) {
			continue;
		}
		found.add(specifier);
	}
	return [...found];
}

/** The strings in `optimizeDeps.entries`, read off the config's own text. */
function entriesOfTheConfig(): string[] {
	const block = /optimizeDeps:\s*\{[\s\S]*?entries:\s*\[([^\]]*)\]/.exec(
		read("vite.config.js"),
	);
	if (!block) throw new Error("vite.config.js has no optimizeDeps.entries");
	return [...block[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
}

describe("the dependency optimizer's first pass", () => {
	it("scans from every place the route scan cannot see into", () => {
		const entries = entriesOfTheConfig();
		for (const { file, why } of HIDDEN_FROM_THE_ROUTE_SCAN) {
			expect(entries, why).toContain(file);
			expect(existsSync(join(root, file)), `${file} exists`).toBe(true);
		}
	});

	it("has something to find there", () => {
		// The reading of an import is the one this file relies on: it sees Sentry in
		// the hooks and TipTap in the editor. (A file that stopped importing its
		// package would not fail here; it would just have an entry it no longer needs.)
		expect(packagesImportedBy(read("src/hooks.client.ts"))).toContain(
			"@sentry/sveltekit",
		);
		expect(
			packagesImportedBy(
				read("src/lib/components/artifacts/document/document-editor.ts"),
			),
		).toContain("@tiptap/core");
	});
});
