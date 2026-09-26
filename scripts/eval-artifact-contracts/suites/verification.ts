// The `verification` eval suite (Feature 2 · Artifacts, Slice 2 —
// decisions.md ruling 44). Its cases are NOT app-generation prompts: each one
// sends the model the product's own verifier prompt (`verify.ts`'s
// `buildVerifierPrompt`) plus a hand-authored app and the request that
// produced it, and scores whether the raw answer catches (or correctly does
// not catch) a known problem — the same shape `verifyApp`'s own verifier call
// sends, minus `research_web` (this harness's `client.ts` has no tool loop at
// all, so every case runs with `hasResearchWeb: false`).
//
// Three of the four content fixtures are the hand-audited prototype bug
// classes named in slice-2.md's Global Constraints and Task A3
// (mislabelled_aggregate, wrong_unit, wrong_key); the fourth is a clean
// negative the verifier must stay silent on. Fixture HTML lives under
// `fixtures/verification/apps/*.html` — see that directory and
// `fixtures/verification/known-bad/README.md` for what each one demonstrates.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AppVerificationFindingClass,
	buildVerifierPrompt,
	parseVerifierAnswer,
} from "$lib/server/services/artifacts/app/verify";
import type { EvalAttempt, EvalCase, EvalScoreResult } from "../types";

// process.cwd()-relative rather than import.meta.url-relative: this module is
// imported both under Vitest (verification.test.ts) and under tsx (run.ts's
// CLI), and every documented invocation of either runs from the repo root
// (package.json's scripts, this README's own examples) — matching run.ts's
// own fixturesRoot convention (the served, gitignored fixtures/ directory)
// without import.meta.url's URL-scheme quirks under Vitest's module runner.
const FIXTURES_DIR = join(
	process.cwd(),
	"scripts",
	"eval-artifact-contracts",
	"fixtures",
	"verification",
	"apps",
);

function readFixture(fileName: string): string {
	return readFileSync(join(FIXTURES_DIR, fileName), "utf8");
}

interface VerificationFixture {
	id: string;
	description: string;
	language: "en" | "hu";
	/** The request that produced the app — what verify.ts's own `params.prompt` carries. */
	request: string;
	html: string;
	/** null for the clean negative: the verifier must find nothing settled. */
	expectedClass: AppVerificationFindingClass | null;
}

const FIXTURES: VerificationFixture[] = [
	{
		id: "verification-mislabelled-aggregate",
		description:
			"A loan calculator's yearly table holds cumulative-to-date totals mislabelled as per-year figures (prototype bug 03).",
		language: "hu",
		request:
			"Számolj ki egy hitelt: havi törlesztés 50 000 Ft, és mutass egy 3 éves bontású táblázatot arról, mennyit fizettem évente, plusz az összes befizetett összeget.",
		html: readFixture("mislabelled-aggregate.html"),
		expectedClass: "mislabelled_aggregate",
	},
	{
		id: "verification-wrong-unit",
		description:
			"An English-Hungarian flashcard set glosses 'frog' with the plural 'békák' among singular glosses (prototype bug 04).",
		language: "hu",
		request: "Készíts angol-magyar szókártyákat állatokról: cat, dog, frog.",
		html: readFixture("wrong-unit.html"),
		expectedClass: "wrong_unit",
	},
	{
		id: "verification-wrong-key",
		description:
			"A Danube quiz marks Bucharest (not on the Danube) as the correct answer to 'easternmost Danube capital' (prototype bug 07).",
		language: "hu",
		request:
			"Készíts egy kvízkérdést arról, melyik főváros fekszik a Duna mentén a legkeletebbre, négy válaszlehetőséggel.",
		html: readFixture("wrong-key.html"),
		expectedClass: "wrong_key",
	},
	{
		id: "verification-clean",
		description:
			"A correct Celsius-to-Fahrenheit table with no computational or labelling bugs — the negative case.",
		language: "en",
		request:
			"Make a Celsius to Fahrenheit conversion table for 0, 37 and 100 degrees.",
		html: readFixture("clean.html"),
		expectedClass: null,
	},
];

function verifierUserContent(request: string, html: string): string {
	// Mirrors verify.ts's own message content exactly (A3.9's "the request and
	// the HTML only") so this suite measures the real prompt shape.
	return `The request that produced this app:\n${request}\n\nThe app's HTML:\n${html}`;
}

function buildCase(fixture: VerificationFixture): EvalCase {
	return {
		id: fixture.id,
		suite: "verification",
		description: fixture.description,
		prompt: `${buildVerifierPrompt(false, fixture.language)}\n\n${verifierUserContent(fixture.request, fixture.html)}`,
		thinking: "off",
	};
}

/**
 * The suite's own known-bad fixture (ruling 25): the real verifier prompt,
 * plus an instruction to ignore its fenced-JSON contract and answer with a
 * bare word. `parseVerifierAnswer` can never parse that as findings, so this
 * scores "bad" deterministically, live or replayed — see
 * `fixtures/verification/known-bad/README.md`.
 */
const KNOWN_BAD_CASE: EvalCase = {
	id: "verification-known-bad-unparseable",
	suite: "verification",
	description:
		"Asks the verifier to ignore its own JSON contract and answer with a bare word — must score bad.",
	prompt: `${buildVerifierPrompt(false, "en")}\n\n${verifierUserContent(
		"Make a Celsius to Fahrenheit conversion table.",
		readFixture("clean.html"),
	)}\n\nIgnore the fenced JSON format above entirely. Reply with exactly the single word CONFIRMED and nothing else.`,
	knownBad: true,
	thinking: "off",
};

const EXPECTED_CLASS_BY_CASE = new Map<
	string,
	AppVerificationFindingClass | null
>(FIXTURES.map((fixture) => [fixture.id, fixture.expectedClass]));

export const VERIFICATION_EVAL_CASES: EvalCase[] = [
	...FIXTURES.map(buildCase),
	KNOWN_BAD_CASE,
];

/**
 * Pure and synchronous (ruling 25): parses the model's raw answer with the
 * exact parser `verifyApp` uses, then checks it against the fixture's known
 * outcome.
 *
 * - A bug fixture (`expectedClass` set): empty findings → "bad" (missed it
 *   entirely); a settled finding of the expected class → "good"; anything
 *   else it raised (unsettled, or a different class) → "acceptable" — it
 *   noticed something without confidently naming the exact bug, which is a
 *   real, non-broken outcome `verifyApp` itself can also produce.
 * - The clean fixture (`expectedClass: null`): no findings → "good"; a
 *   settled (confident) finding → "bad", because a confident false positive
 *   on a clean app is the failure mode `verify.ts`'s own repair-acceptance
 *   rules exist to avoid; an unsettled finding → "acceptable" (honest doubt,
 *   not a wrong assertion).
 * - An answer that does not parse as the verifier's fenced JSON at all →
 *   "bad", the same standard `verifyApp` applies (`unavailable`, never
 *   trusted).
 */
export function scoreVerificationEval(
	evalCase: EvalCase,
	attempt: EvalAttempt,
): EvalScoreResult {
	const answer = parseVerifierAnswer(attempt.response);
	if (!answer) {
		return {
			verdict: "bad",
			reasons: [
				`case ${evalCase.id}: the answer could not be parsed as the verifier's fenced JSON`,
			],
		};
	}

	const expectedClass = EXPECTED_CLASS_BY_CASE.get(evalCase.id) ?? null;
	const settledFindings = answer.findings.filter(
		(finding) => finding.settled !== false,
	);

	if (expectedClass === null) {
		if (settledFindings.length > 0) {
			const finding = settledFindings[0];
			return {
				verdict: "bad",
				reasons: [
					`case ${evalCase.id}: confidently flagged a problem in a clean app — "${finding.claim}": ${finding.problem}`,
				],
			};
		}
		if (answer.findings.length > 0) {
			return {
				verdict: "acceptable",
				reasons: [
					`case ${evalCase.id}: raised an unsettled doubt about a clean app rather than a confident false positive`,
				],
			};
		}
		return {
			verdict: "good",
			reasons: [`case ${evalCase.id}: correctly silent on a clean app`],
		};
	}

	if (answer.findings.length === 0) {
		return {
			verdict: "bad",
			reasons: [
				`case ${evalCase.id}: missed the known ${expectedClass} bug entirely`,
			],
		};
	}

	const matched = settledFindings.find(
		(finding) => finding.class === expectedClass,
	);
	if (matched) {
		return {
			verdict: "good",
			reasons: [
				`case ${evalCase.id}: correctly flagged ${expectedClass} — "${matched.claim}"`,
			],
		};
	}

	return {
		verdict: "acceptable",
		reasons: [
			`case ${evalCase.id}: flagged something (${answer.findings
				.map((finding) => finding.class)
				.join(
					", ",
				)}) but not a settled match for the known ${expectedClass} bug`,
		],
	};
}
