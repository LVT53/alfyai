import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";

export const UNIT_TEST_INCLUDE = [
	"src/**/*.test.ts",
	"scripts/**/*.test.ts",
	"tests/integration/**/*.test.ts",
	"tests/cross-cutting/**/*.test.ts",
];
export const UNIT_TEST_EXCLUDE = ["tests/e2e/**"];

const FULL_RUN_TRIGGERS = [
	"package.json",
	"package-lock.json",
	"vitest.config.ts",
	"vite.config.js",
	"svelte.config.js",
	"tsconfig.json",
	"src/vitest-setup.ts",
	"src/vitest-global-setup.ts",
	"drizzle/**",
	"scripts/unit-test-selection.mjs",
];

export function vitestForceRerunTriggers() {
	return FULL_RUN_TRIGGERS.map((pattern) => `**/${pattern}`);
}

export function isUnitTestFile(path) {
	return (
		UNIT_TEST_INCLUDE.some((pattern) => matchesGlob(path, pattern)) &&
		!UNIT_TEST_EXCLUDE.some((pattern) => matchesGlob(path, pattern))
	);
}

function git(root, args) {
	const result = spawnSync("git", args, {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 8 * 1024 * 1024,
		timeout: 5000,
	});
	if (result.status !== 0)
		throw new Error(
			result.stderr?.trim() ||
				result.error?.message ||
				`git ${args[0]} exited ${result.status}`,
		);
	return result.stdout;
}

function nulPaths(text) {
	return text.split("\0").filter(Boolean);
}

export function unitTestFiles(root) {
	return [
		...new Set(
			nulPaths(
				git(root, [
					"ls-files",
					"-z",
					"--cached",
					"--others",
					"--exclude-standard",
				]),
			),
		),
	]
		.filter((path) => isUnitTestFile(path) && existsSync(join(root, path)))
		.sort();
}

export function changedSince(root, base) {
	try {
		const ref = git(root, [
			"rev-parse",
			"--verify",
			"--end-of-options",
			`${base}^{commit}`,
		]).trim();
		const mergeBase = git(root, ["merge-base", "HEAD", ref]).trim();
		const changed = new Set(
			nulPaths(git(root, ["ls-files", "-z", "--others", "--exclude-standard"])),
		);
		const deletedOrRenamed = new Set();
		for (const args of [[mergeBase, "HEAD"], ["--cached"], []]) {
			const fields = nulPaths(
				git(root, ["diff", "--name-status", "-z", "-M", ...args]),
			);
			for (let index = 0; index < fields.length; ) {
				const status = fields[index++];
				const path = fields[index++];
				if (status === "D") deletedOrRenamed.add(path);
				else if (status.startsWith("R")) {
					deletedOrRenamed.add(path);
					changed.add(fields[index++]);
				} else if (status.startsWith("C")) {
					changed.add(fields[index++]);
				} else changed.add(path);
			}
		}
		return {
			mergeBase,
			changed: [...changed]
				.filter((path) => existsSync(join(root, path)))
				.sort(),
			deletedOrRenamed: [...deletedOrRenamed].sort(),
		};
	} catch (error) {
		return { error: error.message };
	}
}

export function chooseUnitTests({ changes, alwaysRun, base }) {
	if (changes.error)
		return {
			kind: "all",
			reason: `no merge-base with ${base} (${changes.error})`,
		};
	const trigger = [...changes.changed, ...changes.deletedOrRenamed].find(
		(path) => FULL_RUN_TRIGGERS.some((pattern) => matchesGlob(path, pattern)),
	);
	if (trigger) return { kind: "all", reason: `${trigger} changed` };
	const missing = changes.deletedOrRenamed.find(
		(path) => !isUnitTestFile(path),
	);
	if (missing)
		return { kind: "all", reason: `${missing} was deleted or renamed` };
	return {
		kind: "related",
		paths: [...new Set([...changes.changed, ...alwaysRun])].sort(),
		changed: changes.changed.length,
		alwaysRun: alwaysRun.length,
		base,
		mergeBase: changes.mergeBase,
	};
}

export function alwaysRunFiles(root) {
	return unitTestFiles(root).filter((path) =>
		/^\s*\/\/\s*@always-run:/m.test(readFileSync(join(root, path), "utf8")),
	);
}
