// @always-run: checks the Vitest configuration and test selection policy.
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations
import * as selection from "./unit-test-selection.mjs";

test("collects commits, staged edits, unstaged edits, untracked files and old rename paths", () => {
	const dir = mkdtempSync(join(tmpdir(), "alfyai-selection-"));
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	const write = (name: string, body: string) =>
		writeFileSync(join(dir, name), body);
	try {
		git("init", "-b", "main");
		git("config", "user.email", "test@example.invalid");
		git("config", "user.name", "Selection test");
		mkdirSync(join(dir, "src"));
		for (const name of ["a", "b", "c", "e"])
			write(`src/${name}.ts`, `export const ${name} = 1;\n`);
		git("add", ".");
		git("commit", "-m", "base");
		git("checkout", "-b", "feature");
		write("src/a.ts", "export const a = 2;");
		git("add", "src/a.ts");
		git("commit", "-m", "feature");
		write("src/b.ts", "export const b = 2;");
		git("add", "src/b.ts");
		write("src/c.ts", "export const c = 2;");
		write("src/with spaces.ts", "");
		git("mv", "src/e.ts", "src/moved.ts");
		expect(selection.changedSince(dir, "main")).toMatchObject({
			changed: [
				"src/a.ts",
				"src/b.ts",
				"src/c.ts",
				"src/moved.ts",
				"src/with spaces.ts",
			],
			deletedOrRenamed: ["src/e.ts"],
		});
		expect(selection.changedSince(dir, "missing-ref")).toHaveProperty("error");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test.each([
	"package-lock.json",
	"src/vitest-setup.ts",
	"drizzle/migration.sql",
	"vitest.config.ts",
])("runs every unit test after a change to %s", (path) => {
	expect(
		selection.chooseUnitTests({
			base: "main",
			alwaysRun: [],
			changes: { changed: [path], deletedOrRenamed: [], mergeBase: "abc" },
		}),
	).toEqual({ kind: "all", reason: `${path} changed` });
});

test("uses the full suite when a source may have lost an importer or the base is missing", () => {
	expect(
		selection.chooseUnitTests({
			base: "main",
			alwaysRun: [],
			changes: {
				changed: [],
				deletedOrRenamed: ["src/deleted.ts"],
				mergeBase: "abc",
			},
		}),
	).toMatchObject({ kind: "all" });
	expect(
		selection.chooseUnitTests({
			base: "main",
			alwaysRun: [],
			changes: { error: "missing ref" },
		}),
	).toEqual({ kind: "all", reason: "no merge-base with main (missing ref)" });
});

test("combines unique related paths and always-run files", () => {
	expect(
		selection.chooseUnitTests({
			base: "main",
			alwaysRun: ["src/a.test.ts", "scripts/gates.test.ts"],
			changes: {
				changed: ["src/a.test.ts", "src/a.ts"],
				deletedOrRenamed: ["src/is-included.test.ts"],
				mergeBase: "abc",
			},
		}),
	).toMatchObject({
		kind: "related",
		paths: ["scripts/gates.test.ts", "src/a.test.ts", "src/a.ts"],
		changed: 2,
		alwaysRun: 2,
	});
});

test("matches the unit runner's discovery paths", () => {
	for (const path of [
		"src/x/y.test.ts",
		"src/y.test.ts",
		"scripts/gates.test.ts",
		"tests/integration/z.test.ts",
	]) {
		expect(selection.isUnitTestFile(path)).toBe(true);
	}
	for (const path of [
		"tests/e2e/a.test.ts",
		"src/a.ts",
		"tests/mocks/a.test.ts",
	]) {
		expect(selection.isUnitTestFile(path)).toBe(false);
	}
});

// Runtime file access is invisible to Vitest's import-based selection.
test("file and process tests declare their relationship to repository files", () => {
	const files: string[] = selection.unitTestFiles(process.cwd());
	const external =
		/\b(?:readFileSync|readFile|readdirSync|readdir|statSync|opendirSync|globSync|spawnSync|spawn|execSync|execFileSync|execFile|fork)\s*\(|(?<!meta\.)\bglob\s*\(/;
	const marker = /^\s*\/\/\s*@(always-run|self-contained):\s*\S/m;
	const missing = files.filter((path) => {
		const source = readFileSync(path, "utf8");
		return external.test(source) && !marker.test(source);
	});
	expect(
		missing,
		'add "// @always-run: <what it reads>" or "// @self-contained: <why>"',
	).toEqual([]);
	expect(selection.alwaysRunFiles(process.cwd())).toEqual(
		expect.arrayContaining([
			"scripts/gates.test.ts",
			"scripts/gates-queue.test.ts",
			"scripts/validate-i18n.test.ts",
			"src/lib/utils/tool-reason-words.test.ts",
			"scripts/unit-test-selection.test.ts",
		]),
	);
});
