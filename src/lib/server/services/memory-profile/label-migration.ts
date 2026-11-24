import { createHash } from "node:crypto";
import { and, asc, eq, isNotNull, ne } from "drizzle-orm";
import type { MemoryKind, MemoryScope, MemorySubject } from "$lib/memory-types";
import { type DatabaseInstance, db } from "$lib/server/db";
import {
	memoryAccounts,
	memoryBanks,
	memoryFactLabels,
	memoryPublishedRows,
	memorySourceRevisions,
	users,
} from "$lib/server/db/schema";
import { memoryAdmissionFor } from "./admission";
import { HINDSIGHT_ENGINE_COMMIT, type NativeMemory } from "./contracts";
import { type CurationModel, createCurationModel } from "./curation";
import { classifyMemoryFacts, FACT_LABEL_BATCH_SIZE } from "./fact-classifier";
import { readFactLabels, recordClassifiedFactLabels } from "./fact-labels";
import { nativeMemoryClient } from "./hindsight-client";
import {
	markMemoryLabelsUnverified,
	markMemoryLabelsVerified,
} from "./labels-verified";
import {
	MEMORY_MIGRATION_EXCLUDED,
	memoryMigrationGuard,
} from "./migration-guard";
import { readPublishedMemory } from "./publication";
import { assertMemoryBankFence } from "./revisions";

/**
 * The label migration (Memory redesign, "The label migration for existing
 * entries"): a kind and a subject for every raw fact an account's banks held
 * before bank config 2, so old entries read like new ones, then the account's
 * labels are verified and it gets the new Memory page. One account at a time,
 * resumable, on the local model at background priority behind live turns.
 *
 * It only adds labels where the app reads them (`memory_fact_labels`, through
 * `recordClassifiedFactLabels`) and clears the account's mark
 * (`markMemoryLabelsVerified`). It never changes an entry's text, support,
 * dates or visibility, and never writes to Hindsight: what it is given of
 * Hindsight can only list a bank's facts. The permanent tester rule's guard
 * is asked first; an excluded account is skipped and never read. Reports hold
 * counts, ids and codes only, never memory text.
 */

/** Why an account was left alone. */
export type LabelMigrationSkip =
	| "excluded"
	| "unknown_account"
	| "no_native_memory"
	| "not_active"
	| "memory_off"
	| "already_verified";

/** Why a raw fact is left unlabelled (it reads as lasting). */
export type UnlabelledReason = "no_label" | "model_unavailable";

export interface LabelMigrationAccount {
	userId: string;
	epoch: number | null;
	outcome: "skipped" | "dry_run" | "verified" | "failed";
	skipped?: LabelMigrationSkip;
	/** The code the account failed with (or, in a dry run, will fail with). */
	failure?: string;
	banks: number;
	/** Banks still on config 1: their upgrade marks the epoch unverified again. */
	configOneBanks: number;
	/** Raw facts Hindsight holds in these banks (observations are not facts). */
	facts: number;
	alreadyLabelled: number;
	toLabel: number;
	estimatedCalls: number;
	calls: number;
	labelled: number;
	byKind: Partial<Record<MemoryKind, number>>;
	bySubject: Partial<Record<MemorySubject, number>>;
	unlabelled: Partial<Record<UnlabelledReason, number>>;
	verification?: { factsAccounted: boolean; publishedRowsUnchanged: boolean };
}

export interface LabelMigrationReport {
	execute: boolean;
	/** done: every account it reached was verified or skipped; stopped: one failed. */
	outcome: "dry_run" | "done" | "stopped";
	stoppedAt?: string;
	totals: {
		accounts: number;
		skipped: Partial<Record<LabelMigrationSkip, number>>;
		banks: number;
		facts: number;
		alreadyLabelled: number;
		toLabel: number;
		estimatedCalls: number;
		calls: number;
		labelled: number;
		verified: number;
		failed: number;
	};
	accounts: LabelMigrationAccount[];
}

export interface LabelMigrationDeps {
	database?: DatabaseInstance;
	/** One bank's facts, as Hindsight lists them. The migration only lists. */
	listFacts?: (
		bankId: string,
		tenantId: string,
		signal: AbortSignal,
	) => Promise<NativeMemory[]>;
	/** The model one account's batches go to. */
	model?: (userId: string, signal: AbortSignal) => CurationModel;
	signal?: AbortSignal;
	/** Model calls in flight for an account, 1 to 3 (default 1). */
	concurrency?: number;
	/** Called once an account is done with, for a command's progress line. */
	onAccount?: (account: LabelMigrationAccount) => void;
}

type Bank = typeof memoryBanks.$inferSelect;
type Account = typeof memoryAccounts.$inferSelect;
type Fact = { id: string; text: string };

const MAX_CONCURRENCY = 3;

class AccountFailure extends Error {
	constructor(public code: string) {
		super(code);
	}
}

/** The label migration over every account (or the one named): a dry run unless `execute`. */
export async function runLabelMigration(
	input: { execute: boolean; userId?: string },
	deps: LabelMigrationDeps = {},
): Promise<LabelMigrationReport> {
	const database = deps.database ?? db;
	const report: LabelMigrationReport = {
		execute: input.execute,
		outcome: input.execute ? "done" : "dry_run",
		totals: {
			accounts: 0,
			skipped: {},
			banks: 0,
			facts: 0,
			alreadyLabelled: 0,
			toLabel: 0,
			estimatedCalls: 0,
			calls: 0,
			labelled: 0,
			verified: 0,
			failed: 0,
		},
		accounts: [],
	};
	const userIds =
		input.userId !== undefined
			? [input.userId]
			: database
					.select({ userId: memoryAccounts.userId })
					.from(memoryAccounts)
					.orderBy(asc(memoryAccounts.userId))
					.all()
					.map(({ userId }) => userId);
	for (const userId of userIds) {
		const entry = await migrateAccount(userId, input.execute, database, deps);
		report.accounts.push(entry);
		const { totals } = report;
		totals.accounts++;
		if (entry.skipped)
			totals.skipped[entry.skipped] = (totals.skipped[entry.skipped] ?? 0) + 1;
		totals.banks += entry.banks;
		totals.facts += entry.facts;
		totals.alreadyLabelled += entry.alreadyLabelled;
		totals.toLabel += entry.toLabel;
		totals.estimatedCalls += entry.estimatedCalls;
		totals.calls += entry.calls;
		totals.labelled += entry.labelled;
		if (entry.outcome === "verified") totals.verified++;
		deps.onAccount?.(entry);
		if (entry.outcome === "failed") {
			totals.failed++;
			report.outcome = "stopped";
			report.stoppedAt = userId;
			break;
		}
	}
	return report;
}

function emptyEntry(
	userId: string,
	epoch: number | null,
): LabelMigrationAccount {
	return {
		userId,
		epoch,
		outcome: "skipped",
		banks: 0,
		configOneBanks: 0,
		facts: 0,
		alreadyLabelled: 0,
		toLabel: 0,
		estimatedCalls: 0,
		calls: 0,
		labelled: 0,
		byKind: {},
		bySubject: {},
		unlabelled: {},
	};
}

/** Why this account is not one to label, or null when it is. */
function skipReason(
	userId: string,
	database: DatabaseInstance,
): { skip: LabelMigrationSkip } | { account: Account } {
	// The permanent tester rule first: an excluded account is never read.
	const guard = memoryMigrationGuard(userId, database);
	if (!guard.allowed) return { skip: guard.reason };
	const account = database
		.select()
		.from(memoryAccounts)
		.where(eq(memoryAccounts.userId, userId))
		.get();
	if (account?.authority !== "hindsight") return { skip: "no_native_memory" };
	if (account.lifecycleState !== "active") return { skip: "not_active" };
	const user = database
		.select({ enabled: users.memoryEnabled })
		.from(users)
		.where(eq(users.id, userId))
		.get();
	if (!user?.enabled) return { skip: "memory_off" };
	if (account.labelsUnverifiedEpoch !== account.epoch)
		return { skip: "already_verified" };
	return { account };
}

async function migrateAccount(
	userId: string,
	execute: boolean,
	database: DatabaseInstance,
	deps: LabelMigrationDeps,
): Promise<LabelMigrationAccount> {
	const eligible = skipReason(userId, database);
	if ("skip" in eligible) {
		const entry = emptyEntry(userId, null);
		entry.skipped = eligible.skip;
		return entry;
	}
	const { account } = eligible;
	const entry = emptyEntry(userId, account.epoch);
	const signal = deps.signal ?? new AbortController().signal;
	const listFacts =
		deps.listFacts ??
		((bankId: string, tenantId: string, listSignal: AbortSignal) =>
			nativeMemoryClient(bankId, tenantId, listSignal).list());
	try {
		const banks = database
			.select()
			.from(memoryBanks)
			.where(
				and(
					eq(memoryBanks.userId, userId),
					eq(memoryBanks.epoch, account.epoch),
					ne(memoryBanks.status, "retired"),
				),
			)
			.orderBy(asc(memoryBanks.id))
			.all();
		entry.banks = banks.length;
		entry.configOneBanks = banks.filter(
			(bank) => bank.nativeConfigVersion === HINDSIGHT_ENGINE_COMMIT,
		).length;
		const read = async () => {
			const result: { bank: Bank; facts: Fact[]; todo: Fact[] }[] = [];
			for (const bank of banks) {
				const facts = (await listFacts(bank.id, account.tenantId, signal))
					.filter((fact) => fact.fact_type !== "observation")
					.map(({ id, text }) => ({ id, text }));
				const labels = readFactLabels(database, bank.id);
				const todo = facts.filter((fact) => !labels.get(fact.id)?.kind);
				result.push({ bank, facts, todo });
			}
			return result;
		};
		const banksRead = await read();
		for (const { facts, todo } of banksRead) {
			entry.facts += facts.length;
			entry.alreadyLabelled += facts.length - todo.length;
			entry.toLabel += todo.length;
			entry.estimatedCalls += Math.ceil(todo.length / FACT_LABEL_BATCH_SIZE);
		}
		if (banks.some((bank) => bank.status === "repair_blocked"))
			throw new AccountFailure("bank_repair_blocked");
		if (!execute) {
			entry.outcome = "dry_run";
			return entry;
		}
		const before = publishedFingerprint(database, userId, banks);
		const model = (deps.model ?? defaultModel)(userId, signal);
		const concurrency = Math.min(
			MAX_CONCURRENCY,
			Math.max(1, Math.floor(deps.concurrency ?? 1)),
		);
		const noLabel = new Set<string>();
		let unavailable = 0;
		for (const { bank, todo } of banksRead) {
			const scope: MemoryScope["kind"] =
				bank.scopeKey === "personal" ? "personal" : "project";
			// One pass in batches, then one more for what it left unlabelled.
			let left = todo;
			for (let pass = 0; pass < 2 && left.length; pass++) {
				const missing: Fact[] = [];
				const failed: Fact[] = [];
				await inBatches(left, concurrency, signal, async (batch) => {
					let labels: Map<string, { kind: MemoryKind; subject: MemorySubject }>;
					try {
						entry.calls++;
						labels = await classifyMemoryFacts({ scope, facts: batch }, model);
					} catch {
						failed.push(...batch);
						return;
					}
					// Each answered batch is written at once, fenced like any
					// Memory write: an interrupted run keeps it.
					database.transaction((tx) => {
						assertMemoryBankFence(tx, userId, bank.id, account.epoch);
						recordClassifiedFactLabels(tx, bank.id, labels);
					});
					for (const fact of batch) {
						const label = labels.get(fact.id);
						if (!label) {
							missing.push(fact);
							continue;
						}
						entry.labelled++;
						entry.byKind[label.kind] = (entry.byKind[label.kind] ?? 0) + 1;
						entry.bySubject[label.subject] =
							(entry.bySubject[label.subject] ?? 0) + 1;
					}
				});
				left = [...failed, ...missing];
				if (pass === 1 || !left.length) {
					for (const fact of missing) noLabel.add(fact.id);
					unavailable += failed.length;
				}
			}
		}
		if (noLabel.size) entry.unlabelled.no_label = noLabel.size;
		if (unavailable) {
			entry.unlabelled.model_unavailable = unavailable;
			throw new AccountFailure("model_unavailable");
		}
		// Verify: every raw fact labelled or listed with its reason, and the
		// published rows as they were. Only then the account's mark is cleared.
		const after = await read();
		const factsAccounted = after.every(({ todo }) =>
			todo.every((fact) => noLabel.has(fact.id)),
		);
		const publishedRowsUnchanged =
			publishedFingerprint(database, userId, banks) === before;
		entry.verification = { factsAccounted, publishedRowsUnchanged };
		if (!factsAccounted) throw new AccountFailure("facts_unlabelled");
		if (!publishedRowsUnchanged)
			throw new AccountFailure("published_rows_changed");
		const marked = database.transaction((tx) => {
			for (const bank of banks)
				assertMemoryBankFence(tx, userId, bank.id, account.epoch);
			return markMemoryLabelsVerified(tx, userId, account.epoch);
		});
		if (!marked) throw new AccountFailure("epoch_moved");
		entry.outcome = "verified";
		return entry;
	} catch (error) {
		entry.outcome = "failed";
		entry.failure = failureCode(error);
		if (!execute) entry.outcome = "dry_run";
		return entry;
	}
}

function defaultModel(userId: string, signal: AbortSignal): CurationModel {
	// Background priority: the label migration waits behind live turns.
	return createCurationModel(
		signal,
		undefined,
		memoryAdmissionFor(userId, "background"),
	);
}

function failureCode(error: unknown): string {
	if (error instanceof AccountFailure) return error.code;
	const code =
		error && typeof error === "object" && "code" in error
			? (error as { code: unknown }).code
			: error instanceof Error
				? error.message
				: undefined;
	return typeof code === "string" && /^[a-z][a-z0-9_]*$/.test(code)
		? code
		: "unexpected_error";
}

/**
 * Runs `work` over `facts` in batches of `FACT_LABEL_BATCH_SIZE`, at most
 * `concurrency` at once. An aborted signal stops it before the next batch
 * starts; a batch already answered is still written.
 */
async function inBatches(
	facts: Fact[],
	concurrency: number,
	signal: AbortSignal,
	work: (batch: Fact[]) => Promise<void>,
): Promise<void> {
	const batches: Fact[][] = [];
	for (let start = 0; start < facts.length; start += FACT_LABEL_BATCH_SIZE)
		batches.push(facts.slice(start, start + FACT_LABEL_BATCH_SIZE));
	let next = 0;
	const worker = async () => {
		while (next < batches.length) {
			if (signal.aborted) throw new AccountFailure("label_migration_aborted");
			const batch = batches[next++];
			await work(batch);
		}
	};
	// Every batch in flight settles (and is written) before the account ends.
	const settled = await Promise.allSettled(
		Array.from({ length: Math.min(concurrency, batches.length) }, worker),
	);
	const failed = settled.find((result) => result.status === "rejected");
	if (failed) throw failed.reason;
	if (signal.aborted) throw new AccountFailure("label_migration_aborted");
}

/**
 * What the migration must leave as it was, for these banks: each bank's
 * generation; its published rows' text, support and dates; which rows are
 * visible; its sources' states, dates and support; and every fact's event
 * date. Labels themselves are left out: adding them is the migration's work.
 */
function publishedFingerprint(
	database: DatabaseInstance,
	userId: string,
	banks: Bank[],
): string {
	const hash = createHash("sha256");
	for (const { id } of banks) {
		const bank = database
			.select({
				generation: memoryBanks.generation,
				previousGeneration: memoryBanks.previousGeneration,
				revision: memoryBanks.revision,
				status: memoryBanks.status,
				epoch: memoryBanks.epoch,
			})
			.from(memoryBanks)
			.where(eq(memoryBanks.id, id))
			.get();
		const rows = database
			.select()
			.from(memoryPublishedRows)
			.where(eq(memoryPublishedRows.bankId, id))
			.orderBy(asc(memoryPublishedRows.id))
			.all()
			.map((row) => [
				row.id,
				row.generation,
				row.epoch,
				row.nativeId,
				row.text,
				row.nativeText,
				row.sourceIdsJson,
				row.sourceFingerprintsJson,
				row.updatedAt.getTime(),
			]);
		const visible = readPublishedMemory(userId, id, undefined, database)
			.map((row) => row.id)
			.sort();
		const sources = database
			.select({
				id: memorySourceRevisions.id,
				state: memorySourceRevisions.state,
				assertedAt: memorySourceRevisions.assertedAt,
				explicitEditAt: memorySourceRevisions.explicitEditAt,
				facts: memorySourceRevisions.acknowledgedFactsJson,
			})
			.from(memorySourceRevisions)
			.where(eq(memorySourceRevisions.bankId, id))
			.orderBy(asc(memorySourceRevisions.id))
			.all()
			.map((source) => [
				source.id,
				source.state,
				source.assertedAt?.getTime() ?? null,
				source.explicitEditAt?.getTime() ?? null,
				source.facts,
			]);
		const eventDates = database
			.select({
				id: memoryFactLabels.nativeFactId,
				eventAt: memoryFactLabels.eventAt,
			})
			.from(memoryFactLabels)
			.where(
				and(
					eq(memoryFactLabels.bankId, id),
					isNotNull(memoryFactLabels.eventAt),
				),
			)
			.orderBy(asc(memoryFactLabels.nativeFactId))
			.all()
			.map((label) => [label.id, label.eventAt?.getTime() ?? null]);
		hash.update(
			JSON.stringify({ id, bank, rows, visible, sources, eventDates }),
		);
	}
	return hash.digest("hex");
}

export interface LabelRollbackReport {
	userId: string;
	execute: boolean;
	outcome: "dry_run" | "done" | "refused";
	code?: string;
	banks: number;
	/** The classifier's labels returned (or, in a dry run, to return) to unlabelled. */
	labels: number;
}

/**
 * Undoes the label migration for one account's current epoch: the classifier's
 * labels go back to unlabelled (event dates kept, so the next publication
 * reads them as it read old facts before), and the epoch is marked unverified
 * again, so the account gets today's Memory page. The migration is the only
 * writer of classifier labels today; a fallback classifier for new facts
 * would make this undo its labels too. A dry run unless `execute`; the
 * permanent tester rule's guard first.
 */
export function rollbackLabelMigration(
	input: { userId: string; execute: boolean },
	database: DatabaseInstance = db,
): LabelRollbackReport {
	const report: LabelRollbackReport = {
		userId: input.userId,
		execute: input.execute,
		outcome: "refused",
		banks: 0,
		labels: 0,
	};
	const guard = memoryMigrationGuard(input.userId, database);
	if (!guard.allowed) {
		report.code =
			guard.reason === "excluded"
				? MEMORY_MIGRATION_EXCLUDED
				: "memory_migration_account_unknown";
		return report;
	}
	const account = database
		.select()
		.from(memoryAccounts)
		.where(eq(memoryAccounts.userId, input.userId))
		.get();
	if (account?.authority !== "hindsight") {
		report.code = "no_native_memory";
		return report;
	}
	const banks = database
		.select()
		.from(memoryBanks)
		.where(
			and(
				eq(memoryBanks.userId, input.userId),
				eq(memoryBanks.epoch, account.epoch),
				ne(memoryBanks.status, "retired"),
			),
		)
		.all();
	report.banks = banks.length;
	const classified = (bankId: string) =>
		and(
			eq(memoryFactLabels.bankId, bankId),
			eq(memoryFactLabels.origin, "classifier"),
		);
	for (const bank of banks)
		report.labels += database
			.select({ id: memoryFactLabels.nativeFactId })
			.from(memoryFactLabels)
			.where(classified(bank.id))
			.all().length;
	if (!input.execute) {
		report.outcome = "dry_run";
		return report;
	}
	try {
		database.transaction((tx) => {
			const now = new Date();
			for (const bank of banks) {
				assertMemoryBankFence(tx, input.userId, bank.id, account.epoch);
				tx.update(memoryFactLabels)
					.set({
						kind: null,
						subject: null,
						origin: "extraction",
						updatedAt: now,
					})
					.where(classified(bank.id))
					.run();
			}
			markMemoryLabelsUnverified(tx, input.userId, account.epoch);
		});
	} catch (error) {
		report.code = failureCode(error);
		return report;
	}
	report.outcome = "done";
	return report;
}
