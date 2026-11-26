// @always-run: reads every unit-test file and the modules they import.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations
import { browserEnvironmentViolations } from "./unit-test-environment.mjs";
// @ts-expect-error — plain .mjs script, no type declarations
import { unitTestFiles } from "./unit-test-selection.mjs";

// Vitest reads pragmas anywhere in a test file, including string literals.
const jsdomMarker = ["// @vitest", "environment jsdom"].join("-");

function scanFixture(
	entry: string,
	dependency = 'export const browser = typeof window !== "undefined";',
) {
	const root = mkdtempSync(join(tmpdir(), "alfyai-unit-environment-"));
	const files = {
		"src/entry.test.ts": entry,
		"src/lib/branch.ts": 'export { browser } from "./folder";',
		"src/lib/folder/index.ts": dependency,
	};
	try {
		for (const [name, source] of Object.entries(files)) {
			const path = join(root, name);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, source);
		}
		return browserEnvironmentViolations(root, ["src/entry.test.ts"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("finds a browser-only module through a $lib import, a relative import and an index file", () => {
	expect(scanFixture('void import("$lib/branch");')).toEqual([
		{
			file: "src/entry.test.ts",
			module: "src/lib/folder/index.ts",
			reason: "typeof window",
		},
	]);
});

test.each([
	['void import("mermaid");', 'import "mermaid"'],
	["new DOMParser();", "new DOMParser"],
])(
	"flags a transitive browser dependency written as %s",
	(dependency, reason) => {
		expect(scanFixture('import "$lib/branch";', dependency)).toEqual([
			{ file: "src/entry.test.ts", module: "src/lib/folder/index.ts", reason },
		]);
	},
);

test("follows literal Vite glob imports with negative patterns", () => {
	expect(
		scanFixture('import.meta.glob(["./lib/**/*.ts", "!./lib/branch.ts"]);'),
	).toEqual([
		{
			file: "src/entry.test.ts",
			module: "src/lib/folder/index.ts",
			reason: "typeof window",
		},
	]);
	expect(
		scanFixture('import.meta.glob(["./lib/**/*.ts", "!./lib/**/*.ts"]);'),
	).toEqual([]);
});

test("leaves raw Vite glob reads in Node", () => {
	expect(
		scanFixture(
			'import.meta.glob("./lib/**/*.ts", { query: "?raw", import: "default" });',
		),
	).toEqual([]);
});

test.each([
	['export const browser = typeof (window) !== "undefined";', "typeof window"],
	["export const browser = !import.meta .env.SSR;", "import.meta.env.SSR"],
])("detects equivalent browser condition %s", (dependency, reason) => {
	expect(scanFixture('import "$lib/branch";', dependency)).toEqual([
		{ file: "src/entry.test.ts", module: "src/lib/folder/index.ts", reason },
	]);
});

test("leaves a file alone that says jsdom", () => {
	expect(scanFixture(`${jsdomMarker}\nwindow.alert();`)).toEqual([]);
});

test("does not follow import type", () => {
	expect(scanFixture('import type { browser } from "$lib/branch";')).toEqual(
		[],
	);
});

test("every unit test that runs in Node reaches no module that acts differently in a browser", () => {
	const root = fileURLToPath(new URL("../", import.meta.url));
	const violations = browserEnvironmentViolations(
		root,
		unitTestFiles(root),
	) as {
		file: string;
		module: string;
		reason: string;
	}[];
	const messages = violations.map(
		({ file, module, reason }) =>
			`${file} runs in Node but reaches ${module} (${reason}), which acts differently outside a browser: add "${jsdomMarker}" as its first line`,
	);
	expect(messages, messages.join("\n")).toHaveLength(0);
});
