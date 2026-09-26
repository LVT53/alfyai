import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getSuiteScorer,
	SUITE_SCORERS,
	scoreArtifactEvalAttempt,
} from "./scoring";
import type { EvalAttempt, EvalCase, SuiteScorer } from "./types";

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
	return {
		id: "case-1",
		suite: "document",
		description: "A fixture case",
		prompt: "Write a weekend checklist",
		...overrides,
	};
}

function makeAttempt(overrides: Partial<EvalAttempt> = {}): EvalAttempt {
	return {
		caseId: "case-1",
		suite: "document",
		response: "# Weekend\n- [ ] Buy groceries",
		...overrides,
	};
}

describe("scoreArtifactEvalAttempt", () => {
	it("grades a fixture attempt as good/acceptable/bad with reasons", () => {
		const result = scoreArtifactEvalAttempt(makeCase(), makeAttempt());

		expect(["good", "acceptable", "bad"]).toContain(result.verdict);
		expect(result.reasons.length).toBeGreaterThan(0);
	});

	it("grades an empty answer as bad rather than throwing", () => {
		const result = scoreArtifactEvalAttempt(
			makeCase(),
			makeAttempt({ response: "" }),
		);

		expect(result.verdict).toBe("bad");
		expect(result.reasons.length).toBeGreaterThan(0);
	});

	it("grades a whitespace-only answer as bad", () => {
		const result = scoreArtifactEvalAttempt(
			makeCase(),
			makeAttempt({ response: "   \n\t  " }),
		);

		expect(result.verdict).toBe("bad");
	});

	it("does not throw for a mismatched case/attempt suite", () => {
		expect(() =>
			scoreArtifactEvalAttempt(
				makeCase({ suite: "document" }),
				makeAttempt({ suite: "app" }),
			),
		).not.toThrow();
	});
});

// The per-suite dispatch seam (decisions.md ruling 44): SUITE_SCORERS is
// empty in Slice 5a, and getSuiteScorer falls back to the generic scorer
// above for any suite with nothing registered — never a throw for an
// unknown suite name, since that would make a type slice's very first run
// (before it registers anything) a crash instead of an honest placeholder.
describe("getSuiteScorer", () => {
	afterEach(() => {
		delete SUITE_SCORERS.document;
	});

	it("falls back to the generic scorer for an unregistered suite", () => {
		expect(getSuiteScorer("document")).toBe(scoreArtifactEvalAttempt);
		expect(getSuiteScorer("nonexistent-suite-name")).toBe(
			scoreArtifactEvalAttempt,
		);
	});

	it("dispatches to a suite's own scorer once one is registered", () => {
		const documentScorer: SuiteScorer = () => ({
			verdict: "good",
			reasons: ["document rule"],
		});
		SUITE_SCORERS.document = documentScorer;

		expect(getSuiteScorer("document")).toBe(documentScorer);
		// Registering one suite's scorer never affects another's fallback.
		expect(getSuiteScorer("app")).toBe(scoreArtifactEvalAttempt);
	});
});

// decisions.md ruling 25 / slice-5.md §The eval harness: the harness's own
// key rule is absolute, and this test runs on every invocation of this file
// (not only when someone remembers to add a fixture) — grep every file
// under a results/-shaped directory for anything that looks like an API
// key, and fail on a hit. Real results/ is gitignored and typically does
// not exist in a fresh checkout, so this exercises the same check against a
// directory this test populates itself with a FAKE key shape, proving the
// grep itself would catch a real leak rather than passing vacuously.
describe("no API-key shape reaches a results file", () => {
	let dir: string;
	const FAKE_KEY_SHAPE = "sk-test-fake-not-a-real-key-abcdefgh12345678";

	function listFilesRecursively(root: string): string[] {
		const found: string[] = [];
		for (const entry of readdirSync(root)) {
			const full = join(root, entry);
			found.push(
				...(statSync(full).isDirectory() ? listFilesRecursively(full) : [full]),
			);
		}
		return found;
	}

	// A generic opaque-token shape: 32+ contiguous alnum/dash/underscore
	// characters that include at least one digit. 32 (not 20) and "has a
	// digit" together are what keep this from tripping on an ordinary long
	// camelCase JSON key (e.g. "knownBadFailedAsExpected", 24 letters, no
	// digits) while still catching a real API key's shape.
	function containsKeyShapedString(text: string): boolean {
		const candidates = text.match(/[A-Za-z0-9_-]{32,}/g) ?? [];
		return candidates.some((candidate) => /[0-9]/.test(candidate));
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "eval-artifacts-results-leak-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("would catch a key-shaped string if one were ever written", () => {
		// Prove the detector itself works before trusting a clean run below.
		writeFileSync(
			join(dir, "leaked.json"),
			JSON.stringify({ apiKey: FAKE_KEY_SHAPE }),
		);

		const hit = listFilesRecursively(dir).some((file) =>
			containsKeyShapedString(readFileSync(file, "utf8")),
		);
		expect(hit).toBe(true);
	});

	it("finds nothing key-shaped in a real results.json written by the runner", async () => {
		const { writeResultsJson } = await import("./run");
		writeResultsJson(dir, [
			{
				suite: "document",
				knownBadFailedAsExpected: true,
				knownBadFailures: [],
				results: [{ caseId: "case-1", verdict: "good", reasons: ["fine"] }],
				stoppedEarly: false,
			},
		]);

		const offenders = listFilesRecursively(dir).filter((file) =>
			containsKeyShapedString(readFileSync(file, "utf8")),
		);
		expect(offenders).toEqual([]);
	});
});
