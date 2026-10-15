// The engine's public face: a small, fixed set of functions, and a file that
// imports no kind. The surface may not grow without a reason written in the plan.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(process.cwd(), "src", "lib", "server", "services", "jobs");

describe("index.ts", () => {
	it("exports the interface of the design, the column builders and the test helpers, and no more", async () => {
		const engine = await import("./index");

		expect(Object.keys(engine).sort()).toEqual(
			[
				// The fourteen functions of the interface.
				"defineJobKind",
				"startJobs",
				"stopJobs",
				"drain",
				"enqueue",
				"cancel",
				"cancelAll",
				"retry",
				"reopen",
				"wake",
				"waitForVerdict",
				"runInline",
				"recover",
				"describeJob",
				// The column builders, and the two index helpers that go with them.
				"jobColumns",
				"jobAttemptColumns",
				"liveClaimIndex",
				"jobAttemptIndexes",
				// For tests.
				"inspectJobsForTests",
				"resetJobsForTests",
			].sort(),
		);
	});

	it("imports no kind and no handler", () => {
		const source = readFileSync(join(DIR, "index.ts"), "utf8");
		const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);

		for (const specifier of imports) {
			expect(
				specifier,
				"index.ts may import only the engine's own files",
			).toMatch(/^(\.\/|drizzle-orm$)/);
		}
	});

	it("is imported by no file inside the engine", () => {
		// index.ts is the way IN. A file of the engine that imported it would make a
		// cycle through every module the index imports.
		for (const file of readdirSync(DIR)) {
			if (!/\.ts$/.test(file) || file === "index.ts") continue;
			const source = readFileSync(join(DIR, file), "utf8");
			expect(source, file).not.toMatch(/from\s+"\.\/index"/);
			expect(source, file).not.toMatch(/from\s+"\.\.\/index"/);
		}
	});
});

describe("the engine's files", () => {
	const engineFiles = readdirSync(DIR).filter(
		(file) => /\.ts$/.test(file) && !/\.test\.ts$/.test(file),
	);

	it("import no kind's folder", () => {
		for (const file of engineFiles) {
			const source = readFileSync(join(DIR, file), "utf8");
			expect(source, file).not.toMatch(
				/from\s+"[^"]*\/(atlas|extraction|file-production)\//,
			);
		}
	});

	it("keep columns.ts free of the schema, which imports it", () => {
		const source = readFileSync(join(DIR, "columns.ts"), "utf8");
		expect(source).not.toMatch(/from\s+"[^"]*(db\/schema|\$lib\/server\/db)/);
	});

	it("call no transaction around an await", () => {
		// A transaction here is a synchronous better-sqlite3 transaction. An `await`
		// inside a `db.transaction(` callback would be the callback returning a
		// promise, which commits before the promise settles.
		for (const file of engineFiles) {
			const source = readFileSync(join(DIR, file), "utf8");
			for (const match of source.matchAll(/db\.transaction\(\s*(async\b)?/g)) {
				expect(match[1], `${file}: db.transaction( async`).toBeUndefined();
			}
		}
	});
});
