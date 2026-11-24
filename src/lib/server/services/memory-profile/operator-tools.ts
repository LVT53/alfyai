import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getMemoryNativeWaits } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import {
	memoryAccounts,
	memoryBanks,
	memoryDeliveryJobs,
	memorySourceRevisions,
} from "$lib/server/db/schema";
import { drainUser, reopen, retry } from "../jobs";
import { memoryDeliveryEnabled, memoryDeliveryJob } from "./delivery-job";
import { freshDeliveryAttempts } from "./delivery-policy";
import {
	configuredNativeBinding,
	type HindsightClient,
	NativeMemoryError,
	nativeMemoryClient,
} from "./hindsight-client";
import { parseJsonRecord } from "./internal-json";
import {
	MEMORY_MIGRATION_EXCLUDED,
	memoryMigrationGuard,
} from "./migration-guard";
import {
	RETAIN_ENDED,
	RETAIN_RESENT_FROM,
	RETAIN_RESUBMITTED_FROM,
} from "./revisions";

/**
 * The canonical operator tools for what the Hindsight rollout ran by hand
 * (`scripts/memory-*.ts` are their command lines). Each is a dry run unless
 * told to execute, asks the permanent tester rule's guard before it acts on an
 * account, and reports every step it took, so a failure names its step.
 * Reports hold counts, ids and status words only, never memory text.
 */
export type OperatorTool =
	| "resend"
	| "reattach"
	| "recover-consolidation"
	| "drain";

/** A job the drain did not finish, and why: its status and its error code. */
export interface SkippedJob {
	id: string;
	kind: string;
	status: string;
	code: string | null;
}

export interface OperatorStep {
	step: string;
	ok: boolean;
	/** Why a step refused or failed. */
	code?: string;
	/** A content-free word the step read (an operation's status). */
	detail?: string;
	counts?: Record<string, number>;
	ids?: string[];
	skipped?: SkippedJob[];
}

export interface OperatorReport {
	tool: OperatorTool;
	userId: string;
	execute: boolean;
	/** done: it acted; dry_run: it only looked; refused: a check said no; failed: a step broke. */
	outcome: "done" | "dry_run" | "refused" | "failed";
	steps: OperatorStep[];
}

/** A check that says no: the tool stops, and the report names the step. */
class Refusal extends Error {
	constructor(
		public code: string,
		public extra: Omit<OperatorStep, "step" | "ok" | "code"> = {},
	) {
		super(code);
	}
}

function codeOf(error: unknown): string {
	if (error instanceof Refusal || error instanceof NativeMemoryError)
		return error.code;
	if (error instanceof Error && /^[a-z][a-z0-9_]*$/.test(error.message))
		return error.message;
	return "unexpected_error";
}

type Step = <T>(
	name: string,
	run: () => Promise<T> | T,
	describe?: (value: T) => Omit<OperatorStep, "step" | "ok">,
) => Promise<T>;

async function runTool(
	tool: OperatorTool,
	userId: string,
	execute: boolean,
	body: (step: Step) => Promise<"done" | "dry_run">,
): Promise<OperatorReport> {
	const report: OperatorReport = {
		tool,
		userId,
		execute,
		outcome: "failed",
		steps: [],
	};
	const step: Step = async (name, run, describe) => {
		try {
			const value = await run();
			report.steps.push({ step: name, ok: true, ...describe?.(value) });
			return value;
		} catch (error) {
			report.steps.push({
				step: name,
				ok: false,
				code: codeOf(error),
				...(error instanceof Refusal ? error.extra : {}),
			});
			throw error;
		}
	};
	try {
		report.outcome = await body(step);
	} catch (error) {
		report.outcome = error instanceof Refusal ? "refused" : "failed";
	}
	return report;
}

/** The permanent tester rule, always every tool's first step. */
function guard(step: Step, userId: string) {
	return step("guard", () => {
		const verdict = memoryMigrationGuard(userId);
		if (!verdict.allowed)
			throw new Refusal(
				verdict.reason === "excluded"
					? MEMORY_MIGRATION_EXCLUDED
					: "unknown_account",
			);
	});
}

type Bank = typeof memoryBanks.$inferSelect;
type Account = typeof memoryAccounts.$inferSelect;
type SourceRevision = typeof memorySourceRevisions.$inferSelect;

function clientFor(bank: Bank, account: Account): HindsightClient {
	return nativeMemoryClient(
		bank.id,
		account.tenantId,
		undefined,
		bank.nativeBaseUrl && bank.nativeCredentialHash
			? {
					baseUrl: bank.nativeBaseUrl,
					credentialHash: bank.nativeCredentialHash,
				}
			: configuredNativeBinding(account.tenantId),
	);
}

/** This user's live bank and Memory account, or a refusal. */
function liveBank(userId: string, bankId: string) {
	const bank = db
		.select()
		.from(memoryBanks)
		.where(eq(memoryBanks.id, bankId))
		.get();
	if (!bank || bank.userId !== userId) throw new Refusal("bank_not_found");
	if (bank.status !== "ready") throw new Refusal(`bank_${bank.status}`);
	const account = db
		.select()
		.from(memoryAccounts)
		.where(eq(memoryAccounts.userId, userId))
		.get();
	if (!account || account.epoch !== bank.epoch)
		throw new Refusal("bank_not_current");
	return { bank, account };
}

/** A failed delivery of one of this user's chats, its source and bank, or a refusal. */
function failedSourceDelivery(userId: string, jobId: string) {
	const job = db
		.select()
		.from(memoryDeliveryJobs)
		.where(eq(memoryDeliveryJobs.id, jobId))
		.get();
	// Another user's job is not this tool's to see.
	if (!job || job.userId !== userId) throw new Refusal("job_not_found");
	if (job.kind !== "source") throw new Refusal("job_not_a_chat_delivery");
	if (job.status !== "failed") throw new Refusal(`job_${job.status}`);
	const source = job.sourceId
		? db
				.select()
				.from(memorySourceRevisions)
				.where(eq(memorySourceRevisions.id, job.sourceId))
				.get()
		: undefined;
	if (!source || source.userId !== userId || source.bankId !== job.bankId)
		throw new Refusal("source_missing");
	if (source.state !== "pending" && source.state !== "staged")
		throw new Refusal(`source_${source.state}`);
	if (!source.nativeOperationId || !source.nativeSubmitted)
		throw new Refusal("source_never_sent");
	return { job, source, ...liveBank(userId, job.bankId) };
}

/** Still the revision the checks read: same operation, still sent, still awaiting its end. */
function unchanged(current: SourceRevision | undefined, seen: SourceRevision) {
	return (
		!!current &&
		current.nativeOperationId === seen.nativeOperationId &&
		current.nativeSubmitted === seen.nativeSubmitted &&
		current.nativeAcknowledged === seen.nativeAcknowledged &&
		(current.state === "pending" || current.state === "staged")
	);
}

async function operationStatus(client: HindsightClient, id: string) {
	try {
		return (await client.operation(id)).status;
	} catch (error) {
		if (error instanceof NativeMemoryError && error.code === "native_not_found")
			return "not_found";
		throw error;
	}
}

function quietBank(step: Step, client: HindsightClient) {
	return step(
		"bank_quiet",
		async () => {
			const pending = (await client.pendingOperations()).length;
			if (pending) throw new Refusal("bank_busy", { counts: { pending } });
			return pending;
		},
		(pending) => ({ counts: { pending } }),
	);
}

/** How many raw facts Hindsight holds under the source's document. */
async function documentFacts(client: HindsightClient, sourceId: string) {
	return (await client.list()).filter(
		(fact) => fact.fact_type !== "observation" && fact.document_id === sourceId,
	).length;
}

/**
 * Resends one chat's delivery under a new operation: for a failed delivery
 * whose retain never landed (Hindsight reports it failed, cancelled or unknown,
 * holds no fact under its document, and the bank is quiet). The revision gets
 * a fresh operation ID, written as not yet sent so nothing polls it before the
 * job sends it, its retain bookkeeping is cleared and the old ID is kept as
 * `nativeRetainResentFrom`; the job is reopened with its whole attempt limit.
 */
export function resendDelivery(input: {
	userId: string;
	jobId: string;
	execute: boolean;
}): Promise<OperatorReport> {
	return runTool("resend", input.userId, input.execute, async (step) => {
		await guard(step, input.userId);
		const found = await step(
			"job",
			() => {
				const delivery = failedSourceDelivery(input.userId, input.jobId);
				if (delivery.source.nativeAcknowledged)
					throw new Refusal("retain_already_acknowledged");
				return delivery;
			},
			({ job, source }) => ({
				ids: [job.id, source.id],
				counts: { attempts: job.attemptCount },
			}),
		);
		const { job, source } = found;
		const client = clientFor(found.bank, found.account);
		await step(
			"operation",
			async () => {
				const status = await operationStatus(
					client,
					source.nativeOperationId as string,
				);
				if (!["failed", "cancelled", "not_found"].includes(status))
					throw new Refusal(`operation_${status}`, { detail: status });
				return status;
			},
			(status) => ({ detail: status }),
		);
		await quietBank(step, client);
		await step(
			"document",
			async () => {
				const facts = await documentFacts(client, source.id);
				if (facts)
					throw new Refusal("facts_under_document", { counts: { facts } });
				return facts;
			},
			(facts) => ({ counts: { facts } }),
		);
		if (!input.execute) return "dry_run";
		const freshId = randomUUID();
		await step(
			"resend",
			async () => {
				const reopened = await reopen(memoryDeliveryJob, job.id, {
					userId: input.userId,
					from: ["failed"],
					allow: (tx) => {
						const current = tx
							.select()
							.from(memorySourceRevisions)
							.where(eq(memorySourceRevisions.id, source.id))
							.get();
						if (!unchanged(current, source) || !current) return false;
						const {
							[RETAIN_RESUBMITTED_FROM]: _resubmitted,
							[RETAIN_ENDED]: _ended,
							...envelope
						} = parseJsonRecord(current.context);
						tx.update(memorySourceRevisions)
							.set({
								nativeOperationId: freshId,
								nativeSubmitted: false,
								context: JSON.stringify({
									...envelope,
									[RETAIN_RESENT_FROM]: source.nativeOperationId,
								}),
							})
							.where(eq(memorySourceRevisions.id, source.id))
							.run();
						return true;
					},
					retryState: (state) => freshDeliveryAttempts(state, job.attemptCount),
				});
				if (!reopened) throw new Refusal("reopen_refused");
			},
			() => ({ ids: [job.id, freshId] }),
		);
		return "done";
	});
}

/**
 * Reattaches a delivered document to its job: for a failed delivery whose
 * retain did land (Hindsight holds facts under its document and the bank is
 * quiet). The revision is marked sent and acknowledged and its recorded end
 * cleared, and the job is reopened with its whole attempt limit, so it goes
 * on to consolidation and publication without sending the retain again.
 */
export function reattachDelivery(input: {
	userId: string;
	jobId: string;
	execute: boolean;
}): Promise<OperatorReport> {
	return runTool("reattach", input.userId, input.execute, async (step) => {
		await guard(step, input.userId);
		const found = await step(
			"job",
			() => failedSourceDelivery(input.userId, input.jobId),
			({ job, source }) => ({
				ids: [job.id, source.id],
				counts: {
					attempts: job.attemptCount,
					acknowledged: source.nativeAcknowledged ? 1 : 0,
				},
			}),
		);
		const { job, source } = found;
		const client = clientFor(found.bank, found.account);
		await quietBank(step, client);
		await step(
			"document",
			async () => {
				const facts = await documentFacts(client, source.id);
				if (!facts)
					throw new Refusal("document_not_delivered", { counts: { facts } });
				return facts;
			},
			(facts) => ({ counts: { facts } }),
		);
		if (!input.execute) return "dry_run";
		await step(
			"reattach",
			async () => {
				const reopened = await reopen(memoryDeliveryJob, job.id, {
					userId: input.userId,
					from: ["failed"],
					allow: (tx) => {
						const current = tx
							.select()
							.from(memorySourceRevisions)
							.where(eq(memorySourceRevisions.id, source.id))
							.get();
						if (!unchanged(current, source) || !current) return false;
						const { [RETAIN_ENDED]: ended, ...envelope } = parseJsonRecord(
							current.context,
						);
						tx.update(memorySourceRevisions)
							.set({
								nativeSubmitted: true,
								nativeAcknowledged: true,
								// The document is delivered: a recorded end no longer applies.
								...(ended === undefined
									? {}
									: { context: JSON.stringify(envelope) }),
							})
							.where(eq(memorySourceRevisions.id, source.id))
							.run();
						return true;
					},
					retryState: (state) => freshDeliveryAttempts(state, job.attemptCount),
				});
				if (!reopened) throw new Refusal("reopen_refused");
			},
			() => ({ ids: [job.id] }),
		);
		return "done";
	});
}

/** Polls a native operation until it ends, for at most `waitMs`. */
async function waitForOperation(
	client: HindsightClient,
	id: string,
	waitMs: number,
	clock: OperatorClock,
): Promise<string> {
	const deadline = clock.now() + waitMs;
	for (;;) {
		const status = await operationStatus(client, id);
		if (["completed", "failed", "cancelled", "not_found"].includes(status))
			return status;
		if (clock.now() >= deadline) return status;
		await clock.sleep(2_000);
	}
}

/** Time for the tools that wait; tests hand in their own. */
export interface OperatorClock {
	now(): number;
	sleep(ms: number): Promise<void>;
}
const realClock: OperatorClock = {
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Resets the facts of one bank that Hindsight marked failed in consolidation
 * (`POST …/consolidation/recover`), runs one consolidation and waits for it,
 * then counts the failed facts again. Only when the bank is quiet.
 */
export function recoverConsolidation(input: {
	userId: string;
	bankId: string;
	execute: boolean;
	clock?: OperatorClock;
}): Promise<OperatorReport> {
	const clock = input.clock ?? realClock;
	return runTool(
		"recover-consolidation",
		input.userId,
		input.execute,
		async (step) => {
			await guard(step, input.userId);
			const { bank, account } = await step(
				"bank",
				() => liveBank(input.userId, input.bankId),
				({ bank }) => ({ ids: [bank.id] }),
			);
			const client = clientFor(bank, account);
			const countFailed = async () => {
				const raw = (await client.list()).filter(
					(fact) => fact.fact_type !== "observation",
				);
				return {
					failed: raw.filter((fact) => fact.consolidation_failed_at).length,
					unconsolidated: raw.filter((fact) => !fact.consolidated_at).length,
				};
			};
			const before = await step("failed_facts", countFailed, (counts) => ({
				counts,
			}));
			if (!before.failed) return input.execute ? "done" : "dry_run";
			await quietBank(step, client);
			if (!input.execute) return "dry_run";
			await step(
				"recover",
				() => client.recoverConsolidation(),
				(answer) => ({
					counts: Object.fromEntries(
						Object.entries(answer).filter(
							(entry): entry is [string, number] =>
								typeof entry[1] === "number",
						),
					),
				}),
			);
			const operation = await step(
				"consolidate",
				() => client.consolidate(),
				(id) => ({ ids: [id] }),
			);
			await step(
				"consolidation_settled",
				async () => {
					const status = await waitForOperation(
						client,
						operation,
						getMemoryNativeWaits().consolidationMs,
						clock,
					);
					if (status !== "completed")
						throw new Refusal(`consolidation_${status}`, { detail: status });
					return status;
				},
				(status) => ({ detail: status }),
			);
			await step(
				"failed_facts_after",
				async () => {
					const after = await countFailed();
					if (after.failed)
						throw new Refusal("facts_still_failed", { counts: after });
					return after;
				},
				(counts) => ({ counts }),
			);
			return "done";
		},
	);
}

function userJobs(userId: string) {
	return db
		.select()
		.from(memoryDeliveryJobs)
		.where(eq(memoryDeliveryJobs.userId, userId))
		.all();
}

function countByStatus(jobs: Array<{ status: string }>) {
	const counts: Record<string, number> = {};
	for (const job of jobs) counts[job.status] = (counts[job.status] ?? 0) + 1;
	return counts;
}

/**
 * Drains one account's Memory jobs to the end, from an operator's process.
 * It retries each failed job whose failure is retryable once (the person's own
 * Retry, under the job's own attempt limit), then runs the account's claimable
 * jobs (`drainUser`), waiting for each job put back behind a delay (a hold, a
 * wait on Hindsight) instead of stopping, for at most `maxMinutes`. It never
 * stops at a failed or held job, and ends with every job it did not finish:
 * its id, kind, status and error code.
 */
export function drainMemory(input: {
	userId: string;
	execute: boolean;
	maxMinutes?: number;
	clock?: OperatorClock;
}): Promise<OperatorReport> {
	const clock = input.clock ?? realClock;
	const maxMs = Math.max(1, input.maxMinutes ?? 60) * 60_000;
	return runTool("drain", input.userId, input.execute, async (step) => {
		await guard(step, input.userId);
		const before = await step(
			"jobs",
			() => userJobs(input.userId),
			(jobs) => ({ counts: countByStatus(jobs) }),
		);
		if (!input.execute) return "dry_run";
		await step("worker_enabled", () => {
			if (!memoryDeliveryEnabled()) throw new Refusal("memory_worker_disabled");
		});
		await step(
			"retry_failed",
			async () => {
				const retried: string[] = [];
				for (const job of before)
					if (
						job.status === "failed" &&
						job.retryable &&
						(await retry(memoryDeliveryJob, job.id, { userId: input.userId }))
					)
						retried.push(job.id);
				return retried;
			},
			(retried) => ({ ids: retried, counts: { retried: retried.length } }),
		);
		const deadline = clock.now() + maxMs;
		const rounds = await step(
			"drain",
			async () => {
				let rounds = 0;
				for (;;) {
					rounds += 1;
					await drainUser(memoryDeliveryJob, input.userId);
					const open = userJobs(input.userId).filter(
						(job) => job.status === "queued" || job.status === "running",
					);
					if (!open.length || clock.now() >= deadline) return rounds;
					// Wait for the first job put back behind a delay, or a moment
					// for one another process is running.
					const next = Math.min(
						...open.map((job) =>
							job.status === "queued" && job.runAfter
								? job.runAfter.getTime()
								: clock.now() + 5_000,
						),
					);
					await clock.sleep(
						Math.max(500, Math.min(next, deadline) - clock.now() + 1_000),
					);
				}
			},
			(rounds) => ({ counts: { rounds } }),
		);
		await step(
			"summary",
			() => {
				const after = userJobs(input.userId);
				return {
					counts: countByStatus(after),
					skipped: after
						.filter((job) => job.status !== "succeeded")
						.map((job) => ({
							id: job.id,
							kind: job.kind,
							status: job.status,
							code: job.errorCode,
						})),
				};
			},
			(summary) => ({ ...summary, counts: { ...summary.counts, rounds } }),
		);
		return "done";
	});
}
