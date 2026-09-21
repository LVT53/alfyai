import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createLedgerFixture,
	type LedgerFixture,
} from "./testing/ledger-fixtures";

type Ledger = typeof import("./job-ledger");

const RETRY = {
	maxAttempts: 3,
	retryBaseMs: 2000,
	retryMaxMs: 60000,
	outageWindowMs: 1_800_000,
	random: () => 0.5,
};

let fixture: LedgerFixture;
let ledger: Ledger;
let userId: string;

beforeEach(async () => {
	fixture = createLedgerFixture("recovery");
	userId = fixture.seedUser("user-1");

	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
	ledger = await import("./job-ledger");
});

afterEach(() => {
	fixture.cleanup();
});

async function enqueueClaimed(workerId: string, name = "report.pdf") {
	const artifactId = fixture.seedArtifact({ userId, name });
	await ledger.enqueueExtractionJob({
		userId,
		conversationId: null,
		origin: "upload",
		intakeRoute: "mineru",
		fileName: name,
		mimeType: "application/pdf",
		sizeBytes: 1024,
		sourceArtifactId: artifactId,
	});
	const claimed = await ledger.claimNextExtractionJob({
		workerId,
		globalLimit: 10,
		perUserLimit: 10,
	});
	if (!claimed) throw new Error("expected a claim");
	return claimed;
}

function staleBefore(): Date {
	return new Date(Date.now() + 60_000);
}

describe("recoverStaleExtractionAttempts", () => {
	it("requeues a parsing job whose worker went silent, with stale_worker", async () => {
		const claimed = await enqueueClaimed("worker-dead");
		await ledger.reportExtractionProgress({
			jobId: claimed.job.id,
			attemptId: claimed.attempt.id,
			workerId: "worker-dead",
			status: "parsing",
			handle: { extractor: "fake", version: 1, remoteJobId: "r1" },
		});

		const result = await ledger.recoverStaleExtractionAttempts({
			staleBefore: staleBefore(),
			...RETRY,
		});
		expect(result).toEqual({ recovered: 1, requeued: 1 });

		const row = await ledger.getExtractionJobRow(claimed.job.id);
		expect(row?.status).toBe("queued");
		expect(row?.errorCode).toBe("stale_worker");
		expect(row?.retryable).toBe(true);
		expect(row?.currentAttemptId).toBeNull();
		expect(row?.nextAttemptAt).not.toBeNull();

		// The remote job is very likely still healthy; the next attempt should
		// resume it rather than pay for the same parse twice.
		expect(row?.remoteHandleJson).toContain("r1");

		const [attempt] = await ledger.listExtractionJobAttempts(claimed.job.id);
		expect(attempt.status).toBe("failed");
		expect(attempt.errorCode).toBe("stale_worker");
	});

	it("hands the resumable handle to the next attempt", async () => {
		const claimed = await enqueueClaimed("worker-dead");
		await ledger.reportExtractionProgress({
			jobId: claimed.job.id,
			attemptId: claimed.attempt.id,
			workerId: "worker-dead",
			status: "parsing",
			handle: { extractor: "fake", version: 1, remoteJobId: "r1" },
		});
		await ledger.recoverStaleExtractionAttempts({
			staleBefore: staleBefore(),
			...RETRY,
		});

		// The backoff gate has to elapse before the next claim can take it.
		const next = await ledger.claimNextExtractionJob({
			workerId: "worker-fresh",
			globalLimit: 10,
			perUserLimit: 10,
			now: new Date(Date.now() + 60_000),
		});
		expect(next?.resumeHandle?.remoteJobId).toBe("r1");
		expect(next?.attempt.resumed).toBe(true);
		expect(next?.attempt.attemptNumber).toBe(2);
	});

	it("fails a job that has already burned its attempts", async () => {
		const claimed = await enqueueClaimed("worker-dead");
		await ledger.recoverStaleExtractionAttempts({
			staleBefore: staleBefore(),
			...RETRY,
			maxAttempts: 1,
		});

		const row = await ledger.getExtractionJobRow(claimed.job.id);
		expect(row?.status).toBe("failed");
		expect(row?.errorCode).toBe("max_attempts");
		// Still offered to the user: the fault was the worker, not the document.
		expect(row?.retryable).toBe(true);
	});

	it("leaves a fresh attempt from another worker alone", async () => {
		const stale = await enqueueClaimed("worker-dead", "stale.pdf");
		const fresh = await enqueueClaimed("worker-alive", "fresh.pdf");

		await ledger.heartbeatExtractionAttempt({
			jobId: fresh.job.id,
			attemptId: fresh.attempt.id,
			workerId: "worker-alive",
			now: new Date(Date.now() + 120_000),
		});

		const result = await ledger.recoverStaleExtractionAttempts({
			staleBefore: new Date(Date.now() + 60_000),
			...RETRY,
		});

		expect(result.recovered).toBe(1);
		expect((await ledger.getExtractionJobRow(stale.job.id))?.status).toBe(
			"queued",
		);
		expect((await ledger.getExtractionJobRow(fresh.job.id))?.status).toBe(
			"uploading",
		);
	});

	it("does nothing on an empty table and on queued-only work", async () => {
		expect(
			await ledger.recoverStaleExtractionAttempts({
				staleBefore: staleBefore(),
				...RETRY,
			}),
		).toEqual({ recovered: 0, requeued: 0 });

		const artifactId = fixture.seedArtifact({ userId, name: "queued.pdf" });
		await ledger.enqueueExtractionJob({
			userId,
			conversationId: null,
			origin: "upload",
			intakeRoute: "mineru",
			fileName: "queued.pdf",
			mimeType: null,
			sizeBytes: 1,
			sourceArtifactId: artifactId,
		});

		expect(
			await ledger.recoverStaleExtractionAttempts({
				staleBefore: staleBefore(),
				...RETRY,
			}),
		).toEqual({ recovered: 0, requeued: 0 });
	});

	it("does not touch a job that was already canceled", async () => {
		const claimed = await enqueueClaimed("worker-dead");
		await ledger.cancelExtractionJob({ userId, jobId: claimed.job.id });

		const result = await ledger.recoverStaleExtractionAttempts({
			staleBefore: staleBefore(),
			...RETRY,
		});
		expect(result.recovered).toBe(0);
		expect((await ledger.getExtractionJobRow(claimed.job.id))?.status).toBe(
			"canceled",
		);
	});
});

// ---------------------------------------------------------------------------
// Ruling 5: the boot sweep that does not wait out the stale window
// ---------------------------------------------------------------------------

/** `<slice>:<hostname>:<pid>:<boot-nonce>`, as `worker-identity.ts` builds it. */
function workerId(host: string, pid: number, nonce = "nonce-a"): string {
	return `extraction:${host}:${pid}:${nonce}`;
}

const HOST = "box-1";
const SELF = workerId(HOST, 4242, "boot-2");

/** Only pid 4242 — this process — is alive on this host. */
const onlySelfAlive = (pid: number) => pid === 4242;

describe("reclaimDeadWorkerExtractionAttempts", () => {
	// Live: the app was healthy 11 s after a deploy, but an attempt orphaned by
	// that very deploy was only reclaimed at `staleAttemptMs` (120 s), because
	// its heartbeat was seconds old at boot and therefore looked perfectly
	// healthy. Nothing about a heartbeat can answer "did that process survive".
	it("reclaims an attempt whose pid is gone on this host, with no stale window at all", async () => {
		const claimed = await enqueueClaimed(workerId(HOST, 9001));
		await ledger.reportExtractionProgress({
			jobId: claimed.job.id,
			attemptId: claimed.attempt.id,
			workerId: workerId(HOST, 9001),
			status: "parsing",
			handle: { extractor: "fake", version: 1, remoteJobId: "r1" },
		});

		// The heartbeat is NOW. A stale sweep would find nothing for two minutes.
		expect(
			await ledger.recoverStaleExtractionAttempts({
				staleBefore: new Date(Date.now() - 120_000),
				...RETRY,
			}),
		).toEqual({ recovered: 0, requeued: 0 });

		expect(
			await ledger.reclaimDeadWorkerExtractionAttempts({
				workerId: SELF,
				isProcessAlive: onlySelfAlive,
				...RETRY,
			}),
		).toEqual({ recovered: 1, requeued: 1 });

		const row = await ledger.getExtractionJobRow(claimed.job.id);
		expect(row?.status).toBe("queued");
		expect(row?.errorCode).toBe("stale_worker");
		// The remote job is still there; the next attempt resumes it.
		expect(row?.remoteHandleJson).toContain("r1");
	});

	it("never touches its own attempts", async () => {
		await enqueueClaimed(SELF);
		expect(
			await ledger.reclaimDeadWorkerExtractionAttempts({
				workerId: SELF,
				isProcessAlive: onlySelfAlive,
				...RETRY,
			}),
		).toEqual({ recovered: 0, requeued: 0 });
	});

	it("never touches the inline runner's attempts, which share our id", async () => {
		await enqueueClaimed(`${SELF}:inline`);
		expect(
			(
				await ledger.reclaimDeadWorkerExtractionAttempts({
					workerId: SELF,
					isProcessAlive: onlySelfAlive,
					...RETRY,
				})
			).recovered,
		).toBe(0);
	});

	it("never touches another host, whose process table we cannot see", async () => {
		await enqueueClaimed(workerId("box-2", 9001));
		expect(
			(
				await ledger.reclaimDeadWorkerExtractionAttempts({
					workerId: SELF,
					isProcessAlive: onlySelfAlive,
					...RETRY,
				})
			).recovered,
		).toBe(0);
	});

	it("leaves a live pid alone, even on this host", async () => {
		await enqueueClaimed(workerId(HOST, 4242, "boot-1"));
		expect(
			(
				await ledger.reclaimDeadWorkerExtractionAttempts({
					workerId: SELF,
					// Same pid, different boot: a pid this process is reusing after a
					// crash-and-restart WOULD be alive, and the liveness probe is the
					// only thing allowed to decide.
					isProcessAlive: onlySelfAlive,
					...RETRY,
				})
			).recovered,
		).toBe(0);
	});

	it("falls back to the stale window for a row in the previous id format", async () => {
		await enqueueClaimed("extraction:9001:1f0c7a3e-0000-4000-8000-000000000000");
		expect(
			(
				await ledger.reclaimDeadWorkerExtractionAttempts({
					workerId: SELF,
					isProcessAlive: onlySelfAlive,
					...RETRY,
				})
			).recovered,
		).toBe(0);
		// …but the old path still works on it.
		expect(
			(
				await ledger.recoverStaleExtractionAttempts({
					staleBefore: staleBefore(),
					...RETRY,
				})
			).recovered,
		).toBe(1);
	});
});
