import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	loadQuarantine,
	type Quarantine,
	quarantinedFileGlobs,
	quarantinedTitlePattern,
} from "../e2e/quarantine";

const ROOT = process.cwd();

describe("the e2e quarantine list", () => {
	const quarantine = loadQuarantine(ROOT);

	it("gives every entry a reason that says something", () => {
		for (const entry of [...quarantine.files, ...quarantine.tests]) {
			const name =
				"title" in entry ? `${entry.file} › ${entry.title}` : entry.file;
			expect(entry.reason.trim().length, name).toBeGreaterThanOrEqual(30);
		}
	});

	it("names only files that exist, once each", () => {
		const files = [
			...quarantine.files.map((entry) => entry.file),
			...quarantine.tests.map((entry) => entry.file),
		];
		for (const file of files) {
			expect(file, file).toMatch(/^tests\/e2e\/[^/]+\.(spec|test)\.ts$/);
			expect(existsSync(join(ROOT, file)), file).toBe(true);
		}
		const wholeFiles = quarantine.files.map((entry) => entry.file);
		expect(new Set(wholeFiles).size, "a file is listed twice").toBe(
			wholeFiles.length,
		);
	});

	it("names only tests that are in their file, and each title once", () => {
		const titles = new Set<string>();
		for (const entry of quarantine.tests) {
			const source = readFileSync(join(ROOT, entry.file), "utf8");
			expect(
				source.includes(entry.title),
				`${entry.file} › ${entry.title}`,
			).toBe(true);
			const key = `${entry.file}\u0000${entry.title}`;
			expect(titles.has(key), `${entry.title} is listed twice`).toBe(false);
			titles.add(key);
			// A title the whole file would match is not a name for one test.
			expect(
				entry.title.trim().length,
				`${entry.file}: the title is too short to name one test`,
			).toBeGreaterThanOrEqual(12);
		}
	});

	it("does not list a file whole and one of its tests as well", () => {
		const whole = new Set(quarantine.files.map((entry) => entry.file));
		for (const entry of quarantine.tests) {
			expect(whole.has(entry.file), entry.file).toBe(false);
		}
	});
});

describe("what the quarantine becomes in the Playwright config", () => {
	const sample: Quarantine = {
		files: [
			{
				file: "tests/e2e/slow-thing.spec.ts",
				reason: "a reason that is long enough to be a reason",
			},
		],
		tests: [
			{
				file: "tests/e2e/other.spec.ts",
				title: "opens (and closes) the panel [fast]",
				reason: "a reason that is long enough to be a reason",
			},
			{
				file: "tests/e2e/other.spec.ts",
				title: "a second one: 100% sure",
				reason: "a reason that is long enough to be a reason",
			},
		],
	};

	it("ignores a quarantined file wherever it sits under testDir", () => {
		expect(quarantinedFileGlobs(sample)).toEqual(["**/slow-thing.spec.ts"]);
	});

	it("inverts a grep on the exact text of each quarantined title, regex characters and all", () => {
		const pattern = quarantinedTitlePattern(sample);
		expect(pattern).toBeInstanceOf(RegExp);
		expect(
			pattern?.test("a describe opens (and closes) the panel [fast]"),
		).toBe(true);
		expect(pattern?.test("something › a second one: 100% sure")).toBe(true);
		// Parentheses and brackets are text, not a group or a class.
		expect(pattern?.test("opens and closes the panel f")).toBe(false);
		expect(pattern?.test("an unrelated test")).toBe(false);
	});

	it("is nothing at all when nothing is quarantined, so no grep is applied", () => {
		const none: Quarantine = { files: [], tests: [] };
		expect(quarantinedFileGlobs(none)).toEqual([]);
		expect(quarantinedTitlePattern(none)).toBeUndefined();
	});
});
