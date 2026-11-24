import { createHash } from "node:crypto";
import { and, asc, eq, isNotNull, ne } from "drizzle-orm";
import type { MemoryKind, MemoryScope, MemorySubject } from "$lib/memory-types";
import { type DatabaseInstance, db } from "$lib/server/db";
import {
	memoryAccounts,
	memoryBanks,
	memoryFactLabels,
	memoryPublishedRows,
	memoryRevocations,
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
	markMemoryLabelsVerified,
	revokeMemoryLabelsVerified,
} from "./labels-verified";
import {
	assertMemoryMigrationAllowed,
	MEMORY_MIGRATION_EXCLUDED,
	memoryMigrationGuard,
} from "./migration-guard";
import { readAcknowledgedFacts, readPublishedMemory } from "./publication";
import {
	assertMemoryBankAccess,
	assertMemoryBankFence,
	memoryTextHash,
} from "./revisions";

/**
 * The label migration (Memory redesign, "The label migration for existing
 * entries"): a kind and a subject for every raw fact an account's banks held
 * before bank config 2, so old entries read like new ones, then the account's
 * labels are verified and it gets the new Memory page. One account at a time,
 * resumable, on the local model at background priority behind live turns.
 *
 * Every raw fact of every bank of the account's current epoch is labelled,
 * config-1 and config-2 banks alike, before the account is verified.
 * It only adds labels where the app reads them (`memory_fact_labels`, through
 * `recordClassifiedFactLabels`; part 3's triggers drop the banks' cached
 * Overviews, as they should) and clears the account's mark
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
	/** Banks still on config 1: labelled like the rest (only a delivery upgrades a bank, never this run). */
	configOneBanks: number;
	/** Raw facts Hindsight holds in these banks (observations are not facts), the removed ones left out. */
	facts: number;
	/** Raw facts the person removed (a revoked source's, or one a revocation names): never sent, never labelled. */
	removed: number;
	alreadyLabelled: number;
	toLabel: number;
	estimatedCalls: number;
	calls: number;
	labelled: number;
	byKind: Partial<Record<MemoryKind, number>>;
	bySubject: Partial<Record<MemorySubject, number>>;
	unlabelled: Partial<Record<UnlabelledReason, number>>;
	verification?: {
		factsAccounted: boolean;
		/** Every fact it labelled reads the same in Hindsight's second listing. */
		factsUnchanged: boolean;
		publishedRowsUnchanged: boolean;
		/** At most one fact in 20 (`MAX_UNLABELLED_SHARE`) left without a usable label. */
		fewUnlabelled: boolean;
		/** The account's labelled facts are not almost all temporary or ongoing (`MIN_LASTING_SHARE`). */
		labelsPlausible: boolean;
	};
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
/**
 * Verification proves the facts were labelled, not only looked at: an account
 * fails (`too_many_unlabelled`) when more than one fact in 20 is left without
 * a usable label (a model whose answers cannot be read labels nothing).
 */
const MAX_UNLABELLED_SHARE = 1 / 20;
/**
 * And it fails (`implausible_labels`) when fewer than this share of its
 * labelled facts are lasting, judged once it has `PLAUSIBILITY_MIN_FACTS`
 * labelled facts (a small account may be all temporary). The acceptance run's
 * two accounts were synthetic and two thirds temporary or ongoing by design,
 * and still 37% and 40% lasting, with no lasting fact mislabelled (0 of 26);
 * a real bank leans further to lasting (bank config 2 and the classifier both
 * lean to it). 15% is under half the most temporary account measured, so an
 * unusual but real account passes, while a model that calls everything
 * temporary or ongoing fails.
 */
const MIN_LASTING_SHARE = 0.15;
const PLAUSIBILITY_MIN_FACTS = 20;
/** Batches failing one after another before the account stops asking (`model_unavailable`). */
const MAX_FAILED_BATCHES_IN_A_ROW = 3;

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
		removed: 0,
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
): { skip: LabelMigrationSkip } | { account: Account; verified: boolean } {
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
	if (account.labelsUnverifiedEpoch === account.epoch)
		return { account, verified: false };
	// Verified. An epoch this migration verified may still hold the few facts
	// it left without a usable label: a later run asks for them again. Any
	// other verified epoch (a new account or epoch) has nothing to label.
	if (account.labelsVerifiedEpoch === account.epoch)
		return { account, verified: true };
	return { skip: "already_verified" };
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
	const { account, verified } = eligible;
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
			const result: {
				bank: Bank;
				facts: Fact[];
				removed: number;
				todo: Fact[];
				kinds: Partial<Record<MemoryKind, number>>;
			}[] = [];
			for (const bank of banks) {
				const listed = (
					await listFacts(bank.id, account.tenantId, signal)
				).filter((fact) => fact.fact_type !== "observation");
				// Text the person removed is never sent: Hindsight may still list it.
				const removed = removedByPerson(database, bank.id);
				const facts = listed
					.filter((fact) => !removed(fact))
					.map(({ id, text }) => ({ id, text }));
				const labels = readFactLabels(database, bank.id);
				const todo = facts.filter((fact) => !labels.get(fact.id)?.kind);
				const kinds: Partial<Record<MemoryKind, number>> = {};
				for (const fact of facts) {
					const kind = labels.get(fact.id)?.kind;
					if (kind) kinds[kind] = (kinds[kind] ?? 0) + 1;
				}
				result.push({
					bank,
					facts,
					removed: listed.length - facts.length,
					todo,
					kinds,
				});
			}
			return result;
		};
		const banksRead = await read();
		for (const { facts, removed, todo } of banksRead) {
			entry.facts += facts.length;
			entry.removed += removed;
			entry.alreadyLabelled += facts.length - todo.length;
			entry.toLabel += todo.length;
			entry.estimatedCalls += Math.ceil(todo.length / FACT_LABEL_BATCH_SIZE);
		}
		if (banks.some((bank) => bank.status === "repair_blocked"))
			throw new AccountFailure("bank_repair_blocked");
		if (verified && !entry.toLabel) {
			entry.outcome = "skipped";
			entry.skipped = "already_verified";
			return entry;
		}
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
		/** Each fact this run labelled, by id: a hash of the text it was labelled from. */
		const labelledText = new Map<string, string>();
		let unavailable = 0;
		let failedInARow = 0;
		for (const { bank, todo } of banksRead) {
			const scope: MemoryScope["kind"] =
				bank.scopeKey === "personal" ? "personal" : "project";
			// As curation does: the tester rule and the bank's fence are asked
			// again before each batch and right before its call is sent (after
			// the admission queue's wait), so no fact goes out once the person
			// turned Memory off, cleared or erased it, or the account was excluded.
			const fence = () =>
				database.transaction((tx) => {
					assertMemoryMigrationAllowed(userId, tx);
					assertMemoryBankFence(tx, userId, bank.id, account.epoch);
				});
			const bankModel: CurationModel = (
				prompt,
				input,
				schema,
				thinkingMode,
				assertCurrent,
				call,
			) => {
				fence();
				return model(
					prompt,
					input,
					schema,
					thinkingMode,
					() => {
						fence();
						assertCurrent?.();
					},
					call,
				);
			};
			// One pass in batches, then one more for what it left unlabelled.
			let left = todo;
			for (let pass = 0; pass < 2 && left.length; pass++) {
				const missing: Fact[] = [];
				const failed: Fact[] = [];
				await inBatches(left, concurrency, signal, async (batch) => {
					fence();
					let labels: Map<string, { kind: MemoryKind; subject: MemorySubject }>;
					try {
						entry.calls++;
						labels = await classifyMemoryFacts(
							{ scope, facts: batch },
							bankModel,
						);
					} catch {
						failed.push(...batch);
						// A model that is down fails every batch: stop asking.
						if (++failedInARow >= MAX_FAILED_BATCHES_IN_A_ROW)
							throw new AccountFailure("model_unavailable");
						return;
					}
					failedInARow = 0;
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
						labelledText.set(fact.id, memoryTextHash(fact.text));
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
		// An epoch already verified keeps its verification: what this run
		// labelled are the facts an earlier run left without a usable label.
		if (verified) {
			entry.outcome = "verified";
			return entry;
		}
		// Verify: every raw fact labelled or listed with its reason, few left
		// without a label, a plausible kind mix, and the published rows as they
		// were. Only then the account's mark is cleared.
		const after = await read();
		const factsAccounted = after.every(({ todo }) =>
			todo.every((fact) => noLabel.has(fact.id)),
		);
		// A fact labelled from one wording must still read so: its label
		// was chosen for that text.
		const listedAfter = new Map(
			after.flatMap(({ facts }) =>
				facts.map((fact) => [fact.id, memoryTextHash(fact.text)] as const),
			),
		);
		const factsUnchanged = [...labelledText].every(
			([id, hash]) => listedAfter.get(id) === hash,
		);
		const publishedRowsUnchanged =
			publishedFingerprint(database, userId, banks) === before;
		const fewUnlabelled = noLabel.size <= entry.facts * MAX_UNLABELLED_SHARE;
		let lasting = 0;
		let labelled = 0;
		for (const bank of after)
			for (const [kind, count = 0] of Object.entries(bank.kinds)) {
				labelled += count;
				if (kind === "lasting") lasting += count;
			}
		const labelsPlausible =
			labelled < PLAUSIBILITY_MIN_FACTS ||
			lasting >= labelled * MIN_LASTING_SHARE;
		entry.verification = {
			factsAccounted,
			factsUnchanged,
			publishedRowsUnchanged,
			fewUnlabelled,
			labelsPlausible,
		};
		if (!factsAccounted) throw new AccountFailure("facts_unlabelled");
		if (!factsUnchanged) throw new AccountFailure("facts_changed");
		if (!publishedRowsUnchanged)
			throw new AccountFailure("published_rows_changed");
		if (!fewUnlabelled) throw new AccountFailure("too_many_unlabelled");
		if (!labelsPlausible) throw new AccountFailure("implausible_labels");
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
		// Stopped early: every fact not labelled yet waits for the model.
		if (entry.failure === "model_unavailable")
			entry.unlabelled.model_unavailable =
				entry.toLabel - entry.labelled - (entry.unlabelled.no_label ?? 0);
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
 * The raw facts the person removed, which the migration never sends or
 * labels, as `admittedNativeFacts` keeps them out of every entry: a fact a
 * revocation names (by id, and by its text when the revocation holds a hash),
 * and a fact of a source that is revoked or that a revocation names, unless a
 * source the person kept still acknowledges it.
 */
function removedByPerson(
	database: DatabaseInstance,
	bankId: string,
): (fact: NativeMemory) => boolean {
	const revocations = database
		.select()
		.from(memoryRevocations)
		.where(eq(memoryRevocations.bankId, bankId))
		.all();
	const sources = database
		.select({
			id: memorySourceRevisions.id,
			state: memorySourceRevisions.state,
			facts: memorySourceRevisions.acknowledgedFactsJson,
		})
		.from(memorySourceRevisions)
		.where(eq(memorySourceRevisions.bankId, bankId))
		.all();
	const revokedSources = new Set<string>();
	for (const { sourceId } of revocations)
		if (sourceId) revokedSources.add(sourceId);
	for (const source of sources)
		if (source.state === "revoked") revokedSources.add(source.id);
	const ofRevoked = new Set<string>();
	const kept = new Set<string>();
	for (const source of sources)
		for (const { id } of readAcknowledgedFacts(source.facts))
			if (revokedSources.has(source.id)) ofRevoked.add(id);
			else if (source.state === "accepted") kept.add(id);
	const named = new Map<string, (string | null)[]>();
	for (const { nativeFactId, nativeTextHash } of revocations)
		if (nativeFactId)
			named.set(nativeFactId, [
				...(named.get(nativeFactId) ?? []),
				nativeTextHash,
			]);
	return (fact) =>
		(named
			.get(fact.id)
			?.some((hash) => hash === null || hash === memoryTextHash(fact.text)) ??
			false) ||
		(!kept.has(fact.id) &&
			(ofRevoked.has(fact.id) ||
				(!!fact.document_id && revokedSources.has(fact.document_id))));
}

/**
 * What the migration must leave as it was, for these banks: each bank's
 * generation; its published rows' text, support and dates; which rows are
 * visible; the states, dates and support of the sources those rows rest on;
 * and every fact's event date. Labels themselves are left out: adding them is
 * the migration's work. Sources no published row rests on are left out too: a
 * turn records a pending source, and a revocation or an import its own, while
 * the run goes on, which changes nothing the person sees until a publication,
 * and a publication changes the bank's generation.
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
		const published = database
			.select()
			.from(memoryPublishedRows)
			.where(eq(memoryPublishedRows.bankId, id))
			.orderBy(asc(memoryPublishedRows.id))
			.all();
		const restsOn = new Set<string>();
		for (const row of published) {
			for (const fact of readAcknowledgedFacts(row.sourceFingerprintsJson))
				restsOn.add(fact.id);
			const ids: unknown = JSON.parse(row.sourceIdsJson);
			if (Array.isArray(ids))
				for (const factId of ids)
					if (typeof factId === "string") restsOn.add(factId);
		}
		const rows = published.map((row) => [
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
			.filter((source) =>
				readAcknowledgedFacts(source.facts).some((fact) =>
					restsOn.has(fact.id),
				),
			)
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
	/** Whether the label migration had verified this epoch (`labels_verified_epoch`). */
	epochVerified: boolean;
}

/**
 * Undoes the label migration for one account's current epoch: the classifier's
 * labels go back to unlabelled (event dates kept, so the next publication
 * reads them as it read old facts before), and the epoch's verification is
 * taken back (`revokeMemoryLabelsVerified`), so the account gets today's
 * Memory page. A dry run unless `execute`; the permanent tester rule's guard
 * first. It works with Memory off (it writes only the app's own label rows
 * and the page mark, which the switch does not govern), and refuses an epoch
 * the migration never ran on (`label_migration_not_run`: no classifier label
 * and not recorded as verified), so a new epoch is never sent to today's page.
 *
 * What it cannot restore, because nothing records it: whether a fact had a
 * label row before (the migration adds one for a fact with none; the undone
 * row has no kind or subject, which reads as no row does, and the next
 * publication refreshes it from Hindsight); a subject Hindsight's extraction
 * gave a fact without a kind (the classifier wrote over it; the next
 * publication copies it back from the fact's tags, and today's page, where the
 * account is sent, shows no subjects); and the rows' `updated_at`. It undoes
 * every classifier label of the epoch: the migration is their only writer
 * today, so a fallback classifier for new facts would need its own record.
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
		epochVerified: false,
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
	report.epochVerified = account.labelsVerifiedEpoch === account.epoch;
	if (!report.labels && !report.epochVerified) {
		report.code = "label_migration_not_run";
		return report;
	}
	if (!input.execute) {
		report.outcome = "dry_run";
		return report;
	}
	try {
		database.transaction((tx) => {
			const now = new Date();
			for (const bank of banks) {
				// The bank's fence without the Memory switch, as an owner's export:
				// a rollback with Memory off still takes its labels back.
				assertMemoryBankAccess(
					tx,
					input.userId,
					bank.id,
					account.epoch,
					"owner-export",
				);
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
			// Truly today's page: the verification is forgotten too, so an
			// in-place upgrade marks the epoch again.
			revokeMemoryLabelsVerified(tx, input.userId, account.epoch);
		});
	} catch (error) {
		report.code = failureCode(error);
		return report;
	}
	report.outcome = "done";
	return report;
}
