import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Vite's dependency optimizer scans from the ROUTE files. A package that only a
// hooks file imports is not found by the scan: the first page load finds it,
// re-optimizes and reloads the page, which on a dev server with an empty cache
// aborts the first navigation and breaks hydration with two copies of Svelte's
// runtime (the first e2e test of a fresh server used to fail that way). Naming
// such packages in `optimizeDeps.include` puts them in the first pass.

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

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

/** The strings in `optimizeDeps.include`, read off the config's own text. */
function includedByTheConfig(): string[] {
	const block = /optimizeDeps:\s*\{[\s\S]*?include:\s*\[([^\]]*)\]/.exec(
		read("vite.config.js"),
	);
	if (!block) throw new Error("vite.config.js has no optimizeDeps.include");
	return [...block[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
}

describe("the dependency optimizer's first pass", () => {
	it("holds every package the client hooks import, which the route scan cannot see", () => {
		const imported = packagesImportedBy(read("src/hooks.client.ts"));
		// The check sees what it is meant to: the hooks do import Sentry.
		expect(imported).toContain("@sentry/sveltekit");

		const included = includedByTheConfig();
		expect(imported.filter((name) => !included.includes(name))).toEqual([]);
	});
});
