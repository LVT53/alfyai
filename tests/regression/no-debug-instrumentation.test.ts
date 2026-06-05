import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve(process.cwd(), "src");
const forbiddenDebugPrefix = "[DEBUG-" + "diagnose-stream]";
const sourceExtensions = new Set([".ts", ".svelte"]);

async function listSourceFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map(async (entry) => {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) return listSourceFiles(fullPath);
			return sourceExtensions.has(path.extname(entry.name)) ? [fullPath] : [];
		}),
	);
	return nested.flat();
}

describe("production debug instrumentation", () => {
	it("does not ship diagnose stream debug markers in source", async () => {
		const files = await listSourceFiles(sourceRoot);
		const offenders: string[] = [];

		for (const file of files) {
			const text = await readFile(file, "utf8");
			if (text.includes(forbiddenDebugPrefix)) {
				offenders.push(path.relative(process.cwd(), file));
			}
		}

		expect(offenders).toEqual([]);
	});
});
