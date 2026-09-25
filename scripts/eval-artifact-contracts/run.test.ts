import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalArtifactsModelClient } from "./client";
import {
	loadCommittedResponseFromDisk,
	main,
	parseArgv,
	type RunDeps,
	recordSuiteResponses,
	runSuite,
	writeCommittedResponseToDisk,
} from "./run";
import type { EvalCase } from "./types";

// ── A FAKE suite, never one of the five real ones (document/app/canvas/
// slides/verification) — Slice 5a writes no real suite (ruling 44). This
// proves the runner's own mechanics: the known-bad-first gate, the
// retry/circuit-breaker policy, and replay — entirely through dependency
// injection, so it never touches the real (empty) cases.ts registry.

const FAKE_SUITE = "__fixture_harness_selftest__";

function fakeCase(overrides: Partial<EvalCase> = {}): EvalCase {
	return {
		id: "case-1",
		suite: FAKE_SUITE,
		description: "A fixture case",
		prompt: "Say hello",
		...overrides,
	};
}

function alwaysGoodScore() {
	return { verdict: "good" as const, reasons: ["looks fine"] };
}

function fakeClient(
	send: EvalArtifactsModelClient["send"],
): EvalArtifactsModelClient {
	return { baseUrl: "http://fake.invalid/v1", model: "fake-model", send };
}

function baseDeps(overrides: Partial<RunDeps> = {}): RunDeps {
	return {
		cases: {},
		client: null,
		loadCommittedResponse: () => null,
		score: alwaysGoodScore,
		log: () => {},
		defaultThinking: "off",
		...overrides,
	};
}

describe("parseArgv", () => {
	it("parses --suite, --limit, --only and --out", () => {
		const args = parseArgv([
			"--suite",
			"document",
			"--limit",
			"5",
			"--only",
			"a, b ,c",
			"--out",
			"custom-results",
		]);

		expect(args).toEqual({
			suite: "document",
			replay: false,
			limit: 5,
			only: ["a", "b", "c"],
			out: "custom-results",
			help: false,
		});
	});

	it("treats --skip-model as an alias of --replay", () => {
		expect(parseArgv(["--replay"]).replay).toBe(true);
		expect(parseArgv(["--skip-model"]).replay).toBe(true);
	});

	it("parses --help", () => {
		expect(parseArgv(["--help"]).help).toBe(true);
		expect(parseArgv(["-h"]).help).toBe(true);
	});

	it("defaults everything to unset with no arguments", () => {
		expect(parseArgv([])).toEqual({
			suite: null,
			replay: false,
			limit: null,
			only: null,
			out: null,
			help: false,
		});
	});

	it("ignores a non-positive --limit", () => {
		expect(parseArgv(["--limit", "0"]).limit).toBeNull();
		expect(parseArgv(["--limit", "abc"]).limit).toBeNull();
	});
});

describe("runSuite — the known-bad-first gate", () => {
	it("fails the run when a known-bad fixture did not fail", async () => {
		const deps = baseDeps({
			cases: {
				[FAKE_SUITE]: [
					fakeCase({ id: "known-bad-1", knownBad: true }),
					fakeCase({ id: "regular-1" }),
				],
			},
			// Scores EVERYTHING "good", including the known-bad case — the gate
			// this test proves can fail.
			score: alwaysGoodScore,
			loadCommittedResponse: () => ({ response: "anything" }),
		});

		const report = await runSuite(
			FAKE_SUITE,
			{ replay: true, limit: null, only: null },
			deps,
		);

		expect(report.knownBadFailedAsExpected).toBe(false);
		expect(report.knownBadFailures).toEqual(["known-bad-1"]);
		// Refuses to trust anything once the gate fails — no real scores.
		expect(report.results).toEqual([]);
	});

	it("trusts real scores once every known-bad fixture failed", async () => {
		const scored: string[] = [];
		const deps = baseDeps({
			cases: {
				[FAKE_SUITE]: [
					fakeCase({ id: "known-bad-1", knownBad: true }),
					fakeCase({ id: "regular-1" }),
					fakeCase({ id: "regular-2" }),
				],
			},
			score: (evalCase) => {
				scored.push(evalCase.id);
				return evalCase.id === "known-bad-1"
					? { verdict: "bad", reasons: ["seeded failure"] }
					: { verdict: "good", reasons: ["fine"] };
			},
			loadCommittedResponse: () => ({ response: "anything" }),
		});

		const report = await runSuite(
			FAKE_SUITE,
			{ replay: true, limit: null, only: null },
			deps,
		);

		expect(report.knownBadFailedAsExpected).toBe(true);
		expect(report.knownBadFailures).toEqual([]);
		expect(report.results.map((r) => r.caseId).sort()).toEqual([
			"regular-1",
			"regular-2",
		]);
		// The known-bad set is scored BEFORE any regular case — proof this is a
		// gate a real suite runs through, not a check bolted on afterward.
		expect(scored[0]).toBe("known-bad-1");
	});

	it("passes the gate vacuously (with a warning) when a suite declares no known-bad fixtures", async () => {
		const warnings: string[] = [];
		const deps = baseDeps({
			cases: { [FAKE_SUITE]: [fakeCase({ id: "regular-1" })] },
			loadCommittedResponse: () => ({ response: "anything" }),
			log: (message) => warnings.push(message),
		});

		const report = await runSuite(
			FAKE_SUITE,
			{ replay: true, limit: null, only: null },
			deps,
		);

		expect(report.knownBadFailedAsExpected).toBe(true);
		expect(report.results).toHaveLength(1);
		expect(warnings.some((w) => w.includes("no known-bad fixtures"))).toBe(
			true,
		);
	});
});

describe("runSuite — replay", () => {
	it("replays committed responses without constructing a model client", async () => {
		const deps = baseDeps({
			cases: { [FAKE_SUITE]: [fakeCase({ id: "regular-1" })] },
			client: null, // proves no client is needed
			loadCommittedResponse: (suite, caseId) =>
				suite === FAKE_SUITE && caseId === "regular-1"
					? { response: "a committed answer" }
					: null,
			score: (_evalCase, attempt) => ({
				verdict: attempt.response === "a committed answer" ? "good" : "bad",
				reasons: [],
			}),
		});

		const report = await runSuite(
			FAKE_SUITE,
			{ replay: true, limit: null, only: null },
			deps,
		);

		expect(report.results).toEqual([
			{ caseId: "regular-1", verdict: "good", reasons: [] },
		]);
	});

	it("scores a case bad, not a throw, when no committed response exists for it", async () => {
		const deps = baseDeps({
			cases: { [FAKE_SUITE]: [fakeCase({ id: "regular-1" })] },
			loadCommittedResponse: () => null,
		});

		const report = await runSuite(
			FAKE_SUITE,
			{ replay: true, limit: null, only: null },
			deps,
		);

		expect(report.results).toEqual([
			expect.objectContaining({ caseId: "regular-1", verdict: "bad" }),
		]);
	});
});

describe("runSuite — retry and the two-consecutive-error circuit breaker", () => {
	it("retries exactly once, and scores the retry's result on success", async () => {
		let calls = 0;
		const send = vi.fn(async () => {
			calls += 1;
			if (calls === 1) throw Object.assign(new Error("flaky"), { status: 500 });
			return { text: "recovered" };
		});
		const deps = baseDeps({
			cases: { [FAKE_SUITE]: [fakeCase({ id: "regular-1" })] },
			client: fakeClient(send),
			score: (_c, attempt) => ({
				verdict: attempt.response === "recovered" ? "good" : "bad",
				reasons: [],
			}),
		});

		const report = await runSuite(
			FAKE_SUITE,
			{ replay: false, limit: null, only: null },
			deps,
		);

		expect(send).toHaveBeenCalledTimes(2);
		expect(report.results).toEqual([
			{ caseId: "regular-1", verdict: "good", reasons: [] },
		]);
	});

	it("gives up after the one retry and records the case as bad", async () => {
		const send = vi.fn(async () => {
			throw Object.assign(new Error("still broken"), { status: 500 });
		});
		const deps = baseDeps({
			cases: { [FAKE_SUITE]: [fakeCase({ id: "regular-1" })] },
			client: fakeClient(send),
		});

		const report = await runSuite(
			FAKE_SUITE,
			{ replay: false, limit: null, only: null },
			deps,
		);

		expect(send).toHaveBeenCalledTimes(2);
		expect(report.results).toEqual([
			expect.objectContaining({ caseId: "regular-1", verdict: "bad" }),
		]);
	});

	it("stops after two consecutive 429/5xx failures, recording the case that tripped it but never reaching later cases", async () => {
		const send = vi.fn(async () => {
			throw Object.assign(new Error("rate limited"), { status: 429 });
		});
		const deps = baseDeps({
			cases: {
				[FAKE_SUITE]: [
					fakeCase({ id: "regular-1" }),
					fakeCase({ id: "regular-2" }),
					fakeCase({ id: "regular-3" }),
				],
			},
			client: fakeClient(send),
		});

		const report = await runSuite(
			FAKE_SUITE,
			{ replay: false, limit: null, only: null },
			deps,
		);

		// Two attempts (try + one retry) per failing case, for the two cases
		// that ran before the breaker tripped; regular-3 is never attempted.
		expect(send).toHaveBeenCalledTimes(4);
		expect(report.results.map((r) => r.caseId)).toEqual([
			"regular-1",
			"regular-2",
		]);
		expect(report.stoppedEarly).toBe(true);
	});

	it("does not trip the breaker on a non-429/5xx error", async () => {
		const send = vi.fn(async () => {
			throw new Error("plain failure, no status");
		});
		const deps = baseDeps({
			cases: {
				[FAKE_SUITE]: [
					fakeCase({ id: "regular-1" }),
					fakeCase({ id: "regular-2" }),
				],
			},
			client: fakeClient(send),
		});

		const report = await runSuite(
			FAKE_SUITE,
			{ replay: false, limit: null, only: null },
			deps,
		);

		expect(report.stoppedEarly).toBe(false);
		expect(report.results).toHaveLength(2);
	});
});

describe("runSuite — limit and only", () => {
	it("caps only the non-known-bad cases; the known-bad set always runs in full", async () => {
		const deps = baseDeps({
			cases: {
				[FAKE_SUITE]: [
					fakeCase({ id: "known-bad-1", knownBad: true }),
					fakeCase({ id: "known-bad-2", knownBad: true }),
					fakeCase({ id: "regular-1" }),
					fakeCase({ id: "regular-2" }),
					fakeCase({ id: "regular-3" }),
				],
			},
			score: (evalCase) =>
				evalCase.knownBad
					? { verdict: "bad", reasons: [] }
					: { verdict: "good", reasons: [] },
			loadCommittedResponse: () => ({ response: "x" }),
		});

		const report = await runSuite(
			FAKE_SUITE,
			{ replay: true, limit: 1, only: null },
			deps,
		);

		expect(report.results).toHaveLength(1);
	});

	it("filters both known-bad and regular cases down to the --only ids", async () => {
		const deps = baseDeps({
			cases: {
				[FAKE_SUITE]: [
					fakeCase({ id: "known-bad-1", knownBad: true }),
					fakeCase({ id: "regular-1" }),
					fakeCase({ id: "regular-2" }),
				],
			},
			score: (evalCase) =>
				evalCase.knownBad
					? { verdict: "bad", reasons: [] }
					: { verdict: "good", reasons: [] },
			loadCommittedResponse: () => ({ response: "x" }),
		});

		const report = await runSuite(
			FAKE_SUITE,
			{ replay: true, limit: null, only: ["known-bad-1", "regular-2"] },
			deps,
		);

		expect(report.results.map((r) => r.caseId)).toEqual(["regular-2"]);
	});
});

describe("recordSuiteResponses", () => {
	it("calls the model for every case and returns raw, unscored attempts", async () => {
		const send = vi.fn(async ({ prompt }: { prompt: string }) => ({
			text: `echo: ${prompt}`,
		}));
		const attempts = await recordSuiteResponses(
			FAKE_SUITE,
			{ limit: null, only: null },
			{
				cases: { [FAKE_SUITE]: [fakeCase({ id: "regular-1", prompt: "hi" })] },
				client: fakeClient(send),
				defaultThinking: "off",
			},
		);

		expect(attempts).toEqual([
			expect.objectContaining({
				caseId: "regular-1",
				suite: FAKE_SUITE,
				response: "echo: hi",
			}),
		]);
	});

	it("throws when no client is configured, rather than silently recording nothing", async () => {
		await expect(
			recordSuiteResponses(
				FAKE_SUITE,
				{ limit: null, only: null },
				{
					cases: { [FAKE_SUITE]: [fakeCase()] },
					client: null,
					defaultThinking: "off",
				},
			),
		).rejects.toThrow();
	});
});

describe("committed response disk round trip", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "eval-artifacts-run-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes a committed response and reads it back", () => {
		const path = writeCommittedResponseToDisk(dir, {
			caseId: "case-1",
			suite: FAKE_SUITE,
			response: "the recorded answer",
			durationMs: 42,
		});

		expect(path).toContain(join(FAKE_SUITE, "responses", "case-1.json"));
		const loaded = loadCommittedResponseFromDisk(dir, FAKE_SUITE, "case-1");
		expect(loaded).toEqual({ response: "the recorded answer", durationMs: 42 });
	});

	it("returns null for a case with no committed response file", () => {
		expect(
			loadCommittedResponseFromDisk(dir, FAKE_SUITE, "never-recorded"),
		).toBeNull();
	});
});

describe("main — nothing configured / --help", () => {
	it("prints the help text and exits 0 without reading any config", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		const exitCode = await main(["--help"]);

		expect(exitCode).toBe(0);
		expect(logSpy).toHaveBeenCalled();
		logSpy.mockRestore();
	});

	it("exits 0 with an explanation when no suite has any cases registered", async () => {
		// The real cases.ts registry is empty until a type slice appends a
		// suite (ruling 44) — this proves the "nothing configured" path
		// against production reality, not a mock.
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		const exitCode = await main(["--suite", "document"]);

		expect(exitCode).toBe(0);
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("No cases are registered"),
		);
		logSpy.mockRestore();
	});
});
