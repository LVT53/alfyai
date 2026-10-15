// File production as a job-engine kind: its definition, its handler and the cutover.
//
// The engine's own tests cover claiming, leases, fencing, take-backs, scheduling
// and waiting over a test kind. What is file production's, and what these tests
// pin, is what the kind SAYS to the engine (one job at a time install-wide, the
// lease from the config, the words an attempt gets when it is taken back, a failure
// never requeues: ADR-0005, Retry only from a retryable failure), what the handler
// does with a claimed job (a cancel reaches the work in flight and nothing is
// stored for a cancelled job, a throw settles the job instead of leaving it
// running), and what happens to a job that was running when the deploy landed.
//
// The wide net of "this request makes that file" cases is `index.test.ts`, which
// runs the same handler through `testing/run-once.ts`.

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import { createWorkerId } from "$lib/server/services/jobs/worker-identity";
import {
	createFileProductionLedgerFixture,
	type FileProductionLedgerFixture,
} from "./testing/ledger-fixtures";
import {
	createPreEngineFileProductionDatabase,
	type PreEngineFileProductionDatabase,
	SEED_WARNING,
} from "./testing/pre-engine-database";
import { drainFileProductionJobs } from "./testing/run-once";
import { installSeams, resetSeams, seams } from "./testing/runner-seams";

/**
 * Lets a test flip `FILE_PRODUCTION_WORKER_ENABLED` mid-run, the way an admin
 * write to `admin_config` does — that is the case worth proving, because an
 * env var read at import can only ever test the boot half of the switch.
 * `null` passes the real resolved config straight through.
 */
const switchOverride = vi.hoisted(() => ({
	workerEnabled: null as boolean | null,
}));

vi.mock("./config", async () => {
	const actual = await vi.importActual<typeof import("./config")>("./config");
	return {
		...actual,
		getFileProductionWorkerConfig: () => ({
			...actual.getFileProductionWorkerConfig(),
			...(switchOverride.workerEnabled === null
				? {}
				: { workerEnabled: switchOverride.workerEnabled }),
		}),
	};
});

let fixture: FileProductionLedgerFixture;
const userId = "user-1";
const conversationId = "conv-1";

beforeEach(() => {
	resetSeams();
	switchOverride.workerEnabled = null;
	fixture = createFileProductionLedgerFixture("fp-runner");
	fixture.seedUser(userId);
	fixture.seedConversation(conversationId, userId);
	process.env.DATABASE_PATH = fixture.dbPath;
	delete process.env.FILE_PRODUCTION_STALE_ATTEMPT_MS;
	delete process.env.FILE_PRODUCTION_WORKER_ENABLED;
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
	vi.useRealTimers();
	fixture.cleanup();
	vi.restoreAllMocks();
});

async function engine() {
	const jobs = await import("$lib/server/services/jobs");
	const { fileProductionJob } = await import("./production-job");
	return { ...jobs, fileProductionJob };
}

async function appDb() {
	const { db } = await import("$lib/server/db");
	return db;
}

async function readJob(jobId: string) {
	const db = await appDb();
	const row = db
		.select()
		.from(schema.fileProductionJobs)
		.where(eq(schema.fileProductionJobs.id, jobId))
		.get();
	if (!row) throw new Error(`No file-production job ${jobId}`);
	return row;
}

async function readAttempts(jobId: string) {
	const db = await appDb();
	return db
		.select()
		.from(schema.fileProductionJobAttempts)
		.where(eq(schema.fileProductionJobAttempts.jobId, jobId))
		.orderBy(schema.fileProductionJobAttempts.attemptNumber)
		.all();
}

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

/** A promise the test releases by hand, to hold a run open. */
function deferred(): { promise: Promise<void>; release: () => void } {
	let release: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

let storedFileCounter = 0;

/** Stores a produced file without touching the real chat-files service. */
function fakeStore(counter: { calls: number } = { calls: 0 }) {
	const store = async (
		conversation: string,
		user: string,
		file: { filename: string; mimeType?: string | null; content: Buffer },
	) => {
		counter.calls += 1;
		storedFileCounter += 1;
		const id = `stored-file-${storedFileCounter}`;
		const createdAt = new Date();
		const db = await appDb();
		db.insert(schema.chatGeneratedFiles)
			.values({
				id,
				conversationId: conversation,
				assistantMessageId: null,
				userId: user,
				filename: file.filename,
				mimeType: file.mimeType ?? "text/plain",
				sizeBytes: file.content.length,
				storagePath: `${conversation}/${id}.txt`,
				createdAt,
			})
			.run();
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
	return store as never;
}

describe("the file-production kind", () => {
	it("settles a retryable failure failed and never puts it back in the queue (ADR-0005)", async () => {
		const jobId = fixture.seedJob({ userId, conversationId });

		await drainFileProductionJobs({
			executeCode: async () => ({
				files: [],
				stdout: "",
				stderr: "",
				error: "the program exited with status 1",
			}),
		});

		expect(await readJob(jobId)).toMatchObject({
			status: "failed",
			retryable: true,
			errorCode: "program_execution_failed",
			attemptCount: 1,
			runAfter: null,
		});
		// A second drain has nothing to do: nothing retries but the person.
		let executed = 0;
		await drainFileProductionJobs({
			executeCode: async () => {
				executed += 1;
				return textOutput();
			},
		});
		expect(executed).toBe(0);
		expect(
			(await readAttempts(jobId)).map((attempt) => attempt.status),
		).toEqual(["failed"]);
	});

	it("lets the person retry only a failure that said it was retryable", async () => {
		const { describeJob, fileProductionJob } = await engine();
		const jobId = fixture.seedJob({ userId, conversationId });
		const retryable = await readJob(jobId);
		const row = (status: string, isRetryable: boolean) =>
			({ ...retryable, status, retryable: isRetryable }) as typeof retryable;

		expect(describeJob(fileProductionJob, row("failed", true))).toEqual({
			terminal: true,
			canCancel: false,
			canRetry: true,
		});
		expect(describeJob(fileProductionJob, row("failed", false)).canRetry).toBe(
			false,
		);
		expect(
			describeJob(fileProductionJob, row("cancelled", true)).canRetry,
		).toBe(false);
		expect(
			describeJob(fileProductionJob, row("succeeded", true)).canRetry,
		).toBe(false);
		expect(describeJob(fileProductionJob, row("queued", false))).toEqual({
			terminal: false,
			canCancel: true,
			canRetry: false,
		});
	});

	it("runs one job at a time, install-wide, whoever holds the slot", async () => {
		const { recover, fileProductionJob } = await engine();
		const orphanId = fixture.seedJob({ userId, conversationId });
		fixture.seedOrphanedRunningJob({ jobId: orphanId, heartbeatAgeMs: 10_000 });
		const waitingId = fixture.seedJob({ userId, conversationId });
		let executed = 0;
		const executeCode = async () => {
			executed += 1;
			return textOutput();
		};

		// The row `running` under another worker holds the only slot.
		await drainFileProductionJobs({
			executeCode,
			storeGeneratedFile: fakeStore(),
		});
		expect(executed).toBe(0);
		expect((await readJob(waitingId)).status).toBe("queued");

		// Its heartbeat goes stale: the engine takes it back, the slot is free, and
		// the job that was waiting runs.
		fixture.sqlite
			.prepare(
				"UPDATE file_production_job_attempts SET heartbeat_at = unixepoch() - 600 WHERE job_id = ?",
			)
			.run(orphanId);
		expect(await recover(fileProductionJob, {})).toEqual({ recovered: 1 });
		await drainFileProductionJobs({
			executeCode,
			storeGeneratedFile: fakeStore(),
			syncGeneratedFilesToMemory: async () => undefined,
		});
		expect(executed).toBe(1);
		expect((await readJob(waitingId)).status).toBe("succeeded");
		expect(await readJob(orphanId)).toMatchObject({
			status: "failed",
			retryable: true,
			errorCode: "worker_heartbeat_timeout",
			errorMessage: "File production worker stopped before finishing.",
		});
	});

	it("tells an attempt the engine takes back what the card has always said", async () => {
		const { recover, fileProductionJob } = await engine();
		const staleId = fixture.seedJob({ userId, conversationId });
		fixture.seedOrphanedRunningJob({ jobId: staleId, heartbeatAgeMs: 600_000 });
		// A running row whose current attempt never existed.
		const lostId = fixture.seedJob({
			userId,
			conversationId,
			createdAt: new Date("2026-09-20T08:00:00.000Z"),
		});
		fixture.sqlite
			.prepare(
				"UPDATE file_production_jobs SET status = 'running', current_attempt_id = 'missing-attempt', updated_at = unixepoch() - 600 WHERE id = ?",
			)
			.run(lostId);

		expect(await recover(fileProductionJob, {})).toEqual({ recovered: 2 });

		expect(await readJob(staleId)).toMatchObject({
			status: "failed",
			retryable: true,
			errorCode: "worker_heartbeat_timeout",
			errorMessage: "File production worker stopped before finishing.",
		});
		expect(await readAttempts(staleId)).toMatchObject([
			{
				status: "failed",
				errorCode: "worker_heartbeat_timeout",
				retryable: true,
			},
		]);
		expect(await readJob(lostId)).toMatchObject({
			status: "failed",
			retryable: true,
			errorCode: "worker_state_lost",
			errorMessage: "File production worker state was lost before finishing.",
		});
	});

	it("takes no new work while the worker is switched off, and runs it again when switched on", async () => {
		const jobId = fixture.seedJob({ userId, conversationId });
		let executed = 0;
		const run = () =>
			drainFileProductionJobs({
				executeCode: async () => {
					executed += 1;
					return textOutput();
				},
				storeGeneratedFile: fakeStore(),
				syncGeneratedFilesToMemory: async () => undefined,
			});

		switchOverride.workerEnabled = false;
		await run();
		expect(executed).toBe(0);
		expect((await readJob(jobId)).status).toBe("queued");

		switchOverride.workerEnabled = true;
		await run();
		expect(executed).toBe(1);
		expect((await readJob(jobId)).status).toBe("succeeded");
	});
});

describe("the file-production handler", () => {
	it("stores the file, links it to the job and settles succeeded in one step", async () => {
		const jobId = fixture.seedJob({ userId, conversationId });
		const stored = { calls: 0 };

		await drainFileProductionJobs({
			executeCode: async () => textOutput(),
			storeGeneratedFile: fakeStore(stored),
			syncGeneratedFilesToMemory: async () => undefined,
		});

		expect(stored.calls).toBe(1);
		const db = await appDb();
		const links = db
			.select()
			.from(schema.fileProductionJobFiles)
			.where(eq(schema.fileProductionJobFiles.jobId, jobId))
			.all();
		expect(links).toHaveLength(1);
		expect(await readJob(jobId)).toMatchObject({
			status: "succeeded",
			attemptCount: 1,
			retryable: false,
			errorCode: null,
		});
		// The job still names the attempt that made it, which the read model reads
		// the warnings of a succeeded job through.
		const [attempt] = await readAttempts(jobId);
		expect((await readJob(jobId)).currentAttemptId).toBe(attempt?.id);
		expect(attempt).toMatchObject({ status: "succeeded" });
	});

	it("stops the sandbox at once when the job is cancelled, and stores nothing", async () => {
		const { cancelFileProductionJob } = await import("./production-job");
		const jobId = fixture.seedJob({ userId, conversationId });
		const started = deferred();
		let signalReason: unknown;
		const stored = { calls: 0 };

		const run = drainFileProductionJobs({
			executeCode: (_code, _language, options) =>
				new Promise((resolve) => {
					started.release();
					options?.signal?.addEventListener("abort", () => {
						signalReason = options.signal?.reason;
						resolve({
							files: [],
							stdout: "",
							stderr: "",
							error: "Execution aborted",
						});
					});
				}),
			storeGeneratedFile: fakeStore(stored),
		});
		await started.promise;

		const cancelled = await cancelFileProductionJob({ userId, jobId });
		expect(cancelled).toMatchObject({ id: jobId, status: "cancelled" });
		await run;

		// The signal said why, in the same instant, with no heartbeat in between.
		expect(signalReason).toBe("cancelled");
		expect(stored.calls).toBe(0);
		expect(await readJob(jobId)).toMatchObject({
			status: "cancelled",
			errorCode: null,
			retryable: false,
		});
		expect(await readAttempts(jobId)).toMatchObject([
			{ status: "cancelled", errorCode: "cancelled" },
		]);
	});

	it("stores nothing for a job another process cancelled while the work ran", async () => {
		// No signal reaches this process: the cancel is a write on another connection.
		// The handler asks the row, with a fenced beat, before it stores anything.
		const jobId = fixture.seedJob({ userId, conversationId });
		const stored = { calls: 0 };

		await drainFileProductionJobs({
			executeCode: async () => {
				fixture.sqlite
					.prepare(
						"UPDATE file_production_job_attempts SET status = 'cancelled' WHERE job_id = ?",
					)
					.run(jobId);
				fixture.sqlite
					.prepare(
						"UPDATE file_production_jobs SET status = 'cancelled', completed_at = unixepoch() WHERE id = ?",
					)
					.run(jobId);
				return textOutput();
			},
			storeGeneratedFile: fakeStore(stored),
		});

		expect(stored.calls).toBe(0);
		expect((await readJob(jobId)).status).toBe("cancelled");
	});

	it("settles a job whose run threw instead of leaving it running, and keeps the error off the card", async () => {
		const jobId = fixture.seedJob({ userId, conversationId });
		await installSeams();
		const execution = await import("./execution-adapter");
		vi.spyOn(
			execution,
			"executePersistedFileProductionRequest",
		).mockRejectedValueOnce(
			new Error("ENOENT: no such file or directory, open '/home/alfy/secret'"),
		);
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});

		await drainFileProductionJobs();

		// A drain used to log "Worker drain failed" and leave the row `running` until
		// the stale window flipped it to the words below; now it settles at once, with
		// the same words (the card shows a code it has no line for as it is, and a
		// message like this one names the host's paths). The real error is in the log.
		expect(await readJob(jobId)).toMatchObject({
			status: "failed",
			retryable: true,
			errorCode: "worker_heartbeat_timeout",
			errorMessage: "File production worker stopped before finishing.",
		});
		expect(await readAttempts(jobId)).toMatchObject([
			{ status: "failed", errorCode: "worker_heartbeat_timeout" },
		]);
		expect(logged).toHaveBeenCalledWith(
			"[FILE_PRODUCTION] Attempt threw",
			expect.objectContaining({
				jobId,
				error: expect.objectContaining({
					message: expect.stringContaining("ENOENT"),
				}),
			}),
		);
	});
});

describe("the kind is woken by what makes work", () => {
	it("runs a job the moment it is made, retried or regenerated, with nothing waking the worker by hand", async () => {
		// The Retry and Regenerate routes and the intake used to wake the worker
		// themselves; now the engine wakes the kind after the commit that leaves work
		// to claim. This is that, end to end, with the engine started.
		const { startJobs, fileProductionJob } = await engine();
		const {
			createOrReuseFileProductionJob,
			regenerateFileProductionJob,
			retryFileProductionJob,
		} = await import("./production-job");
		await installSeams();
		let outcome: "fail" | "succeed" = "fail";
		seams.executeCode = async () =>
			outcome === "fail"
				? { files: [], stdout: "", stderr: "", error: "the program exited" }
				: textOutput();
		seams.storeGeneratedFile = fakeStore();
		seams.syncGeneratedFilesToMemory = async () => undefined;
		await startJobs([fileProductionJob], {
			startInNonServingContextForTests: true,
		});

		const { job } = await createOrReuseFileProductionJob({
			userId,
			conversationId,
			title: "Woken report",
			origin: "unified_produce",
			idempotencyKey: "wake-1",
			sourceMode: "program",
			requestJson: {
				sourceMode: "program",
				program: {
					language: "python",
					sourceCode: "print('hi')",
					filename: "out.txt",
				},
				outputs: [{ type: "txt" }],
			},
		});
		await vi.waitFor(
			async () => expect((await readJob(job.id)).status).toBe("failed"),
			{ timeout: 5_000 },
		);

		// Retry: the same job, a new attempt.
		outcome = "succeed";
		expect(
			await retryFileProductionJob({ userId, jobId: job.id }),
		).toMatchObject({ id: job.id, status: "queued" });
		await vi.waitFor(
			async () => expect((await readJob(job.id)).status).toBe("succeeded"),
			{ timeout: 5_000 },
		);

		// Regenerate: the file was deleted, and the job makes it again.
		fixture.sqlite.prepare("DELETE FROM chat_generated_files").run();
		expect(
			await regenerateFileProductionJob({ userId, jobId: job.id }),
		).toMatchObject({ id: job.id, status: "queued" });
		await vi.waitFor(
			async () => {
				const row = await readJob(job.id);
				expect(row.status).toBe("succeeded");
				expect(row.attemptCount).toBe(3);
			},
			{ timeout: 5_000 },
		);
		expect(
			(await readAttempts(job.id)).map((attempt) => [
				attempt.attemptNumber,
				attempt.status,
			]),
		).toEqual([
			[1, "failed"],
			[2, "succeeded"],
			[3, "succeeded"],
		]);
	});
});

describe("waiting for a verdict", () => {
	const wait = async (
		input: Partial<{
			userId: string;
			timeoutMs: number;
			jobId: string;
		}> & { jobId: string },
	) => {
		const { waitForFileProductionJobVerdict } = await import(
			"./production-job"
		);
		return waitForFileProductionJobVerdict({
			userId,
			conversationId,
			timeoutMs: 60_000,
			...input,
		});
	};

	it("resolves with the card the moment this process settles the job, without a poll", async () => {
		const jobId = fixture.seedJob({ userId, conversationId });
		const waiting = wait({ jobId });

		await drainFileProductionJobs({
			executeCode: async () => textOutput(),
			storeGeneratedFile: fakeStore(),
			syncGeneratedFilesToMemory: async () => undefined,
		});

		expect(await waiting).toMatchObject({
			settled: true,
			job: {
				id: jobId,
				status: "succeeded",
				files: [expect.objectContaining({ filename: "out.txt" })],
			},
		});
	});

	it("resolves with a failure's card, error included", async () => {
		const jobId = fixture.seedJob({ userId, conversationId });
		const waiting = wait({ jobId });

		await drainFileProductionJobs({
			executeCode: async () => ({
				files: [],
				stdout: "",
				stderr: "",
				error: "the program exited",
			}),
		});

		expect(await waiting).toMatchObject({
			settled: true,
			job: {
				id: jobId,
				status: "failed",
				error: { code: "program_execution_failed", retryable: true },
			},
		});
	});

	it("says what it saw when the verdict does not come in time", async () => {
		const jobId = fixture.seedJob({ userId, conversationId });

		expect(await wait({ jobId, timeoutMs: 30 })).toMatchObject({
			settled: false,
			job: { id: jobId, status: "queued" },
		});
	});

	it("never hands a job to someone it is not theirs, and says nothing of one that does not exist", async () => {
		const jobId = fixture.seedJob({ userId, conversationId });
		await drainFileProductionJobs({
			executeCode: async () => textOutput(),
			storeGeneratedFile: fakeStore(),
			syncGeneratedFilesToMemory: async () => undefined,
		});

		// The job has settled, and the engine says so; the card is read for its owner.
		expect(await wait({ jobId, userId: "user-2", timeoutMs: 0 })).toEqual({
			settled: false,
			job: null,
		});
		expect(await wait({ jobId: "no-such-job", timeoutMs: 0 })).toEqual({
			settled: false,
			job: null,
		});
	});
});

describe("a file-production job that was running at the cutover", () => {
	let preEngine: PreEngineFileProductionDatabase | null = null;

	afterEach(() => {
		preEngine?.cleanup();
		preEngine = null;
	});

	/**
	 * The database of the release before the engine, upgraded the way a deploy
	 * upgrades it, then opened by a restarted server. The attempt the old release
	 * was running belongs to a process that is gone from this host.
	 */
	async function startNewReleaseOn(
		old: PreEngineFileProductionDatabase,
		options: { processIsGone: boolean },
	): Promise<void> {
		if (options.processIsGone) {
			const gone = createWorkerId("file-production").replace(
				`:${process.pid}:`,
				":999999:",
			);
			old.sqlite
				.prepare(
					"UPDATE file_production_job_attempts SET worker_id = ? WHERE status = 'running'",
				)
				.run(gone);
		}
		old.close();
		process.env.DATABASE_PATH = old.dbPath;
		vi.resetModules();
		resetSeams();
		await installSeams();
		seams.executeCode = async () => textOutput();
		seams.storeGeneratedFile = fakeStore();
		seams.syncGeneratedFilesToMemory = async () => undefined;
	}

	it("takes the row back once as a retryable failure, runs the queued job, and numbers a retry past the old attempt", async () => {
		const old = createPreEngineFileProductionDatabase();
		preEngine = old;
		old.seedLiveRows();
		old.upgrade();
		await startNewReleaseOn(old, { processIsGone: true });
		const warnings = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		const { startJobs, fileProductionJob } = await engine();

		await startJobs([fileProductionJob], {
			startInNonServingContextForTests: true,
			isProcessAlive: () => false,
		});

		// ADR-0005: not requeued, failed and retryable, with the words the restart has
		// always given; its dead attempt is closed with the same.
		expect(await readJob("job-running")).toMatchObject({
			status: "failed",
			retryable: true,
			errorCode: "worker_heartbeat_timeout",
			errorMessage: "File production stopped when the server restarted.",
			attemptCount: 1,
		});
		expect(await readAttempts("job-running")).toMatchObject([
			{
				status: "failed",
				errorCode: "worker_heartbeat_timeout",
				retryable: true,
			},
		]);
		expect(
			warnings.mock.calls.filter(
				([line]) =>
					line === "[FILE_PRODUCTION] Reclaimed attempts from a dead worker",
			),
		).toEqual([
			[
				"[FILE_PRODUCTION] Reclaimed attempts from a dead worker",
				{ recovered: 1, requeued: 0 },
			],
		]);

		// The slot is free: the job that was waiting runs, as the engine's first
		// attempt at it.
		await vi.waitFor(async () => {
			expect((await readJob("job-queued")).status).toBe("succeeded");
		});
		expect(await readJob("job-queued")).toMatchObject({ attemptCount: 1 });
		// Nothing is left running that nobody is running.
		const db = await appDb();
		expect(
			db
				.select({ status: schema.fileProductionJobs.status })
				.from(schema.fileProductionJobs)
				.all()
				.map((row) => row.status)
				.sort(),
		).toEqual(["cancelled", "failed", "failed", "succeeded", "succeeded"]);

		// The rows that were not live are as the previous release left them, and the
		// succeeded one still reads its warnings through the attempt it names.
		expect(await readJob("job-failed")).toMatchObject({
			status: "failed",
			errorCode: "sandbox_timeout",
			attemptCount: 2,
		});
		expect(await readJob("job-cancelled")).toMatchObject({
			status: "cancelled",
			dismissed: true,
		});
		const { getConversationFileProductionJob } = await import("./read-model");
		expect(
			await getConversationFileProductionJob({
				userId,
				conversationId,
				jobId: "job-succeeded",
			}),
		).toMatchObject({ status: "succeeded", warnings: [SEED_WARNING] });

		// A Retry of the row the engine took back runs as attempt 2: past the one
		// the previous release opened, never a collision with it.
		const { retryFileProductionJob } = await import("./production-job");
		expect(
			await retryFileProductionJob({ userId, jobId: "job-running" }),
		).toMatchObject({ id: "job-running", status: "queued" });
		await vi.waitFor(async () => {
			expect((await readJob("job-running")).status).toBe("succeeded");
		});
		expect(
			(await readAttempts("job-running")).map((attempt) => [
				attempt.attemptNumber,
				attempt.status,
			]),
		).toEqual([
			[1, "failed"],
			[2, "succeeded"],
		]);
	});

	it("leaves an attempt of another host to the stale window, with the stale words", async () => {
		const old = createPreEngineFileProductionDatabase();
		preEngine = old;
		old.seedLiveRows();
		old.upgrade();
		// The previous release's own id names a host that is not this one, and its
		// last beat is months old.
		await startNewReleaseOn(old, { processIsGone: false });
		const { startJobs, fileProductionJob } = await engine();

		await startJobs([fileProductionJob], {
			startInNonServingContextForTests: true,
			isProcessAlive: () => false,
		});

		expect(await readJob("job-running")).toMatchObject({
			status: "failed",
			retryable: true,
			errorCode: "worker_heartbeat_timeout",
			errorMessage: "File production worker stopped before finishing.",
		});
	});
});
