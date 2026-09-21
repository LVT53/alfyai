// The worker: claim a file-production job, run it, write the verdict — and
// keep itself alive between jobs.
//
// It is in-process and single-scheduler by design (ADR-0005): the deploy runs
// one `node build/index.js` and there is no pm2 or cluster config anywhere. The
// ledger's claim is nevertheless a real CAS against `current_attempt_id` and a
// worker id, so a second process would be correct rather than merely unlikely
// to collide. Only the scheduler is per-process.
//
// The claim also takes AT MOST ONE job at a time, install-wide: it refuses
// while any row is `running`. That makes liveness load-bearing here in a way it
// is not in a worker with a concurrency cap — one attempt nobody ever calls
// dead is not one stuck card, it is every later production for every user.

import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import { fileProductionJobs } from "$lib/server/db/schema";
import type { FileProductionJob } from "$lib/server/services/file-production/types";
import {
	type FileProductionWorkerConfig,
	getFileProductionWorkerConfig,
} from "./config";
import {
	executePersistedFileProductionRequest,
	type ProgramExecutionResult,
} from "./execution-adapter";
import {
	claimNextFileProductionJob,
	completeFileProductionJobAttempt,
	failFileProductionJobAttempt,
	getCurrentOwnedRunningJob,
	heartbeatFileProductionJobAttempt,
	recoverStaleFileProductionAttempts,
} from "./job-ledger";
import type { FileProductionLimits } from "./limits";
import {
	type StoreGeneratedFileDependency,
	type SyncGeneratedFilesToMemoryDependency,
	storeFileProductionOutputs,
	syncFileProductionOutputsToMemory,
} from "./storage-adapter";

export interface ExecuteNextFileProductionJobInput {
	workerId: string;
	now?: Date;
	executeCode?: (
		sourceCode: string,
		language: "python" | "javascript",
	) => Promise<ProgramExecutionResult>;
	storeGeneratedFile?: StoreGeneratedFileDependency;
	syncGeneratedFilesToMemory?: SyncGeneratedFilesToMemoryDependency;
	limits?: Partial<FileProductionLimits>;
	/** Overrides the configured heartbeat cadence. Test seam. */
	heartbeatMs?: number;
}

export interface ExecuteNextFileProductionJobResult {
	job: FileProductionJob;
	files: FileProductionJob["files"];
}

export interface DrainFileProductionWorkerInput
	extends Omit<ExecuteNextFileProductionJobInput, "workerId"> {
	workerId?: string;
}

interface ExecuteNextFileProductionJobStepResult {
	processed: boolean;
	result: ExecuteNextFileProductionJobResult | null;
}

const DEFAULT_WORKER_ID = `file-production:${process.pid}:${randomUUID()}`;

/**
 * The bootstrap guard for THIS module instance. The authoritative one lives on
 * the scheduler state below; this is only the cheap early return for a repeated
 * import of the same instance.
 */
let workerInitialized = false;
let drainPromise: Promise<void> | null = null;
/** A wake that arrived while a drain was running, to be honoured after it. */
let drainRequestedAgain = false;

/**
 * The scheduler's state, held on `globalThis` rather than in a module binding.
 *
 * `workerInitialized` above makes a double IMPORT a no-op (the module registry
 * hands back the same instance) but not an HMR re-EVALUATION: vite hands the new
 * instance a fresh set of bindings, and the old instance's timers would keep
 * firing beside the new one's. Two schedulers against one ledger is not a
 * correctness bug — every claim is a CAS — but it is two sweeps and two drains
 * per tick for as long as the dev server lives, and the same shape of mistake
 * in a future `node --watch` deploy would be one per reload forever. A
 * `Symbol.for` key is the one thing every instance shares.
 */
interface FileProductionSchedulerState {
	initialized: boolean;
	/** True only while timers may be armed: the scheduler is serving. */
	running: boolean;
	idleTick: ReturnType<typeof setInterval> | null;
	idleTickMs: number | null;
	bootSweep: ReturnType<typeof setTimeout> | null;
	/** Dependencies every scheduler-driven drain runs with. Test seam. */
	drainInput: DrainFileProductionWorkerInput | null;
	lastRecoveryAt: number;
	/** Every call to `wakeFileProductionWorker`, including the ones it drops. */
	wakeRequests: number;
	/** Drains actually started, so a dropped wake is visible to a test. */
	drainRuns: number;
}

const SCHEDULER_KEY = Symbol.for("alfyai.file-production.worker-scheduler");

function scheduler(): FileProductionSchedulerState {
	const host = globalThis as typeof globalThis & {
		[SCHEDULER_KEY]?: FileProductionSchedulerState;
	};
	host[SCHEDULER_KEY] ??= {
		initialized: false,
		running: false,
		idleTick: null,
		idleTickMs: null,
		bootSweep: null,
		drainInput: null,
		lastRecoveryAt: 0,
		wakeRequests: 0,
		drainRuns: 0,
	};
	return host[SCHEDULER_KEY];
}

/** Idle-tick bounds. Fast enough to bound recovery, slow enough to be free. */
const IDLE_TICK_MIN_MS = 5_000;
const IDLE_TICK_MAX_MS = 60_000;

/** `heartbeatMs × 2`, clamped. 30 s on the default config. */
function idleTickIntervalMs(config: FileProductionWorkerConfig): number {
	return Math.min(
		IDLE_TICK_MAX_MS,
		Math.max(IDLE_TICK_MIN_MS, config.heartbeatMs * 2),
	);
}

const LIVE_JOB_STATUSES: readonly string[] = ["queued", "running"];

async function executeNextFileProductionJobStep(
	input: ExecuteNextFileProductionJobInput,
): Promise<ExecuteNextFileProductionJobStepResult> {
	const now = input.now ?? new Date();
	const claimed = await claimNextFileProductionJob({
		workerId: input.workerId,
		now,
	});
	if (!claimed) {
		return { processed: false, result: null };
	}

	let currentJobRow = await getCurrentOwnedRunningJob({
		jobId: claimed.job.id,
		attemptId: claimed.attempt.id,
		workerId: input.workerId,
	});
	if (!currentJobRow) {
		return { processed: true, result: null };
	}

	const owned = {
		jobId: claimed.job.id,
		attemptId: claimed.attempt.id,
		workerId: input.workerId,
	};
	const attemptStartedAtMs = Date.now();
	const stopHeartbeat = startAttemptHeartbeat(owned, input.heartbeatMs);

	try {
		const execution = await executePersistedFileProductionRequest({
			requestJson: currentJobRow.requestJson,
			userId: currentJobRow.userId,
			conversationId: currentJobRow.conversationId,
			assistantMessageId: currentJobRow.assistantMessageId,
			fileProductionJobId: currentJobRow.id,
			title: currentJobRow.title,
			documentIntent: currentJobRow.documentIntent,
			executeCode: input.executeCode,
		});
		if (!execution.ok) {
			await failAttempt({
				...owned,
				errorCode: execution.errorCode,
				errorMessage: execution.errorMessage,
				retryable: execution.retryable,
				attemptNumber: claimed.attempt.attemptNumber,
				startedAtMs: attemptStartedAtMs,
			});
			return { processed: true, result: null };
		}

		const executionResult = execution.execution;

		const latestJobRow = await getCurrentOwnedRunningJob({
			jobId: claimed.job.id,
			attemptId: claimed.attempt.id,
			workerId: input.workerId,
		});
		if (!latestJobRow) {
			return { processed: true, result: null };
		}
		currentJobRow = latestJobRow;

		const storedOutput = await storeFileProductionOutputs({
			job: currentJobRow,
			attemptId: claimed.attempt.id,
			request: execution.request,
			executionResult,
			sourceArtifact: execution.sourceArtifact,
			now,
			storeGeneratedFile: input.storeGeneratedFile,
			limits: input.limits,
		});
		if (!storedOutput.ok) {
			await failAttempt({
				...owned,
				errorCode: storedOutput.errorCode,
				errorMessage: storedOutput.errorMessage,
				retryable: storedOutput.retryable,
				diagnostics: storedOutput.diagnostics,
				attemptNumber: claimed.attempt.attemptNumber,
				startedAtMs: attemptStartedAtMs,
			});
			return { processed: true, result: null };
		}

		const { producedFiles } = storedOutput;

		const completed = await completeFileProductionJobAttempt({
			...owned,
			files: producedFiles.map((file, index) => ({
				chatGeneratedFileId: file.id,
				sortOrder: index,
			})),
			now: new Date(),
		});

		if (!completed) {
			return { processed: true, result: null };
		}

		await syncFileProductionOutputsToMemory({
			job: currentJobRow,
			producedFiles,
			syncGeneratedFilesToMemory: input.syncGeneratedFilesToMemory,
		});

		return {
			processed: true,
			result: {
				job: {
					...claimed.job,
					assistantMessageId: currentJobRow.assistantMessageId,
					status: "succeeded",
					stage: null,
					updatedAt: Date.now(),
					files: producedFiles,
				},
				files: producedFiles,
			},
		};
	} finally {
		stopHeartbeat();
	}
}

/**
 * Marks the attempt alive on a timer of its own, so `heartbeat_at` tracks
 * whether this PROCESS is alive rather than how long the sandbox or the
 * renderer happens to take.
 *
 * Before this, nothing in the worker ever called
 * `heartbeatFileProductionJobAttempt`: the column was written once, by the
 * claim, and then frozen for the whole attempt. That is why the stale window
 * had to be longer than the sandbox timeout, and why a restart-orphaned attempt
 * looked healthy for ten minutes.
 *
 * A beat that comes back `false` means the claim is gone — a sweep or a cancel
 * took it — so there is nothing left to mark alive and the timer stops. Nothing
 * aborts the work in flight: the renderers take no `AbortSignal` today, and the
 * ledger's CAS already refuses this attempt's late verdict, so the worst case
 * is wasted CPU, never a stale write over newer state.
 */
function startAttemptHeartbeat(
	owned: { jobId: string; attemptId: string; workerId: string },
	overrideMs?: number,
): () => void {
	const heartbeatMs = Math.max(
		250,
		overrideMs ?? getFileProductionWorkerConfig().heartbeatMs,
	);
	const timer = setInterval(() => {
		void heartbeatFileProductionJobAttempt(owned)
			.then((alive) => {
				if (!alive) clearInterval(timer);
			})
			// Nothing awaits this promise, so without a catch one SQLITE_BUSY on a
			// heartbeat write becomes an unhandled rejection — which Node 22 turns
			// into a process exit, taking the server down for a liveness ping.
			.catch((error) => {
				console.warn("[FILE_PRODUCTION] Heartbeat write failed", {
					jobId: owned.jobId,
					attemptId: owned.attemptId,
					error,
				});
			});
	}, heartbeatMs);
	timer.unref?.();
	return () => clearInterval(timer);
}

/**
 * Writes the verdict and says so.
 *
 * There is no automatic requeue and no attempt ceiling in this ledger: ADR-0005
 * decided that a retryable file-production failure surfaces an explicit user
 * Retry rather than retrying itself. So there is no next-attempt time to report
 * and no "max attempts" line to write; `retryable: false` is the equivalent
 * terminal fact, and it gets its own line because it is the moment a job stops
 * being something anyone can rescue.
 */
async function failAttempt(params: {
	jobId: string;
	attemptId: string;
	workerId: string;
	errorCode: string;
	errorMessage: string;
	retryable: boolean;
	diagnostics?: unknown;
	attemptNumber: number;
	startedAtMs: number;
}): Promise<void> {
	const applied = await failFileProductionJobAttempt({
		jobId: params.jobId,
		attemptId: params.attemptId,
		workerId: params.workerId,
		errorCode: params.errorCode,
		errorMessage: params.errorMessage,
		retryable: params.retryable,
		diagnostics: params.diagnostics,
		now: new Date(),
	});

	// `applied: false` means the claim was already gone and nothing was written,
	// so reporting a verdict here would assert a write this worker never made.
	if (!applied) return;

	console.warn("[FILE_PRODUCTION] Attempt failed", {
		jobId: params.jobId,
		attemptId: params.attemptId,
		attemptNumber: params.attemptNumber,
		errorCode: params.errorCode,
		retryable: params.retryable,
		durationMs: Date.now() - params.startedAtMs,
	});

	if (params.retryable) return;

	console.warn("[FILE_PRODUCTION] Job will not be retried", {
		jobId: params.jobId,
		attemptId: params.attemptId,
		attemptNumber: params.attemptNumber,
		errorCode: params.errorCode,
	});
}

export async function executeNextFileProductionJob(
	input: ExecuteNextFileProductionJobInput,
): Promise<ExecuteNextFileProductionJobResult | null> {
	const step = await executeNextFileProductionJobStep(input);
	return step.result;
}

/**
 * Loops until the claim returns nothing, then sweeps once and tries again.
 *
 * The sweep between empty drains is not decoration here. The claim refuses
 * while any row is `running`, so "the claim returned nothing" and "one dead
 * attempt is holding the only slot" are the same observation from the outside —
 * and before this, a drain that met the second case simply returned and left
 * the install wedged. It is rate-limited to one sweep per idle tick so a busy
 * box does not turn every empty claim into a write storm.
 */
export async function drainFileProductionWorker(
	input: DrainFileProductionWorkerInput = {},
): Promise<void> {
	const workerId = input.workerId ?? DEFAULT_WORKER_ID;

	for (;;) {
		const step = await executeNextFileProductionJobStep({ ...input, workerId });
		if (step.processed) continue;

		const config = getFileProductionWorkerConfig();
		if (Date.now() - scheduler().lastRecoveryAt < idleTickIntervalMs(config)) {
			return;
		}

		const { recovered } = await runStaleRecovery(config, "drain");
		if (recovered === 0) {
			return;
		}
	}
}

async function runStaleRecovery(
	config: FileProductionWorkerConfig,
	reason: string,
): Promise<{ recovered: number }> {
	scheduler().lastRecoveryAt = Date.now();
	const outcome = await recoverStaleFileProductionAttempts({
		staleBefore: new Date(Date.now() - config.staleAttemptMs),
	});

	// Silence on a sweep that found nothing is the point: this runs every tick
	// forever. A sweep that DID reclaim something is the one line that explains
	// why a card the user was watching turned into a failure they can retry.
	if (outcome.recovered > 0) {
		console.warn("[FILE_PRODUCTION] Reclaimed stale attempts", {
			reason,
			recovered: outcome.recovered,
			staleAttemptMs: config.staleAttemptMs,
		});
	}
	return outcome;
}

/** Fire-and-forget wake, deduped by an in-module promise. */
export function wakeFileProductionWorker(): void {
	scheduler().wakeRequests += 1;

	if (schedulerIsInert()) {
		// Under vitest this is the one entry point a test reaches by accident: any
		// test that produces a file calls `submitFileProductionIntake`, which wakes
		// the worker, which would drain with the REAL sandbox adapter and try to
		// start a Docker container from a unit test. Tests that mean to run the
		// worker call `executeNextFileProductionJob` or `drainFileProductionWorker`
		// directly, or start the scheduler explicitly; those stay live.
		return;
	}

	startDrain();
}

/**
 * Starts a drain, or records that one is owed.
 *
 * The dedupe used to drop a wake that arrived while a drain was running, which
 * is wrong whenever the enqueue landed after that drain's last claim: the job
 * was then invisible to the drain that swallowed its wake, and waited for the
 * next unrelated production. The flag costs nothing and closes the window.
 */
function startDrain(): void {
	if (drainPromise) {
		drainRequestedAgain = true;
		return;
	}

	const input = scheduler().drainInput ?? {};
	scheduler().drainRuns += 1;
	drainPromise = Promise.resolve()
		.then(() => drainFileProductionWorker(input))
		.catch((error) => {
			console.error("[FILE_PRODUCTION] Worker drain failed", { error });
		})
		.finally(() => {
			drainPromise = null;
			if (drainRequestedAgain) {
				drainRequestedAgain = false;
				startDrain();
			}
		});
}

function isNonServingContext(): boolean {
	// Vitest imports server modules freely; a worker that started draining a
	// test's temp database would race every test that seeds one. The build step
	// imports modules for analysis and must not open a DB connection at all.
	return Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";
}

/**
 * True when nothing should be scheduled. A test that started the scheduler on
 * purpose (`startInNonServingContextForTests`) has flipped `running`, and from
 * then on its wakes are as live as production's — which is the only way to test
 * that a wake during a drain is not lost.
 */
function schedulerIsInert(): boolean {
	return isNonServingContext() && !scheduler().running;
}

interface FileProductionQueueSnapshot {
	/** Rows in `running`, i.e. rows a stale sweep could have work on. */
	runningCount: number;
	/** Rows in `queued`, i.e. work waiting for the single slot. */
	queuedCount: number;
}

/**
 * One aggregate over the jobs table: is there anything to do at all.
 *
 * Deliberately one query and deliberately aggregate-only, because the idle tick
 * runs it forever on boxes where nobody produces anything. `file_production_jobs`
 * has no index on `status` today, so this is a narrow scan rather than an index
 * probe — the same scan `claimNextFileProductionJob` already does on every
 * claim. Adding a partial index on the two live statuses would make it an O(1)
 * probe and is the obvious follow-up; it needs a migration, which is out of
 * scope for this change.
 */
async function readQueueSnapshot(): Promise<FileProductionQueueSnapshot> {
	const status = fileProductionJobs.status;
	const [row] = await db
		.select({
			runningCount: sql<number>`sum(case when ${status} = 'running' then 1 else 0 end)`,
			queuedCount: sql<number>`sum(case when ${status} = 'queued' then 1 else 0 end)`,
		})
		.from(fileProductionJobs)
		.where(inArray(status, LIVE_JOB_STATUSES));

	return {
		runningCount: Number(row?.runningCount ?? 0),
		queuedCount: Number(row?.queuedCount ?? 0),
	};
}

/**
 * The periodic sweep, and the only thing that runs on a box where nobody
 * produces anything. Recovery latency after a crash is therefore bounded by
 * roughly `staleAttemptMs + idleTick`, not by the next unrelated production.
 */
async function runIdleTick(): Promise<void> {
	const state = scheduler();
	if (!state.running) return;

	const snapshot = await readQueueSnapshot();
	if (snapshot.runningCount === 0 && snapshot.queuedCount === 0) {
		return;
	}

	const config = getFileProductionWorkerConfig();
	if (snapshot.runningCount > 0) {
		const { recovered } = await runStaleRecovery(config, "idle-tick");
		// A row still `running` holds the only slot, so there is nothing to claim
		// until the sweep frees it. When it does, whatever was queued behind it can
		// finally move.
		if (recovered > 0) startDrain();
		return;
	}

	if (snapshot.queuedCount > 0) {
		startDrain();
	}
}

function startIdleTick(config: FileProductionWorkerConfig): void {
	const state = scheduler();
	if (state.idleTick) return;

	const intervalMs = idleTickIntervalMs(config);
	state.idleTickMs = intervalMs;
	state.idleTick = setInterval(() => {
		void runIdleTick().catch((error) => {
			console.error("[FILE_PRODUCTION] Idle tick failed", { error });
		});
	}, intervalMs);
	state.idleTick.unref?.();
}

export interface EnsureFileProductionWorkerInput
	extends DrainFileProductionWorkerInput {
	/**
	 * Test seam: start the scheduler even under vitest, and run every drain it
	 * arms with the rest of this input (a fake executor, a fake store). The
	 * production call site in `hooks.server.ts` passes nothing, so the default
	 * stays "do nothing outside a serving process".
	 */
	startInNonServingContextForTests?: boolean;
}

/**
 * Once per process, from `hooks.server.ts` init.
 *
 * Idempotent: the module flag makes a double import a no-op, and the flag on
 * the `Symbol.for` state makes an HMR re-evaluation — which builds a fresh
 * module instance with a fresh `workerInitialized` — a no-op too. It does not
 * block server start (the caller does not await it) and it is safe against an
 * empty table, where the sweep and the drain both return immediately.
 *
 * Boot recovery runs TWICE by design. The sweep at boot reclaims attempts whose
 * worker died long enough ago to look stale; the one scheduled `staleAttemptMs`
 * later reclaims the attempts this very restart orphaned, whose heartbeats were
 * seconds old at boot and so looked perfectly healthy. Without it, a box where
 * nobody produces anything keeps a job `running` — and therefore keeps every
 * other production queued — until some later restart happens to land more than
 * a stale window after the heartbeat froze.
 */
export async function ensureFileProductionWorker(
	input: EnsureFileProductionWorkerInput = {},
): Promise<void> {
	if (workerInitialized) {
		return;
	}
	workerInitialized = true;

	const state = scheduler();
	if (state.initialized) {
		return;
	}

	const { startInNonServingContextForTests, ...drainInput } = input;
	if (isNonServingContext() && startInNonServingContextForTests !== true) {
		return;
	}
	state.initialized = true;
	state.running = true;
	state.drainInput = drainInput;

	const config = getFileProductionWorkerConfig();
	console.info("[FILE_PRODUCTION] Worker started", {
		idleTickMs: idleTickIntervalMs(config),
		staleAttemptMs: config.staleAttemptMs,
		heartbeatMs: config.heartbeatMs,
	});

	await runStaleRecovery(config, "boot");

	state.bootSweep = setTimeout(() => {
		state.bootSweep = null;
		void (async () => {
			if (!state.running) return;
			const current = getFileProductionWorkerConfig();
			const { recovered } = await runStaleRecovery(current, "boot-followup");
			if (recovered > 0) startDrain();
		})().catch((error) => {
			console.error("[FILE_PRODUCTION] Boot follow-up sweep failed", { error });
		});
	}, config.staleAttemptMs);
	state.bootSweep.unref?.();

	startIdleTick(config);
	startDrain();
}

/** Test helper: forget the bootstrap guard and disarm every timer. */
export function resetFileProductionWorkerForTests(): void {
	const state = scheduler();
	if (state.idleTick) clearInterval(state.idleTick);
	if (state.bootSweep) clearTimeout(state.bootSweep);
	state.idleTick = null;
	state.idleTickMs = null;
	state.bootSweep = null;
	state.initialized = false;
	state.running = false;
	state.drainInput = null;
	state.lastRecoveryAt = 0;
	state.wakeRequests = 0;
	state.drainRuns = 0;
	workerInitialized = false;
	drainPromise = null;
	drainRequestedAgain = false;
}

export interface FileProductionSchedulerInspection {
	running: boolean;
	idleTickArmed: boolean;
	idleTickMs: number | null;
	/** `hasRef()` on the armed interval, or null when it cannot be asked. */
	idleTickRefed: boolean | null;
	bootSweepArmed: boolean;
	bootSweepRefed: boolean | null;
	/** Wakes requested, including the ones dropped in a non-serving context. */
	wakeRequests: number;
	/** Drains started. A wake that was swallowed shows up as a missing run. */
	drainRuns: number;
}

/**
 * Test helper: what the scheduler currently has armed.
 *
 * Returning facts rather than the handles themselves keeps a test from clearing
 * a timer the scheduler still believes it owns.
 */
export function inspectFileProductionSchedulerForTests(): FileProductionSchedulerInspection {
	const state = scheduler();
	return {
		running: state.running,
		idleTickArmed: state.idleTick !== null,
		idleTickMs: state.idleTickMs,
		idleTickRefed: state.idleTick?.hasRef?.() ?? null,
		bootSweepArmed: state.bootSweep !== null,
		bootSweepRefed: state.bootSweep?.hasRef?.() ?? null,
		wakeRequests: state.wakeRequests,
		drainRuns: state.drainRuns,
	};
}
