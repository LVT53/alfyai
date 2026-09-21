// The worker has to keep itself alive.
//
// What this file is about happened on the dev box: a 250-page PDF was `parsing`
// when the service restarted. Boot recovery reclaimed nothing (the attempt's
// heartbeat was ten seconds old), and then NOTHING else ever looked at the
// table — `drainExtractionWorker` only ran when an upload called
// `wakeExtractionWorker`, and the job sat `parsing` with a frozen heartbeat for
// 23 minutes until an unrelated upload arrived. When the sweep finally did
// requeue it behind a two-second backoff, the drain found nothing claimable and
// returned, and nothing re-armed: the job then sat `queued` for another 212
// seconds past its own gate. On a box nobody uploads to, both waits are
// forever.
//
// Every test here therefore does the same thing: it starts the worker, it never
// calls a wake, and it only moves the clock.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "$lib/server/services/knowledge/types";
import {
	createFakeExtractor,
	type FakeExtractor,
} from "./testing/fake-extractor";
import {
	createLedgerFixture,
	type LedgerFixture,
} from "./testing/ledger-fixtures";

type Worker = typeof import("./worker-runner");
type Ledger = typeof import("./job-ledger");

let fixture: LedgerFixture;
let worker: Worker;
let ledger: Ledger;
let storageDir: string;
const userId = "user-1";

/** The defaults this suite reasons about, after ruling 2. */
const STALE_ATTEMPT_MS = 120_000;
const IDLE_TICK_MS = 30_000;

beforeEach(async () => {
	fixture = createLedgerFixture("worker-scheduler");
	fixture.seedUser(userId);
	storageDir = await mkdtemp(join(tmpdir(), "alfyai-scheduler-"));

	process.env.DATABASE_PATH = fixture.dbPath;
	delete process.env.DOCUMENT_EXTRACTION_WORKER_ENABLED;
	vi.resetModules();
	worker = await import("./worker-runner");
	ledger = await import("./job-ledger");
	worker.resetExtractionWorkerForTests();
});

afterEach(async () => {
	worker.resetExtractionWorkerForTests();
	vi.useRealTimers();
	fixture.cleanup();
	await rm(storageDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

async function seedStoredDocument(name: string): Promise<string> {
	const absolute = join(storageDir, name);
	await writeFile(absolute, "stored bytes", "utf8");
	return fixture.seedArtifact({
		userId,
		name,
		storagePath: relative(process.cwd(), absolute),
	});
}

async function enqueue(name: string): Promise<string> {
	const artifactId = await seedStoredDocument(name);
	const { job } = await ledger.enqueueExtractionJob({
		userId,
		conversationId: null,
		origin: "upload",
		intakeRoute: "mineru",
		fileName: name,
		mimeType: "application/pdf",
		sizeBytes: 12,
		sourceArtifactId: artifactId,
	});
	return job.id;
}

/**
 * A job left `parsing` by a worker that is no longer running — what a restart
 * mid-extraction leaves behind. `heartbeatAgeMs` is how old its last heartbeat
 * is at the moment the new process boots.
 */
async function seedOrphanedParsingJob(
	name: string,
	heartbeatAgeMs: number,
): Promise<string> {
	const jobId = await enqueue(name);
	const claimed = await ledger.claimNextExtractionJob({
		workerId: "worker-that-died",
		globalLimit: 10,
		perUserLimit: 10,
	});
	if (!claimed) throw new Error("expected a claim");
	await ledger.reportExtractionProgress({
		jobId: claimed.job.id,
		attemptId: claimed.attempt.id,
		workerId: "worker-that-died",
		status: "parsing",
	});
	if (heartbeatAgeMs > 0) {
		fixture.sqlite
			.prepare(
				"UPDATE document_extraction_job_attempts SET heartbeat_at = ? WHERE job_id = ?",
			)
			.run(Math.floor((Date.now() - heartbeatAgeMs) / 1000), jobId);
	}
	return jobId;
}

function fakePersist() {
	let n = 0;
	return (async () => {
		n += 1;
		const id = fixture.seedArtifact({
			userId,
			type: "normalized_document",
			name: `normalized-${n}.md`,
		});
		return { id } as Artifact;
	}) as never;
}

async function statusOf(jobId: string): Promise<string | undefined> {
	return (await ledger.getExtractionJobRow(jobId))?.status;
}

/** Boots the scheduler with a scripted extractor and no external wake at all. */
async function bootWorker(extractor: FakeExtractor): Promise<void> {
	await worker.ensureExtractionWorker({
		startInNonServingContextForTests: true,
		workerId: "scheduler-worker",
		resolveExtractor: () => extractor,
		persistResult: fakePersist(),
	});
}

describe("the worker keeps itself alive", () => {
	it("reclaims a restart-orphaned attempt on the boot follow-up sweep", async () => {
		// Ruling 3. The heartbeat was ten seconds old when the process came back,
		// so the sweep AT boot cannot call it dead — and on an idle box there is
		// no later upload to make anyone look again.
		const jobId = await seedOrphanedParsingJob("orphan.pdf", 10_000);
		const sweeps = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.useFakeTimers();

		await bootWorker(createFakeExtractor({ steps: [{ kind: "succeed" }] }));
		expect(await statusOf(jobId)).toBe("parsing");
		expect(worker.inspectExtractionSchedulerForTests().bootSweepArmed).toBe(
			true,
		);

		await vi.advanceTimersByTimeAsync(STALE_ATTEMPT_MS - 1_000);
		expect(await statusOf(jobId)).toBe("parsing");

		await vi.advanceTimersByTimeAsync(2_000);
		expect(sweeps).toHaveBeenCalledWith(
			"[EXTRACTION] Reclaimed stale attempts",
			expect.objectContaining({ reason: "boot-followup", recovered: 1 }),
		);
		expect(await statusOf(jobId)).toBe("queued");
	});

	it("reclaims an attempt that only goes stale later, on the idle tick", async () => {
		// Ruling 1. This attempt's heartbeat is exactly as old as the boot, so the
		// boot follow-up sweep (which runs at boot + staleAttemptMs) still sees it
		// as fresh by a hair. Before this change the next sweep was whenever
		// somebody happened to upload something else.
		const jobId = await seedOrphanedParsingJob("late.pdf", 0);
		const sweeps = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.useFakeTimers();

		await bootWorker(createFakeExtractor({ steps: [{ kind: "succeed" }] }));

		await vi.advanceTimersByTimeAsync(STALE_ATTEMPT_MS + 1_000);
		expect(await statusOf(jobId)).toBe("parsing");

		await vi.advanceTimersByTimeAsync(IDLE_TICK_MS);
		expect(sweeps).toHaveBeenCalledWith(
			"[EXTRACTION] Reclaimed stale attempts",
			expect.objectContaining({ reason: "idle-tick", recovered: 1 }),
		);
		expect(worker.inspectExtractionSchedulerForTests().wakeRequests).toBe(0);
	});

	it("carries a reclaimed job all the way to succeeded on its own timers", async () => {
		// The second half of the live failure: the sweep requeued the job behind a
		// backoff, the drain found nothing claimable, and nothing re-armed.
		const jobId = await seedOrphanedParsingJob("recovered.pdf", 10_000);
		vi.useFakeTimers();

		await bootWorker(createFakeExtractor({ steps: [{ kind: "succeed" }] }));
		await vi.advanceTimersByTimeAsync(STALE_ATTEMPT_MS + 1_000);
		expect(await statusOf(jobId)).toBe("queued");

		// Only the clock moves: no upload, no retry, no wake.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await statusOf(jobId)).toBe("succeeded");
		expect(worker.inspectExtractionSchedulerForTests().wakeRequests).toBe(0);
	});

	it("re-drains at next_attempt_at after an ordinary retryable failure", async () => {
		// Ruling 6. Nothing here involves the stale sweep: the attempt fails with
		// `unavailable`, `failExtractionAttempt` requeues it behind a backoff, and
		// the question is whether anything is scheduled to pick it up.
		const jobId = await enqueue("flaky.pdf");
		const extractor = createFakeExtractor({
			steps: [{ kind: "throw", code: "unavailable" }, { kind: "succeed" }],
		});
		vi.useFakeTimers();

		await bootWorker(extractor);
		// The boot drain is fire-and-forget; one tick of the clock lets the first
		// attempt run and write its verdict.
		await vi.advanceTimersByTimeAsync(1);
		expect(await statusOf(jobId)).toBe("queued");
		expect(extractor.calls).toHaveLength(1);
		expect(worker.inspectExtractionSchedulerForTests().backoffArmed).toBe(true);

		await vi.advanceTimersByTimeAsync(10_000);
		expect(extractor.calls).toHaveLength(2);
		expect(await statusOf(jobId)).toBe("succeeded");
		expect(worker.inspectExtractionSchedulerForTests().wakeRequests).toBe(0);
	});
});

describe("the scheduler's timers", () => {
	it("arms exactly one idle tick and one boot sweep, however often it is started", async () => {
		vi.useFakeTimers();
		await bootWorker(createFakeExtractor({ steps: [{ kind: "succeed" }] }));
		const armed = vi.getTimerCount();
		expect(armed).toBe(2);

		// A second call, and then a whole second module instance: an HMR
		// re-evaluation gets fresh module bindings but the same process.
		await bootWorker(createFakeExtractor({ steps: [{ kind: "succeed" }] }));
		vi.resetModules();
		const reimported = (await import("./worker-runner")) as Worker;
		await reimported.ensureExtractionWorker({
			startInNonServingContextForTests: true,
		});

		expect(vi.getTimerCount()).toBe(armed);
	});

	it("never keeps the process alive, and is disarmed by the test reset", async () => {
		// Real timers on purpose: `hasRef` is the only honest way to ask, and a
		// faked timer cannot answer it.
		await bootWorker(createFakeExtractor({ steps: [{ kind: "succeed" }] }));

		const armed = worker.inspectExtractionSchedulerForTests();
		expect(armed.idleTickArmed).toBe(true);
		expect(armed.idleTickMs).toBe(IDLE_TICK_MS);
		expect(armed.idleTickRefed).toBe(false);
		expect(armed.bootSweepArmed).toBe(true);
		expect(armed.bootSweepRefed).toBe(false);

		worker.resetExtractionWorkerForTests();
		const cleared = worker.inspectExtractionSchedulerForTests();
		expect(cleared.idleTickArmed).toBe(false);
		expect(cleared.bootSweepArmed).toBe(false);
		expect(cleared.backoffArmed).toBe(false);
		expect(cleared.running).toBe(false);
	});

	it("arms nothing in a non-serving context", async () => {
		// The existing guard: under vitest the bootstrap must not start draining a
		// test's temp database. It stays exactly as it was.
		await worker.ensureExtractionWorker();
		const state = worker.inspectExtractionSchedulerForTests();
		expect(state.running).toBe(false);
		expect(state.idleTickArmed).toBe(false);
		expect(state.bootSweepArmed).toBe(false);
	});

	it("arms nothing when the worker is switched off", async () => {
		process.env.DOCUMENT_EXTRACTION_WORKER_ENABLED = "false";
		vi.resetModules();
		const disabled = (await import("./worker-runner")) as Worker;
		disabled.resetExtractionWorkerForTests();
		try {
			await disabled.ensureExtractionWorker({
				startInNonServingContextForTests: true,
			});
			const state = disabled.inspectExtractionSchedulerForTests();
			expect(state.running).toBe(false);
			expect(state.idleTickArmed).toBe(false);
			expect(state.bootSweepArmed).toBe(false);
		} finally {
			disabled.resetExtractionWorkerForTests();
			delete process.env.DOCUMENT_EXTRACTION_WORKER_ENABLED;
		}
	});

	it("announces what it actually started with", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		await bootWorker(createFakeExtractor({ steps: [{ kind: "succeed" }] }));

		expect(info).toHaveBeenCalledWith(
			"[EXTRACTION] Worker started",
			expect.objectContaining({
				idleTickMs: IDLE_TICK_MS,
				staleAttemptMs: STALE_ATTEMPT_MS,
				heartbeatMs: 15_000,
			}),
		);
	});
});
