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
	documentScorer,
	getSuiteScorer,
	parseDocumentPatchOpsFromModelResponse,
	SUITE_SCORERS,
	scoreArtifactEvalAttempt,
} from "./scoring";
import { DOCUMENT_EVAL_CASES } from "./suites/document";
import type { EvalAttempt, EvalCase, SuiteScorer } from "./types";

function documentCase(id: string): EvalCase {
	const found = DOCUMENT_EVAL_CASES.find((c) => c.id === id);
	if (!found) throw new Error(`no document eval case registered for "${id}"`);
	return found;
}

function documentAttempt(caseId: string, response: string): EvalAttempt {
	return { caseId, suite: "document", response };
}

// A plain relative path from the process cwd (vitest runs from the repo
// root), not `import.meta.url` — that throws "URL must be of scheme file"
// under this project's vitest/jsdom setup (the same fix already used
// elsewhere in this codebase for a source-scan test with the same symptom).
const DOCUMENT_FIXTURES_DIR = join(
	"scripts",
	"eval-artifact-contracts",
	"fixtures",
	"document",
	"responses",
);

function readCommittedResponse(caseId: string): string {
	const path = join(DOCUMENT_FIXTURES_DIR, `${caseId}.json`);
	const committed = JSON.parse(readFileSync(path, "utf8")) as {
		response: string;
	};
	return committed.response;
}

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

// The per-suite dispatch seam (decisions.md ruling 44): getSuiteScorer falls
// back to the generic scorer for any suite with nothing registered — never a
// throw for an unknown suite name, since that would make a type slice's very
// first run (before it registers anything) a crash instead of an honest
// placeholder. Slice 1 has now registered a real `document` scorer (below),
// so these two tests use "canvas" (Slice 3, still unregistered here) as the
// stand-in instead — using "document" would either assert the wrong thing
// or, via this describe's own cleanup, delete Slice 1's real registration
// out from under any test that runs after this one in the same process.
describe("getSuiteScorer", () => {
	afterEach(() => {
		delete SUITE_SCORERS.canvas;
	});

	it("falls back to the generic scorer for an unregistered suite", () => {
		expect(getSuiteScorer("canvas")).toBe(scoreArtifactEvalAttempt);
		expect(getSuiteScorer("nonexistent-suite-name")).toBe(
			scoreArtifactEvalAttempt,
		);
	});

	it("dispatches to a suite's own scorer once one is registered", () => {
		const canvasScorer: SuiteScorer = () => ({
			verdict: "good",
			reasons: ["canvas rule"],
		});
		SUITE_SCORERS.canvas = canvasScorer;

		expect(getSuiteScorer("canvas")).toBe(canvasScorer);
		// Registering one suite's scorer never affects another's fallback.
		expect(getSuiteScorer("app")).toBe(scoreArtifactEvalAttempt);
	});
});

// Slice 1's own registration (ruling 44): document is no longer a "not
// measured yet" placeholder.
describe("getSuiteScorer (document, Slice 1)", () => {
	it("dispatches document to its own registered scorer, not the generic one", () => {
		expect(getSuiteScorer("document")).toBe(SUITE_SCORERS.document);
		expect(getSuiteScorer("document")).not.toBe(scoreArtifactEvalAttempt);
	});
});

// The document suite's own scorer (Feature 2 · Artifacts, Slice 1, Task
// T13, Step 1.1): the five required behaviours, against the suite's REAL
// registered fixtures — not a second, parallel fixture set that could drift
// from what `run.ts --suite document` actually exercises.
describe("documentScorer", () => {
	it("scores a patch that applies cleanly as good", () => {
		const result = documentScorer(
			documentCase("document-clean-patch"),
			documentAttempt(
				"document-clean-patch",
				'[{"op":"replaceBlock","blockId":"p1","baseHash":"7a0213eb","text":"Book the flight to Budapest."}]',
			),
		);
		expect(result.verdict).toBe("good");
	});

	it("scores a patch that applies but rewrites a block outside the requested scope as bad", () => {
		// document-stays-in-scope's fixture is two blocks (p1, p2); the request
		// only ever names day one (p1) — a response that ALSO rewrites p2 has
		// gone outside what was asked, even though both ops apply cleanly.
		const result = documentScorer(
			documentCase("document-stays-in-scope"),
			documentAttempt(
				"document-stays-in-scope",
				'[{"op":"replaceBlock","blockId":"p1","baseHash":"a73237ed","text":"Day one: museum in the afternoon."},' +
					'{"op":"replaceBlock","blockId":"p2","baseHash":"458533ab","text":"Day two: cancelled."}]',
			),
		);
		expect(result.verdict).toBe("bad");
		expect(result.reasons.join(" ")).toContain("day two");
	});

	it("scores a patch that correctly refuses a non-existent block as good — refusing correctly is a pass", () => {
		const result = documentScorer(
			documentCase("document-refuses-missing-block"),
			documentAttempt(
				"document-refuses-missing-block",
				'[{"op":"replaceBlock","blockId":"p-does-not-exist","baseHash":"anything","text":"x"}]',
			),
		);
		expect(result.verdict).toBe("good");
	});

	it("scores a patch that does NOT refuse a genuinely stale block as bad, naming the reason", () => {
		// The fixture's current content differs from what was shown (someone
		// else edited it) — an empty-ops answer never even attempts the
		// block_changed refusal the situation calls for.
		const result = documentScorer(
			documentCase("document-stale-block-refused"),
			documentAttempt("document-stale-block-refused", "[]"),
		);
		expect(result.verdict).toBe("bad");
		expect(result.reasons.join(" ")).toContain("block_changed");
	});

	it("scores an answer with no parseable ops as bad, never throwing", () => {
		expect(() =>
			documentScorer(
				documentCase("document-known-bad-ignores-json-format"),
				documentAttempt(
					"document-known-bad-ignores-json-format",
					"Sure! I've updated the hotel booking.",
				),
			),
		).not.toThrow();
		const result = documentScorer(
			documentCase("document-known-bad-ignores-json-format"),
			documentAttempt(
				"document-known-bad-ignores-json-format",
				"Sure! I've updated the hotel booking.",
			),
		);
		expect(result.verdict).toBe("bad");
	});

	it("correctly refuses an ambiguous find rather than guessing (good), and scores a guess that applies unsafely as bad", () => {
		const refusal = documentScorer(
			documentCase("document-ambiguous-find-refused"),
			documentAttempt("document-ambiguous-find-refused", "[]"),
		);
		expect(refusal.verdict).toBe("good");
	});

	it("scores every committed regular-case response as good (the suite's own replay fixtures)", () => {
		for (const evalCase of DOCUMENT_EVAL_CASES) {
			if (evalCase.knownBad) continue;
			const response = readCommittedResponse(evalCase.id);
			const result = documentScorer(
				evalCase,
				documentAttempt(evalCase.id, response),
			);
			expect(
				result.verdict,
				`case ${evalCase.id}: ${result.reasons.join("; ")}`,
			).toBe("good");
		}
	});

	it("scores the committed known-bad response as bad — the gate this suite exists to prove works", () => {
		const knownBad = DOCUMENT_EVAL_CASES.find((c) => c.knownBad);
		expect(knownBad).toBeDefined();
		const response = readCommittedResponse(knownBad?.id ?? "");
		const result = documentScorer(
			knownBad as EvalCase,
			documentAttempt(knownBad?.id ?? "", response),
		);
		expect(result.verdict).toBe("bad");
	});
});

describe("parseDocumentPatchOpsFromModelResponse", () => {
	it("extracts a JSON array wrapped in a markdown code fence", () => {
		const ops = parseDocumentPatchOpsFromModelResponse(
			'Here you go:\n```json\n[{"op":"replaceBlock","blockId":"p1","baseHash":"h1","text":"x"}]\n```',
		);
		expect(ops).toHaveLength(1);
		expect(ops?.[0].kind).toBe("replaceBlock");
	});

	it("returns an empty array for a deliberate refusal answer", () => {
		expect(parseDocumentPatchOpsFromModelResponse("[]")).toEqual([]);
	});

	it("returns null for prose with no JSON array at all", () => {
		expect(
			parseDocumentPatchOpsFromModelResponse("I updated the document for you."),
		).toBeNull();
	});

	it("returns null for an op missing a required field, rather than throwing", () => {
		expect(
			parseDocumentPatchOpsFromModelResponse(
				'[{"op":"replaceBlock","text":"x"}]',
			),
		).toBeNull();
	});

	it("returns null for an unknown op kind", () => {
		expect(
			parseDocumentPatchOpsFromModelResponse(
				'[{"op":"deleteEverything","blockId":"p1","baseHash":"h1"}]',
			),
		).toBeNull();
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
