// What the file-production worker says out loud.
//
// The stuck-job shape this fixes produced ZERO `[FILE_PRODUCTION]` orchestration
// lines: the worker started silently, the boot sweep reclaimed silently, and a
// failed attempt wrote its code only into the ledger. These lines are the minimum
// that makes the sequence readable in a journal — and they carry ids, counts, codes
// and durations only, never a title the user chose, a prompt, or a byte of the
// produced file, because this log ends up in places the document is not allowed to
// reach.
//
// The lines come from the job engine now (`services/jobs`: it says what happened
// to the attempt, and what the boot sweeps found); the words are the ones the
// worker used before the engine, and this test pins them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFileProductionLedgerFixture,
	type FileProductionLedgerFixture,
} from "./testing/ledger-fixtures";
import { drainFileProductionJobs } from "./testing/run-once";
import { resetSeams } from "./testing/runner-seams";

let fixture: FileProductionLedgerFixture;
/** Only what `payloadsFor` reads, so the spy's own generics stay out of it. */
type ConsoleSpy = { mock: { calls: unknown[][] } };
let info: ConsoleSpy;
let warn: ConsoleSpy;

const userId = "user-1";
const conversationId = "conv-1";

beforeEach(async () => {
	resetSeams();
	fixture = createFileProductionLedgerFixture("fp-logging");
	fixture.seedUser(userId);
	fixture.seedConversation(conversationId, userId);

	process.env.DATABASE_PATH = fixture.dbPath;
	delete process.env.FILE_PRODUCTION_STALE_ATTEMPT_MS;
	vi.resetModules();

	info = vi.spyOn(console, "info").mockImplementation(() => {});
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
	try {
		const { resetJobsForTests } = await import("$lib/server/services/jobs");
		resetJobsForTests();
	} catch {
		// The engine was never imported.
	}
	try {
		const { sqlite } = await import("$lib/server/db");
		sqlite.close();
	} catch {
		// The DB module may not have been imported if a test failed early.
	}
	vi.useRealTimers();
	fixture.cleanup();
	vi.restoreAllMocks();
});

function payloadsFor(
	spy: ConsoleSpy,
	message: string,
): Record<string, unknown>[] {
	return spy.mock.calls
		.filter((call) => call[0] === message)
		.map((call) => call[1] as Record<string, unknown>);
}

async function startEngine() {
	const { startJobs } = await import("$lib/server/services/jobs");
	const { fileProductionJob } = await import("./production-job");
	await startJobs([fileProductionJob], {
		startInNonServingContextForTests: true,
	});
}

describe("[FILE_PRODUCTION] worker log lines", () => {
	it("announces what it actually started with", async () => {
		vi.useFakeTimers();
		await startEngine();

		expect(payloadsFor(info, "[FILE_PRODUCTION] Worker started")).toMatchObject(
			[{ idleTickMs: 30_000, staleAttemptMs: 120_000, heartbeatMs: 15_000 }],
		);
	});

	it("reports a failed attempt with its code, and says when it is terminal", async () => {
		const jobId = fixture.seedJob({
			userId,
			conversationId,
			title: "Secret quarterly numbers",
		});

		await drainFileProductionJobs({
			executeCode: async () => ({
				files: [],
				stdout: "",
				stderr: "",
				error: "the program exited with status 1",
			}),
		});

		const [failed] = payloadsFor(warn, "[FILE_PRODUCTION] Attempt failed");
		expect(failed).toMatchObject({
			jobId,
			attemptNumber: 1,
			errorCode: "program_execution_failed",
			retryable: true,
		});
		expect(typeof failed.durationMs).toBe("number");

		// Ids, counts, codes and durations only: no title, no program source, no
		// produced bytes.
		const serialized = JSON.stringify(failed);
		expect(serialized).not.toContain("Secret quarterly numbers");
		expect(serialized).not.toContain("print(");

		// A retryable failure is not the end of the job: the user can still press
		// Retry, so nothing claims it is finished with.
		expect(
			payloadsFor(warn, "[FILE_PRODUCTION] Job will not be retried"),
		).toEqual([]);
	});

	it("says when a job has no automatic or manual try left", async () => {
		const jobId = fixture.seedJob({
			userId,
			conversationId,
			requestJson: { sourceMode: "nonsense" },
		});

		await drainFileProductionJobs();

		expect(
			payloadsFor(warn, "[FILE_PRODUCTION] Job will not be retried"),
		).toMatchObject([
			{ jobId, errorCode: "unsupported_file_production_request" },
		]);
	});

	it("says nothing about a sweep that reclaimed nothing", async () => {
		// This one runs forever on an idle box; a line per tick would drown the
		// lines that matter.
		await drainFileProductionJobs();
		expect(
			payloadsFor(warn, "[FILE_PRODUCTION] Reclaimed stale attempts"),
		).toEqual([]);
	});

	it("names the sweep that reclaimed something, with a count", async () => {
		const jobId = fixture.seedJob({ userId, conversationId });
		fixture.seedOrphanedRunningJob({ jobId, heartbeatAgeMs: 10 * 60 * 1000 });
		vi.useFakeTimers();

		await startEngine();

		expect(
			payloadsFor(warn, "[FILE_PRODUCTION] Reclaimed stale attempts"),
		).toMatchObject([
			{ reason: "boot", recovered: 1, staleAttemptMs: 120_000 },
		]);
	});
});
