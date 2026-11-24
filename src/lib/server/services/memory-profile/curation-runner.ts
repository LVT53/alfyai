import { randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	memoryAccounts,
	memoryActions,
	memoryBanks,
	memoryDeliveryAttempts,
	memoryDeliveryJobs,
	memoryPublishedRows,
	memoryRevocations,
	memorySourceRevisions,
	users,
} from "$lib/server/db/schema";
import type { JobRunContext, Tx } from "../jobs/types";
import { memoryAdmissionFor } from "./admission";
import { ensureConfiguredBank } from "./bank-configuration";
import {
	EXPLICIT_EDIT_RETENTION_GUIDANCE,
	NATIVE_DELIVERY_ATTEMPT_LIMIT,
	type NativeMemory,
} from "./contracts";
import {
	applyMemoryEdit,
	type CurationModel,
	checkMemoryEdit,
	createCurationModel,
	type EditedFact,
	planMemoryEdit,
} from "./curation";
import {
	type ActionIntentRecord,
	parseActionIntent,
	type ReplayCheck,
} from "./curation-intent";
import { readNativeCurationLineage } from "./curation-lineage";
import { countedDeliveryAttempt } from "./delivery-policy";
import {
	type NativeSettlement,
	runDependencyRepair,
} from "./dependency-repair";
import {
	type HindsightClient,
	type NativeBinding,
	NativeMemoryError,
} from "./hindsight-client";
import { parseJsonRecord } from "./internal-json";
import {
	admittedNativeFacts,
	assertCurationPublication,
	curatedObservationChanges,
	manualPublicationReceipts,
	prepareNativeSnapshot,
	publishedEditResult,
	publishedRowsForGeneration,
	publishNativeSnapshot,
	readAcknowledgedFacts,
	readPublishedMemory,
	republishRenumberedNativeObservations,
} from "./publication";
import {
	acceptedCorrectionSources,
	assertMemoryActionOriginCurrent,
	assertMemoryBankFence,
	assertMemoryCurationSourceCurrent,
	assertMemoryDependencySourceCurrent,
	assertMemorySourceCurrent,
	carriedMemorySources,
	isEditResendWithdrawal,
	memorySourcePredecessors,
	memoryTextHash,
	recordMemorySource,
} from "./revisions";

type Context = JobRunContext<typeof memoryDeliveryJobs>;
const collectiveRejection = "memory_dependency_check_rejected";
type Source = typeof memorySourceRevisions.$inferSelect;
type SourceAssertions = NonNullable<
	Parameters<typeof checkMemoryEdit>[0]["sourceAssertions"]
>;
type CandidateCheck = {
	memories: NativeMemory[];
	sourceIds: string[];
	originalFacts: ActionIntentRecord["facts"];
	replays?: ReplayCheck[];
	sourceAssertions?: SourceAssertions;
	assertContextCurrent?: (tx: Tx) => void;
	withdrawnFactIds?: ReadonlySet<string>;
	withdrawnSourceIds?: string[];
};
function withdrawnComparisonFacts(
	tx: Tx,
	ctx: Context,
	bank: typeof memoryBanks.$inferSelect,
	compared: ReadonlySet<string>,
	verifiedSources: ReadonlySet<string>,
) {
	const withdrawn = new Set<string>();
	if (!compared.size) return withdrawn;
	const current =
		ctx.row.kind === "source" && ctx.row.sourceId
			? assertMemorySourceCurrent(tx, ctx.row.sourceId, bank.userId, bank.id)
			: undefined;
	const revisions = tx
		.select()
		.from(memorySourceRevisions)
		.where(
			and(
				eq(memorySourceRevisions.userId, bank.userId),
				eq(memorySourceRevisions.bankId, bank.id),
				eq(memorySourceRevisions.epoch, bank.epoch),
				eq(memorySourceRevisions.state, "revoked"),
			),
		)
		.all();
	for (const source of revisions) {
		if (
			verifiedSources.has(source.id) &&
			current &&
			(isEditResendWithdrawal(source) ||
				(!current.eventId.startsWith("message:") &&
					current.predecessorSourceId === source.id))
		)
			continue;
		for (const fact of readAcknowledgedFacts(source.acknowledgedFactsJson))
			if (compared.has(fact.id)) withdrawn.add(fact.id);
	}
	return withdrawn;
}

function assertComparisonSourcesCurrent(
	tx: Tx,
	ctx: Context,
	bank: typeof memoryBanks.$inferSelect,
	compared: ReadonlySet<string>,
	verifiedSources: ReadonlySet<string>,
) {
	assertCurationPublication(tx, bank.id, bank.epoch, {
		checkedActionIds: ctx.row.actionId ? [ctx.row.actionId] : [],
	});
	if (withdrawnComparisonFacts(tx, ctx, bank, compared, verifiedSources).size)
		throw new NativeMemoryError("memory_dependency_source_changed", true);
}

async function checkCandidate(
	ctx: Context,
	candidate: CandidateCheck,
	edit: Pick<
		Parameters<typeof checkMemoryEdit>[0],
		| "before"
		| "after"
		| "intent"
		| "orderedEdits"
		| "latestChatSourceId"
		| "sourceAssertions"
		| "withdrawnSourceIds"
		| "removalOnly"
		| "restorePrevious"
	>,
	model: CurationModel,
) {
	const replays = candidate.replays ?? [];
	const sourceIds = new Set([
		...candidate.sourceIds,
		...replays.flatMap((r) => r.sources),
	]);
	const originalFacts = [
		...new Map(
			[...replays.flatMap((r) => r.originals), ...candidate.originalFacts].map(
				(f) => [f.id, f],
			),
		).values(),
	];
	const proposedFacts = candidate.memories.filter(
		(m) => m.fact_type !== "observation" && sourceIds.has(m.document_id ?? ""),
	);
	const affected = new Set([
		...originalFacts.map((f) => f.id),
		...proposedFacts.map((f) => f.id),
	]);
	const bank = db.transaction((tx) => actionFence(tx, ctx));
	const previousRows = bank.generation
		? db
				.select()
				.from(memoryPublishedRows)
				.where(
					and(
						eq(memoryPublishedRows.bankId, bank.id),
						eq(memoryPublishedRows.generation, bank.generation),
					),
				)
				.all()
		: [];
	const previousById = new Map(previousRows.map((row) => [row.nativeId, row]));
	const raw = new Map(
		candidate.memories
			.filter((m) => m.fact_type !== "observation")
			.map((m) => [m.id, m.text]),
	);
	const prepared = prepareNativeSnapshot(candidate.memories);
	const changedRows = new Set<string>();
	const observations = candidate.memories.flatMap((row) => {
		if (row.fact_type !== "observation") return [];
		const previous = previousById.get(row.id);
		const ids = row.source_memory_ids ?? [];
		const text = prepared.get(row.id) ?? row.text;
		const fingerprints = previous
			? readAcknowledgedFacts(previous.sourceFingerprintsJson)
			: [];
		const changed =
			!previous ||
			previous.text !== text ||
			previous.nativeText !== row.text ||
			fingerprints.length !== ids.length ||
			fingerprints.some(
				(fact) => !ids.includes(fact.id) || raw.get(fact.id) !== fact.text,
			);
		if (changed) changedRows.add(row.id);
		if (!changed && !ids.some((id) => affected.has(id))) return [];
		return [{ id: row.id, text, sourceFactIds: ids }];
	});
	const liveIds = new Set(
		candidate.memories
			.filter((row) => row.fact_type === "observation")
			.map((row) => row.id),
	);
	const compared = previousRows.flatMap((row) => {
		const facts = readAcknowledgedFacts(row.sourceFingerprintsJson);
		const ids = facts.map((fact) => fact.id);
		if (
			!changedRows.has(row.nativeId) &&
			liveIds.has(row.nativeId) &&
			!ids.some((id) => affected.has(id) || candidate.withdrawnFactIds?.has(id))
		)
			return [];
		return [{ row, facts, ids }];
	});
	const comparedIds = new Set(compared.flatMap(({ ids }) => ids));
	const withdrawn = db.transaction((tx) =>
		withdrawnComparisonFacts(tx, ctx, bank, comparedIds, sourceIds),
	);
	const previous = compared.flatMap(({ row, facts, ids }) => {
		const isWithdrawn = (id: string) =>
			withdrawn.has(id) || candidate.withdrawnFactIds?.has(id);
		if (ids.some(isWithdrawn))
			return facts
				.filter((fact) => !isWithdrawn(fact.id))
				.map((fact) => ({ ...fact, sourceFactIds: [fact.id] }));
		return [{ id: row.nativeId, text: row.text, sourceFactIds: ids }];
	});
	if (
		edit.restorePrevious &&
		!originalFacts.length &&
		!proposedFacts.length &&
		!observations.length &&
		!previous.length
	)
		return;
	const assertions = candidate.sourceAssertions ?? edit.sourceAssertions;
	const dispatchedIds = new Set([
		...previous.flatMap((row) => row.sourceFactIds),
		...originalFacts.map((fact) => fact.id),
		...proposedFacts.map((fact) => fact.id),
		...observations.flatMap((row) => row.sourceFactIds),
	]);
	const verificationModel = guardedModel(ctx, model, (tx) => {
		assertComparisonSourcesCurrent(tx, ctx, bank, dispatchedIds, sourceIds);
		candidate.assertContextCurrent?.(tx);
		for (const replay of replays) replay.assertProvenance?.(tx);
		for (const assertion of assertions ?? []) {
			if (!assertion.originalSourceId)
				throw new NativeMemoryError("memory_dependency_source_changed", true);
			try {
				const { original, live } = assertMemoryDependencySourceCurrent(
					tx,
					assertion.originalSourceId,
					bank,
				);
				const rebuilt = assertMemorySourceCurrent(
					tx,
					assertion.id,
					bank.userId,
					bank.id,
				);
				if (
					original.epoch === bank.epoch &&
					rebuilt.epoch === bank.epoch &&
					original.text === assertion.assertion &&
					rebuilt.textHash === original.textHash &&
					rebuilt.messageId === live.messageId &&
					rebuilt.predecessorSourceId === original.id &&
					rebuilt.state === "repair_held" &&
					rebuilt.nativeAcknowledged
				)
					continue;
			} catch {
				// A withdrawn reply cannot be used to check a stale rebuild.
			}
			throw new NativeMemoryError("memory_dependency_source_changed", true);
		}
	});
	await checkMemoryEdit(
		{
			...edit,
			sourceAssertions: assertions?.length ? assertions : edit.sourceAssertions,
			withdrawnSourceIds:
				edit.withdrawnSourceIds ?? candidate.withdrawnSourceIds,
			orderedEdits:
				edit.orderedEdits ??
				(replays.length
					? orderedChecks(replays, Boolean(edit.latestChatSourceId))
					: undefined),
			originalFacts,
			proposedFacts: proposedFacts.map(({ id, text, document_id }) => ({
				id,
				text,
				sourceId: document_id,
			})),
			observations,
			previousObservations: previous,
		},
		verificationModel,
	);
}
function orderedChecks(replays: ReplayCheck[], chronology = false) {
	const byAction = new Map<string, ReplayCheck>();
	for (const replay of replays) {
		const prior = byAction.get(replay.actionId);
		byAction.set(
			replay.actionId,
			prior
				? {
						...replay,
						sources: [...new Set([...prior.sources, ...replay.sources])],
					}
				: replay,
		);
	}
	const checks = [...byAction.values()];
	const crossScopeReplay = checks.some(
		(check) => check.replayOrder !== undefined,
	);
	return checks
		.sort((a, b) => {
			if (
				(crossScopeReplay || chronology) &&
				a.actionAt !== undefined &&
				b.actionAt !== undefined
			)
				return (
					a.actionAt - b.actionAt ||
					(a.replayOrder ?? a.actionOrder ?? Number.MAX_SAFE_INTEGER) -
						(b.replayOrder ?? b.actionOrder ?? Number.MAX_SAFE_INTEGER)
				);
			return a.revision - b.revision;
		})
		.map(({ before, after, intent, sources, chatRevision }) => ({
			before,
			after,
			intent,
			...(chronology ? { chatRevision } : {}),
			sources,
		}));
}
function actionFence(tx: Tx, ctx: Context) {
	const bank = assertMemoryBankFence(
		tx,
		ctx.row.userId,
		ctx.row.bankId,
		ctx.row.epoch,
	);
	const account = tx
		.select()
		.from(memoryAccounts)
		.where(eq(memoryAccounts.userId, ctx.row.userId))
		.get();
	if (!account || account.controlRevision !== ctx.row.controlRevision)
		throw new NativeMemoryError("memory_control_changed", false);
	if (ctx.row.kind === "source" && ctx.row.sourceId)
		assertMemorySourceCurrent(tx, ctx.row.sourceId, ctx.row.userId, bank.id);
	if (ctx.row.actionId) {
		const action = tx
			.select()
			.from(memoryActions)
			.where(eq(memoryActions.id, ctx.row.actionId))
			.get();
		const intent = action ? parseActionIntent(action.intentJson) : null;
		try {
			assertMemoryActionOriginCurrent(tx, bank, intent?.originConversationId);
		} catch {
			throw new NativeMemoryError("memory_control_changed", false);
		}
	}
	return bank;
}
async function fence(ctx: Context) {
	if (
		!(await ctx.write((tx) => {
			actionFence(tx, ctx);
		}))
	)
		throw new NativeMemoryError("memory_cancelled", false);
}
function assertActionAttemptCurrent(tx: Tx, ctx: Context) {
	const claim = tx
		.select()
		.from(memoryDeliveryJobs)
		.where(eq(memoryDeliveryJobs.id, ctx.row.id))
		.get();
	if (
		ctx.signal.aborted ||
		claim?.status !== "running" ||
		claim.currentAttemptId !== ctx.attempt.id
	)
		throw new NativeMemoryError("memory_cancelled", false);
}
function guardedModel(
	ctx: Context,
	override?: CurationModel,
	check?: (tx: Tx) => void,
): CurationModel {
	const beforeDispatch = () => {
		db.transaction((tx) => {
			assertActionAttemptCurrent(tx, ctx);
			actionFence(tx, ctx);
			check?.(tx);
		});
	};
	// A curation job is background work in the admission queue, in its tenant's lane.
	const model =
		override ??
		createCurationModel(
			ctx.signal,
			undefined,
			memoryAdmissionFor(ctx.row.userId, "background"),
		);
	return (prompt, input, schema, thinkingMode, assertCurrent) => {
		beforeDispatch();
		return model(prompt, input, schema, thinkingMode, () => {
			beforeDispatch();
			assertCurrent?.();
		});
	};
}
async function saveIntent(
	ctx: Context,
	actionId: string,
	intent: ActionIntentRecord,
) {
	await saveIntents(ctx, [{ actionId, intent }]);
}
/** Several actions' intents in one fenced write. */
async function saveIntents(
	ctx: Context,
	intents: ReadonlyArray<{ actionId: string; intent: ActionIntentRecord }>,
) {
	if (
		!(await ctx.write((tx) => {
			actionFence(tx, ctx);
			for (const { actionId, intent } of intents)
				tx.update(memoryActions)
					.set({ intentJson: JSON.stringify(intent) })
					.where(eq(memoryActions.id, actionId))
					.run();
		}))
	)
		throw new NativeMemoryError("memory_cancelled", false);
}

/**
 * Where a per-chat forget step that already began to edit this chat stands,
 * from its live facts: as before the edit (nothing landed, so it runs again),
 * as the saved edit left them (it goes on from what it saved), or anything
 * else, a partial edit say, which no review can check any more.
 */
function resumedMeaningCheck(
	step: NonNullable<ActionIntentRecord["meaningCheck"]>,
	sourceId: string,
	live: ReadonlyArray<{ id: string; text: string }>,
) {
	if (!step.started.includes(sourceId)) return undefined;
	const saved = step.edits?.find((edit) => edit.sourceId === sourceId);
	const same = (facts: ReadonlyArray<{ id: string; text: string }>) =>
		live.length === facts.length &&
		facts.every((fact) =>
			live.some(({ id, text }) => id === fact.id && text === fact.text),
		);
	if (saved && same(saved.baseline)) return undefined;
	if (saved && same(saved.proposal.filter(({ text }) => text.trim())))
		return saved;
	throw new NativeMemoryError("memory_meaning_check_interrupted", false);
}
function sourcesFor(bankId: string, ids: string[]) {
	return ids.length
		? db
				.select()
				.from(memorySourceRevisions)
				.where(
					and(
						eq(memorySourceRevisions.bankId, bankId),
						inArray(memorySourceRevisions.id, ids),
					),
				)
				.all()
		: [];
}
async function patch(
	ctx: Context,
	client: HindsightClient,
	proposal: Array<{ id: string; text: string }>,
	checkSources?: (tx: Tx) => void,
	mentionedAt?: ReadonlyMap<string, string>,
	expectedSources?: ReadonlyMap<string, string>,
	verifyInputs?: (memories: NativeMemory[]) => void,
	/** Runs once, before the first native edit, if there is one. */
	beforeFirstEdit?: () => Promise<void>,
) {
	let firstEdit = beforeFirstEdit;
	const live = await client.list();
	verifyInputs?.(live);
	const current = new Map(
		live.filter((m) => m.fact_type !== "observation").map((m) => [m.id, m]),
	);
	for (const fact of proposal) {
		const time = mentionedAt?.get(fact.id);
		const previous = current.get(fact.id);
		if (
			(previous?.text === fact.text &&
				(!time ||
					Date.parse(previous.mentioned_at ?? "") === Date.parse(time))) ||
			(!fact.text.trim() && !previous)
		)
			continue;
		if (!previous)
			throw new NativeMemoryError("memory_edit_source_missing", false);
		if (
			expectedSources &&
			previous.document_id !== expectedSources.get(fact.id)
		)
			throw new NativeMemoryError("memory_source_edit_protected_fact", false);
		await fence(ctx);
		ctx.signal.throwIfAborted();
		db.transaction((tx) => {
			actionFence(tx, ctx);
			checkSources?.(tx);
		});
		await firstEdit?.();
		firstEdit = undefined;
		await client.editFact(
			fact.id,
			fact.text.trim()
				? { text: fact.text, ...(time ? { mentioned_at: time } : {}) }
				: { state: "invalidated", reason: "Explicit user memory removal" },
		);
	}
}
/** A Remove can settle independently of a retained source whose own publication was held. */
function removalPublicationSnapshot(
	tx: Tx,
	action: typeof memoryActions.$inferSelect,
	bank: typeof memoryBanks.$inferSelect,
	actionSourceIds: string[],
	memories: NativeMemory[],
) {
	if (!action.exclusionAcknowledged) return memories;
	const pending = tx
		.select({ source: memorySourceRevisions })
		.from(memoryDeliveryJobs)
		.innerJoin(
			memorySourceRevisions,
			eq(memorySourceRevisions.id, memoryDeliveryJobs.sourceId),
		)
		.innerJoin(
			memoryAccounts,
			eq(memoryAccounts.userId, memoryDeliveryJobs.userId),
		)
		.where(
			and(
				eq(memoryDeliveryJobs.userId, bank.userId),
				eq(memoryDeliveryJobs.bankId, bank.id),
				eq(memoryDeliveryJobs.epoch, bank.epoch),
				eq(memoryDeliveryJobs.kind, "source"),
				eq(memoryDeliveryJobs.controlRevision, memoryAccounts.controlRevision),
				eq(memoryDeliveryJobs.status, "failed"),
				eq(memoryDeliveryJobs.errorCode, "memory_curation_publication_held"),
				sql`${memoryDeliveryJobs.requestId} = 'source:' || ${memorySourceRevisions.id}`,
				eq(
					memorySourceRevisions.controlRevision,
					memoryDeliveryJobs.controlRevision,
				),
				eq(memorySourceRevisions.state, "pending"),
				eq(memorySourceRevisions.nativeAcknowledged, true),
				eq(memorySourceRevisions.nativeSubmitted, true),
			),
		)
		.all();
	const candidates = pending
		.map(({ source }) => source)
		.filter(
			(source) =>
				source.userId === bank.userId &&
				source.bankId === bank.id &&
				source.epoch === bank.epoch &&
				source.createdAt <= action.createdAt &&
				source.messageId &&
				source.eventId.startsWith("message:") &&
				source.nativeOperationId &&
				!source.acceptedGeneration &&
				!readAcknowledgedFacts(source.acknowledgedFactsJson).length &&
				!actionSourceIds.includes(source.id),
		);
	if (!candidates.length) return memories;
	const revocations = tx
		.select()
		.from(memoryRevocations)
		.where(
			and(
				eq(memoryRevocations.bankId, bank.id),
				eq(memoryRevocations.epoch, bank.epoch),
			),
		)
		.all();
	const pendingIds = new Set(
		candidates
			.filter(
				(source) =>
					!revocations.some((revocation) => revocation.sourceId === source.id),
			)
			.map(
				(source) =>
					assertMemorySourceCurrent(tx, source.id, bank.userId, bank.id).id,
			),
	);
	const pendingFacts = new Set(
		memories
			.filter(
				(fact) =>
					fact.fact_type !== "observation" &&
					fact.document_id &&
					pendingIds.has(fact.document_id) &&
					!revocations.some(
						(revocation) => revocation.nativeFactId === fact.id,
					),
			)
			.map(({ id }) => id),
	);
	if (!pendingFacts.size) return memories;
	const prior = new Set(
		bank.generation
			? publishedRowsForGeneration(
					tx,
					bank.id,
					bank.epoch,
					bank.generation,
				).map((row) => row.nativeId)
			: [],
	);
	return memories.filter((row) => {
		const support = row.source_memory_ids ?? [];
		return (
			row.fact_type !== "observation" ||
			prior.has(row.id) ||
			!support.length ||
			!support.every((id) => pendingFacts.has(id))
		);
	});
}

function acceptedUpdates(
	tx: Tx,
	ctx: Context,
	sourceIds: string[],
	memories: NativeMemory[],
	actionId: string,
	originals: ActionIntentRecord["facts"],
) {
	actionFence(tx, ctx);
	for (const source of sourcesFor(ctx.row.bankId, sourceIds)) {
		const facts = memories
			.filter(
				(m) => m.fact_type !== "observation" && m.document_id === source.id,
			)
			.map((m) => ({ id: m.id, text: m.text }));
		// Exact old-text revocation survives later source re-extraction; saved intent handles new IDs.
		for (const old of originals.filter((f) => f.sourceId === source.id)) {
			const current = facts.find((f) => f.id === old.id);
			if (!current || current.text !== old.text)
				tx.insert(memoryRevocations)
					.values({
						id: randomUUID(),
						userId: ctx.row.userId,
						bankId: ctx.row.bankId,
						epoch: ctx.row.epoch,
						nativeFactId: old.id,
						nativeTextHash: memoryTextHash(old.text),
						actionId,
					})
					.run();
		}
		tx.update(memorySourceRevisions)
			.set({ state: "staged", acknowledgedFactsJson: JSON.stringify(facts) })
			.where(eq(memorySourceRevisions.id, source.id))
			.run();
	}
}
/** A rejected staged delta never becomes replay authority. Cleanup retries preserve that decision. */
export async function runMemoryAction(
	ctx: Context,
	client: HindsightClient,
	native: NativeSettlement,
	binding: NativeBinding,
	model?: CurationModel,
) {
	const read = () =>
		db
			.select()
			.from(memoryActions)
			.where(eq(memoryActions.id, ctx.row.actionId ?? ""))
			.get();
	const initial = read();
	const saved = initial ? parseActionIntent(initial.intentJson) : null;
	const cleanupWhileOff = async () => {
		if (
			initial?.kind !== "remove" ||
			!initial.exclusionAcknowledged ||
			!saved ||
			db
				.select({ enabled: users.memoryEnabled })
				.from(users)
				.where(eq(users.id, ctx.row.userId))
				.get()?.enabled !== false
		)
			return;
		// Acknowledged exclusion survives off. Only already-submitted dependency cleanup
		// may continue; no planner, patch reconstruction, replay or retain is permitted.
		await runDependencyRepair(ctx, client, native, {
			rootSourceIds: saved.sourceIds,
			memories: [],
			replay: async () => {
				throw new NativeMemoryError("memory_dependency_paused", true);
			},
		});
		throw new NativeMemoryError("memory_dependency_paused", true);
	};
	await cleanupWhileOff();
	try {
		if (initial?.kind === "edit" && saved?.rollbackPending) {
			await restoreCancelledEdit(ctx, client, native, initial, saved, model);
			return;
		}
		if (saved?.outcome === "rejected")
			throw new NativeMemoryError(
				saved.rejectionCode ?? "memory_edit_rejected",
				false,
			);
		// An older receipt can still hold a staged Edit after exhausting retries.
		// When reclaimed, compensate before applying that proposal again.
		if (
			countedDeliveryAttempt(ctx.row, ctx.attempt.number) >
				NATIVE_DELIVERY_ATTEMPT_LIMIT &&
			initial?.kind === "edit" &&
			initial.cleanupPending &&
			saved?.proposal &&
			!saved.outcome
		) {
			const previous = db
				.select({ code: memoryDeliveryAttempts.errorCode })
				.from(memoryDeliveryAttempts)
				.where(
					and(
						eq(memoryDeliveryAttempts.jobId, ctx.row.id),
						eq(memoryDeliveryAttempts.attemptNumber, ctx.attempt.number - 1),
					),
				)
				.get();
			if (previous?.code === collectiveRejection)
				throw new NativeMemoryError(collectiveRejection, false);
		}
		await executeMemoryAction(ctx, client, native, binding, model);
	} catch (error) {
		await cleanupWhileOff();
		const action = read();
		const intent = action ? parseActionIntent(action.intentJson) : null;
		if (intent?.rollbackPending) {
			// Enable may have rebound the durable job while the old attempt was
			// still settling. Requeue for the recovery handler, never the old Edit.
			throw new NativeMemoryError(
				saved?.rollbackPending && error instanceof NativeMemoryError
					? error.code
					: "memory_edit_restore_pending",
				true,
			);
		}
		const code =
			error instanceof NativeMemoryError
				? error.code
				: error instanceof Error
					? error.message
					: "memory_edit_invalid";
		const terminal =
			error instanceof NativeMemoryError
				? !error.retryable
				: (action?.kind === "edit" && action.cleanupPending) ||
					[
						"memory_edit_rejected",
						"memory_edit_invalid",
						"memory_edit_too_large",
					].includes(code);
		if (
			action?.kind === "edit" &&
			action.cleanupPending &&
			intent?.proposal &&
			!intent.outcome &&
			(terminal ||
				(code === collectiveRejection &&
					countedDeliveryAttempt(ctx.row, ctx.attempt.number) >=
						NATIVE_DELIVERY_ATTEMPT_LIMIT)) &&
			code !== "memory_control_changed" &&
			code !== "memory_cancelled"
		) {
			const rejected: ActionIntentRecord = {
				...intent,
				outcome: "rejected",
				rejectionCode: code,
				rollbackPending: true,
			};
			await saveIntent(ctx, action.id, rejected);
			try {
				await restoreCancelledEdit(
					ctx,
					client,
					native,
					action,
					rejected,
					model,
				);
				return;
			} catch (restoreError) {
				throw new NativeMemoryError(
					restoreError instanceof NativeMemoryError
						? restoreError.code
						: "memory_edit_restore_pending",
					true,
				);
			}
		}
		if (
			action &&
			intent?.addedSourceId &&
			terminal &&
			code !== "memory_control_changed" &&
			code !== "memory_cancelled"
		) {
			const rejected: ActionIntentRecord = {
				...intent,
				outcome: "rejected",
				rejectionCode: code,
			};
			await saveIntent(ctx, action.id, rejected);
			await ctx.write((tx) => {
				actionFence(tx, ctx);
				tx.update(memoryActions)
					.set({ cleanupPending: true })
					.where(eq(memoryActions.id, action.id))
					.run();
			});
			await client.deleteDocument(intent.addedSourceId);
			await native.settle(client, [await client.consolidate()], ctx.signal);
			const remaining = await native.capture(client, ctx.signal);
			if (remaining.some((m) => m.document_id === intent.addedSourceId))
				throw new NativeMemoryError("memory_rejected_cleanup_pending", true);
			await ctx.write((tx) => {
				const bank = actionFence(tx, ctx);
				tx.update(memorySourceRevisions)
					.set({ state: "revoked", acknowledgedFactsJson: "[]" })
					.where(eq(memorySourceRevisions.id, intent.addedSourceId ?? ""))
					.run();
				if (
					action.kind === "edit" &&
					action.generation &&
					action.generation === bank.generation
				)
					republishRenumberedNativeObservations(tx, {
						userId: action.userId,
						bankId: bank.id,
						epoch: bank.epoch,
						expectedRevision: bank.revision,
						generation: action.generation,
						actionId: action.id,
						memories: remaining,
					});
				tx.update(memoryActions)
					.set({ cleanupPending: false })
					.where(eq(memoryActions.id, action.id))
					.run();
			});
		}
		throw error;
	}
}

async function restoreCancelledEdit(
	ctx: Context,
	client: HindsightClient,
	native: NativeSettlement,
	action: typeof memoryActions.$inferSelect,
	intent: ActionIntentRecord,
	modelOverride?: CurationModel,
) {
	const readInventory = (tx: Tx) => {
		const bank = actionFence(tx, ctx);
		if (action.generation !== bank.generation || intent.facts.length > 100)
			throw new NativeMemoryError("memory_edit_restore_unavailable", true);
		const originals = sourcesFor(bank.id, intent.sourceIds);
		if (originals.length !== intent.sourceIds.length)
			throw new NativeMemoryError("memory_edit_restore_source_changed", true);
		const revocations = tx
			.select()
			.from(memoryRevocations)
			.where(
				and(
					eq(memoryRevocations.userId, ctx.row.userId),
					eq(memoryRevocations.bankId, bank.id),
					eq(memoryRevocations.epoch, bank.epoch),
					or(
						inArray(
							memoryRevocations.nativeFactId,
							intent.facts.map((f) => f.id),
						),
						inArray(memoryRevocations.sourceId, intent.sourceIds),
					),
				),
			)
			.all();
		const withdrawn = new Set(
			revocations.flatMap((row) => (row.sourceId ? [row.sourceId] : [])),
		);
		const rebuild = new Set<string>();
		for (const source of originals) {
			if (source.userId !== ctx.row.userId || source.epoch !== bank.epoch)
				throw new NativeMemoryError("memory_edit_restore_source_changed", true);
			if (withdrawn.has(source.id) && source.state === "revoked") continue;
			if (withdrawn.has(source.id))
				throw new NativeMemoryError("memory_edit_restore_source_changed", true);
			if (
				source.state === "repair_held" &&
				withdrawn.size &&
				source.acceptedGeneration === bank.generation
			) {
				assertMemorySourceCurrent(tx, source.id, ctx.row.userId, bank.id);
				rebuild.add(source.id);
			} else if (source.state !== "accepted")
				throw new NativeMemoryError("memory_edit_restore_source_changed", true);
			else if (source.messageId)
				assertMemoryCurationSourceCurrent(tx, source, bank);
		}
		const withdrawnFactIds = new Set(
			intent.facts
				.filter(
					(f) =>
						withdrawn.has(f.sourceId) ||
						revocations.some(
							(r) =>
								r.nativeFactId === f.id &&
								(!r.nativeTextHash ||
									r.nativeTextHash === memoryTextHash(f.text)),
						),
				)
				.map((f) => f.id),
		);
		return {
			bank,
			rebuild,
			withdrawn,
			withdrawnFactIds,
			sources: intent.sourceIds.filter(
				(id) => !withdrawn.has(id) && !rebuild.has(id),
			),
			facts: intent.facts.filter(
				(f) => !withdrawnFactIds.has(f.id) && !rebuild.has(f.sourceId),
			),
		};
	};
	const inventory = db.transaction(readInventory);
	const { bank } = inventory;
	const restoreFence = (tx: Tx) => {
		const current = readInventory(tx);
		if (
			current.sources.length !== inventory.sources.length ||
			current.sources.some((id) => !inventory.sources.includes(id)) ||
			current.rebuild.size !== inventory.rebuild.size ||
			[...current.rebuild].some((id) => !inventory.rebuild.has(id)) ||
			current.withdrawn.size !== inventory.withdrawn.size ||
			[...current.withdrawn].some((id) => !inventory.withdrawn.has(id)) ||
			current.withdrawnFactIds.size !== inventory.withdrawnFactIds.size ||
			[...current.withdrawnFactIds].some(
				(id) => !inventory.withdrawnFactIds.has(id),
			)
		)
			throw new NativeMemoryError("memory_edit_restore_source_changed", true);
	};
	await client.verifyConfig();
	const live = new Map(
		(await client.list())
			.filter((m) => m.fact_type !== "observation")
			.map((m) => [m.id, m]),
	);
	for (const old of inventory.facts) {
		const current = live.get(old.id);
		if (
			current
				? current.document_id !== old.sourceId
				: !(await client.matchesArchivedFact(old))
		)
			throw new NativeMemoryError("memory_edit_restore_unavailable", true);
		if (current?.text === old.text) continue;
		await fence(ctx);
		try {
			// Hindsight only edits live facts. Restore the archived fact by
			// state alone after verifying the archived text and source exactly.
			await client.editFact(
				old.id,
				current ? { text: old.text } : { state: "valid" },
				() =>
					db.transaction((tx) => {
						assertActionAttemptCurrent(tx, ctx);
						restoreFence(tx);
					}),
			);
		} catch (error) {
			if (
				error instanceof NativeMemoryError &&
				error.code === "native_not_found"
			)
				throw new NativeMemoryError("memory_edit_restore_unavailable", true);
			throw error;
		}
	}
	const delta = sourcesFor(
		bank.id,
		intent.addedSourceId ? [intent.addedSourceId] : [],
	)[0];
	if (
		delta?.nativeSubmitted &&
		!delta.nativeAcknowledged &&
		delta.nativeOperationId
	)
		await native.settle(
			client,
			[delta.nativeOperationId],
			ctx.signal,
			true,
			"retain",
		);
	if (intent.addedSourceId) {
		await fence(ctx);
		await client.deleteDocument(intent.addedSourceId);
	}
	await fence(ctx);
	await native.settle(client, [await client.consolidate()], ctx.signal);
	const restored = await native.capture(client, ctx.signal);
	try {
		verifySourceResult(
			restored,
			intent.sourceIds.filter((id) => !inventory.rebuild.has(id)),
			inventory.facts,
		);
	} catch {
		throw new NativeMemoryError("memory_edit_restore_readback", true);
	}
	if (
		restored.some(
			(m) => m.document_id === intent.addedSourceId && intent.addedSourceId,
		)
	)
		throw new NativeMemoryError("memory_edit_restore_incomplete", true);
	const model = guardedModel(ctx, modelOverride, restoreFence);
	const repair = await runDependencyRepair(ctx, client, native, {
		rootSourceIds: intent.sourceIds,
		verifiedRoots: new Map(inventory.sources.map((id) => [id, id])),
		withdrawnSourceIds: [...inventory.withdrawn],
		rebuildSourceIds: inventory.rebuild,
		memories: restored,
		compensate: true,
		replay: (replacement, original) =>
			replaySourceCuration(ctx, client, replacement, model, {
				replacesSourceId: original.id,
			}),
	});
	const withdrawnFactIds = new Set([
		...inventory.withdrawnFactIds,
		...repair.withdrawnFactIds,
	]);
	const hasWithdrawal =
		withdrawnFactIds.size > 0 || repair.withdrawnSourceIds.length > 0;
	await checkCandidate(
		ctx,
		{
			...repair,
			sourceIds: [...inventory.sources, ...repair.sourceIds],
			originalFacts: [
				...repair.originalFacts,
				...intent.facts.filter((fact) => !withdrawnFactIds.has(fact.id)),
			],
			withdrawnFactIds,
		},
		{
			before: hasWithdrawal ? "" : intent.before,
			after: hasWithdrawal ? "" : intent.before,
			intent: { forget: [], replace: [], preserve: [] },
			sourceAssertions: hasWithdrawal ? repair.sourceAssertions : undefined,
			withdrawnSourceIds: repair.withdrawnSourceIds,
			restorePrevious: true,
		},
		model,
	);
	await ctx.fail(
		{
			code: intent.rejectionCode ?? "memory_edit_cancelled",
			message: "The edit did not complete and prior Memory was restored.",
			retryable: false,
		},
		{
			apply: (tx) => {
				restoreFence(tx);
				repair.assertContextCurrent?.(tx);
				repair.apply(tx);
				publishNativeSnapshot(tx, {
					userId: action.userId,
					bankId: bank.id,
					epoch: bank.epoch,
					expectedRevision: bank.revision,
					memories: repair.memories,
					verifiedCuratedChanges: true,
					sourceIds: repair.sourceIds,
					checkedActionIds: [
						action.id,
						...repair.replays.map((r) => r.actionId),
					],
				});
				if (intent.addedSourceId)
					tx.update(memorySourceRevisions)
						.set({ state: "revoked", acknowledgedFactsJson: "[]" })
						.where(eq(memorySourceRevisions.id, intent.addedSourceId))
						.run();
				tx.update(memoryActions)
					.set({
						cleanupPending: false,
						intentJson: JSON.stringify({
							...intent,
							rollbackPending: false,
							outcome: "rejected",
						} satisfies ActionIntentRecord),
					})
					.where(eq(memoryActions.id, action.id))
					.run();
			},
		},
	);
}
function earlierOmissionFacts(
	tx: Tx,
	bank: typeof memoryBanks.$inferSelect,
	intent: ActionIntentRecord,
) {
	if (
		!intent.removalOnly ||
		intent.sourceIds.length !== 1 ||
		!intent.facts.length
	)
		return [];
	const selected = sourcesFor(bank.id, intent.sourceIds)[0];
	if (!selected || selected.eventId !== `manual:${selected.lineageId}`)
		return [];
	const acceptedEdit = tx
		.select()
		.from(memoryActions)
		.where(
			and(
				eq(memoryActions.id, selected.lineageId),
				eq(memoryActions.userId, bank.userId),
				eq(memoryActions.bankId, bank.id),
				eq(memoryActions.epoch, bank.epoch),
				eq(memoryActions.kind, "edit"),
			),
		)
		.get();
	if (!acceptedEdit) return [];
	const prior = parseActionIntent(acceptedEdit.intentJson);
	if (prior.outcome !== "accepted" || prior.addedSourceId !== selected.id)
		return [];
	const own = new Map(
		readAcknowledgedFacts(selected.acknowledgedFactsJson).map((fact) => [
			fact.id,
			fact.text,
		]),
	);
	const native = new Map(
		prior.nativeFacts?.map((fact) => [fact.id, fact.text]),
	);
	if (
		!intent.facts.every(
			(fact) =>
				fact.sourceId === selected.id &&
				own.get(fact.id) === fact.text &&
				native.get(fact.id) === fact.text,
		)
	)
		return [];
	const original = new Map(prior.facts.map((fact) => [fact.id, fact]));
	const retained = (prior.proposal ?? []).filter(
		(fact) => fact.text.trim() && original.has(fact.id),
	);
	if (!retained.length) return [];
	if (retained.length > 100 || prior.sourceIds.length > 64)
		throw new NativeMemoryError("memory_edit_too_large", false);
	const candidates = new Map(retained.map((fact) => [fact.id, fact.text]));
	const admitted = admittedNativeFacts(bank.userId, bank.id, tx).filter(
		(fact) =>
			candidates.get(fact.id) === fact.text &&
			original.get(fact.id)?.sourceId === fact.source.id &&
			prior.sourceIds.includes(fact.source.id),
	);
	const proofs = admitted
		.flatMap((fact) => {
			const assertedAt = fact.source.explicitEditAt ?? fact.source.assertedAt;
			if (assertedAt >= selected.assertedAt) return [];
			try {
				assertMemoryCurationSourceCurrent(tx, fact.source, bank);
			} catch {
				return [];
			}
			return [
				{
					id: fact.id,
					text: fact.text,
					sourceId: fact.source.id,
					assertion_at: assertedAt.toISOString(),
				},
			];
		})
		.sort((first, second) => first.id.localeCompare(second.id));
	const dated = new Map<string, string | null>();
	if (proofs.length) {
		const supported = new Map(proofs.map((fact) => [fact.id, fact.text]));
		for (const row of readPublishedMemory(
			bank.userId,
			bank.id,
			bank.generation ?? undefined,
			tx,
		)) {
			for (const fact of readAcknowledgedFacts(row.sourceFingerprintsJson)) {
				if (
					supported.get(fact.id) !== fact.text ||
					fact.mentionedAt === undefined
				)
					continue;
				if (dated.has(fact.id) && dated.get(fact.id) !== fact.mentionedAt)
					throw new NativeMemoryError("memory_edit_readback_mismatch", false);
				dated.set(fact.id, fact.mentionedAt);
			}
		}
	}
	return proofs.map((fact) => ({
		...fact,
		native_mentioned_at: dated.get(fact.id),
	}));
}

function removeSharedSupportObservations(
	tx: Tx,
	action: typeof memoryActions.$inferSelect,
	intent: ActionIntentRecord,
) {
	const rows = tx
		.select()
		.from(memoryPublishedRows)
		.where(
			and(
				eq(memoryPublishedRows.bankId, action.bankId),
				eq(memoryPublishedRows.epoch, action.epoch),
				eq(memoryPublishedRows.generation, action.generation ?? ""),
			),
		)
		.orderBy(memoryPublishedRows.nativeId)
		.all();
	const target = rows.find((row) => row.nativeId === action.rowId);
	if (!target) throw new NativeMemoryError("stale_memory", false);
	const originals = new Map(intent.facts.map((fact) => [fact.id, fact.text]));
	const targetIds = new Set(
		readAcknowledgedFacts(target.sourceFingerprintsJson)
			.filter((fact) => originals.get(fact.id) === fact.text)
			.map((fact) => fact.id),
	);
	const siblings = rows.flatMap((row) => {
		if (row.nativeId === target.nativeId) return [];
		const facts = readAcknowledgedFacts(row.sourceFingerprintsJson);
		// The prewrite model only sees the targeted raw facts. Do not let an
		// observation borrowing other evidence move that claim to those facts.
		if (
			!facts.length ||
			!facts.every(
				(fact) =>
					targetIds.has(fact.id) && originals.get(fact.id) === fact.text,
			)
		)
			return [];
		return [
			{
				id: row.nativeId,
				text: row.text,
				sourceFactIds: facts.map((f) => f.id),
			},
		];
	});
	if (
		siblings.length > 100 ||
		Buffer.byteLength(JSON.stringify([intent.before, siblings])) > 100000
	)
		throw new NativeMemoryError("memory_edit_too_large", false);
	return siblings;
}

function unsupportedEditFact(
	memories: NativeMemory[],
	sourceId: string,
	expected: ActionIntentRecord["nativeFacts"],
) {
	if (!expected?.length) return;
	const support = new Set<string>();
	for (const observation of memories) {
		if (observation.fact_type !== "observation") continue;
		if (!observation.source_memory_ids?.length) return;
		for (const id of observation.source_memory_ids) support.add(id);
	}
	const candidates = memories.filter(
		(fact) =>
			(fact.fact_type === "world" || fact.fact_type === "experience") &&
			fact.document_id === sourceId &&
			typeof fact.consolidated_at === "string" &&
			!!fact.consolidated_at &&
			!fact.consolidation_failed_at &&
			!support.has(fact.id) &&
			expected.some(
				(saved) =>
					saved.id === fact.id &&
					saved.text === fact.text &&
					saved.native_mentioned_at === (fact.mentioned_at ?? null),
			),
	);
	// A bounded repair is only qualified for one independently identified fact.
	if (candidates.length === 1) return candidates[0];
}

async function executeMemoryAction(
	ctx: Context,
	client: HindsightClient,
	native: NativeSettlement,
	binding: NativeBinding,
	modelOverride?: CurationModel,
) {
	const action = db
		.select()
		.from(memoryActions)
		.where(
			and(
				eq(memoryActions.id, ctx.row.actionId ?? ""),
				eq(memoryActions.userId, ctx.row.userId),
				eq(memoryActions.bankId, ctx.row.bankId),
			),
		)
		.get();
	if (!action) throw new NativeMemoryError("memory_action_missing", false);
	let intent = parseActionIntent(action.intentJson);
	const checkSources = (tx: Tx) => {
		if (action.kind === "add") return;
		const bank = assertMemoryBankFence(
			tx,
			ctx.row.userId,
			ctx.row.bankId,
			ctx.row.epoch,
		);
		const originals = sourcesFor(ctx.row.bankId, intent.sourceIds);
		if (
			originals.length !== intent.sourceIds.length ||
			originals.some(
				(source) =>
					source.userId !== ctx.row.userId ||
					source.epoch !== ctx.row.epoch ||
					source.state !== "accepted",
			)
		)
			throw new NativeMemoryError("memory_edit_source_withdrawn", false);
		for (const source of originals)
			if (source.messageId) assertMemoryCurationSourceCurrent(tx, source, bank);
		if (
			intent.omissionEarlierFingerprint &&
			memoryTextHash(JSON.stringify(earlierOmissionFacts(tx, bank, intent))) !==
				intent.omissionEarlierFingerprint
		)
			throw new NativeMemoryError("memory_edit_source_withdrawn", false);
	};
	const readSharedSupport = (tx: Tx) =>
		action.kind === "remove" && !intent.proposal
			? removeSharedSupportObservations(tx, action, intent)
			: [];
	const { bank, sharedSupportObservations } = db.transaction((tx) => {
		checkSources(tx);
		return {
			bank: actionFence(tx, ctx),
			sharedSupportObservations: readSharedSupport(tx),
		};
	});
	const model = guardedModel(ctx, modelOverride, (tx) => {
		checkSources(tx);
		if (
			action.kind === "remove" &&
			!intent.proposal &&
			JSON.stringify(readSharedSupport(tx)) !==
				JSON.stringify(sharedSupportObservations)
		)
			throw new NativeMemoryError("memory_dependency_source_changed", true);
	});
	if (
		action.kind === "edit" &&
		!intent.proposal &&
		bank.generation !== action.generation
	)
		throw new NativeMemoryError("stale_memory", false);
	await ensureConfiguredBank(ctx, client, binding, (tx) =>
		actionFence(tx, ctx),
	);
	let sourceIds = intent.sourceIds;
	let earlierFacts: ReturnType<typeof earlierOmissionFacts> = [];
	const verifyEarlierFacts = (memories: NativeMemory[]) => {
		for (const expected of earlierFacts) {
			const live = memories.find(
				(fact) => fact.id === expected.id && fact.fact_type !== "observation",
			);
			if (
				!live ||
				live.document_id !== expected.sourceId ||
				live.text !== expected.text ||
				(expected.native_mentioned_at !== undefined &&
					(live.mentioned_at ?? null) !== expected.native_mentioned_at)
			)
				throw new NativeMemoryError("memory_edit_readback_mismatch", false);
		}
	};
	if (action.kind === "add") {
		let source: Source | undefined;
		if (
			!(await ctx.write((tx) => {
				actionFence(tx, ctx);
				source = recordMemorySource({
					userId: action.userId,
					bankId: bank.id,
					epoch: bank.epoch,
					eventId: `manual:${action.id}`,
					conversationId: intent.originConversationId,
					lineageId: action.id,
					text: action.text ?? "",
					context:
						"Explicit user-authored memory. This is a user assertion, not assistant text.",
					assertedAt: action.createdAt,
				});
			}))
		)
			return;
		if (!source?.nativeOperationId) throw Error("memory_source_missing");
		const active = source;
		const operationId = source.nativeOperationId;
		intent = { ...intent, addedSourceId: active.id };
		await saveIntent(ctx, action.id, intent);
		if (
			!(await ctx.write((tx) => {
				actionFence(tx, ctx);
				tx.update(memorySourceRevisions)
					.set({ nativeSubmitted: true })
					.where(eq(memorySourceRevisions.id, active.id))
					.run();
			}))
		)
			return;
		const ids = active.nativeAcknowledged
			? []
			: await client.retain(
					{
						content: active.text,
						context: active.context,
						timestamp: active.assertedAt.toISOString(),
						document_id: active.id,
						tags: [active.id],
						metadata: { source_revision: active.id, manual_action: action.id },
					},
					operationId,
				);
		await native.settle(client, ids, ctx.signal, false, "retain");
		if (
			!(await ctx.write((tx) => {
				actionFence(tx, ctx);
				tx.update(memorySourceRevisions)
					.set({ nativeAcknowledged: true })
					.where(eq(memorySourceRevisions.id, active.id))
					.run();
			}))
		)
			return;
		sourceIds = [active.id];
		intent = { ...intent, sourceIds };
		await saveIntent(ctx, action.id, intent);
	} else {
		if (!intent.plan) {
			const plan = await planMemoryEdit(
				intent.before,
				action.text ?? "",
				model,
				sharedSupportObservations,
			);
			intent = {
				...intent,
				plan,
				// A staged draft from a prior attempt must still be checked or cleaned.
				removalOnly:
					action.kind === "edit" &&
					!intent.addedSourceId &&
					plan.forget.length > 0 &&
					plan.replace.length === 0,
			};
			await saveIntent(ctx, action.id, intent);
		}
		if (action.kind === "edit" && intent.removalOnly) {
			earlierFacts = db.transaction((tx) =>
				earlierOmissionFacts(tx, actionFence(tx, ctx), intent),
			);
			if (earlierFacts.length) {
				if (intent.proposal && !intent.omissionEarlierFingerprint)
					throw new NativeMemoryError("memory_edit_rejected", false);
				intent = {
					...intent,
					omissionEarlierFingerprint: memoryTextHash(
						JSON.stringify(earlierFacts),
					),
				};
			}
		}
		if (action.kind === "edit" && !intent.removalOnly) {
			let assertion: Source | undefined;
			if (
				!(await ctx.write((tx) => {
					actionFence(tx, ctx);
					assertion = recordMemorySource({
						userId: action.userId,
						bankId: bank.id,
						epoch: bank.epoch,
						eventId: `manual:${action.id}`,
						conversationId: intent.originConversationId,
						lineageId: action.id,
						text: action.text ?? "",
						context: EXPLICIT_EDIT_RETENTION_GUIDANCE,
						assertedAt: action.createdAt,
					});
				}))
			)
				return;
			if (!assertion?.nativeOperationId) throw Error("memory_source_missing");
			const current = assertion;
			const editOperationId = assertion.nativeOperationId;
			intent = { ...intent, addedSourceId: current.id };
			await saveIntent(ctx, action.id, intent);
			if (
				!(await ctx.write((tx) => {
					actionFence(tx, ctx);
					tx.update(memorySourceRevisions)
						.set({ nativeSubmitted: true })
						.where(eq(memorySourceRevisions.id, current.id))
						.run();
				}))
			)
				return;
			const operations = current.nativeAcknowledged
				? []
				: await client.retain(
						{
							content: JSON.stringify({
								kind: "source_edit",
								before: intent.before,
								after: action.text,
								original_asserted_at: new Date(
									Math.min(
										...sourcesFor(bank.id, intent.sourceIds).map((s) =>
											s.assertedAt.getTime(),
										),
									),
								).toISOString(),
								explicit_edit_at: action.createdAt.toISOString(),
							}),
							context: current.context,
							timestamp: action.createdAt.toISOString(),
							document_id: current.id,
							tags: [current.id],
							metadata: {
								source_revision: current.id,
								manual_action: action.id,
							},
						},
						editOperationId,
					);
			await native.settle(client, operations, ctx.signal, false, "retain");
			if (
				!(await ctx.write((tx) => {
					actionFence(tx, ctx);
					tx.update(memorySourceRevisions)
						.set({ nativeAcknowledged: true })
						.where(eq(memorySourceRevisions.id, current.id))
						.run();
				}))
			)
				return;
			intent = { ...intent, addedSourceId: current.id };
			await saveIntent(ctx, action.id, intent);
			sourceIds = [...sourceIds, current.id];
		}
		if (!intent.proposal) {
			// The retained replacement can enqueue native consolidation after its
			// retain receipt settles. Let that same-bank work finish before the
			// proposal competes with it for the shared inference budget.
			const current =
				action.kind === "edit" && intent.addedSourceId
					? await native.capture(client, ctx.signal)
					: await client.list();
			verifyEarlierFacts(current);
			const sourceDates = new Map(
				sourcesFor(bank.id, sourceIds).map((source) => [
					source.id,
					(source.explicitEditAt ?? source.assertedAt).toISOString(),
				]),
			);
			const timing = (sourceId: string, fact: NativeMemory) => ({
				assertion_at: sourceDates.get(sourceId),
				native_mentioned_at: fact.mentioned_at ?? null,
			});
			const addedSourceId = intent.addedSourceId;
			const newFacts = addedSourceId
				? current
						.filter(
							(m) =>
								m.fact_type !== "observation" &&
								m.document_id === addedSourceId,
						)
						.map((fact) => ({
							id: fact.id,
							text: fact.text,
							...timing(addedSourceId, fact),
						}))
				: undefined;
			const facts = intent.facts.map((f) => {
				const live = current.find((m) => m.id === f.id);
				if (!live || live.text !== f.text || live.document_id !== f.sourceId)
					throw new NativeMemoryError("stale_memory", false);
				return {
					id: f.id,
					text: f.text,
					...(newFacts?.length || earlierFacts.length
						? timing(f.sourceId, live)
						: {}),
				};
			});
			intent = {
				...intent,
				nativeFacts: newFacts,
				proposal: await applyMemoryEdit(
					{
						before: intent.before,
						after: action.text ?? "",
						intent: requirePlan(intent),
						facts,
						removalOnly: intent.removalOnly,
						newFacts,
						earlierPreservedFacts: earlierFacts,
						sharedSupportObservations,
						verifyNewAssertionTiming: action.kind === "edit",
					},
					model,
				),
			};
			await saveIntent(ctx, action.id, intent);
		}
		if (!intent.proposal) throw Error("memory_action_corrupt");
		if (
			action.kind === "edit" &&
			intent.nativeFacts?.some((fact) => !fact.assertion_at)
		)
			throw new NativeMemoryError("memory_edit_invalid", false);
		if (
			action.kind === "edit" &&
			!(await ctx.write((tx) => {
				actionFence(tx, ctx);
				tx.update(memoryActions)
					.set({ cleanupPending: true })
					.where(eq(memoryActions.id, action.id))
					.run();
			}))
		)
			return;
		await patch(
			ctx,
			client,
			intent.proposal,
			checkSources,
			undefined,
			new Map(intent.facts.map((fact) => [fact.id, fact.sourceId])),
			verifyEarlierFacts,
		);
	}
	await fence(ctx);
	await native.settle(client, [await client.consolidate()], ctx.signal);
	let memories = await native.capture(client, ctx.signal);
	const validateReadback = () => {
		verifyEarlierFacts(memories);
		if (intent.nativeFacts && intent.addedSourceId)
			verifyFixedNativeFacts(
				memories,
				intent.addedSourceId,
				intent.nativeFacts,
			);
		if (intent.proposal)
			verifySourceResult(memories, sourceIds, [
				...intent.proposal,
				...(intent.nativeFacts ?? []),
			]);
	};
	validateReadback();
	const addedSourceId = intent.addedSourceId;
	if (
		action.kind === "edit" &&
		addedSourceId &&
		intent.plan?.replace.length &&
		!intent.removalOnly &&
		!intent.observationResetFactId
	) {
		const target = unsupportedEditFact(
			memories,
			addedSourceId,
			intent.nativeFacts,
		);
		if (target) {
			const assertCurrent = (tx: Tx, expectedReset?: string) => {
				assertActionAttemptCurrent(tx, ctx);
				const current = actionFence(tx, ctx);
				checkSources(tx);
				const source = assertMemorySourceCurrent(
					tx,
					addedSourceId,
					bank.userId,
					bank.id,
				);
				const saved = parseActionIntent(
					tx
						.select({ intentJson: memoryActions.intentJson })
						.from(memoryActions)
						.where(eq(memoryActions.id, action.id))
						.get()?.intentJson ?? null,
				);
				if (
					current.revision !== bank.revision ||
					source.epoch !== bank.epoch ||
					source.controlRevision !== ctx.row.controlRevision ||
					source.state !== "pending" ||
					!source.nativeSubmitted ||
					!source.nativeAcknowledged ||
					source.eventId !== `manual:${action.id}` ||
					source.text !== action.text ||
					source.assertedAt.getTime() !== action.createdAt.getTime() ||
					saved.addedSourceId !== addedSourceId ||
					saved.rollbackPending ||
					saved.outcome ||
					saved.observationResetFactId !== expectedReset ||
					!saved.nativeFacts?.some(
						(fact) =>
							fact.id === target.id &&
							fact.text === target.text &&
							fact.assertion_at === source.assertedAt.toISOString() &&
							fact.native_mentioned_at === (target.mentioned_at ?? null),
					)
				)
					throw new NativeMemoryError("memory_candidate_curation_drift", true);
			};
			const marked = { ...intent, observationResetFactId: target.id };
			if (
				!(await ctx.write((tx) => {
					assertCurrent(tx);
					tx.update(memoryActions)
						.set({ intentJson: JSON.stringify(marked) })
						.where(eq(memoryActions.id, action.id))
						.run();
				}))
			)
				throw new NativeMemoryError("memory_cancelled", false);
			intent = marked;
			const beforeDispatch = () =>
				db.transaction((tx) => assertCurrent(tx, target.id));
			await client.resetUnsupportedFactObservations(target.id, beforeDispatch);
			await native.settle(
				client,
				[await client.consolidate(beforeDispatch)],
				ctx.signal,
			);
			memories = await native.capture(client, ctx.signal);
			validateReadback();
		}
	}
	if (
		action.kind === "add" &&
		!memories.some(
			(m) =>
				m.fact_type !== "observation" &&
				sourceIds.includes(m.document_id ?? ""),
		)
	)
		throw new NativeMemoryError("memory_no_facts", false);
	const repaired =
		action.kind !== "add"
			? await runDependencyRepair(ctx, client, native, {
					rootSourceIds: intent.sourceIds,
					verifiedRoots: new Map(intent.sourceIds.map((id) => [id, id])),
					memories,
					replay: (replacement, original) =>
						replaySourceCuration(ctx, client, replacement, model, {
							replacesSourceId: original.id,
						}),
				})
			: null;
	if (repaired) {
		memories = repaired.memories;
		verifyEarlierFacts(memories);
		sourceIds = [...new Set([...sourceIds, ...repaired.sourceIds])];
		await checkCandidate(
			ctx,
			{
				memories,
				sourceIds: [...sourceIds, ...earlierFacts.map((fact) => fact.sourceId)],
				originalFacts: [
					...intent.facts,
					...repaired.originalFacts,
					...earlierFacts,
				],
				sourceAssertions: repaired.sourceAssertions,
				assertContextCurrent: repaired.assertContextCurrent,
				withdrawnSourceIds: repaired.withdrawnSourceIds,
				replays: repaired.replays.length
					? [
							...repaired.replays,
							{
								actionId: action.id,
								revision: intent.revision ?? 0,
								actionAt: action.createdAt.getTime(),
								sources: sourceIds,
								originals: intent.facts,
								before: intent.before,
								after: action.text ?? "",
								intent: requirePlan(intent),
							},
						]
					: undefined,
			},
			{
				before: intent.before,
				after: action.text ?? "",
				intent: requirePlan(intent),
				removalOnly: intent.removalOnly,
				...(action.kind === "remove" &&
				(repaired.sourceAssertions.length || repaired.withdrawnSourceIds.length)
					? {
							sourceAssertions: repaired.sourceAssertions,
							withdrawnSourceIds: repaired.withdrawnSourceIds,
						}
					: {}),
			},
			model,
		);
	}
	const prepared = prepareNativeSnapshot(memories);
	const relevant = memories.filter(
		(m) =>
			m.fact_type === "observation" &&
			(m.source_memory_ids ?? []).some((id) =>
				memories.some(
					(f) => f.id === id && sourceIds.includes(f.document_id ?? ""),
				),
			),
	);
	if (action.kind === "add" && relevant.length === 0)
		throw new NativeMemoryError("memory_no_observations", false);
	const verifiedCuratedDiff =
		action.kind === "add" && intent.addedSourceId
			? await verifyNewAssertionCuration(
					ctx,
					intent.addedSourceId,
					memories,
					prepared,
					modelOverride,
				)
			: undefined;
	await ctx.succeed({
		apply: (tx) => {
			actionFence(tx, ctx);
			checkSources(tx);
			verifiedCuratedDiff?.assertCurrent(tx);
			repaired?.assertContextCurrent?.(tx);
			repaired?.apply(tx);
			const publicationMemories =
				action.kind === "remove"
					? removalPublicationSnapshot(tx, action, bank, sourceIds, memories)
					: memories;
			acceptedUpdates(tx, ctx, sourceIds, memories, action.id, intent.facts);
			const generation = publishNativeSnapshot(tx, {
				userId: action.userId,
				bankId: bank.id,
				epoch: bank.epoch,
				expectedRevision: bank.revision,
				memories: publicationMemories,
				prepared,
				sourceIds,
				verifiedCuratedChanges: !!repaired,
				verifiedCuratedDiff,
				checkedActionIds: [
					action.id,
					...(repaired?.replays.map((r) => r.actionId) ?? []),
				],
			});
			const editResult =
				action.kind === "edit"
					? publishedEditResult(tx, action, intent, generation)
					: null;
			tx.update(memoryActions)
				.set({
					intentJson: JSON.stringify({
						...intent,
						resultGeneration: generation,
						resultSupport: editResult?.support,
						resultPresentation: editResult?.presentation,
						resultOriginSourceIds: editResult?.originSourceIds,
						resultRows: intent.addedSourceId
							? manualPublicationReceipts(
									tx,
									bank.id,
									bank.epoch,
									generation,
									memories,
									intent.addedSourceId,
								)
							: undefined,
						outcome: "accepted",
					}),
					resultRowId:
						editResult?.rowId ??
						(action.kind === "add" && relevant.length === 1
							? (relevant[0]?.id ?? null)
							: null),
					cleanupPending: false,
				})
				.where(eq(memoryActions.id, action.id))
				.run();
		},
	});
}

/** Only send a changed, known curated family when the incoming assertion actually backs its candidate. */
export async function verifyNewAssertionCuration(
	ctx: Context,
	sourceId: string,
	memories: NativeMemory[],
	prepared: Map<string, string>,
	modelOverride?: CurationModel,
) {
	const { changes, source, bank } = db.transaction((tx) => {
		const bank = actionFence(tx, ctx);
		return {
			bank,
			changes: curatedObservationChanges(
				tx,
				bank,
				memories,
				prepared,
				sourceId,
			),
			source: sourcesFor(bank.id, [sourceId])[0],
		};
	});
	if (!changes.length) return undefined;
	const assertedAt = source?.explicitEditAt ?? source?.assertedAt;
	if (
		!source ||
		!assertedAt ||
		changes.some(
			({ facts, previous }) =>
				!facts.some((fact) => fact.document_id === source.id) ||
				previous.some(({ row }) => assertedAt <= row.updatedAt),
		)
	)
		throw new NativeMemoryError("memory_candidate_curation_drift", true);
	const previous = [...new Set(changes.flatMap((change) => change.previous))];
	const facts = new Map(
		changes
			.flatMap((change) => change.facts)
			.map(({ id, text, document_id }) => [
				id,
				{ id, text, sourceId: document_id },
			]),
	);
	const comparedIds = new Set([
		...previous.flatMap(({ facts }) => facts.map(({ id }) => id)),
		...facts.keys(),
	]);
	const verifiedSources = new Set([sourceId]);
	const assertCurrent = (tx: Tx) => {
		const current = actionFence(tx, ctx);
		const live = sourcesFor(current.id, [sourceId])[0];
		if (
			current.revision !== bank.revision ||
			!live ||
			live.userId !== ctx.row.userId ||
			live.epoch !== ctx.row.epoch ||
			live.textHash !== source.textHash ||
			live.state === "revoked" ||
			(live.explicitEditAt ?? live.assertedAt).getTime() !==
				assertedAt.getTime() ||
			(ctx.row.kind === "source"
				? ctx.row.sourceId !== live.id
				: live.eventId !== `manual:${ctx.row.actionId}`)
		)
			throw new NativeMemoryError("memory_candidate_curation_drift", true);
		assertComparisonSourcesCurrent(
			tx,
			ctx,
			current,
			comparedIds,
			verifiedSources,
		);
	};
	const model = guardedModel(ctx, modelOverride, assertCurrent);
	await checkMemoryEdit(
		{
			before: "",
			after: "",
			intent: { forget: [], replace: [], preserve: [] },
			newAssertion: {
				sourceId,
				text: source.text,
				assertedAt: assertedAt.toISOString(),
			},
			originalFacts: [
				...new Map(
					previous
						.flatMap(({ facts }) => facts)
						.map(({ id, text }) => [id, { id, text }]),
				).values(),
			],
			proposedFacts: [...facts.values()],
			observations: changes.map(({ observation, text }) => ({
				id: observation.id,
				text,
				sourceFactIds: observation.source_memory_ids,
			})),
			previousObservations: previous.map(({ row, facts }) => ({
				id: row.nativeId,
				text: row.text,
				sourceFactIds: facts.map(({ id }) => id),
			})),
		},
		model,
	);
	return {
		sourceId,
		proofs: new Set(changes.map(({ proof }) => proof)),
		assertCurrent,
	};
}

function sourceCurationActions(
	source: Source,
	replacesSourceId?: string,
	followPredecessors = false,
) {
	const identities = new Set([source.id]);
	if (replacesSourceId) identities.add(replacesSourceId);
	let ancestor = replacesSourceId ?? source.predecessorSourceId;
	while (followPredecessors && ancestor) {
		if (identities.size > 64)
			throw new NativeMemoryError("memory_edit_too_large", false);
		const original = sourcesFor(source.bankId, [ancestor])[0];
		if (
			!original ||
			original.userId !== source.userId ||
			original.epoch !== source.epoch ||
			original.lineageId !== source.lineageId ||
			original.conversationId !== source.conversationId
		)
			break;
		identities.add(ancestor);
		ancestor = original.predecessorSourceId;
		if (ancestor && identities.has(ancestor))
			throw new NativeMemoryError("memory_predecessor_invalid", false);
	}
	return db
		.select({ action: memoryActions, order: sql<number>`rowid` })
		.from(memoryActions)
		.where(
			and(
				eq(memoryActions.bankId, source.bankId),
				eq(memoryActions.userId, source.userId),
				eq(memoryActions.epoch, source.epoch),
			),
		)
		.all()
		.flatMap(({ action, order }) => {
			if (!action.intentJson || action.kind === "add") return [];
			const intent = parseActionIntent(action.intentJson);
			if (intent.outcome !== "accepted" && !action.exclusionAcknowledged)
				return [];
			return [...identities].some(
				(id) =>
					id &&
					(intent.sourceIds.includes(id) ||
						intent.addedSourceId === id ||
						(action.kind === "source_edit" &&
							intent.request.kind !== "add" &&
							intent.request.ref.rowId === id)),
			)
				? [{ action, intent, order }]
				: [];
		})
		.sort((a, b) => {
			const dateOrder =
				a.action.createdAt.getTime() - b.action.createdAt.getTime();
			return a.intent.replayOrder !== undefined ||
				b.intent.replayOrder !== undefined
				? dateOrder ||
						(a.intent.replayOrder ?? a.order) -
							(b.intent.replayOrder ?? b.order)
				: (a.intent.revision ?? 0) - (b.intent.revision ?? 0) || dateOrder;
		});
}

function recordedActionSources(intent: ActionIntentRecord) {
	return new Set([
		...intent.sourceIds,
		...intent.facts.map((fact) => fact.sourceId),
		...(intent.addedSourceId ? [intent.addedSourceId] : []),
	]);
}

function assertReplaySources(
	tx: Tx,
	bank: typeof memoryBanks.$inferSelect,
	recorded: ReadonlySet<string>,
	verifiedOwners: ReadonlySet<string>,
) {
	if (recorded.size > 64)
		throw new NativeMemoryError("memory_edit_too_large", false);
	for (const id of recorded) {
		if (verifiedOwners.has(id)) continue;
		const source = tx
			.select()
			.from(memorySourceRevisions)
			.where(eq(memorySourceRevisions.id, id))
			.get();
		if (!source || source.bankId !== bank.id || source.state !== "accepted")
			throw new NativeMemoryError("memory_edit_source_withdrawn", true);
		try {
			assertMemoryCurationSourceCurrent(tx, source, bank);
		} catch {
			throw new NativeMemoryError("memory_edit_source_withdrawn", true);
		}
	}
}
/** A null result authorizes the first retain of a previously unsubmitted assertion. */
export function unchangedSourceInventory(
	tx: Tx,
	source: Source,
	predecessor: Source,
) {
	const bank = assertMemoryBankFence(
		tx,
		source.userId,
		source.bankId,
		source.epoch,
	);
	const prior = source.state === "accepted" ? source : predecessor;
	if (
		prior.messageId &&
		prior.state === "revoked" &&
		!isEditResendWithdrawal(prior)
	)
		throw new NativeMemoryError("memory_unchanged_source_unverified", true);
	const facts = readAcknowledgedFacts(prior.acknowledgedFactsJson);
	const acceptedHere =
		prior.state === "accepted" ||
		(prior.acceptedGeneration !== null &&
			(prior.acceptedGeneration === bank.generation ||
				prior.acceptedGeneration === bank.previousGeneration));
	// A prepared source can contain unaccepted native facts. The accepted
	// generation is authority for a revoked predecessor, even after its chat row is gone.
	const hasAcceptedEvidence =
		!acceptedHere &&
		facts.length > 0 &&
		bank.generation &&
		tx
			.select({ facts: memoryPublishedRows.sourceFingerprintsJson })
			.from(memoryPublishedRows)
			.where(
				and(
					eq(memoryPublishedRows.bankId, bank.id),
					eq(memoryPublishedRows.generation, bank.generation),
				),
			)
			.all()
			.some((row) =>
				readAcknowledgedFacts(row.facts).some((f) =>
					facts.some((prior) => prior.id === f.id && prior.text === f.text),
				),
			);
	if (!acceptedHere && !hasAcceptedEvidence) {
		if (
			!prior.nativeSubmitted &&
			!prior.nativeAcknowledged &&
			!prior.acceptedGeneration &&
			!facts.length &&
			!sourceCurationActions(source, predecessor.id, true).length
		)
			return null;
		throw new NativeMemoryError("memory_unchanged_source_unverified", true);
	}
	const previousOwners = carriedMemorySources(tx, prior, bank) ?? [
		prior,
		...[...memorySourcePredecessors(tx, prior)].filter(
			(owner) =>
				owner.state === "accepted" &&
				owner.acceptedGeneration === bank.generation,
		),
	];
	const priorLineage = [
		prior.id,
		...[...memorySourcePredecessors(tx, prior)].map((owner) => owner.id),
		...previousOwners.map((owner) => owner.id),
	];
	const actionOwners = acceptedCorrectionSources(tx, bank, priorLineage);
	const owners = [
		...new Map(
			[...previousOwners, ...actionOwners].map((owner) => [owner.id, owner]),
		).values(),
	].filter(
		(owner) =>
			owner.nativeSubmitted ||
			readAcknowledgedFacts(owner.acknowledgedFactsJson).length,
	);
	const originalFacts = owners.flatMap((owner) =>
		readAcknowledgedFacts(owner.acknowledgedFactsJson).map((fact) => ({
			...fact,
			sourceId: owner.id,
		})),
	);
	const revoked = tx
		.select()
		.from(memoryRevocations)
		.where(
			and(
				eq(memoryRevocations.bankId, bank.id),
				eq(memoryRevocations.epoch, bank.epoch),
				or(
					inArray(
						memoryRevocations.nativeFactId,
						originalFacts.map((f) => f.id),
					),
					inArray(
						memoryRevocations.sourceId,
						owners.filter((s) => s.id !== prior.id).map((s) => s.id),
					),
				),
			),
		)
		.all();
	if (revoked.some((row) => row.sourceId))
		throw new NativeMemoryError("memory_unchanged_source_unverified", true);
	const authorized = originalFacts.filter(
		(f) =>
			!revoked.some(
				(r) =>
					r.nativeFactId === f.id &&
					(!r.nativeTextHash || r.nativeTextHash === memoryTextHash(f.text)),
			),
	);
	if (
		owners.length > 64 ||
		authorized.length > 100 ||
		JSON.stringify(authorized).length > 100000
	)
		throw new NativeMemoryError("memory_edit_too_large", false);
	return { owners, facts: authorized };
}

export function prepareUnchangedSourceCuration(
	ctx: Context,
	source: Source,
	predecessor: Source,
	accepted: NonNullable<ReturnType<typeof unchangedSourceInventory>>,
) {
	const sourceIds = accepted.owners.map((owner) => owner.id);
	function verify(memories: NativeMemory[]) {
		try {
			verifySourceResult(memories, sourceIds, accepted.facts);
			const raw = new Map(
				memories
					.filter((fact) => fact.fact_type !== "observation")
					.map((fact) => [fact.id, fact]),
			);
			if (
				accepted.facts.some(
					(fact) => raw.get(fact.id)?.document_id !== fact.sourceId,
				)
			)
				throw new Error("memory_unchanged_source_owner_mismatch");
		} catch {
			throw new NativeMemoryError("memory_unchanged_source_fact_missing", true);
		}
	}
	function verifyUnchangedDisplay(
		tx: Tx,
		memories: NativeMemory[],
		dependencyChanged: boolean,
	) {
		const bank = actionFence(tx, ctx);
		if (!bank.generation) return;
		const raw = new Map(
			memories
				.filter((fact) => fact.fact_type !== "observation")
				.map((fact) => [fact.id, fact]),
		);
		const acceptedIds = new Set(accepted.facts.map((fact) => fact.id));
		const previous = tx
			.select()
			.from(memoryPublishedRows)
			.where(
				and(
					eq(memoryPublishedRows.bankId, bank.id),
					eq(memoryPublishedRows.epoch, bank.epoch),
					eq(memoryPublishedRows.generation, bank.generation),
				),
			)
			.all();
		const prepared = prepareNativeSnapshot(memories);
		const observations = memories.filter(
			(observation) =>
				observation.fact_type === "observation" &&
				observation.source_memory_ids?.some((id) => acceptedIds.has(id)),
		);
		for (const row of previous) {
			const support = readAcknowledgedFacts(row.sourceFingerprintsJson);
			if (!support.some((fact) => acceptedIds.has(fact.id))) continue;
			if (
				support.some(
					(fact) =>
						acceptedIds.has(fact.id) &&
						fact.mentionedAt !== undefined &&
						fact.mentionedAt !== (raw.get(fact.id)?.mentioned_at ?? null),
				)
			)
				throw new NativeMemoryError(
					"memory_unchanged_source_fact_missing",
					true,
				);
			if (dependencyChanged) continue;
			const match = observations.findIndex(
				(observation) =>
					observation.text === row.nativeText &&
					prepared.get(observation.id) === row.text &&
					observation.source_memory_ids?.length === support.length &&
					support.every(
						(fact) =>
							observation.source_memory_ids?.includes(fact.id) &&
							raw.get(fact.id)?.text === fact.text,
					),
			);
			if (match === -1)
				throw new NativeMemoryError(
					"memory_unchanged_source_fact_missing",
					true,
				);
			observations.splice(match, 1);
		}
		if (!dependencyChanged && observations.length)
			throw new NativeMemoryError("memory_unchanged_source_fact_missing", true);
	}
	function assertCurrent(tx: Tx) {
		const old = tx
			.select()
			.from(memorySourceRevisions)
			.where(eq(memorySourceRevisions.id, predecessor.id))
			.get();
		if (!old || old.textHash !== predecessor.textHash)
			throw new NativeMemoryError("memory_unchanged_source_unverified", true);
		const current = unchangedSourceInventory(tx, source, old);
		if (
			JSON.stringify(current?.facts) !== JSON.stringify(accepted.facts) ||
			JSON.stringify(current?.owners.map((owner) => owner.id)) !==
				JSON.stringify(sourceIds)
		)
			throw new NativeMemoryError("memory_unchanged_source_unverified", true);
	}
	const verifiedOwners = new Set([source.id, predecessor.id, ...sourceIds]);
	const checks: ReplayCheck[] = sourceCurationActions(
		source,
		predecessor.id,
		true,
	).map(({ action, intent, order }) => ({
		actionId: action.id,
		revision: intent.revision ?? 0,
		actionAt: action.createdAt.getTime(),
		actionOrder: order,
		replayOrder: intent.replayOrder,
		sources: sourceIds,
		originals: [],
		before: intent.before,
		after: action.text ?? "",
		intent: requirePlan(intent),
		assertProvenance: (tx) => {
			const bank = actionFence(tx, ctx);
			assertCurrent(tx);
			assertReplaySources(
				tx,
				bank,
				recordedActionSources(intent),
				verifiedOwners,
			);
		},
	}));
	return {
		sourceIds,
		checks,
		verify,
		assertCurrent,
		verifyDependencies: async (result: CandidateCheck) => {
			verify(result.memories);
			const dependencyChanged = Boolean(
				result.sourceIds.length || result.replays?.length,
			);
			db.transaction((tx) =>
				verifyUnchangedDisplay(tx, result.memories, dependencyChanged),
			);
			if (!dependencyChanged) return;
			await checkCandidate(
				ctx,
				{
					...result,
					sourceIds: [...sourceIds, ...result.sourceIds],
					originalFacts: [...accepted.facts, ...result.originalFacts],
					replays: [...checks, ...(result.replays ?? [])],
				},
				{
					before: "",
					after: "",
					intent: { forget: [], replace: [], preserve: [] },
					restorePrevious: true,
				},
				guardedModel(ctx),
			);
		},
		apply: (tx: Tx, memories: NativeMemory[]) => {
			verify(memories);
			assertCurrent(tx);
			for (const owner of accepted.owners) {
				if (owner.id !== predecessor.id) continue;
				tx.update(memorySourceRevisions)
					.set({ state: "staged" })
					.where(eq(memorySourceRevisions.id, owner.id))
					.run();
				tx.delete(memoryRevocations)
					.where(
						and(
							eq(memoryRevocations.userId, source.userId),
							eq(memoryRevocations.bankId, source.bankId),
							eq(memoryRevocations.epoch, source.epoch),
							eq(memoryRevocations.sourceId, owner.id),
						),
					)
					.run();
			}
			tx.update(memorySourceRevisions)
				.set({
					context: JSON.stringify({
						...parseJsonRecord(source.context),
						carriedSourceIds: sourceIds,
					}),
				})
				.where(eq(memorySourceRevisions.id, source.id))
				.run();
		},
	};
}

/** Apply only saved actions bound to this old source; a genuinely new assertion never inherits a topic ban. */
export async function replaySourceCuration(
	ctx: Context,
	client: HindsightClient,
	source: Source,
	modelOverride?: CurationModel,
	options?: { replacesSourceId: string },
) {
	const actions = sourceCurationActions(source, options?.replacesSourceId);
	const expected = new Map<string, string>();
	const checkedSources = new Set<string>();
	const updates: Array<{
		sourceIds: string[];
		actionId: string;
		originals: ActionIntentRecord["facts"];
		intent: ActionIntentRecord;
	}> = [];
	const checks: ReplayCheck[] = [];
	for (const entry of actions) {
		const { action } = entry;
		let { intent } = entry;
		const recordedIds = recordedActionSources(intent);
		const assertProvenance = (tx: Tx) => {
			const bank = actionFence(tx, ctx);
			const current = assertMemorySourceCurrent(
				tx,
				source.id,
				bank.userId,
				bank.id,
			);
			const equivalent = new Set([current.id]);
			for (const prior of memorySourcePredecessors(tx, current)) {
				if (prior.textHash !== current.textHash) break;
				if (equivalent.size >= 64)
					throw new NativeMemoryError("memory_edit_too_large", false);
				equivalent.add(prior.id);
			}
			if (options && !equivalent.has(options.replacesSourceId))
				throw new NativeMemoryError("memory_predecessor_invalid", false);
			assertReplaySources(tx, bank, recordedIds, equivalent);
		};
		const model = guardedModel(ctx, modelOverride, assertProvenance);
		if (!intent.plan) {
			intent = {
				...intent,
				plan: await planMemoryEdit(intent.before, action.text ?? "", model),
			};
			await saveIntent(ctx, action.id, intent);
		}
		const mappedIds = intent.sourceIds.map((id) =>
			id === options?.replacesSourceId ? source.id : id,
		);
		if (options?.replacesSourceId) {
			intent = {
				...intent,
				sourceIds: [...new Set([...intent.sourceIds, ...mappedIds])],
				addedSourceId:
					intent.addedSourceId === options.replacesSourceId
						? source.id
						: intent.addedSourceId,
			};
			if (
				action.kind === "source_edit" &&
				intent.request.kind !== "add" &&
				intent.request.ref.rowId === options.replacesSourceId
			)
				intent = {
					...intent,
					request: {
						...intent.request,
						ref: { ...intent.request.ref, rowId: source.id },
					},
				};
		}
		const permitted = sourcesFor(source.bankId, mappedIds)
			.filter((s) => s.state === "accepted" || s.id === source.id)
			.map((s) => s.id);
		const live = await client.list();
		const originals = live
			.filter(
				(m) =>
					m.fact_type !== "observation" &&
					permitted.includes(m.document_id ?? ""),
			)
			.map((m) => ({ id: m.id, text: m.text, sourceId: m.document_id ?? "" }));
		const sourceEditId =
			action.kind === "source_edit" && intent.request.kind !== "add"
				? intent.request.ref.rowId
				: (intent.addedSourceId ?? null);
		const newFacts = sourceEditId
			? live
					.filter(
						(m) =>
							m.fact_type !== "observation" && m.document_id === sourceEditId,
					)
					.map((m) => ({ id: m.id, text: m.text }))
			: undefined;
		const verifyCorrectionDates =
			action.kind === "migration_edit" &&
			typeof intent.replayOriginActionId === "string" &&
			!newFacts?.length;
		// A per-chat forget step whose edit already landed goes on from what it
		// saved: the edit is not made again, and its review compares the result
		// with the chat's facts from before the edit.
		const resumed = intent.meaningCheck
			? resumedMeaningCheck(intent.meaningCheck, source.id, originals)
			: undefined;
		const reviewed = resumed?.baseline ?? originals;
		const proposal: EditedFact[] =
			resumed?.proposal ??
			(await applyMemoryEdit(
				{
					before: intent.before,
					after: action.text ?? "",
					intent: requirePlan(intent),
					facts: originals.map(({ id, text }) => ({ id, text })),
					newFacts: verifyCorrectionDates ? undefined : newFacts,
					removalOnly: intent.removalOnly,
					verifyCorrectionDates,
				},
				model,
			));
		const dates = new Map<string, string>();
		if (verifyCorrectionDates) {
			const local = new Map(
				live
					.filter((fact) => fact.fact_type !== "observation")
					.map((fact) => [fact.id, fact]),
			);
			const receipts = new Map(
				(intent.replayFactDates ?? [])
					.filter((fact) => {
						const prior = local.get(fact.id);
						return (
							prior?.document_id === fact.sourceId &&
							memoryTextHash(prior.text) === fact.textHash
						);
					})
					.map((fact) => [fact.id, fact]),
			);
			for (const fact of proposal) {
				const original = originals.find((entry) => entry.id === fact.id);
				if (fact.carriesCorrection && original)
					receipts.set(fact.id, {
						id: fact.id,
						sourceId: original.sourceId,
						textHash: memoryTextHash(fact.text),
					});
				const receipt = receipts.get(fact.id);
				if (receipt && receipt.textHash === memoryTextHash(fact.text))
					dates.set(fact.id, action.createdAt.toISOString());
			}
			const replayFactDates = [...receipts.values()];
			if (
				JSON.stringify(replayFactDates) !==
				JSON.stringify(intent.replayFactDates ?? [])
			) {
				intent = { ...intent, replayFactDates };
				// A retry can recover the date after the text was already patched.
				await saveIntent(ctx, action.id, intent);
			}
		}
		if (!resumed)
			await patch(
				ctx,
				client,
				proposal,
				assertProvenance,
				dates,
				undefined,
				undefined,
				intent.meaningCheck
					? async () => {
							// Committed before the edit, so a failed attempt leaves
							// behind what the next one needs to tell what landed. An
							// earlier pass does not cover this edit.
							const step = intent.meaningCheck ?? {
								started: [],
								checked: [],
							};
							intent = {
								...intent,
								meaningCheck: {
									started: [...new Set([...step.started, source.id])],
									checked: step.checked.filter((id) => id !== source.id),
									edits: [
										...(step.edits ?? []).filter(
											(edit) => edit.sourceId !== source.id,
										),
										{
											sourceId: source.id,
											baseline: originals,
											proposal: proposal.map(({ id, text }) => ({ id, text })),
										},
									],
								},
							};
							await saveIntent(ctx, action.id, intent);
						}
					: undefined,
			);
		const applied = await client.list();
		verifyAppliedProposal(applied, proposal);
		for (const [id, date] of dates)
			if (
				Date.parse(
					applied.find((fact) => fact.id === id)?.mentioned_at ?? "",
				) !== Date.parse(date)
			)
				throw new NativeMemoryError("memory_edit_date_readback", true);
		for (const id of permitted) checkedSources.add(id);
		if (sourceEditId) checkedSources.add(sourceEditId);
		for (const fact of reviewed) expected.set(fact.id, fact.text);
		for (const fact of newFacts ?? []) expected.set(fact.id, fact.text);
		for (const fact of proposal) expected.set(fact.id, fact.text);
		updates.push({
			sourceIds: permitted,
			actionId: action.id,
			originals: reviewed,
			intent,
		});
		checks.push({
			actionId: action.id,
			revision: intent.revision ?? 0,
			actionAt: action.createdAt.getTime(),
			actionOrder: entry.order,
			replayOrder: intent.replayOrder,
			sources: [...permitted, ...(sourceEditId ? [sourceEditId] : [])],
			originals: reviewed,
			before: intent.before,
			after: action.text ?? "",
			intent: requirePlan(intent),
			chatRevision: action.kind === "source_edit",
			assertProvenance,
			...(intent.meaningCheck ? { meaningCheck: true as const } : {}),
		});
	}
	return {
		sourceIds: [...new Set(updates.flatMap((u) => u.sourceIds))],
		checks,
		verifyDependencies: async (result: CandidateCheck) => {
			if (!updates.length && !result.replays?.length) return;
			const first = updates[0]?.intent;
			const last = updates.at(-1)?.intent;
			const replays = [...checks, ...(result.replays ?? [])];
			const model = guardedModel(ctx, modelOverride);
			try {
				await checkCandidate(
					ctx,
					{
						memories: result.memories,
						sourceIds: [
							...new Set([...checkedSources, ...result.sourceIds, source.id]),
						],
						originalFacts: result.originalFacts,
						sourceAssertions: result.sourceAssertions,
						assertContextCurrent: result.assertContextCurrent,
						withdrawnSourceIds: result.withdrawnSourceIds,
						replays,
					},
					{
						before: first?.before ?? "",
						after: last
							? last.request.kind === "remove"
								? ""
								: last.request.text
							: source.text,
						intent: last
							? requirePlan(last)
							: { forget: [], replace: [], preserve: [] },
						orderedEdits: replays.length ? orderedChecks(replays) : undefined,
					},
					model,
				);
			} catch (error) {
				// A per-chat forget step the review refuses is not tried again: a
				// retry would compare against facts it may already have edited.
				if (
					error instanceof NativeMemoryError &&
					error.code === "memory_dependency_check_rejected" &&
					updates.some(({ intent }) => intent.meaningCheck)
				)
					throw new NativeMemoryError(error.code, false);
				throw error;
			}
			// The review passed for this revision: record it before publication,
			// all of this delivery's marks in one write.
			const passed = updates.filter(
				({ intent }) =>
					intent.meaningCheck &&
					!intent.meaningCheck.checked.includes(source.id),
			);
			for (const update of passed) {
				const meaningCheck = update.intent.meaningCheck;
				if (!meaningCheck) continue;
				update.intent = {
					...update.intent,
					meaningCheck: {
						...meaningCheck,
						checked: [...meaningCheck.checked, source.id],
					},
				};
			}
			if (passed.length) await saveIntents(ctx, passed);
		},
		apply: (tx: Tx, memories: NativeMemory[]) => {
			verifySourceResult(
				memories,
				[...checkedSources],
				[...expected].map(([id, text]) => ({ id, text })),
			);
			for (const update of updates) {
				tx.update(memoryActions)
					.set({ intentJson: JSON.stringify(update.intent) })
					.where(eq(memoryActions.id, update.actionId))
					.run();
				acceptedUpdates(
					tx,
					ctx,
					update.sourceIds,
					memories,
					update.actionId,
					update.originals,
				);
			}
		},
	};
}
/** A source edit preserves original dates on unchanged old facts; changed claims were extracted by native retain. */
export async function prepareSourceCuration(
	ctx: Context,
	client: HindsightClient,
	source: Source,
	predecessor: Source,
	native: NativeSettlement,
	modelOverride?: CurationModel,
) {
	if (
		predecessor.bankId !== source.bankId ||
		predecessor.userId !== source.userId
	)
		throw Error("memory_predecessor_invalid");
	let action = db
		.select()
		.from(memoryActions)
		.where(
			and(
				eq(memoryActions.userId, source.userId),
				eq(memoryActions.requestId, source.id),
			),
		)
		.get();
	if (!action) {
		const sourceBank = db
			.select()
			.from(memoryBanks)
			.where(eq(memoryBanks.id, source.bankId))
			.get();
		if (!sourceBank) throw Error("memory_bank_missing");
		const owners = db.transaction((tx) =>
			carriedMemorySources(tx, predecessor, sourceBank),
		) ?? [predecessor];
		const originals = owners.flatMap((owner) =>
			readAcknowledgedFacts(owner.acknowledgedFactsJson).map((fact) => ({
				...fact,
				sourceId: owner.id,
			})),
		);
		const intent: ActionIntentRecord = {
			revision: sourceBank.revision,
			request: {
				kind: "edit",
				requestId: source.id,
				text: source.text,
				ref: {
					scope:
						sourceBank.scopeKey === "personal"
							? { kind: "personal" }
							: { kind: "project", projectId: sourceBank.scopeKey.slice(8) },
					generation: "source-edit",
					rowId: source.id,
				},
			},
			before: predecessor.text,
			sourceIds: [
				...new Set([predecessor.id, ...owners.map((owner) => owner.id)]),
			],
			facts: originals,
		};
		if (
			!(await ctx.write((tx) => {
				actionFence(tx, ctx);
				tx.insert(memoryActions)
					.values({
						id: randomUUID(),
						userId: source.userId,
						bankId: source.bankId,
						epoch: source.epoch,
						requestId: source.id,
						kind: "source_edit",
						text: source.text,
						previousText: predecessor.text,
						intentJson: JSON.stringify(intent),
					})
					.onConflictDoNothing()
					.run();
			}))
		)
			throw Error("memory_cancelled");
		action = db
			.select()
			.from(memoryActions)
			.where(
				and(
					eq(memoryActions.userId, source.userId),
					eq(memoryActions.requestId, source.id),
				),
			)
			.get();
	}
	if (!action) throw Error("memory_action_missing");
	let intent = parseActionIntent(action.intentJson);
	const owners = sourcesFor(source.bankId, intent.sourceIds);
	if (
		owners.length !== new Set(intent.sourceIds).size ||
		owners.some(
			(owner) => owner.userId !== source.userId || owner.epoch !== source.epoch,
		)
	)
		throw new NativeMemoryError("memory_edit_source_withdrawn", false);
	const protectedOwners = new Map(
		owners
			.filter((owner) => owner.eventId.startsWith("manual:"))
			.map((owner) => [owner.id, owner]),
	);
	const fixed = intent.facts.filter((fact) =>
		protectedOwners.has(fact.sourceId),
	);
	const protectedDates = new Map<string, string | null>();
	if (fixed.length) {
		const known = new Map(fixed.map((fact) => [fact.id, fact.text]));
		for (const row of readPublishedMemory(source.userId, source.bankId))
			for (const fact of readAcknowledgedFacts(row.sourceFingerprintsJson)) {
				if (known.get(fact.id) !== fact.text || fact.mentionedAt === undefined)
					continue;
				if (
					protectedDates.has(fact.id) &&
					protectedDates.get(fact.id) !== fact.mentionedAt
				)
					throw new NativeMemoryError("memory_edit_readback_mismatch", false);
				protectedDates.set(fact.id, fact.mentionedAt);
			}
	}
	const protectedFacts = fixed.map((fact) => ({
		...fact,
		assertion_at: protectedOwners.get(fact.sourceId)?.assertedAt.toISOString(),
		native_mentioned_at: protectedDates.get(fact.id),
	}));
	const protectedById = new Map(protectedFacts.map((fact) => [fact.id, fact]));
	const editableFacts = intent.facts.filter(
		(fact) => !protectedOwners.has(fact.sourceId),
	);
	const editableIds = new Map(
		editableFacts.map(({ id, sourceId }) => [id, sourceId]),
	);
	const assertEditInputs = (tx: Tx) => {
		const bank = actionFence(tx, ctx);
		const prior = tx
			.select()
			.from(memorySourceRevisions)
			.where(eq(memorySourceRevisions.id, predecessor.id))
			.get();
		if (
			prior?.state !== "revoked" ||
			(source.eventId.startsWith("message:") &&
				!isEditResendWithdrawal(prior)) ||
			prior.textHash !== predecessor.textHash ||
			prior.epoch !== source.epoch ||
			prior.userId !== source.userId ||
			prior.bankId !== source.bankId ||
			prior.conversationId !== source.conversationId ||
			prior.lineageId !== source.lineageId ||
			source.predecessorSourceId !== prior.id
		)
			throw new NativeMemoryError("memory_predecessor_invalid", false);
		const authorized = new Map(
			[prior, ...(carriedMemorySources(tx, prior, bank) ?? [])].map((owner) => [
				owner.id,
				owner,
			]),
		);
		for (const owner of owners) {
			const live = authorized.get(owner.id);
			if (!live || live.acknowledgedFactsJson !== owner.acknowledgedFactsJson)
				throw new NativeMemoryError("memory_edit_source_withdrawn", false);
			if (protectedOwners.has(owner.id))
				assertMemorySourceCurrent(tx, owner.id, source.userId, source.bankId);
		}
	};
	function verifyProtectedFacts(memories: NativeMemory[]) {
		for (const id of protectedOwners.keys())
			verifyFixedNativeFacts(
				memories,
				id,
				protectedFacts.filter((fact) => fact.sourceId === id),
			);
	}
	const model = guardedModel(ctx, modelOverride, assertEditInputs);
	if (!intent.plan) {
		intent = {
			...intent,
			plan: await planMemoryEdit(predecessor.text, source.text, model),
		};
		await saveIntent(ctx, action.id, intent);
	}
	if (!intent.proposal) {
		const live = await client.list();
		verifySourceResult(live, intent.sourceIds, intent.facts);
		verifyProtectedFacts(live);
		const facts = live
			.filter((m) => m.fact_type !== "observation" && editableIds.has(m.id))
			.map((m) => ({ id: m.id, text: m.text }));
		const newFacts = live
			.filter(
				(m) => m.fact_type !== "observation" && m.document_id === source.id,
			)
			.map((m) => ({ id: m.id, text: m.text }));
		intent = {
			...intent,
			nativeFacts: newFacts,
			proposal: await applyMemoryEdit(
				{
					before: predecessor.text,
					after: source.text,
					intent: requirePlan(intent),
					facts,
					newFacts,
					protectedFacts,
				},
				model,
			),
		};
		await saveIntent(ctx, action.id, intent);
	}
	if (!intent.proposal) throw Error("memory_action_corrupt");
	const proposal = intent.proposal.filter((fact) => {
		const protectedFact = protectedById.get(fact.id);
		if (protectedFact && protectedFact.text === fact.text) return false;
		if (!editableIds.has(fact.id))
			throw new NativeMemoryError("memory_source_edit_protected_fact", false);
		return true;
	});
	await patch(ctx, client, proposal, assertEditInputs, undefined, editableIds);
	await native.settle(client, [await client.consolidate()], ctx.signal);
	const memories = await native.capture(client, ctx.signal);
	verifyAppliedProposal(memories, proposal);
	verifyFixedNativeFacts(memories, source.id, intent.nativeFacts ?? []);
	verifySourceResult(
		memories,
		[source.id, ...intent.sourceIds],
		[...proposal, ...protectedFacts, ...(intent.nativeFacts ?? [])],
	);
	verifyProtectedFacts(memories);
	const carried = Array.isArray(
		parseJsonRecord(predecessor.context).carriedSourceIds,
	);
	const logicalOnly = carried && !predecessor.nativeSubmitted;
	const writableSources = intent.sourceIds.filter(
		(id) => !protectedOwners.has(id),
	);
	const editedSources = logicalOnly
		? writableSources.filter((id) => id !== predecessor.id)
		: writableSources;
	const sourceIds = [source.id, ...writableSources];
	const verifiedRoots = new Map<string, string | string[]>(
		sourceIds.map((id) => [id, id]),
	);
	if (carried || editedSources.length > 1)
		verifiedRoots.set(predecessor.id, [
			source.id,
			...editedSources,
			...protectedOwners.keys(),
		]);
	return {
		memories,
		sourceIds,
		verifiedRoots,
		apply: (tx: Tx) => {
			assertEditInputs(tx);
			tx.update(memoryActions)
				.set({ intentJson: JSON.stringify({ ...intent, outcome: "accepted" }) })
				.where(eq(memoryActions.id, action.id))
				.run();
			acceptedUpdates(
				tx,
				ctx,
				editedSources,
				memories,
				action?.id,
				editableFacts,
			);
			// Only the verified sanitised predecessor is admitted. Old full-text fingerprints remain revoked.
			if (!logicalOnly)
				tx.delete(memoryRevocations)
					.where(
						and(
							eq(memoryRevocations.bankId, source.bankId),
							eq(memoryRevocations.sourceId, predecessor.id),
						),
					)
					.run();
		},
	};
}

function requirePlan(intent: ActionIntentRecord) {
	if (!intent.plan) throw Error("memory_action_corrupt");
	return intent.plan;
}

function verifyAppliedProposal(
	memories: NativeMemory[],
	proposal: Array<{ id: string; text: string }>,
) {
	const current = new Map(
		memories
			.filter((m) => m.fact_type !== "observation")
			.map((m) => [m.id, m.text]),
	);
	for (const fact of proposal) {
		if (
			fact.text.trim()
				? current.get(fact.id) !== fact.text
				: current.has(fact.id)
		)
			throw new NativeMemoryError("memory_edit_readback_mismatch", false);
	}
}

function verifyFixedNativeFacts(
	memories: NativeMemory[],
	sourceId: string,
	expected: NonNullable<ActionIntentRecord["nativeFacts"]>,
) {
	const actual = memories.filter(
		(m) => m.fact_type !== "observation" && m.document_id === sourceId,
	);
	if (
		actual.length !== expected.length ||
		expected.some(
			(fact) =>
				fact.native_mentioned_at !== undefined &&
				(actual.find((candidate) => candidate.id === fact.id)?.mentioned_at ??
					null) !== fact.native_mentioned_at,
		)
	)
		throw new NativeMemoryError("memory_edit_readback_mismatch", false);
	verifyAppliedProposal(memories, expected);
}

/** Same bounded final checker for a deliberate edited-chat dependency closure. */
export async function checkSourceDependencyCuration(
	ctx: Context,
	source: Source,
	result: CandidateCheck,
	modelOverride?: CurationModel,
) {
	const action = db
		.select()
		.from(memoryActions)
		.where(
			and(
				eq(memoryActions.userId, ctx.row.userId),
				eq(memoryActions.requestId, source.id),
			),
		)
		.get();
	if (!action) throw new NativeMemoryError("memory_action_missing", false);
	const intent = parseActionIntent(action.intentJson);
	const sourceIds = [...intent.sourceIds, source.id, ...result.sourceIds];
	const direct = sourceCurationActions(
		source,
		source.predecessorSourceId ?? undefined,
		true,
	);
	const knownActions = new Map(direct.map((entry) => [entry.action.id, entry]));
	const { scopedSources, ownedLineage } = db.transaction((tx) => {
		const scopedSources = tx
			.select()
			.from(memorySourceRevisions)
			.where(
				and(
					eq(memorySourceRevisions.userId, source.userId),
					eq(memorySourceRevisions.bankId, source.bankId),
					eq(memorySourceRevisions.epoch, source.epoch),
				),
			)
			.all();
		return {
			scopedSources,
			ownedLineage: readNativeCurationLineage(
				tx,
				source.userId,
				source.epoch,
				scopedSources,
			).filter(
				(entry) => entry.whollyChatBound && entry.intent.outcome === "accepted",
			),
		};
	});
	const roots = new Set(
		ownedLineage
			.filter(({ action }) => knownActions.has(action.id))
			.flatMap((entry) => entry.roots.map((root) => root.id)),
	);
	const correctionSources = new Set<string>();
	for (const entry of ownedLineage) {
		if (!entry.roots.every((root) => roots.has(root.id))) continue;
		knownActions.set(entry.action.id, entry);
		if (entry.correction?.state === "accepted")
			correctionSources.add(entry.correction.id);
	}
	if (knownActions.size > 64 || correctionSources.size > 64)
		throw new NativeMemoryError("memory_edit_too_large", false);
	const provenance = new Map(
		ownedLineage.map((entry) => [
			entry.action.id,
			entry.roots.map((root) => root.id),
		]),
	);
	const recorded = new Map(
		scopedSources.map((revision) => [revision.id, revision]),
	);
	const predecessorIds = db.transaction((tx) => {
		const ids = new Set([source.id]);
		for (const prior of memorySourcePredecessors(tx, source)) {
			if (ids.size >= 64)
				throw new NativeMemoryError("memory_edit_too_large", false);
			ids.add(prior.id);
		}
		return ids;
	});
	const assertAuthorized = (
		tx: Tx,
		bank: ReturnType<typeof actionFence>,
		id: string,
	) => {
		if (predecessorIds.has(id)) return;
		const revision = recorded.get(id);
		if (!revision) throw new Error("memory_source_revoked");
		assertMemoryCurationSourceCurrent(tx, revision, bank);
	};
	const denied = new Set<string>();
	const authorized = new Set<string>();
	const checkedIds = new Set<string>();
	const allChecks = new Map(knownActions);
	const replayIds = (result.replays ?? [])
		.map((replay) => replay.actionId)
		.filter((id) => !allChecks.has(id));
	if (allChecks.size + replayIds.length > 64)
		throw new NativeMemoryError("memory_edit_too_large", false);
	if (replayIds.length)
		for (const prior of db
			.select({ action: memoryActions, order: sql<number>`rowid` })
			.from(memoryActions)
			.where(
				and(
					inArray(memoryActions.id, replayIds),
					eq(memoryActions.userId, source.userId),
					eq(memoryActions.bankId, source.bankId),
					eq(memoryActions.epoch, source.epoch),
				),
			)
			.all())
			allChecks.set(prior.action.id, {
				...prior,
				intent: parseActionIntent(prior.action.intentJson),
			});
	db.transaction((tx) => {
		const bank = actionFence(tx, ctx);
		for (const { action: prior, intent: saved } of allChecks.values()) {
			const ids = new Set([
				...recordedActionSources(saved),
				...(provenance.get(prior.id) ?? []),
			]);
			let permitted = true;
			for (const id of ids) {
				try {
					assertAuthorized(tx, bank, id);
				} catch {
					denied.add(id);
					permitted = false;
				}
			}
			if (permitted) {
				authorized.add(prior.id);
				for (const id of ids) checkedIds.add(id);
			}
		}
	});
	const model = guardedModel(ctx, modelOverride, (tx) => {
		const bank = actionFence(tx, ctx);
		for (const id of checkedIds) assertAuthorized(tx, bank, id);
	});
	const correctionFacts = correctionSources.size
		? admittedNativeFacts(source.userId, source.bankId)
				.filter((fact) => correctionSources.has(fact.source.id))
				.map(({ id, text, source: correction }) => ({
					id,
					text,
					sourceId: correction.id,
				}))
		: [];
	const earlier: ReplayCheck[] = [];
	for (const { action: prior, intent: saved, order } of knownActions.values()) {
		if (!authorized.has(prior.id)) continue;
		// The predecessor's approved native facts already reflect earlier edits.
		// The checker must know their intent to tell unchanged wording from a new assertion.
		const plan =
			saved.plan ??
			(await planMemoryEdit(saved.before, prior.text ?? "", model));
		if (!saved.plan) await saveIntent(ctx, prior.id, { ...saved, plan });
		const manualIds = [
			...saved.sourceIds,
			...(saved.addedSourceId ? [saved.addedSourceId] : []),
		].filter((id) => correctionSources.has(id));
		const directIds = saved.sourceIds.some((id) => !correctionSources.has(id))
			? sourceIds
			: [];
		earlier.push({
			actionId: prior.id,
			revision: saved.revision ?? 0,
			actionAt: prior.createdAt.getTime(),
			actionOrder: order,
			replayOrder: saved.replayOrder,
			sources: [...new Set([...directIds, ...manualIds])],
			originals: [],
			before: saved.before,
			after: prior.text ?? "",
			intent: plan,
			chatRevision: prior.kind === "source_edit",
		});
	}
	const replays = [
		...earlier,
		...(result.replays ?? []).filter((replay) =>
			authorized.has(replay.actionId),
		),
	];
	const withdrawnFactIds = new Set(result.withdrawnFactIds);
	for (const id of denied) {
		const revision = recorded.get(id);
		if (revision)
			for (const fact of readAcknowledgedFacts(revision.acknowledgedFactsJson))
				withdrawnFactIds.add(fact.id);
	}
	for (const { intent: saved } of allChecks.values()) {
		for (const fact of saved.facts)
			if (denied.has(fact.sourceId)) withdrawnFactIds.add(fact.id);
	}
	const hasVerifiedCorrection = correctionFacts.some(
		(fact) =>
			checkedIds.has(fact.sourceId) &&
			!withdrawnFactIds.has(fact.id) &&
			intent.facts.some(
				(original) =>
					original.id === fact.id &&
					original.sourceId === fact.sourceId &&
					original.text === fact.text,
			),
	);
	// Native cleanup can lag local withdrawal. Never send a mixed candidate
	// whose display is still backed by withdrawn facts.
	if (
		result.memories.some(
			(memory) =>
				memory.fact_type === "observation" &&
				memory.source_memory_ids?.some((id) => withdrawnFactIds.has(id)),
		)
	)
		throw new NativeMemoryError("memory_candidate_unaccepted", true);
	await checkCandidate(
		ctx,
		{
			memories: result.memories,
			sourceAssertions: result.sourceAssertions,
			assertContextCurrent: result.assertContextCurrent,
			withdrawnSourceIds: result.withdrawnSourceIds,
			sourceIds: [...sourceIds, ...correctionSources].filter(
				(id) => !denied.has(id),
			),
			originalFacts: [
				...intent.facts,
				...result.originalFacts,
				...correctionFacts,
			].filter((fact) => !withdrawnFactIds.has(fact.id)),
			withdrawnFactIds,
			replays: replays.length
				? [
						...replays,
						{
							actionId: action.id,
							revision: intent.revision ?? 0,
							actionAt: action.createdAt.getTime(),
							chatRevision: true,
							sources: sourceIds,
							originals: intent.facts,
							before: intent.before,
							after: source.text,
							intent: requirePlan(intent),
						},
					]
				: undefined,
		},
		{
			before: intent.before,
			after: source.text,
			intent: requirePlan(intent),
			latestChatSourceId: hasVerifiedCorrection ? source.id : undefined,
		},
		model,
	);
}

export async function checkDeletedSourceRepair(
	ctx: Context,
	result: CandidateCheck & {
		withdrawnSourceIds: string[];
		sourceAssertions: SourceAssertions;
	},
) {
	await checkCandidate(
		ctx,
		result,
		{
			before: "",
			after: "",
			intent: { forget: [], replace: [], preserve: [] },
			sourceAssertions: result.sourceAssertions,
			withdrawnSourceIds: result.withdrawnSourceIds,
		},
		guardedModel(ctx),
	);
}

function verifySourceResult(
	memories: NativeMemory[],
	sourceIds: string[],
	expected: Array<{ id: string; text: string }>,
) {
	verifyAppliedProposal(memories, expected);
	const allowed = new Set(
		expected.filter((f) => f.text.trim()).map((f) => f.id),
	);
	if (
		memories.some(
			(m) =>
				m.fact_type !== "observation" &&
				sourceIds.includes(m.document_id ?? "") &&
				!allowed.has(m.id),
		)
	)
		throw new NativeMemoryError("memory_edit_readback_mismatch", false);
}
