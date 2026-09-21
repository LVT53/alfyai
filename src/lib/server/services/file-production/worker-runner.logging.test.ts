// What the file-production worker says out loud.
//
// The stuck-job shape this branch fixes produced ZERO `[FILE_PRODUCTION]`
// orchestration lines: the worker started silently, the boot sweep reclaimed
// silently, and a failed attempt wrote its code only into the ledger. These
// lines are the minimum that makes the sequence readable in a journal — and
// they carry ids, counts, codes and durations only, never a title the user
// chose, a prompt, or a byte of the produced file, because this log ends up in
// places the document is not allowed to reach.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFileProductionLedgerFixture,
	type FileProductionLedgerFixture,
} from "./testing/ledger-fixtures";

type Worker = typeof import("./worker-runner");

let fixture: FileProductionLedgerFixture;
let worker: Worker;
/** Only what `payloadsFor` reads, so the spy's own generics stay out of it. */
type ConsoleSpy = { mock: { calls: unknown[][] } };
let info: ConsoleSpy;
let warn: ConsoleSpy;

const userId = "user-1";
const conversationId = "conv-1";

beforeEach(async () => {
	fixture = createFileProductionLedgerFixture("fp-logging");
	fixture.seedUser(userId);
	fixture.seedConversation(conversationId, userId);

	process.env.DATABASE_PATH = fixture.dbPath;
	delete process.env.FILE_PRODUCTION_STALE_ATTEMPT_MS;
	vi.resetModules();
	worker = await import("./worker-runner");
	worker.resetFileProductionWorkerForTests();

	info = vi.spyOn(console, "info").mockImplementation(() => {});
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	worker.resetFileProductionWorkerForTests();
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

describe("[FILE_PRODUCTION] worker log lines", () => {
	it("announces what it actually started with", async () => {
		vi.useFakeTimers();
		await worker.ensureFileProductionWorker({
			startInNonServingContextForTests: true,
			workerId: "log-worker",
		});

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

		await worker.drainFileProductionWorker({
			workerId: "log-worker",
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

		await worker.drainFileProductionWorker({ workerId: "log-worker" });

		expect(
			payloadsFor(warn, "[FILE_PRODUCTION] Job will not be retried"),
		).toMatchObject([
			{ jobId, errorCode: "unsupported_file_production_request" },
		]);
	});

	it("says nothing about a sweep that reclaimed nothing", async () => {
		// This one runs forever on an idle box; a line per tick would drown the
		// lines that matter.
		await worker.drainFileProductionWorker({ workerId: "log-worker" });
		expect(
			payloadsFor(warn, "[FILE_PRODUCTION] Reclaimed stale attempts"),
		).toEqual([]);
	});

	it("names the sweep that reclaimed something, with a count", async () => {
		const jobId = fixture.seedJob({ userId, conversationId });
		fixture.seedOrphanedRunningJob({ jobId, heartbeatAgeMs: 10 * 60 * 1000 });
		vi.useFakeTimers();

		await worker.ensureFileProductionWorker({
			startInNonServingContextForTests: true,
			workerId: "log-worker",
		});

		expect(
			payloadsFor(warn, "[FILE_PRODUCTION] Reclaimed stale attempts"),
		).toMatchObject([
			{ reason: "boot", recovered: 1, staleAttemptMs: 120_000 },
		]);
	});
});
