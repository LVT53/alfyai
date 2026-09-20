import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createLedgerFixture,
	type LedgerFixture,
} from "./testing/ledger-fixtures";

type Ledger = typeof import("./job-ledger");

const WORKER = "worker-a";
const RETRY = {
	maxAttempts: 3,
	retryBaseMs: 2000,
	retryMaxMs: 60000,
	random: () => 0.5,
};

let fixture: LedgerFixture;
let ledger: Ledger;
let userId: string;
let artifactId: string;

beforeEach(async () => {
	fixture = createLedgerFixture("job-ledger");
	userId = fixture.seedUser("user-1");
	artifactId = fixture.seedArtifact({ userId, name: "report.pdf" });

	// The fixture connection stays open beside the module's own: a test that
	// seeds more rows mid-way needs it, and two connections to one SQLite file
	// are exactly what the production busy_timeout is there for.
	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
	ledger = await import("./job-ledger");
});

afterEach(() => {
	fixture.cleanup();
});

async function enqueue(overrides: Record<string, unknown> = {}) {
	const { job } = await ledger.enqueueExtractionJob({
		userId,
		conversationId: null,
		origin: "upload",
		intakeRoute: "mineru",
		fileName: "report.pdf",
		mimeType: "application/pdf",
		sizeBytes: 2048,
		sourceArtifactId: artifactId,
		...overrides,
	});
	return job;
}

async function claim(workerId = WORKER) {
	const claimed = await ledger.claimNextExtractionJob({
		workerId,
		globalLimit: 5,
		perUserLimit: 5,
	});
	if (!claimed) throw new Error("expected a claim");
	return claimed;
}

describe("enqueueExtractionJob", () => {
	it("T1: inserts a queued job with no attempt", async () => {
		const job = await enqueue();
		expect(job.status).toBe("queued");
		expect(job.attemptCount).toBe(0);
		expect(job.startedAt).toBeNull();
		expect(await ledger.listExtractionJobAttempts(job.id)).toEqual([]);
	});

	it("is idempotent on the source artifact", async () => {
		const first = await enqueue();
		const second = await ledger.enqueueExtractionJob({
			userId,
			conversationId: null,
			origin: "upload",
			intakeRoute: "mineru",
			fileName: "report.pdf",
			mimeType: "application/pdf",
			sizeBytes: 2048,
			sourceArtifactId: artifactId,
		});

		expect(second.reused).toBe(true);
		expect(second.job.id).toBe(first.id);
	});

	it("recovers from a lost UNIQUE race instead of throwing", async () => {
		// The partial UNIQUE index on source_artifact_id is what makes the race
		// impossible to lose badly: a second enqueue with DIFFERENT inputs still
		// resolves to the winner's row rather than throwing a 500 at the user.
		const winner = await enqueue();

		const second = await ledger.enqueueExtractionJob({
			userId,
			conversationId: null,
			origin: "upload",
			intakeRoute: "mineru",
			fileName: "report.pdf",
			mimeType: null,
			sizeBytes: 1,
			sourceArtifactId: artifactId,
		});
		expect(second.reused).toBe(true);
		expect(second.job.id).toBe(winner.id);
	});

	it("T2: a dedupe hit is born succeeded with no attempt row", async () => {
		const normalizedId = fixture.seedArtifact({
			userId,
			type: "normalized_document",
			name: "report.md",
		});
		const job = await enqueue({ normalizedArtifactId: normalizedId });

		expect(job.status).toBe("succeeded");
		expect(job.normalizedArtifactId).toBe(normalizedId);
		expect(job.attemptCount).toBe(0);
		expect(job.completedAt).not.toBeNull();
		expect(await ledger.listExtractionJobAttempts(job.id)).toEqual([]);
	});

	it("stores hints opaquely and hands them back", async () => {
		const job = await enqueue({ hints: { tier: "standard" } });
		expect(ledger.parseExtractionHints(job.hintsJson)).toEqual({
			tier: "standard",
		});
	});

	it("refuses a job with neither an artifact nor a generated file", async () => {
		await expect(
			ledger.enqueueExtractionJob({
				userId,
				conversationId: null,
				origin: "upload",
				intakeRoute: "mineru",
				fileName: "x",
				mimeType: null,
				sizeBytes: 0,
			}),
		).rejects.toThrow(/sourceArtifactId or a chatGeneratedFileId/);
	});
});

describe("claimNextExtractionJob", () => {
	it("T3: moves queued to uploading and opens attempt 1", async () => {
		await enqueue();
		const claimed = await claim();

		expect(claimed.job.status).toBe("uploading");
		expect(claimed.job.attemptCount).toBe(1);
		expect(claimed.job.currentAttemptId).toBe(claimed.attempt.id);
		expect(claimed.job.startedAt).not.toBeNull();
		expect(claimed.attempt.attemptNumber).toBe(1);
		expect(claimed.attempt.workerId).toBe(WORKER);
		expect(claimed.attempt.resumed).toBe(false);
		expect(claimed.resumeHandle).toBeNull();
	});

	it("returns null when nothing is claimable", async () => {
		expect(
			await ledger.claimNextExtractionJob({
				workerId: WORKER,
				globalLimit: 5,
				perUserLimit: 5,
			}),
		).toBeNull();
	});

	it("never claims a job twice", async () => {
		await enqueue();
		await claim();
		expect(
			await ledger.claimNextExtractionJob({
				workerId: "worker-b",
				globalLimit: 5,
				perUserLimit: 5,
			}),
		).toBeNull();
	});
});

describe("progress and heartbeat", () => {
	it("T4/T5: walks the phase ladder and persists the handle", async () => {
		await enqueue();
		const claimed = await claim();
		const owned = {
			jobId: claimed.job.id,
			attemptId: claimed.attempt.id,
			workerId: WORKER,
		};

		expect(
			await ledger.reportExtractionProgress({
				...owned,
				status: "parsing",
				handle: { extractor: "fake", version: 1, remoteJobId: "r1" },
			}),
		).toBe(true);

		let row = await ledger.getExtractionJobRow(claimed.job.id);
		expect(row?.status).toBe("parsing");
		expect(row?.remoteHandleJson).toContain("r1");

		expect(
			await ledger.reportExtractionProgress({
				...owned,
				status: "downloading",
			}),
		).toBe(true);
		row = await ledger.getExtractionJobRow(claimed.job.id);
		expect(row?.status).toBe("downloading");
	});

	it("T6: repeating a phase is a heartbeat, not a status change", async () => {
		await enqueue();
		const claimed = await claim();
		const owned = {
			jobId: claimed.job.id,
			attemptId: claimed.attempt.id,
			workerId: WORKER,
		};

		await ledger.reportExtractionProgress({ ...owned, status: "parsing" });
		const later = new Date(Date.now() + 5000);
		expect(
			await ledger.reportExtractionProgress({
				...owned,
				status: "parsing",
				now: later,
			}),
		).toBe(true);

		const row = await ledger.getExtractionJobRow(claimed.job.id);
		expect(row?.status).toBe("parsing");
		// Timestamps are stored as unix SECONDS, so compare at that resolution.
		const [attempt] = await ledger.listExtractionJobAttempts(claimed.job.id);
		expect(attempt.heartbeatAt?.getTime()).toBe(
			Math.floor(later.getTime() / 1000) * 1000,
		);
	});

	it("refuses a backwards phase report", async () => {
		await enqueue();
		const claimed = await claim();
		const owned = {
			jobId: claimed.job.id,
			attemptId: claimed.attempt.id,
			workerId: WORKER,
		};
		await ledger.reportExtractionProgress({ ...owned, status: "downloading" });

		expect(
			await ledger.reportExtractionProgress({ ...owned, status: "uploading" }),
		).toBe(false);
		expect((await ledger.getExtractionJobRow(claimed.job.id))?.status).toBe(
			"downloading",
		);
	});

	it("refuses every write from a worker that does not own the attempt", async () => {
		await enqueue();
		const claimed = await claim();
		const stranger = {
			jobId: claimed.job.id,
			attemptId: claimed.attempt.id,
			workerId: "worker-imposter",
		};

		expect(await ledger.heartbeatExtractionAttempt(stranger)).toBe(false);
		expect(
			await ledger.reportExtractionProgress({ ...stranger, status: "parsing" }),
		).toBe(false);
		expect(
			await ledger.completeExtractionAttempt({
				...stranger,
				normalizedArtifactId: artifactId,
				textLength: 1,
				pageCount: null,
			}),
		).toBe(false);
		expect((await ledger.getExtractionJobRow(claimed.job.id))?.status).toBe(
			"uploading",
		);
	});
});

describe("completion", () => {
	it("T7/T8: indexing then succeeded clears the handle and the hints", async () => {
		const normalizedId = fixture.seedArtifact({
			userId,
			type: "normalized_document",
			name: "report.md",
		});
		await enqueue({ hints: { tier: "standard" } });
		const claimed = await claim();
		const owned = {
			jobId: claimed.job.id,
			attemptId: claimed.attempt.id,
			workerId: WORKER,
		};

		await ledger.reportExtractionProgress({
			...owned,
			status: "parsing",
			handle: { extractor: "fake", version: 1, remoteJobId: "r1" },
		});
		expect(
			await ledger.reportExtractionProgress({ ...owned, status: "indexing" }),
		).toBe(true);
		expect(
			await ledger.completeExtractionAttempt({
				...owned,
				normalizedArtifactId: normalizedId,
				textLength: 42,
				pageCount: 7,
			}),
		).toBe(true);

		const row = await ledger.getExtractionJobRow(claimed.job.id);
		expect(row?.status).toBe("succeeded");
		expect(row?.normalizedArtifactId).toBe(normalizedId);
		expect(row?.remoteHandleJson).toBeNull();
		expect(row?.hintsJson).toBeNull();
		expect(row?.completedAt).not.toBeNull();

		const [attempt] = await ledger.listExtractionJobAttempts(claimed.job.id);
		expect(attempt.status).toBe("succeeded");
		expect(attempt.textLength).toBe(42);
		expect(attempt.pageCount).toBe(7);
	});

	it("refuses to complete a job that never reached indexing", async () => {
		await enqueue();
		const claimed = await claim();
		expect(
			await ledger.completeExtractionAttempt({
				jobId: claimed.job.id,
				attemptId: claimed.attempt.id,
				workerId: WORKER,
				normalizedArtifactId: artifactId,
				textLength: 1,
				pageCount: null,
			}),
		).toBe(false);
	});

	it("T16: a succeeded job is immutable", async () => {
		const normalizedId = fixture.seedArtifact({
			userId,
			type: "normalized_document",
			name: "report.md",
		});
		const job = await enqueue({ normalizedArtifactId: normalizedId });

		expect(
			await ledger.retryExtractionJob({ userId, jobId: job.id }),
		).toBeNull();
		expect(
			await ledger.cancelExtractionJob({ userId, jobId: job.id }),
		).toBeNull();
		expect((await ledger.getExtractionJobRow(job.id))?.status).toBe(
			"succeeded",
		);
	});
});

describe("failure", () => {
	it("T9: a retryable failure requeues with a backoff gate and keeps the error", async () => {
		await enqueue();
		const claimed = await claim();
		const now = new Date("2026-09-20T10:00:00.000Z");

		const outcome = await ledger.failExtractionAttempt({
			jobId: claimed.job.id,
			attemptId: claimed.attempt.id,
			workerId: WORKER,
			errorCode: "unavailable",
			errorMessage: "backend down",
			retryable: true,
			clearHandle: false,
			now,
			...RETRY,
		});

		expect(outcome.requeued).toBe(true);
		expect(outcome.nextAttemptAt?.getTime()).toBe(now.getTime() + 2000);

		const row = await ledger.getExtractionJobRow(claimed.job.id);
		expect(row?.status).toBe("queued");
		expect(row?.currentAttemptId).toBeNull();
		// Kept on purpose: the UI has to be able to say "retrying after X".
		expect(row?.errorCode).toBe("unavailable");
		expect(row?.attemptCount).toBe(1);
	});

	it("T10: a non-retryable failure is terminal and not user-retryable", async () => {
		await enqueue();
		const claimed = await claim();

		const outcome = await ledger.failExtractionAttempt({
			jobId: claimed.job.id,
			attemptId: claimed.attempt.id,
			workerId: WORKER,
			errorCode: "too_large",
			errorMessage: "too big",
			retryable: false,
			clearHandle: false,
			...RETRY,
		});

		expect(outcome.requeued).toBe(false);
		const row = await ledger.getExtractionJobRow(claimed.job.id);
		expect(row?.status).toBe("failed");
		expect(row?.errorCode).toBe("too_large");
		expect(row?.retryable).toBe(false);
		expect(row?.remoteHandleJson).toBeNull();
	});

	it("T10: exhausting the attempts reports max_attempts, still user-retryable", async () => {
		await enqueue();
		for (let i = 0; i < 3; i += 1) {
			const claimed = await claim();
			await ledger.failExtractionAttempt({
				jobId: claimed.job.id,
				attemptId: claimed.attempt.id,
				workerId: WORKER,
				errorCode: "unavailable",
				errorMessage: "backend down",
				retryable: true,
				clearHandle: false,
				// Backdated so the computed backoff gate is already in the past and
				// the next claim is not blocked by it.
				now: new Date(Date.now() - 60_000),
				...RETRY,
			});
		}

		const job = await enqueue();
		const row = await ledger.getExtractionJobRow(job.id);
		expect(row?.status).toBe("failed");
		expect(row?.errorCode).toBe("max_attempts");
		expect(row?.retryable).toBe(true);
		expect(row?.attemptCount).toBe(3);
		expect(await ledger.listExtractionJobAttempts(job.id)).toHaveLength(3);
	});

	it("clears the handle only when the remote forgot it", async () => {
		await enqueue();
		const first = await claim();
		await ledger.reportExtractionProgress({
			jobId: first.job.id,
			attemptId: first.attempt.id,
			workerId: WORKER,
			status: "parsing",
			handle: { extractor: "fake", version: 1, remoteJobId: "r1" },
		});
		await ledger.failExtractionAttempt({
			jobId: first.job.id,
			attemptId: first.attempt.id,
			workerId: WORKER,
			errorCode: "unavailable",
			errorMessage: "down",
			retryable: true,
			clearHandle: false,
			now: new Date(Date.now() - 10_000),
			...RETRY,
		});
		expect(
			(await ledger.getExtractionJobRow(first.job.id))?.remoteHandleJson,
		).toContain("r1");

		const second = await claim();
		expect(second.resumeHandle?.remoteJobId).toBe("r1");
		expect(second.attempt.resumed).toBe(true);

		await ledger.failExtractionAttempt({
			jobId: second.job.id,
			attemptId: second.attempt.id,
			workerId: WORKER,
			errorCode: "protocol",
			errorMessage: "unknown job",
			retryable: true,
			clearHandle: true,
			now: new Date(Date.now() - 10_000),
			...RETRY,
		});
		expect(
			(await ledger.getExtractionJobRow(second.job.id))?.remoteHandleJson,
		).toBeNull();
	});
});

describe("user actions", () => {
	it("T12: cancels a queued job without touching an attempt", async () => {
		const job = await enqueue();
		const canceled = await ledger.cancelExtractionJob({
			userId,
			jobId: job.id,
		});

		expect(canceled?.status).toBe("canceled");
		expect(canceled?.cancelRequestedAt).not.toBeNull();
		expect(await ledger.listExtractionJobAttempts(job.id)).toEqual([]);
	});

	it("T13: cancels an active job and closes its attempt", async () => {
		await enqueue();
		const claimed = await claim();
		expect(await ledger.isCancelRequested(claimed.job.id)).toBe(false);

		const canceled = await ledger.cancelExtractionJob({
			userId,
			jobId: claimed.job.id,
		});
		expect(canceled?.status).toBe("canceled");
		expect(await ledger.isCancelRequested(claimed.job.id)).toBe(true);

		const [attempt] = await ledger.listExtractionJobAttempts(claimed.job.id);
		expect(attempt.status).toBe("canceled");

		// The worker that held it can no longer write anything.
		expect(
			await ledger.heartbeatExtractionAttempt({
				jobId: claimed.job.id,
				attemptId: claimed.attempt.id,
				workerId: WORKER,
			}),
		).toBe(false);
	});

	it("refuses to cancel or retry another user's job", async () => {
		const other = fixture.seedUser("user-2");
		const job = await enqueue();

		expect(
			await ledger.cancelExtractionJob({ userId: other, jobId: job.id }),
		).toBeNull();
		expect(
			await ledger.retryExtractionJob({ userId: other, jobId: job.id }),
		).toBeNull();
	});

	it("T14: a user retry keeps attempt_count and clears the gate", async () => {
		await enqueue();
		const claimed = await claim();
		await ledger.failExtractionAttempt({
			jobId: claimed.job.id,
			attemptId: claimed.attempt.id,
			workerId: WORKER,
			errorCode: "empty_result",
			errorMessage: "nothing readable",
			retryable: false,
			clearHandle: false,
			...RETRY,
		});

		const retried = await ledger.retryExtractionJob({
			userId,
			jobId: claimed.job.id,
		});
		expect(retried?.status).toBe("queued");
		expect(retried?.attemptCount).toBe(1);
		expect(retried?.errorCode).toBeNull();
		expect(retried?.nextAttemptAt).toBeNull();

		// Attempt numbers stay unique: the next claim is attempt 2, not attempt 1.
		const next = await claim();
		expect(next.attempt.attemptNumber).toBe(2);
	});

	it("T15: a canceled job can be retried", async () => {
		const job = await enqueue();
		await ledger.cancelExtractionJob({ userId, jobId: job.id });

		const retried = await ledger.retryExtractionJob({ userId, jobId: job.id });
		expect(retried?.status).toBe("queued");
		expect(retried?.cancelRequestedAt).toBeNull();
	});

	it("a user retry grants exactly one more attempt past the cap", async () => {
		await enqueue();
		for (let i = 0; i < 3; i += 1) {
			const claimed = await claim();
			await ledger.failExtractionAttempt({
				jobId: claimed.job.id,
				attemptId: claimed.attempt.id,
				workerId: WORKER,
				errorCode: "unavailable",
				errorMessage: "down",
				retryable: true,
				clearHandle: false,
				now: new Date(Date.now() - 10_000),
				...RETRY,
			});
		}
		const job = await enqueue();
		expect((await ledger.getExtractionJobRow(job.id))?.errorCode).toBe(
			"max_attempts",
		);

		await ledger.retryExtractionJob({ userId, jobId: job.id });
		const fourth = await claim();
		expect(fourth.attempt.attemptNumber).toBe(4);

		await ledger.failExtractionAttempt({
			jobId: fourth.job.id,
			attemptId: fourth.attempt.id,
			workerId: WORKER,
			errorCode: "unavailable",
			errorMessage: "down",
			retryable: true,
			clearHandle: false,
			...RETRY,
		});

		// And only one: it is capped again immediately, rather than getting a
		// fresh budget of three.
		const row = await ledger.getExtractionJobRow(job.id);
		expect(row?.status).toBe("failed");
		expect(row?.errorCode).toBe("max_attempts");
		expect(
			await ledger.claimNextExtractionJob({
				workerId: WORKER,
				globalLimit: 5,
				perUserLimit: 5,
			}),
		).toBeNull();
	});

	it("updates the stored hints when a retry supplies new ones", async () => {
		await enqueue({ hints: { tier: "basic" } });
		const claimed = await claim();
		await ledger.failExtractionAttempt({
			jobId: claimed.job.id,
			attemptId: claimed.attempt.id,
			workerId: WORKER,
			errorCode: "empty_result",
			errorMessage: "nothing",
			retryable: false,
			clearHandle: false,
			...RETRY,
		});

		const retried = await ledger.retryExtractionJob({
			userId,
			jobId: claimed.job.id,
			hints: { tier: "standard" },
		});
		expect(ledger.parseExtractionHints(retried?.hintsJson ?? null)).toEqual({
			tier: "standard",
		});
	});
});

describe("materializeLegacyExtractionJob", () => {
	it("writes a failed, retryable row a user can act on", async () => {
		const job = await ledger.materializeLegacyExtractionJob({
			userId,
			sourceArtifactId: artifactId,
			fileName: "report.pdf",
		});

		expect(job?.status).toBe("failed");
		expect(job?.errorCode).toBe("legacy_unknown");
		expect(job?.retryable).toBe(true);
		expect(job?.attemptCount).toBe(0);

		const retried = await ledger.retryExtractionJob({
			userId,
			jobId: job?.id ?? "",
		});
		expect(retried?.status).toBe("queued");
	});

	it("returns the existing row rather than a second one", async () => {
		const first = await enqueue();
		const second = await ledger.materializeLegacyExtractionJob({
			userId,
			sourceArtifactId: artifactId,
		});
		expect(second?.id).toBe(first.id);
	});

	it("refuses to hand another user's artifact back", async () => {
		const other = fixture.seedUser("user-2");
		await enqueue();
		expect(
			await ledger.materializeLegacyExtractionJob({
				userId: other,
				sourceArtifactId: artifactId,
			}),
		).toBeNull();
	});
});
