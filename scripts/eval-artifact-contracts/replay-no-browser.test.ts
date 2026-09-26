// Ruling 56, end to end: "--replay constructs no browser and no client."
// The unit tests in run.test.ts prove the generic core never calls
// deps.evaluate under --replay; browser-eval.test.ts proves evaluateAppEval
// really does launch Chromium when it runs. This test wires the REAL `app`
// suite's evaluator (evaluators.ts's getSuiteEvaluator, not a fake) through
// runSuite with a mocked chromium.launch, so a regression that reintroduces
// a live call on the replay path would fail here even if it looked correct
// at either layer alone.
import { describe, expect, it, vi } from "vitest";

const launch = vi.fn();
vi.mock("playwright", () => ({
	chromium: { launch: (...args: unknown[]) => launch(...args) },
}));

import { getSuiteEvaluator } from "./evaluators";
import { type RunDeps, runSuite } from "./run";
import { getSuiteScorer } from "./scoring";
import { APP_EVAL_CASES } from "./suites/apps";
import type { EvalCase } from "./types";

const FENCED_APP_RESPONSE = [
	"```html",
	'<!doctype html><html lang="en"><body>',
	'<button id="go">Go</button>',
	"</body></html>",
	"```",
].join("\n");

function realAppDeps(overrides: Partial<RunDeps> = {}): RunDeps {
	const evaluator = getSuiteEvaluator("app");
	if (!evaluator) throw new Error("app suite has no registered evaluator");
	return {
		cases: {},
		client: null,
		loadCommittedResponse: () => null,
		loadCommittedEvaluation: () => null,
		score: (evalCase, attempt, evaluation) =>
			getSuiteScorer(evalCase.suite)(evalCase, attempt, evaluation),
		evaluate: evaluator,
		log: () => {},
		defaultThinking: "off",
		...overrides,
	};
}

describe("the real app suite's evaluate step under --replay (ruling 56)", () => {
	it("never launches Chromium when replaying a committed response and evaluation", async () => {
		const knownBad = APP_EVAL_CASES.find((c) => c.knownBad);
		if (!knownBad) throw new Error("no known-bad app case");
		const regular: EvalCase = {
			id: "app-replay-check",
			suite: "app",
			description: "a fenced app, replayed",
			prompt: "irrelevant under replay",
			language: "en",
		};

		const deps = realAppDeps({
			cases: { app: [knownBad, regular] },
			loadCommittedResponse: (_suite, caseId) =>
				caseId === regular.id
					? { response: FENCED_APP_RESPONSE }
					: { response: "OK" }, // the known-bad fixture's own expected answer
			loadCommittedEvaluation: () => ({ pages: [], interaction: {} }),
		});

		await runSuite("app", { replay: true, limit: null, only: null }, deps);

		expect(launch).not.toHaveBeenCalled();
	});

	it("does launch Chromium on a live run once extraction finds a fenced app", async () => {
		launch.mockResolvedValue({
			newContext: vi.fn(),
			close: vi.fn(),
		});
		const client = {
			baseUrl: "http://fake.invalid",
			model: "fake",
			send: vi.fn().mockResolvedValue({ text: FENCED_APP_RESPONSE }),
		};
		const deps = realAppDeps({
			cases: {
				app: [
					{
						id: "app-live-check",
						suite: "app",
						description: "a fenced app, live",
						prompt: "make an app",
						language: "en",
					},
				],
			},
			client,
		});

		// newContext throws immediately in this fake browser, so evaluateApp's
		// own try/catch records it as a page error rather than the test needing
		// a full fake Playwright Context/Page — the only thing under test here
		// is whether chromium.launch was reached at all.
		await runSuite("app", { replay: false, limit: null, only: null }, deps);

		expect(launch).toHaveBeenCalled();
	});
});
