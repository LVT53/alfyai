// The file-production worker has to keep itself alive.
//
// What this file is about is live in production today. `ensureFileProduction-
// Worker` ran ONE recovery sweep at boot and then nothing ever looked at the
// table again unless a new production or a retry called
// `wakeFileProductionWorker`. A job that a restart orphaned had a heartbeat
// seconds old at boot, so the boot sweep skipped it — and here that is worse
// than a single stuck card, because `claimNextFileProductionJob` refuses to
// claim ANYTHING while one row sits in `running`. One orphan wedges every
// later production in the whole install, for every user, until the next
// restart happens to boot more than a stale window after the heartbeat froze.
//
// Every test here therefore does the same thing: it starts the worker, it never
// calls a wake, and it only moves the clock.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatGeneratedFiles } from "$lib/server/db/schema";
import {
	createFileProductionLedgerFixture,
	type FileProductionLedgerFixture,
} from "./testing/ledger-fixtures";

type Worker = typeof import("./worker-runner");

let fixture: FileProductionLedgerFixture;
let worker: Worker;
const userId = "user-1";
const conversationId = "conv-1";

/** The defaults this suite reasons about, after ruling 2. */
const STALE_ATTEMPT_MS = 120_000;
const IDLE_TICK_MS = 30_000;

beforeEach(async () => {
	fixture = createFileProductionLedgerFixture("fp-scheduler");
	fixture.seedUser(userId);
	fixture.seedConversation(conversationId, userId);

	process.env.DATABASE_PATH = fixture.dbPath;
	delete process.env.FILE_PRODUCTION_STALE_ATTEMPT_MS;
	vi.resetModules();
	worker = await import("./worker-runner");
	worker.resetFileProductionWorkerForTests();
});

afterEach(() => {
	worker.resetFileProductionWorkerForTests();
	vi.useRealTimers();
	fixture.cleanup();
	vi.restoreAllMocks();
});

function textOutput() {
	const content = Buffer.from("produced bytes", "utf8");
	return {
		files: [
			{
				filename: "out.txt",
				mimeType: "text/plain",
				content,
				sizeBytes: content.length,
			},
		],
		stdout: "",
		stderr: "",
		error: null as string | null,
	};
}

let storedFileCounter = 0;

/** Stores a produced file without touching the real chat-files service. */
const storeGeneratedFile = async (
	conversation: string,
	user: string,
	file: { filename: string; mimeType?: string | null; content: Buffer },
) => {
	storedFileCounter += 1;
	const id = `stored-file-${storedFileCounter}`;
	const createdAt = new Date();
	await fixture.db.insert(chatGeneratedFiles).values({
		id,
		conversationId: conversation,
		assistantMessageId: null,
		userId: user,
		filename: file.filename,
		mimeType: file.mimeType ?? "text/plain",
		sizeBytes: file.content.length,
		storagePath: `${conversation}/${id}.txt`,
		createdAt,
	});
	return {
		id,
		conversationId: conversation,
		assistantMessageId: null,
		artifactId: null,
		userId: user,
		filename: file.filename,
		mimeType: file.mimeType ?? "text/plain",
		sizeBytes: file.content.length,
		storagePath: `${conversation}/${id}.txt`,
		createdAt: createdAt.getTime(),
	};
};

/** Boots the scheduler with fake execution and storage, and no external wake. */
async function bootWorker(
	overrides: Parameters<Worker["ensureFileProductionWorker"]>[0] = {},
): Promise<void> {
	await worker.ensureFileProductionWorker({
		startInNonServingContextForTests: true,
		workerId: "scheduler-worker",
		executeCode: async () => textOutput(),
		storeGeneratedFile: storeGeneratedFile as never,
		syncGeneratedFilesToMemory: (async () => undefined) as never,
		...overrides,
	});
}

describe("the worker keeps itself alive", () => {
	it("reclaims a restart-orphaned attempt on the boot follow-up sweep", async () => {
		// Ruling 1. The heartbeat was ten seconds old when the process came back,
		// so the sweep AT boot cannot call it dead — and on an idle box there is
		// no later production to make anyone look again.
		const jobId = fixture.seedJob({ userId, conversationId });
		fixture.seedOrphanedRunningJob({ jobId, heartbeatAgeMs: 10_000 });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.useFakeTimers();

		await bootWorker();
		expect(fixture.jobStatus(jobId)).toBe("running");
		expect(
			worker.inspectFileProductionSchedulerForTests().bootSweepArmed,
		).toBe(true);

		await vi.advanceTimersByTimeAsync(STALE_ATTEMPT_MS - 1_000);
		expect(fixture.jobStatus(jobId)).toBe("running");

		await vi.advanceTimersByTimeAsync(2_000);
		expect(warn).toHaveBeenCalledWith(
			"[FILE_PRODUCTION] Reclaimed stale attempts",
			expect.objectContaining({ reason: "boot-followup", recovered: 1 }),
		);
		expect(fixture.jobStatus(jobId)).toBe("failed");
		expect(fixture.jobErrorCode(jobId)).toBe("worker_heartbeat_timeout");
	});

	it("unwedges every later production the orphan was blocking", async () => {
		// The claim refuses to take anything while ANY row is `running`, so one
		// orphan is not one stuck card: it is the whole install. Nothing in this
		// test wakes the worker — the later job is queued before boot and has to
		// come out the other side on the scheduler's own timers.
		const orphanId = fixture.seedJob({ userId, conversationId });
		fixture.seedOrphanedRunningJob({ jobId: orphanId, heartbeatAgeMs: 10_000 });
		const blockedId = fixture.seedJob({
			userId,
			conversationId,
			createdAt: new Date("2026-09-20T10:00:00.000Z"),
		});
		vi.useFakeTimers();

		await bootWorker();
		await vi.advanceTimersByTimeAsync(1);
		expect(fixture.jobStatus(blockedId)).toBe("queued");

		await vi.advanceTimersByTimeAsync(STALE_ATTEMPT_MS + IDLE_TICK_MS);
		expect(fixture.jobStatus(orphanId)).toBe("failed");
		expect(fixture.jobStatus(blockedId)).toBe("succeeded");
		expect(
			worker.inspectFileProductionSchedulerForTests().wakeRequests,
		).toBe(0);
	});

	it("reclaims an attempt that only goes stale later, on the idle tick", async () => {
		// This attempt's heartbeat is exactly as old as the boot, so the boot
		// follow-up sweep (which runs at boot + staleAttemptMs) still sees it as
		// fresh by a hair. Before this change the next sweep was whenever somebody
		// happened to produce something else.
		const jobId = fixture.seedJob({ userId, conversationId });
		fixture.seedOrphanedRunningJob({ jobId, heartbeatAgeMs: 0 });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.useFakeTimers();

		await bootWorker();

		await vi.advanceTimersByTimeAsync(STALE_ATTEMPT_MS + 1_000);
		expect(fixture.jobStatus(jobId)).toBe("running");

		await vi.advanceTimersByTimeAsync(IDLE_TICK_MS);
		expect(warn).toHaveBeenCalledWith(
			"[FILE_PRODUCTION] Reclaimed stale attempts",
			expect.objectContaining({ reason: "idle-tick", recovered: 1 }),
		);
		expect(fixture.jobStatus(jobId)).toBe("failed");
	});

	it("drains a job queued while the box was down, without any wake", async () => {
		const jobId = fixture.seedJob({ userId, conversationId });
		vi.useFakeTimers();

		await bootWorker();
		await vi.advanceTimersByTimeAsync(1);

		expect(fixture.jobStatus(jobId)).toBe("succeeded");
		expect(
			worker.inspectFileProductionSchedulerForTests().wakeRequests,
		).toBe(0);
	});
});

describe("a job that is genuinely still running", () => {
	it("is not reclaimed, however long the work takes", async () => {
		// Ruling 2, and the reason the window may be two minutes instead of ten:
		// the heartbeat is on its own timer, so an attempt that legitimately runs
		// for five times the stale window is never called dead. Before this, the
		// worker wrote `heartbeat_at` exactly once — at the claim — and the window
		// had to be longer than the sandbox timeout to compensate.
		const jobId = fixture.seedJob({ userId, conversationId });
		let release: (() => void) | null = null;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.useFakeTimers();

		await bootWorker({
			executeCode: async () => {
				await held;
				return textOutput();
			},
		});
		await vi.advanceTimersByTimeAsync(1);
		expect(fixture.jobStatus(jobId)).toBe("running");

		await vi.advanceTimersByTimeAsync(STALE_ATTEMPT_MS * 5);
		expect(fixture.jobStatus(jobId)).toBe("running");
		expect(warn).not.toHaveBeenCalledWith(
			"[FILE_PRODUCTION] Reclaimed stale attempts",
			expect.anything(),
		);
		// The heartbeat has kept the row young the whole time.
		expect(
			fixture.attemptHeartbeatAgeMs(jobId, new Date(Date.now())),
		).toBeLessThan(STALE_ATTEMPT_MS);

		release?.();
		await vi.advanceTimersByTimeAsync(1);
		expect(fixture.jobStatus(jobId)).toBe("succeeded");
	});
});

describe("a wake that arrives during a drain", () => {
	it("is honoured instead of dropped", async () => {
		// The dedupe used to drop a wake that landed while a drain was running,
		// which is wrong whenever the enqueue happened after that drain's last
		// claim: the job was invisible to the drain that swallowed its wake, and
		// waited for the next unrelated production.
		fixture.seedJob({ userId, conversationId });
		let release: (() => void) | null = null;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});

		await bootWorker({
			executeCode: async () => {
				await held;
				return textOutput();
			},
		});
		await vi.waitFor(() => {
			expect(
				worker.inspectFileProductionSchedulerForTests().drainRuns,
			).toBe(1);
		});

		worker.wakeFileProductionWorker();
		release?.();

		await vi.waitFor(() => {
			expect(
				worker.inspectFileProductionSchedulerForTests().drainRuns,
			).toBe(2);
		});
	});
});

describe("the scheduler's timers", () => {
	it("arms exactly one idle tick and one boot sweep, however often it is started", async () => {
		vi.useFakeTimers();
		await bootWorker();
		const armed = vi.getTimerCount();
		expect(armed).toBe(2);

		// A second call, and then a whole second module instance: an HMR
		// re-evaluation gets fresh module bindings but the same process.
		await bootWorker();
		vi.resetModules();
		const reimported = (await import("./worker-runner")) as Worker;
		await reimported.ensureFileProductionWorker({
			startInNonServingContextForTests: true,
		});

		expect(vi.getTimerCount()).toBe(armed);
	});

	it("never keeps the process alive, and is disarmed by the test reset", async () => {
		// Real timers on purpose: `hasRef` is the only honest way to ask, and a
		// faked timer cannot answer it.
		await bootWorker();

		const armed = worker.inspectFileProductionSchedulerForTests();
		expect(armed.idleTickArmed).toBe(true);
		expect(armed.idleTickMs).toBe(IDLE_TICK_MS);
		expect(armed.idleTickRefed).toBe(false);
		expect(armed.bootSweepArmed).toBe(true);
		expect(armed.bootSweepRefed).toBe(false);

		worker.resetFileProductionWorkerForTests();
		const cleared = worker.inspectFileProductionSchedulerForTests();
		expect(cleared.idleTickArmed).toBe(false);
		expect(cleared.bootSweepArmed).toBe(false);
		expect(cleared.running).toBe(false);
	});

	it("arms nothing in a non-serving context", async () => {
		// Under vitest the bootstrap must not start draining a test's temp
		// database, and a wake must not run the REAL sandbox from a unit test.
		await worker.ensureFileProductionWorker();
		worker.wakeFileProductionWorker();

		const state = worker.inspectFileProductionSchedulerForTests();
		expect(state.running).toBe(false);
		expect(state.idleTickArmed).toBe(false);
		expect(state.bootSweepArmed).toBe(false);
		expect(state.drainRuns).toBe(0);
	});
});
