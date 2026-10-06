import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EVAL_CASES } from "./cases";
import {
	loadCommittedResponseFromDisk,
	type RunDeps,
	recordSuiteResponses,
	runSuite,
} from "./run";
import { getSuiteScorer } from "./scoring";

// Ruling 59, across every REAL suite rather than a fake one: a known-bad case is
// a recorded answer, hand-written, committed, and served from disk in a live run
// too. The model is never asked to misbehave: a model asked to break its
// contract kept it (verification, RV-2B) and wrote a real app instead of the bare
// word (app), and either way the gate that proves the scorer can fail was
// measuring the model.

const FIXTURES_ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const SUITES = Object.entries(EVAL_CASES);

describe("every suite's known-bad cases are recorded answers (ruling 59)", () => {
	it.each(
		SUITES,
	)("%s declares at least one known-bad case", (_suite, cases) => {
		expect(cases.some((evalCase) => evalCase.knownBad)).toBe(true);
	});

	it.each(
		SUITES,
	)("%s: each known-bad case has its hand-written answer on disk, and no recorded evaluation of one", (suite, cases) => {
		for (const evalCase of cases.filter((c) => c.knownBad)) {
			expect(
				loadCommittedResponseFromDisk(FIXTURES_ROOT, suite, evalCase.id),
				`${evalCase.id} has no committed answer`,
			).not.toBeNull();
			// An evaluation record is what a run makes of a REAL answer (the app's
			// browser pass). A hand-written one has none; a stale one is a sign the
			// model was once asked for this case.
			expect(
				existsSync(
					join(FIXTURES_ROOT, suite, "evaluations", `${evalCase.id}.json`),
				),
				`${evalCase.id} has a recorded evaluation`,
			).toBe(false);
		}
	});

	it.each(
		SUITES,
	)("%s: no known-bad prompt asks the model to misbehave", (_suite, cases) => {
		// The prompt of a known-bad case is never sent. A prompt that tells the
		// model to ignore its contract is the old way of making one, and a reader
		// of it would believe the model is still asked.
		for (const evalCase of cases.filter((c) => c.knownBad)) {
			expect(evalCase.prompt, evalCase.id).not.toMatch(/\bignore\b/i);
		}
	});

	it.each(
		SUITES,
	)("%s: a live run never calls the model for a known-bad case, and the suite's own scorer fails every one", async (suite, cases) => {
		const asked: string[] = [];
		const deps: RunDeps = {
			cases: EVAL_CASES,
			client: {
				baseUrl: "http://offline.invalid/v1",
				model: "offline",
				send: async ({ prompt }) => {
					asked.push(prompt);
					throw new Error("the model is offline");
				},
			},
			loadCommittedResponse: (s, id) =>
				loadCommittedResponseFromDisk(FIXTURES_ROOT, s, id),
			loadCommittedEvaluation: () => null,
			score: (evalCase, attempt, evaluation) =>
				getSuiteScorer(evalCase.suite)(evalCase, attempt, evaluation),
			evaluate: async () => null,
			log: () => {},
			defaultThinking: "off",
		};

		// `only` names no real case, so everything left to run is the known-bad set.
		const report = await runSuite(
			suite,
			{ replay: false, limit: null, only: ["no-such-case"] },
			deps,
		);

		expect(asked).toEqual([]);
		expect(report.knownBadFailures).toEqual([]);
		expect(report.knownBadFailedAsExpected).toBe(true);
		expect(cases.some((evalCase) => evalCase.knownBad)).toBe(true);
	});

	it.each(
		SUITES,
	)("%s: recording asks the model for the real cases only", async (suite, cases) => {
		const asked: string[] = [];
		const recorded = await recordSuiteResponses(
			suite,
			{ limit: null, only: null },
			{
				cases: EVAL_CASES,
				client: {
					baseUrl: "http://offline.invalid/v1",
					model: "offline",
					send: async ({ prompt }) => {
						asked.push(prompt);
						return { text: "recorded" };
					},
				},
				defaultThinking: "off",
				evaluate: async () => null,
			},
		);

		const real = cases.filter((evalCase) => !evalCase.knownBad);
		expect(recorded.map(({ attempt }) => attempt.caseId)).toEqual(
			real.map((evalCase) => evalCase.id),
		);
		expect(asked).toEqual(real.map((evalCase) => evalCase.prompt));
	});
});
