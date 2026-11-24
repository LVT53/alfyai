import { and, asc, eq, ne } from "drizzle-orm";
import type { MemoryKind, MemoryScope, MemorySubject } from "$lib/memory-types";
import { type DatabaseInstance, db } from "$lib/server/db";
import {
	memoryAccounts,
	memoryBanks,
	memoryFactLabels,
	memoryLabelRelabels,
} from "$lib/server/db/schema";
import type { CurationModel } from "./curation";
import { classifyMemoryFacts, FACT_LABEL_BATCH_SIZE } from "./fact-classifier";
import { readFactLabels, recordClassifiedFactLabels } from "./fact-labels";
import { nativeMemoryClient } from "./hindsight-client";
import {
	AccountFailure,
	type AccountReading,
	type Bank,
	type BankRead,
	defaultModel,
	eligibleAccount,
	type Fact,
	failureCode,
	inBatches,
	type LabelMigrationDeps,
	type LabelMigrationSkip,
	labelCounts,
	MAX_CONCURRENCY,
	MAX_FAILED_BATCHES_IN_A_ROW,
	MAX_UNLABELLED_SHARE,
	publishedFingerprint,
	readBankFacts,
	reading,
	removedByPerson,
} from "./label-migration";
import {
	assertMemoryMigrationAllowed,
	MEMORY_MIGRATION_EXCLUDED,
	memoryMigrationGuard,
} from "./migration-guard";
import {
	assertMemoryBankAccess,
	assertMemoryBankFence,
	memoryTextHash,
} from "./revisions";

/**
 * The label relabel (Memory bank config 3): the label migration's second
 * mode. Config 2 labelled a purchase or an acquisition temporary (a dated
 * event), so a phone the person bought aged into Earlier. Config 3's words
 * say that something bought, got or owned now is lasting; this run asks the
 * classifier, with those words, about every fact whose label is temporary
 * today, and writes the answer where the classifier's label wins
 * (`recordClassifiedFactLabels`) when the fact is no longer temporary.
 *
 * The safety is the migration's, and a little more, because it changes an
 * account that already has its labels:
 * - the permanent tester rule's guard first, and an account whose epoch still
 *   waits for the label migration is left to it (the migration labels it with
 *   the new words anyway);
 * - a dry run unless `execute`, counts only; the paired backup is the
 *   command's to check before any write;
 * - it only lists from Hindsight and never writes there; what the person
 *   removed is never sent;
 * - every answer is collected first and verified, and only then written, in
 *   one fenced transaction for the account (the bank's epoch and status, the
 *   tester rule, and a check inside it that the published rows are exactly as
 *   they were): an account that fails verification is left as it was, with
 *   nothing recorded;
 * - each fact it asked about gets a record of the label it held before
 *   (`memory_label_relabels`, which also makes the run resumable: a fact is
 *   asked once, however it was answered), and the rollback puts back exactly
 *   what the relabel changed, only where the label is still as the relabel
 *   wrote it.
 * Reports hold counts, ids and codes only, never memory text.
 */

export type RelabelSkip =
	| LabelMigrationSkip
	/** The epoch still waits for the label migration. */
	| "labels_not_verified"
	/** Every temporary fact was asked about already (or there is none). */
	| "nothing_to_relabel";

/** What the relabel acts through: the migration's, with its own per-account callback. */
export type RelabelDeps = Omit<LabelMigrationDeps, "onAccount"> & {
	/** Called once an account is done with, for a command's progress line. */
	onAccount?: (account: RelabelAccount) => void;
};

export interface RelabelAccount {
	userId: string;
	epoch: number | null;
	outcome: "skipped" | "dry_run" | "relabelled" | "failed";
	skipped?: RelabelSkip;
	/** The code the account failed with: nothing was written. */
	failure?: string;
	banks: number;
	/** Raw facts Hindsight holds in these banks, the removed ones left out. */
	facts: number;
	/** Raw facts the person removed: never sent. */
	removed: number;
	/** Facts whose label is temporary now. */
	temporary: number;
	/** Of those, the ones an earlier run asked about already. */
	alreadyRelabelled: number;
	toRelabel: number;
	estimatedCalls: number;
	calls: number;
	/** Facts the model gave a usable label this run. */
	reclassified: number;
	/**
	 * Of those, the facts the new words no longer call temporary, by the kind
	 * they get (what the answers say; written only when the account verified).
	 */
	moved: Partial<Record<MemoryKind, number>>;
	stillTemporary: number;
	/** Facts the model left without a usable label (asked again by the next run). */
	unanswered: number;
	/** Facts whose label changed while the run asked: left as they are. */
	labelChanged: number;
	/** The account as it read before the run: its entries and the Earlier ones. */
	before?: AccountReading;
	/** The account as it reads at the end of the run (a dry run: now). */
	whole?: AccountReading;
	verification?: {
		/** Every fact it asked about reads the same in Hindsight's second listing. */
		factsUnchanged: boolean;
		publishedRowsUnchanged: boolean;
		/** At most one fact in 20 (`MAX_UNLABELLED_SHARE`) left without a usable label. */
		fewUnanswered: boolean;
		/** Not almost every answered fact moved (`MAX_MOVED_SHARE`). */
		plausible: boolean;
	};
}

export interface RelabelReport {
	execute: boolean;
	/** done: every account it reached was relabelled or skipped; stopped: one failed. */
	outcome: "dry_run" | "done" | "stopped";
	stoppedAt?: string;
	totals: {
		accounts: number;
		skipped: Partial<Record<RelabelSkip, number>>;
		banks: number;
		facts: number;
		temporary: number;
		alreadyRelabelled: number;
		toRelabel: number;
		estimatedCalls: number;
		calls: number;
		reclassified: number;
		/** Facts moved off temporary, in the accounts that were relabelled. */
		moved: number;
		/** Accounts relabelled. */
		relabelled: number;
		failed: number;
		/** Entries of the accounts it read at the end, and how many are Earlier. */
		entries: number;
		earlierEntries: number;
	};
	accounts: RelabelAccount[];
}

/**
 * The new words call a temporary fact lasting or ongoing for what it is: a
 * purchase, an acquisition. They never turn most of an account's temporary
 * facts into something else, so an answer that moves more than this share of
 * the facts it was asked about (judged once `PLAUSIBILITY_MIN_FACTS` were
 * answered; a small account may move all of them) is a model that has stopped
 * reading, and fails the account with nothing written.
 */
const MAX_MOVED_SHARE = 0.9;
const PLAUSIBILITY_MIN_FACTS = 20;

/**
 * The relabel over every account, the one named, or exactly the ones listed
 * (`userIds`, in that order: the command's list, which its backup was checked
 * for): a dry run unless `execute`.
 */
export async function runLabelRelabel(
	input: { execute: boolean; userId?: string; userIds?: readonly string[] },
	deps: RelabelDeps = {},
): Promise<RelabelReport> {
	const database = deps.database ?? db;
	const report: RelabelReport = {
		execute: input.execute,
		outcome: input.execute ? "done" : "dry_run",
		totals: {
			accounts: 0,
			skipped: {},
			banks: 0,
			facts: 0,
			temporary: 0,
			alreadyRelabelled: 0,
			toRelabel: 0,
			estimatedCalls: 0,
			calls: 0,
			reclassified: 0,
			moved: 0,
			relabelled: 0,
			failed: 0,
			entries: 0,
			earlierEntries: 0,
		},
		accounts: [],
	};
	const userIds =
		input.userIds ??
		(input.userId !== undefined
			? [input.userId]
			: database
					.select({ userId: memoryAccounts.userId })
					.from(memoryAccounts)
					.orderBy(asc(memoryAccounts.userId))
					.all()
					.map(({ userId }) => userId));
	for (const userId of userIds) {
		const entry = await relabelAccount(userId, input.execute, database, deps);
		report.accounts.push(entry);
		const { totals } = report;
		totals.accounts++;
		if (entry.skipped)
			totals.skipped[entry.skipped] = (totals.skipped[entry.skipped] ?? 0) + 1;
		totals.banks += entry.banks;
		totals.facts += entry.facts;
		totals.temporary += entry.temporary;
		totals.alreadyRelabelled += entry.alreadyRelabelled;
		totals.toRelabel += entry.toRelabel;
		totals.estimatedCalls += entry.estimatedCalls;
		totals.calls += entry.calls;
		totals.reclassified += entry.reclassified;
		totals.entries += entry.whole?.entries ?? 0;
		totals.earlierEntries += entry.whole?.earlierEntries ?? 0;
		if (entry.outcome === "relabelled") {
			totals.relabelled++;
			totals.moved += Object.values(entry.moved).reduce(
				(sum, count) => sum + (count ?? 0),
				0,
			);
		}
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

function emptyEntry(userId: string, epoch: number | null): RelabelAccount {
	return {
		userId,
		epoch,
		outcome: "skipped",
		banks: 0,
		facts: 0,
		removed: 0,
		temporary: 0,
		alreadyRelabelled: 0,
		toRelabel: 0,
		estimatedCalls: 0,
		calls: 0,
		reclassified: 0,
		moved: {},
		stillTemporary: 0,
		unanswered: 0,
		labelChanged: 0,
	};
}

type Answer = { kind: MemoryKind; subject: MemorySubject };

async function relabelAccount(
	userId: string,
	execute: boolean,
	database: DatabaseInstance,
	deps: RelabelDeps,
): Promise<RelabelAccount> {
	const eligible = eligibleAccount(userId, database);
	if ("skip" in eligible) {
		const entry = emptyEntry(userId, null);
		entry.skipped = eligible.skip;
		return entry;
	}
	const { account } = eligible;
	const entry = emptyEntry(userId, account.epoch);
	// An epoch that still waits for the label migration is labelled by it, with
	// the same words: nothing to relabel until it has run.
	if (eligible.unverified) {
		entry.skipped = "labels_not_verified";
		return entry;
	}
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
		const read = async () => {
			const result: (BankRead & { temporary: Fact[]; todo: Fact[] })[] = [];
			for (const bank of banks) {
				const bankRead = await readBankFacts(
					database,
					bank,
					account.tenantId,
					listFacts,
					signal,
				);
				// A fact is asked once, for as long as its label still reads as the
				// relabel left it: a record stands on that label, so when the label
				// migration was rolled back, or a publication copied extraction's
				// tag back, the record is stale and the fact is asked again.
				const recorded = new Map(
					database
						.select()
						.from(memoryLabelRelabels)
						.where(eq(memoryLabelRelabels.bankId, bank.id))
						.all()
						.map((record) => [record.nativeFactId, record]),
				);
				const standing = (id: string) => {
					const record = recorded.get(id);
					const label = bankRead.labels.get(id);
					return (
						!!record &&
						!!label &&
						label.kind === record.kind &&
						label.subject === record.subject &&
						label.origin ===
							(record.changed ? "classifier" : record.previousOrigin)
					);
				};
				const temporary = bankRead.facts.filter(
					(fact) => bankRead.labels.get(fact.id)?.kind === "temporary",
				);
				result.push({
					...bankRead,
					temporary,
					todo: temporary.filter((fact) => !standing(fact.id)),
				});
			}
			return result;
		};
		const banksRead = await read();
		for (const { facts, removed, temporary, todo } of banksRead) {
			entry.facts += facts.length;
			entry.removed += removed;
			entry.temporary += temporary.length;
			entry.alreadyRelabelled += temporary.length - todo.length;
			entry.toRelabel += todo.length;
			entry.estimatedCalls += Math.ceil(todo.length / FACT_LABEL_BATCH_SIZE);
		}
		if (banks.some((bank) => bank.status === "repair_blocked"))
			throw new AccountFailure("bank_repair_blocked");
		entry.before = reading(database, userId, banks, banksRead);
		entry.whole = entry.before;
		if (!entry.toRelabel) {
			entry.skipped = "nothing_to_relabel";
			return entry;
		}
		if (!execute) {
			entry.outcome = "dry_run";
			return entry;
		}
		const fingerprint = publishedFingerprint(database, userId, banks);
		const model = (deps.model ?? defaultModel)(userId, signal);
		const concurrency = Math.min(
			MAX_CONCURRENCY,
			Math.max(1, Math.floor(deps.concurrency ?? 1)),
		);
		// Every answer is held here until the account verifies: nothing is written before.
		const answers = new Map<string, Map<string, Answer>>();
		const unanswered = new Set<string>();
		/** Each fact it asked about, by id: a hash of the text the answer was chosen for. */
		const askedText = new Map<string, string>();
		let failedInARow = 0;
		let unavailable = 0;
		for (const { bank, todo, documentIds } of banksRead) {
			if (!todo.length) continue;
			const scope: MemoryScope["kind"] =
				bank.scopeKey === "personal" ? "personal" : "project";
			// As curation and the migration do: the tester rule and the bank's fence
			// are asked again before each batch and right before its call is sent
			// (after the admission queue's wait), so no fact goes out once the
			// person turned Memory off, cleared or erased it, or the account was
			// excluded.
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
			const forBank = new Map<string, Answer>();
			answers.set(bank.id, forBank);
			// One pass in batches, then one more for what it left unanswered.
			let left = todo;
			for (let pass = 0; pass < 2 && left.length; pass++) {
				const missing: Fact[] = [];
				const failed: Fact[] = [];
				await inBatches(left, concurrency, signal, async (planned) => {
					fence();
					// What the person removed since the listing is not sent.
					const removedNow = removedByPerson(database, bank.id);
					const batch = planned.filter(
						(fact) =>
							!removedNow({
								id: fact.id,
								text: fact.text,
								fact_type: "world",
								document_id: documentIds.get(fact.id) ?? null,
							}),
					);
					if (!batch.length) return;
					let labels: Map<string, Answer>;
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
					for (const fact of batch) {
						const label = labels.get(fact.id);
						if (!label) {
							missing.push(fact);
							continue;
						}
						forBank.set(fact.id, label);
						askedText.set(fact.id, memoryTextHash(fact.text));
					}
				});
				left = [...failed, ...missing];
				if (pass === 1 || !left.length) {
					for (const fact of missing) unanswered.add(fact.id);
					unavailable += failed.length;
				}
			}
		}
		entry.unanswered = unanswered.size;
		if (unavailable) throw new AccountFailure("model_unavailable");
		for (const forBank of answers.values()) {
			for (const { kind } of forBank.values()) {
				entry.reclassified++;
				if (kind === "temporary") entry.stillTemporary++;
				else entry.moved[kind] = (entry.moved[kind] ?? 0) + 1;
			}
		}
		// Verify before anything is written: every fact accounted for, each
		// answer chosen for the text Hindsight still holds, the published rows
		// as they were, few facts left unanswered, and a plausible share moved.
		const after = await read();
		const listedAfter = new Map(
			after.flatMap(({ facts }) =>
				facts.map((fact) => [fact.id, memoryTextHash(fact.text)] as const),
			),
		);
		const factsUnchanged = [...askedText].every(
			([id, hash]) => listedAfter.get(id) === hash,
		);
		const publishedRowsUnchanged =
			publishedFingerprint(database, userId, banks) === fingerprint;
		// At most one fact in 20, and always one: a fact the model leaves
		// unanswered keeps its label and is asked again by the next run, so a
		// small account is not stopped for good by a single one.
		const fewUnanswered =
			unanswered.size <= Math.max(1, entry.toRelabel * MAX_UNLABELLED_SHARE);
		const moved = entry.reclassified - entry.stillTemporary;
		const plausible =
			entry.reclassified < PLAUSIBILITY_MIN_FACTS ||
			moved <= entry.reclassified * MAX_MOVED_SHARE;
		entry.verification = {
			factsUnchanged,
			publishedRowsUnchanged,
			fewUnanswered,
			plausible,
		};
		if (!factsUnchanged) throw new AccountFailure("facts_changed");
		if (!publishedRowsUnchanged)
			throw new AccountFailure("published_rows_changed");
		if (!fewUnanswered) throw new AccountFailure("too_many_unanswered");
		if (!plausible) throw new AccountFailure("implausible_relabel");
		// One write for the account, fenced as any Memory write; the published
		// rows are checked inside it against what the run started with, so a
		// write that changed any, or a publication that slipped in since the
		// check above, would not stand.
		const labelChanged = database.transaction((tx) => {
			assertMemoryMigrationAllowed(userId, tx);
			for (const bank of banks)
				assertMemoryBankFence(tx, userId, bank.id, account.epoch);
			if (publishedFingerprint(database, userId, banks) !== fingerprint)
				throw new AccountFailure("published_rows_changed");
			// One moment for the labels and the records, so a rollback can tell a
			// label this run wrote from one written again later.
			const now = new Date();
			let changedSince = 0;
			for (const [bankId, forBank] of answers) {
				const moves = new Map<string, Answer>();
				for (const [factId, answer] of forBank) {
					const current = tx
						.select()
						.from(memoryFactLabels)
						.where(
							and(
								eq(memoryFactLabels.bankId, bankId),
								eq(memoryFactLabels.nativeFactId, factId),
							),
						)
						.get();
					// The label moved on while the run asked: leave it.
					if (current?.kind !== "temporary") {
						changedSince++;
						continue;
					}
					const changed = answer.kind !== "temporary";
					// A stale record (its label is gone) is replaced by this run's.
					tx.delete(memoryLabelRelabels)
						.where(
							and(
								eq(memoryLabelRelabels.bankId, bankId),
								eq(memoryLabelRelabels.nativeFactId, factId),
							),
						)
						.run();
					tx.insert(memoryLabelRelabels)
						.values({
							bankId,
							nativeFactId: factId,
							previousKind: current.kind,
							previousSubject: current.subject,
							previousOrigin: current.origin,
							kind: changed ? answer.kind : current.kind,
							subject: changed ? answer.subject : current.subject,
							changed,
							relabelledAt: now,
						})
						.run();
					if (changed) moves.set(factId, answer);
				}
				if (moves.size) recordClassifiedFactLabels(tx, bankId, moves, now);
			}
			if (publishedFingerprint(database, userId, banks) !== fingerprint)
				throw new AccountFailure("published_rows_changed");
			return changedSince;
		});
		entry.labelChanged = labelChanged;
		entry.whole = reading(
			database,
			userId,
			banks,
			banksRead.map(({ bank, facts }) => ({
				...labelCounts(facts, readFactLabels(database, bank.id)),
			})),
		);
		entry.outcome = "relabelled";
		return entry;
	} catch (error) {
		entry.outcome = "failed";
		entry.failure = failureCode(error);
		if (!execute) entry.outcome = "dry_run";
		return entry;
	}
}

export interface RelabelRollbackReport {
	userId: string;
	execute: boolean;
	outcome: "dry_run" | "done" | "refused";
	code?: string;
	banks: number;
	/** Facts the relabel moved off temporary: its records that changed a label. */
	changed: number;
	/** Of those, the labels still as the relabel wrote them (in a dry run: to put back). */
	toRestore: number;
	/** Labels put back. */
	restored: number;
	/** Labels someone changed since (or whose fact is gone): left as they are. */
	leftAlone: number;
	/** Facts the relabel asked about and left temporary. */
	lookedAt: number;
}

/**
 * Undoes the relabel for one account's current epoch: every label the relabel
 * changed that still reads as the relabel wrote it goes back to the kind,
 * subject and origin it held before; a label changed since is left as it is;
 * the account's records are forgotten, so the next run asks about those facts
 * again. A dry run unless `execute`; the permanent tester rule's guard first.
 * It works with Memory off (it writes only the app's own label rows), and
 * refuses an account the relabel never ran on (`label_relabel_not_run`). It
 * never touches the account's label verification or any other table.
 */
export function rollbackLabelRelabel(
	input: { userId: string; execute: boolean },
	database: DatabaseInstance = db,
): RelabelRollbackReport {
	const report: RelabelRollbackReport = {
		userId: input.userId,
		execute: input.execute,
		outcome: "refused",
		banks: 0,
		changed: 0,
		toRestore: 0,
		restored: 0,
		leftAlone: 0,
		lookedAt: 0,
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
	const banks: Bank[] = database
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
	const recordsOf = (bankId: string) =>
		database
			.select()
			.from(memoryLabelRelabels)
			.where(eq(memoryLabelRelabels.bankId, bankId))
			.all();
	/** The records that changed a label, with whether the label still reads as written. */
	const survey = (bankId: string) => {
		const labels = readFactLabelRows(database, bankId);
		return recordsOf(bankId).map((record) => {
			const current = labels.get(record.nativeFactId);
			return {
				record,
				intact:
					record.changed &&
					!!current &&
					current.origin === "classifier" &&
					current.kind === record.kind &&
					current.subject === record.subject &&
					// Not written again since (the label migration, run again after its
					// own rollback, can write the same words later).
					current.updatedAt.getTime() <= record.relabelledAt.getTime(),
			};
		});
	};
	for (const bank of banks)
		for (const { record, intact } of survey(bank.id)) {
			if (!record.changed) report.lookedAt++;
			else {
				report.changed++;
				if (intact) report.toRestore++;
				else report.leftAlone++;
			}
		}
	if (!report.changed && !report.lookedAt) {
		report.code = "label_relabel_not_run";
		return report;
	}
	if (!input.execute) {
		report.outcome = "dry_run";
		return report;
	}
	try {
		database.transaction((tx) => {
			const now = new Date();
			report.restored = 0;
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
				for (const { record, intact } of survey(bank.id)) {
					if (!intact) continue;
					tx.update(memoryFactLabels)
						.set({
							kind: record.previousKind,
							subject: record.previousSubject,
							origin: record.previousOrigin,
							updatedAt: now,
						})
						.where(
							and(
								eq(memoryFactLabels.bankId, bank.id),
								eq(memoryFactLabels.nativeFactId, record.nativeFactId),
							),
						)
						.run();
					report.restored++;
				}
				tx.delete(memoryLabelRelabels)
					.where(eq(memoryLabelRelabels.bankId, bank.id))
					.run();
			}
		});
	} catch (error) {
		report.restored = 0;
		report.code = failureCode(error);
		return report;
	}
	report.outcome = "done";
	return report;
}

/** The label rows of a bank by fact id, with their origin (the store's reader drops it for an unlabelled row). */
function readFactLabelRows(database: DatabaseInstance, bankId: string) {
	return new Map(
		database
			.select()
			.from(memoryFactLabels)
			.where(eq(memoryFactLabels.bankId, bankId))
			.all()
			.map((row) => [row.nativeFactId, row]),
	);
}
