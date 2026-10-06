import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Slice 5 T9 Step 4: the gate is wired so that it is cheap and deterministic in
// CI (the replay form re-scores the committed answers, no model, no key) and the
// live form, which talks to the production model, never runs there. A replayed
// response cannot measure a prompt change; a live run costs the owner's model on
// every push. Both exist, and only one of them is a CI step.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readRepoFile(path: string): string {
	return readFileSync(join(REPO_ROOT, path), "utf8");
}

const scripts = (
	JSON.parse(readRepoFile("package.json")) as {
		scripts: Record<string, string>;
	}
).scripts;

/** The live harness: either runner, without --replay. */
const LIVE_RUNNERS = /run\.ts|run-tool-suite\.ts|eval:artifacts(?!:replay)/;

describe("the replay form is the only form CI runs", () => {
	it("defines the replay script as every suite, re-scored with no model", () => {
		expect(scripts["eval:artifacts:replay"]).toMatch(/--replay/);
		expect(scripts["eval:artifacts:replay"]).toMatch(/--suite all/);
	});

	it("runs the replay script in the CI workflow", () => {
		expect(readRepoFile(".github/workflows/ci.yml")).toMatch(
			/run:\s*.*npm run eval:artifacts:replay\s*$/m,
		);
	});

	it("never runs a live runner in the CI workflow", () => {
		const runLines = readRepoFile(".github/workflows/ci.yml")
			.split("\n")
			.filter((line) => /^\s*(?:-\s*)?run:/.test(line));
		for (const line of runLines) {
			const withoutReplay = line.replace(/eval:artifacts:replay/g, "");
			expect(withoutReplay, line).not.toMatch(LIVE_RUNNERS);
		}
		expect(readRepoFile(".github/workflows/ci.yml")).not.toMatch(
			/EVAL_ARTIFACTS_/,
		);
	});

	it("keeps the live harness out of npm test", () => {
		for (const name of Object.keys(scripts).filter((key) =>
			key.startsWith("test"),
		)) {
			expect(scripts[name], name).not.toMatch(LIVE_RUNNERS);
		}
	});
});
