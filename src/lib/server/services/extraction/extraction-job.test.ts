import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobFailure } from "$lib/server/services/jobs";
import {
	createLedgerFixture,
	type LedgerFixture,
} from "./testing/ledger-fixtures";
import { installSeams, resetSeams, seams } from "./testing/runner-seams";

// The extraction kind's definition, and the policy it hands the engine. What the
// engine does with them (claim order, fencing, take-backs, scheduling) is tested
// in services/jobs with its own kind; what is tested here is what is particular to
// extraction: the arithmetic of "again or done" (`retry-policy.ts` has the pure
// cases, this is its wiring to the engine's hook), which words the engine may be
// told, and the caps the definition reads live.

let fixture: LedgerFixture;
let storageDir: string;
/** A stored document every seeded artifact points at, so a claim finds its file. */
let storagePath: string;
const userId = "user-1";

beforeEach(async () => {
	resetSeams();
	fixture = createLedgerFixture("extraction-job");
	fixture.seedUser(userId);
	fixture.seedUser("user-2");
	storageDir = await mkdtemp(join(tmpdir(), "alfyai-extraction-job-"));
	const stored = join(storageDir, "stored.pdf");
	await writeFile(stored, "stored bytes", "utf8");
	storagePath = relative(process.cwd(), stored);
	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
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
	fixture.cleanup();
	await rm(storageDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

async function loadKind() {
	await installSeams();
	const jobs = await import("$lib/server/services/jobs");
	const kind = await import("./extraction-job");
	return { ...jobs, ...kind };
}

function failure(over: Partial<JobFailure> = {}): JobFailure {
	return {
		code: "job_failed",
		message: "the backend said no",
		retryable: true,
		...over,
	};
}

const NOW = 1_781_000_000_000;

describe("the failure policy the engine calls", () => {
	it("waits out an outage without spending the document's attempts, and remembers it", async () => {
		const { decideExtractionFailure } = await loadKind();

		const decision = decideExtractionFailure(failure({ code: "unavailable" }), {
			attempts: 4,
			state: null,
			nowMs: NOW,
		});

		expect(decision).toMatchObject({
			requeue: true,
			code: "unavailable",
			retryable: true,
			state: { since: NOW, waits: 1 },
		});
		// 5 s, jittered by ±20%.
		if (!decision.requeue) throw new Error("expected a requeue");
		expect(decision.delayMs).toBeGreaterThanOrEqual(4000);
		expect(decision.delayMs).toBeLessThanOrEqual(6000);
	});

	it("continues an outage from the state the engine kept on the job", async () => {
		const { decideExtractionFailure } = await loadKind();

		const decision = decideExtractionFailure(failure({ code: "timeout" }), {
			attempts: 6,
			// What `retry_state_json` holds, parsed by the engine.
			state: { since: NOW - 60_000, waits: 3 },
			nowMs: NOW,
		});

		expect(decision).toMatchObject({
			requeue: true,
			state: { since: NOW - 60_000, waits: 4 },
		});
	});

	it("gives up when the outage window is spent, and says the user may try again", async () => {
		const { decideExtractionFailure } = await loadKind();

		const decision = decideExtractionFailure(failure({ code: "unavailable" }), {
			attempts: 14,
			state: { since: NOW - 1_900_000, waits: 12 },
			nowMs: NOW,
		});

		expect(decision).toEqual({
			requeue: false,
			code: "unavailable",
			retryable: true,
			// The window is over; the count of attempts that were not the document's
			// fault stays.
			state: { since: null, waits: 13 },
		});
	});

	it("requeues an ordinary retryable failure with a backoff and leaves the state empty", async () => {
		const { decideExtractionFailure } = await loadKind();

		const decision = decideExtractionFailure(failure(), {
			attempts: 1,
			state: null,
			nowMs: NOW,
		});

		expect(decision).toMatchObject({
			requeue: true,
			code: "job_failed",
			retryable: true,
			// Nothing to remember: the column stays empty.
			state: null,
		});
	});

	it("settles when the attempts are spent, as retryable for the user", async () => {
		const { decideExtractionFailure } = await loadKind();

		expect(
			decideExtractionFailure(failure(), {
				attempts: 3,
				state: null,
				nowMs: NOW,
			}),
		).toEqual({
			requeue: false,
			code: "max_attempts",
			retryable: true,
			state: null,
		});
	});

	it("settles a failure the document caused, without a Retry the same bytes cannot use", async () => {
		const { decideExtractionFailure } = await loadKind();

		expect(
			decideExtractionFailure(
				failure({ code: "empty_result", retryable: false }),
				{ attempts: 1, state: null, nowMs: NOW },
			),
		).toEqual({
			requeue: false,
			code: "empty_result",
			retryable: false,
			state: null,
		});
	});

	it("keeps the Retry button for a configuration failure an admin can fix", async () => {
		const { decideExtractionFailure } = await loadKind();

		expect(
			decideExtractionFailure(
				failure({ code: "auth_failed", retryable: false }),
				{ attempts: 1, state: null, nowMs: NOW },
			),
		).toMatchObject({ requeue: false, code: "auth_failed", retryable: true });
	});

	it("closes the door past the ceiling, whatever the code says", async () => {
		const { decideExtractionFailure } = await loadKind();

		expect(
			decideExtractionFailure(failure(), {
				attempts: 3 + 5,
				state: null,
				nowMs: NOW,
			}),
		).toEqual({
			requeue: false,
			code: "max_attempts",
			retryable: false,
			state: null,
		});
	});

	it("treats a take-back as an ordinary retryable failure", async () => {
		const { decideExtractionFailure } = await loadKind();

		expect(
			decideExtractionFailure(
				failure({ code: "stale_worker", message: "gone" }),
				{ attempts: 1, state: null, nowMs: NOW },
			),
		).toMatchObject({ requeue: true, code: "stale_worker", retryable: true });
	});

	it("reads a word it has not heard as an ordinary retryable failure, never as a crash", async () => {
		const { decideExtractionFailure } = await loadKind();

		// `no_verdict` is the engine's own word for a handler that returned with
		// nothing to say; the retry arithmetic has a policy for every code of its
		// vocabulary and none for this one.
		for (const code of ["no_verdict", "something_else", ""]) {
			expect(
				decideExtractionFailure(failure({ code }), {
					attempts: 1,
					state: null,
					nowMs: NOW,
				}),
			).toMatchObject({ requeue: true, code: "job_failed", retryable: true });
		}
	});

	it("starts from nothing when the state it was given is not a state", async () => {
		const { decideExtractionFailure } = await loadKind();

		for (const state of ["garbage", 7, [], { waits: "many" }]) {
			expect(
				decideExtractionFailure(failure({ code: "unavailable" }), {
					attempts: 1,
					state,
					nowMs: NOW,
				}),
			).toMatchObject({ requeue: true, state: { since: NOW, waits: 1 } });
		}
	});

	it("honours the delay an extractor asked for during an outage", async () => {
		const { decideExtractionFailure } = await loadKind();

		const decision = decideExtractionFailure(
			failure({ code: "rate_limited", retryAfterMs: 42_000 }),
			{ attempts: 1, state: null, nowMs: NOW },
		);

		expect(decision).toMatchObject({ requeue: true, delayMs: 42_000 });
	});
});

describe("which jobs a user's Retry may reopen", () => {
	async function row(over: Record<string, unknown>) {
		const { enqueue, extractionJob } = await loadKind();
		const artifactId = fixture.seedArtifact({
			userId,
			name: `doc-${Math.random().toString(36).slice(2)}.pdf`,
		});
		const { row: created } = await enqueue(extractionJob, {
			values: {
				userId,
				conversationId: null,
				sourceArtifactId: artifactId,
				origin: "upload",
				intakeRoute: "mineru",
				fileName: "doc.pdf",
				mimeType: "application/pdf",
				sizeBytes: 1,
			},
		});
		return { ...created, ...over } as typeof created;
	}

	it("allows a failed or cancelled job with document attempts left", async () => {
		const { describeJob, extractionJob } = await loadKind();

		expect(
			describeJob(
				extractionJob,
				await row({ status: "failed", attemptCount: 3 }),
			).canRetry,
		).toBe(true);
		expect(
			describeJob(
				extractionJob,
				await row({ status: "cancelled", attemptCount: 1 }),
			).canRetry,
		).toBe(true);
	});

	it("refuses a job that is not settled badly", async () => {
		const { describeJob, extractionJob } = await loadKind();

		for (const status of ["queued", "running", "succeeded"]) {
			expect(
				describeJob(extractionJob, await row({ status, attemptCount: 1 }))
					.canRetry,
				status,
			).toBe(false);
		}
	});

	it("measures the ceiling in document attempts: outage waits are not the document's", async () => {
		const { describeJob, extractionJob } = await loadKind();
		const ceiling = 3 + 5;

		// Eight document attempts: the ceiling is reached.
		expect(
			describeJob(
				extractionJob,
				await row({ status: "failed", attemptCount: ceiling }),
			).canRetry,
		).toBe(false);
		// Twelve attempts spent waiting out a dead backend count for none of it.
		expect(
			describeJob(
				extractionJob,
				await row({
					status: "failed",
					attemptCount: ceiling + 4,
					retryState: JSON.stringify({ since: null, waits: 12 }),
				}),
			).canRetry,
		).toBe(true);
	});
});

describe("the caps are read when a job is claimed", () => {
	async function queueJob(owner: string, name: string): Promise<string> {
		const { enqueue, extractionJob } = await loadKind();
		const artifactId = fixture.seedArtifact({
			userId: owner,
			name,
			storagePath,
		});
		const { row } = await enqueue(extractionJob, {
			values: {
				userId: owner,
				conversationId: null,
				sourceArtifactId: artifactId,
				origin: "upload",
				intakeRoute: "mineru",
				fileName: name,
				mimeType: "application/pdf",
				sizeBytes: 1,
			},
		});
		return row.id;
	}

	/** A job another process is running: it takes a seat and nothing here will finish it. */
	function takeASeat(jobId: string): void {
		fixture.sqlite
			.prepare(
				"UPDATE document_extraction_jobs SET status = 'running', phase = 'parsing' WHERE id = ?",
			)
			.run(jobId);
	}

	function statusOf(jobId: string): string {
		return (
			fixture.sqlite
				.prepare("SELECT status FROM document_extraction_jobs WHERE id = ?")
				.get(jobId) as { status: string }
		).status;
	}

	it("holds the global cap across rows, whoever owns them", async () => {
		const { drain, extractionJob } = await loadKind();
		const taken = await queueJob(userId, "taken.pdf");
		const waiting = await queueJob("user-2", "waiting.pdf");
		takeASeat(taken);
		seams.config = { maxConcurrency: 1 };

		await drain(extractionJob);

		expect(statusOf(waiting)).toBe("queued");
	});

	it("holds the per-user cap, and lets another user's job through", async () => {
		const { drain, extractionJob, cancel } = await loadKind();
		const taken = await queueJob(userId, "taken.pdf");
		const sameUser = await queueJob(userId, "same-user.pdf");
		const otherUser = await queueJob("user-2", "other-user.pdf");
		takeASeat(taken);
		seams.config = { maxConcurrency: 5, perUserConcurrency: 1 };
		// Nothing is allowed to reach a real backend: the one job that may run hangs
		// until the test cancels it.
		const { createFakeExtractor } = await import("./testing/fake-extractor");
		seams.extractor = createFakeExtractor({ steps: [{ kind: "hang" }] });

		const running = drain(extractionJob);
		await vi.waitFor(() => {
			expect(statusOf(otherUser)).toBe("running");
		});
		// The first user's second job waits for their seat; the other user's ran.
		expect(statusOf(sameUser)).toBe("queued");

		await cancel(extractionJob, otherUser, { userId: "user-2" });
		await running;
		expect(statusOf(otherUser)).toBe("cancelled");
		expect(statusOf(sameUser)).toBe("queued");
	});
});
