import { randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	memoryAccounts,
	memoryActions,
	memoryBanks,
	memoryDeliveryJobs,
	memoryRevocations,
	memorySourceRevisions,
	users,
} from "$lib/server/db/schema";
import type { JobRunContext, Tx } from "../jobs/types";
import type { NativeMemory } from "./contracts";
import type { ReplayCheck } from "./curation-intent";
import { memoryResendTransitions } from "./curation-lineage";
import type { NativeWaitKind } from "./delivery-policy";
import {
	createDependencyRepairPlan,
	orderDependencySources,
	type RepairPlan,
	readDependencyRepairPlan,
	unfinishedDependencyDraft,
	withdrawnDependencySourceId,
} from "./dependency-plan";
import { type HindsightClient, NativeMemoryError } from "./hindsight-client";
import { parseJsonRecord } from "./internal-json";
import {
	assertMemoryBankAccess,
	assertMemoryBankFence,
	assertMemoryCurationSourceCurrent,
	assertMemoryDependencySourceCurrent,
	assertMemorySourceCurrent,
	carriedMemorySources,
	isEditResendWithdrawal,
	memoryTextHash,
	withoutRetainBookkeeping,
} from "./revisions";

type Source = typeof memorySourceRevisions.$inferSelect;
type Context = JobRunContext<typeof memoryDeliveryJobs>;

export interface NativeSettlement {
	capture: (
		client: HindsightClient,
		signal: AbortSignal,
	) => Promise<NativeMemory[]>;
	/**
	 * Waits until the operations end. `kind` is the wait they get from the job's
	 * failure policy (`delivery-policy.ts`): "retain" for a retain's operation,
	 * "consolidation", the default, for everything else.
	 */
	settle: (
		client: HindsightClient,
		ids: string[],
		signal: AbortSignal,
		cleanup?: boolean,
		kind?: NativeWaitKind,
	) => Promise<void>;
}

function loadPlan(ctx: Context): RepairPlan | undefined {
	const row = db
		.select({ checkpoint: memoryDeliveryJobs.checkpoint })
		.from(memoryDeliveryJobs)
		.where(eq(memoryDeliveryJobs.id, ctx.row.id))
		.get();
	const savedAction = ctx.row.actionId
		? db
				.select({ intent: memoryActions.intentJson })
				.from(memoryActions)
				.where(eq(memoryActions.id, ctx.row.actionId))
				.get()?.intent
		: null;
	if (!row?.checkpoint && !savedAction) return;
	return readDependencyRepairPlan(
		row?.checkpoint ?? savedAction ?? "{}",
		ctx.row,
	);
}
async function write(ctx: Context, apply: (tx: Tx) => void) {
	if (!(await ctx.write(apply)))
		throw new NativeMemoryError("memory_cancelled", false);
}
function sourceById(id: string) {
	const source = db
		.select()
		.from(memorySourceRevisions)
		.where(eq(memorySourceRevisions.id, id))
		.get();
	if (!source)
		throw new NativeMemoryError("memory_dependency_source_missing", false);
	return source;
}

function contextSourceIds(source: Source): string[] {
	const input = JSON.parse(source.context) as {
		messages?: Array<{ sourceId?: string }>;
	};
	return [
		...new Set(
			(input.messages ?? [])
				.map(({ sourceId }) => sourceId)
				.filter((id): id is string => !!id && id !== "$current"),
		),
	];
}

/** Finite repair remains part of its parent job, never publishes a partial family. */
export async function runDependencyRepair(
	ctx: Context,
	client: HindsightClient,
	native: NativeSettlement,
	input: {
		rootSourceIds: string[];
		verifiedRoots?: ReadonlyMap<string, string | string[]>;
		assertVerifiedRoots?: (tx: Tx) => void;
		withdrawnSourceIds?: string[];
		rebuildSourceIds?: ReadonlySet<string>;
		compensate?: boolean;
		memories: NativeMemory[];
		verify?: (result: {
			originalFacts: RepairPlan["originalFacts"];
			memories: NativeMemory[];
			sourceIds: string[];
			withdrawnFactIds: ReadonlySet<string>;
			withdrawnSourceIds: string[];
			sourceAssertions: Array<{
				id: string;
				originalSourceId: string;
				assertion: string;
				priorContext: string;
				withdrawnContextSourceIds: string[];
			}>;
			replays: ReplayCheck[];
			assertContextCurrent: (tx: Tx) => void;
		}) => Promise<void>;
		replay: (
			replacement: Source,
			original: Source,
		) => Promise<{
			sourceIds: string[];
			checks: ReplayCheck[];
			apply: (tx: Tx, memories: NativeMemory[]) => void;
		}>;
	},
) {
	if (!input.rootSourceIds.length)
		return {
			memories: input.memories,
			originalFacts: [],
			sourceIds: [],
			withdrawnFactIds: new Set<string>(),
			withdrawnSourceIds: [],
			sourceAssertions: [],
			assertContextCurrent: undefined,
			replays: [],
			apply: (_tx: Tx) => {},
		};
	function fence(tx: Tx, retain = false) {
		const bank = assertMemoryBankAccess(
			tx,
			ctx.row.userId,
			ctx.row.bankId,
			ctx.row.epoch,
			retain ? "memory" : "owner-export",
		);
		const account = tx
			.select()
			.from(memoryAccounts)
			.where(eq(memoryAccounts.userId, ctx.row.userId))
			.get();
		const liveRevision =
			ctx.row.kind === "source_cleanup"
				? tx
						.select({ revision: memoryDeliveryJobs.controlRevision })
						.from(memoryDeliveryJobs)
						.where(eq(memoryDeliveryJobs.id, ctx.row.id))
						.get()?.revision
				: ctx.row.controlRevision;
		if (retain && account?.controlRevision !== liveRevision)
			throw new NativeMemoryError("memory_control_changed", true);
		if (retain && liveRevision !== undefined)
			ctx.row.controlRevision = liveRevision;
		return bank;
	}
	async function checkpoint(prepare: (tx: Tx) => RepairPlan) {
		const saved = await ctx.progress({
			prepareCheckpoint: (tx) => {
				const plan = prepare(tx);
				if (input.compensate && ctx.row.actionId) {
					const action = tx
						.select({ intent: memoryActions.intentJson })
						.from(memoryActions)
						.where(eq(memoryActions.id, ctx.row.actionId))
						.get();
					const intent = parseJsonRecord(action?.intent ?? "");
					if (intent.rollbackPending !== true)
						throw new NativeMemoryError("memory_cancelled", false);
					// The rejected Edit still owns recovery after an exhausted attempt
					// drops the engine checkpoint.
					tx.update(memoryActions)
						.set({
							intentJson: JSON.stringify({ ...intent, dependencyRepair: plan }),
						})
						.where(eq(memoryActions.id, ctx.row.actionId))
						.run();
				}
				return { dependencyRepair: plan };
			},
		});
		if (!saved) throw new NativeMemoryError("memory_cancelled", false);
	}
	const ownRepairPrefix = `dependency:${ctx.row.id}:`;
	let plan = loadPlan(ctx);
	const rebuild = input.rebuildSourceIds ?? new Set<string>();
	const planned = new Set(plan?.steps.map((step) => step.originalId));
	if (!plan || [...rebuild].some((id) => !planned.has(id))) {
		try {
			await checkpoint((tx) => {
				const bank = fence(tx);
				const refreshed = createDependencyRepairPlan(
					tx,
					ctx.row.userId,
					bank.id,
					bank.epoch,
					rebuild.size ? (input.withdrawnSourceIds ?? []) : input.rootSourceIds,
				);
				if (input.compensate) {
					refreshed.steps = refreshed.steps.filter(
						(step) =>
							!sourceById(step.originalId).eventId.startsWith(ownRepairPrefix),
					);
					const originals = new Set(
						refreshed.steps.map((step) => step.originalId),
					);
					refreshed.originalFacts = refreshed.originalFacts.filter((fact) =>
						originals.has(fact.sourceId),
					);
				}
				const discovered = new Set(
					refreshed.steps.map((step) => step.originalId),
				);
				if ([...rebuild].some((id) => !discovered.has(id)))
					throw new NativeMemoryError(
						"memory_edit_restore_source_changed",
						true,
					);
				refreshed.revision = bank.revision;
				if (!plan) {
					plan = refreshed;
					return plan;
				}
				const steps = new Map(
					plan.steps.map((step) => [step.originalId, step]),
				);
				const oldReplacements = new Set(
					plan.steps.map((step) => step.replacementId),
				);
				for (const step of refreshed.steps)
					if (
						!steps.has(step.originalId) &&
						!oldReplacements.has(step.originalId)
					)
						steps.set(step.originalId, step);
				plan = {
					...refreshed,
					roots: input.rootSourceIds.filter((id) => !rebuild.has(id)),
					steps: orderDependencySources(
						[...steps.values()].map((step) => ({
							...sourceById(step.originalId),
							step,
						})),
					).map(({ step }) => step),
					originalFacts: [
						...refreshed.originalFacts.filter(
							(fact) => steps.has(fact.sourceId) && !planned.has(fact.sourceId),
						),
						...plan.originalFacts,
					],
				};
				return plan;
			});
		} catch (error) {
			if (
				error instanceof NativeMemoryError &&
				error.code === "memory_dependency_limit"
			)
				await write(ctx, (tx) => {
					tx.update(memoryBanks)
						.set({ status: "repair_blocked" })
						.where(eq(memoryBanks.id, ctx.row.bankId))
						.run();
				});
			throw error;
		}
	}
	if (!plan)
		throw new NativeMemoryError("memory_dependency_plan_corrupt", false);
	const active = plan;
	const sourceCleanup = ctx.row.kind === "source_cleanup";
	const rootWithdrawals =
		input.withdrawnSourceIds ?? (sourceCleanup ? input.rootSourceIds : []);
	const withdrawnOriginals = db.transaction(
		(tx) =>
			new Map(
				active.steps.flatMap((step) => {
					const id = withdrawnDependencySourceId(tx, ctx.row, step.originalId);
					return id ? [[step.originalId, id]] : [];
				}),
			),
	);
	const withdrawnSteps = active.steps.filter((step) =>
		withdrawnOriginals.has(step.originalId),
	);
	const originalIds = new Set(active.steps.map(({ originalId }) => originalId));
	const unfinished = db.transaction((tx) =>
		active.steps.flatMap((step) => {
			if (withdrawnOriginals.has(step.originalId)) return [];
			const source = unfinishedDependencyDraft(
				tx,
				ctx.row,
				originalIds,
				step.originalId,
			);
			return source ? [{ step, source }] : [];
		}),
	);
	const unfinishedIds = new Set(unfinished.map(({ source }) => source.id));
	function withdrawnContextSourceId(tx: Tx, sourceId: string) {
		const id = withdrawnDependencySourceId(tx, ctx.row, sourceId);
		if (id && !isEditResendWithdrawal(sourceById(id))) return id;
	}
	const withdrawals = db.transaction((tx) => [
		...new Set([
			...rootWithdrawals,
			...withdrawnOriginals.values(),
			...active.steps.flatMap(({ originalId }) =>
				contextSourceIds(sourceById(originalId)).flatMap((id) => {
					const withdrawn = withdrawnContextSourceId(tx, id);
					return withdrawn ? [withdrawn] : [];
				}),
			),
		]),
	]);
	// A previous verified compensation may already have rebuilt these exact
	// descendants without the deleted roots. Reuse only an admitted successor.
	const replacements = sourceCleanup
		? db.transaction((tx) => {
				const bank = fence(tx);
				const liveDocuments = new Set(input.memories.map((m) => m.document_id));
				const originals = active.steps.map((step) => step.originalId);
				const discarded = tx
					.select()
					.from(memorySourceRevisions)
					.where(
						and(
							eq(memorySourceRevisions.bankId, bank.id),
							eq(memorySourceRevisions.epoch, bank.epoch),
							eq(memorySourceRevisions.userId, ctx.row.userId),
							eq(memorySourceRevisions.state, "revoked"),
							inArray(memorySourceRevisions.id, originals),
						),
					)
					.all()
					.filter(
						(source) =>
							source.predecessorSourceId &&
							source.eventId.startsWith("dependency:") &&
							!source.acceptedGeneration &&
							!liveDocuments.has(source.id),
					);
				const accepted = tx
					.select()
					.from(memorySourceRevisions)
					.where(
						and(
							eq(memorySourceRevisions.userId, ctx.row.userId),
							eq(memorySourceRevisions.bankId, bank.id),
							eq(memorySourceRevisions.epoch, bank.epoch),
							eq(memorySourceRevisions.state, "accepted"),
							inArray(memorySourceRevisions.predecessorSourceId, [
								...originals,
								...discarded.flatMap((source) =>
									source.predecessorSourceId
										? [source.predecessorSourceId]
										: [],
								),
							]),
						),
					)
					.all();
				const covered = new Map<string, string>();
				for (const source of accepted) {
					const previous = source.predecessorSourceId;
					const removed = parseJsonRecord(source.context).withdrawnSourceIds;
					if (
						!previous ||
						liveDocuments.has(previous) ||
						!bank.generation ||
						source.acceptedGeneration !== bank.generation ||
						!Array.isArray(removed) ||
						!withdrawals.every((id) => removed.includes(id))
					)
						continue;
					assertMemorySourceCurrent(tx, source.id, ctx.row.userId, bank.id);
					covered.set(previous, source.id);
					for (const attempt of discarded) {
						if (
							attempt.predecessorSourceId === previous &&
							attempt.lineageId === source.lineageId &&
							attempt.conversationId === source.conversationId &&
							attempt.messageId === source.messageId &&
							attempt.textHash === source.textHash
						)
							covered.set(attempt.id, source.id);
					}
				}
				return covered;
			})
		: new Map<string, string>();
	let steps = active.steps.filter(
		(step) =>
			!replacements.has(step.originalId) &&
			!withdrawnOriginals.has(step.originalId) &&
			!unfinishedIds.has(step.originalId),
	);
	const pendingOriginals = new Set(steps.map((step) => step.originalId));
	const originalFacts = active.originalFacts.filter((fact) =>
		pendingOriginals.has(fact.sourceId),
	);
	const withdrawnFactIds = new Set(
		active.originalFacts
			.filter((fact) => withdrawnOriginals.has(fact.sourceId))
			.map((fact) => fact.id),
	);
	const liveSources = db.transaction((tx) => {
		const bank = fence(tx);
		return new Map(
			steps.map(({ originalId }) => [
				originalId,
				assertMemoryDependencySourceCurrent(tx, originalId, bank).live.id,
			]),
		);
	});
	const physicalSources = new Map(
		[...liveSources].map(([physical, live]) => [live, physical]),
	);
	const physicalId = (id: string) => physicalSources.get(id) ?? id;
	const stepContext = (context: string, mapId: (id: string) => string) => {
		// The original's retain bookkeeping belongs to its operations, not to the replacement.
		const envelope = withoutRetainBookkeeping(parseJsonRecord(context));
		const messages = Array.isArray(envelope.messages) ? envelope.messages : [];
		return {
			...envelope,
			messages: messages.map((message) =>
				typeof message?.sourceId === "string"
					? { ...message, sourceId: mapId(message.sourceId) }
					: message,
			),
		};
	};
	steps = orderDependencySources(
		steps.map((step) => {
			const original = sourceById(step.originalId);
			return {
				id: original.id,
				context: JSON.stringify(stepContext(original.context, physicalId)),
				step,
			};
		}),
	).map(({ step }) => step);
	// Preparation gives default history no context, so it never depends on
	// another source. A rebuild of one would carry no per-chat forget step of
	// its own and stay in verify's `meaningCheckMissing` for good.
	if (
		steps.some(
			({ originalId }) =>
				parseJsonRecord(sourceById(originalId).context)
					.migrationDefaultHistory === true,
		)
	)
		throw new NativeMemoryError("memory_dependency_default_history", false);
	function assertStepCurrent(tx: Tx, originalId: string, enabled = false) {
		const result = assertMemoryDependencySourceCurrent(
			tx,
			originalId,
			fence(tx, enabled),
		);
		if (result.live.id !== liveSources.get(originalId))
			throw new NativeMemoryError("memory_dependency_source_changed", true);
		return result;
	}
	function resolveContext(tx: Tx, step: RepairPlan["steps"][number]) {
		const original = sourceById(step.originalId);
		const replacement = sourceById(step.replacementId);
		const bank = fence(tx, true);
		input.assertVerifiedRoots?.(tx);
		const { live } = assertStepCurrent(tx, original.id, true);
		if (replacement.messageId !== live.messageId)
			throw new NativeMemoryError("memory_dependency_source_changed", true);
		// Context consists solely of currently verified native facts, never removed raw chat wording.
		const facts: Array<{ text: string; asserted_at: string }> = [];
		for (const parentId of contextSourceIds(original)) {
			const root = input.verifiedRoots?.get(parentId);
			const repaired = steps.find((s) => s.originalId === physicalId(parentId));
			const mapped =
				root ??
				repaired?.replacementId ??
				replacements.get(physicalId(parentId)) ??
				parentId;
			// Deleted source roots have no surviving context.
			if (
				withdrawals.includes(parentId) ||
				withdrawnOriginals.has(parentId) ||
				withdrawnContextSourceId(tx, parentId) ||
				(active.roots.includes(parentId) && !root)
			)
				continue;
			const owners = (Array.isArray(mapped) ? mapped : [mapped]).flatMap(
				(nativeId) => {
					const parent = root
						? sourceById(nativeId)
						: assertMemorySourceCurrent(
								tx,
								nativeId,
								ctx.row.userId,
								ctx.row.bankId,
							);
					if (root) {
						if (
							parent.userId !== bank.userId ||
							parent.bankId !== bank.id ||
							parent.epoch !== bank.epoch
						)
							throw new NativeMemoryError(
								"memory_dependency_context_changed",
								true,
							);
						if (parent.state === "revoked") {
							const current =
								ctx.row.kind === "source" && ctx.row.sourceId
									? assertMemorySourceCurrent(
											tx,
											ctx.row.sourceId,
											bank.userId,
											bank.id,
										)
									: undefined;
							const authorized =
								current &&
								((isEditResendWithdrawal(parent) &&
									memoryResendTransitions(tx, current).some(
										({ id }) => id === parent.id,
									)) ||
									(!current.eventId.startsWith("message:") &&
										current.predecessorSourceId === parent.id));
							if (!authorized)
								throw new NativeMemoryError(
									"memory_dependency_context_changed",
									true,
								);
						}
						return [parent];
					}
					if (repaired || replacements.has(physicalId(parentId)))
						return [parent];
					if (parent.state !== "accepted") return [];
					const carried = carriedMemorySources(tx, parent, bank);
					if (!carried) return [parent];
					for (const owner of carried)
						assertMemoryCurationSourceCurrent(tx, owner, bank);
					return carried;
				},
			);
			for (const parent of owners) {
				const raw = memories.filter(
					(m) => m.fact_type !== "observation" && m.document_id === parent.id,
				);
				const acknowledged = new Map(
					(
						JSON.parse(parent.acknowledgedFactsJson) as Array<{
							id: string;
							text: string;
						}>
					).map((f) => [f.id, f.text]),
				);
				const revoked = tx
					.select()
					.from(memoryRevocations)
					.where(
						and(
							eq(memoryRevocations.bankId, parent.bankId),
							eq(memoryRevocations.epoch, parent.epoch),
							or(
								eq(memoryRevocations.sourceId, parent.id),
								inArray(
									memoryRevocations.nativeFactId,
									raw.map((f) => f.id),
								),
							),
						),
					)
					.all();
				for (const fact of raw) {
					if (
						((!root || input.assertVerifiedRoots) &&
							acknowledged.get(fact.id) !== fact.text) ||
						revoked.some(
							(r) =>
								(!root && r.sourceId === parent.id) ||
								(r.nativeFactId === fact.id &&
									(!r.nativeTextHash ||
										r.nativeTextHash === memoryTextHash(fact.text))),
						)
					)
						continue;
					facts.push({
						text: fact.text,
						asserted_at: (
							parent.explicitEditAt ?? parent.assertedAt
						).toISOString(),
					});
				}
			}
		}
		return JSON.stringify({
			guidance:
				"Only content is the original user assertion at its original date. These are sanitized prior-memory facts for attribution, not original quotations or new assertions. Do not infer removed context. Assistant statements are not user facts.",
			prior_memory: facts,
		});
	}
	function assertContextCurrent(tx: Tx) {
		for (const step of steps) {
			let current: string;
			try {
				current = resolveContext(tx, step);
			} catch {
				throw new NativeMemoryError("memory_dependency_context_changed", true);
			}
			if (current !== step.submittedContext)
				throw new NativeMemoryError("memory_dependency_context_changed", true);
		}
	}

	const replayed: Array<Awaited<ReturnType<typeof input.replay>>> = [];
	let memories = input.memories;
	async function deleteRepairDocument(source: Source) {
		db.transaction((tx) => fence(tx));
		if (
			source.nativeSubmitted &&
			!source.nativeAcknowledged &&
			source.nativeOperationId
		)
			await native.settle(
				client,
				[source.nativeOperationId],
				ctx.signal,
				true,
				"retain",
			);
		await native.capture(client, ctx.signal);
		await client.deleteDocument(source.id);
		memories = await native.capture(client, ctx.signal);
		if (memories.some((m) => m.document_id === source.id))
			throw new NativeMemoryError("memory_dependency_cleanup_incomplete", true);
	}
	function resetSubmission(tx: Tx, step: RepairPlan["steps"][number]) {
		step.operationId = randomUUID();
		step.submittedContext = undefined;
		tx.update(memorySourceRevisions)
			.set({
				nativeSubmitted: false,
				nativeAcknowledged: false,
				nativeOperationId: step.operationId,
				acknowledgedFactsJson: "[]",
			})
			.where(eq(memorySourceRevisions.id, step.replacementId))
			.run();
	}
	function verifyWithdrawn(tx: Tx) {
		for (const step of withdrawnSteps)
			if (!withdrawnDependencySourceId(tx, ctx.row, step.originalId))
				throw new NativeMemoryError("memory_dependency_source_changed", true);
	}
	for (const step of withdrawnSteps) {
		// Both the old assertion and any unaccepted repair of it are deletion-only.
		const original = sourceById(step.originalId);
		const discarded = db
			.select()
			.from(memorySourceRevisions)
			.where(eq(memorySourceRevisions.id, step.replacementId))
			.get();
		if (
			discarded &&
			(discarded.predecessorSourceId !== original.id ||
				discarded.userId !== original.userId ||
				discarded.bankId !== original.bankId ||
				discarded.epoch !== original.epoch ||
				discarded.acceptedGeneration !== null)
		)
			throw new NativeMemoryError("memory_dependency_source_changed", true);
		for (const source of discarded ? [original, discarded] : [original]) {
			const live = memories.some((m) => m.document_id === source.id);
			// A submitted document can still exist when extraction returned no facts.
			if (source.nativeSubmitted || live) await deleteRepairDocument(source);
		}
		if (step.deleted && (!discarded || discarded.state === "revoked")) continue;
		await checkpoint((tx) => {
			fence(tx);
			if (!withdrawnDependencySourceId(tx, ctx.row, original.id))
				throw new NativeMemoryError("memory_dependency_source_changed", true);
			step.deleted = true;
			if (discarded)
				tx.update(memorySourceRevisions)
					.set({ state: "revoked" })
					.where(eq(memorySourceRevisions.id, discarded.id))
					.run();
			return active;
		});
	}
	// A sibling cleanup can discover the base reply and another attempt's
	// staged document. Rebuild the authored reply once and discard its draft.
	for (const { step, source } of unfinished) {
		if (source.state === "revoked" && step.deleted) continue;
		if (source.nativeSubmitted) await deleteRepairDocument(source);
		await checkpoint((tx) => {
			fence(tx);
			step.deleted = true;
			tx.update(memorySourceRevisions)
				.set({ state: "revoked" })
				.where(eq(memorySourceRevisions.id, source.id))
				.run();
			return active;
		});
	}
	if (input.compensate) {
		for (const step of steps) {
			if (step.compensating) continue;
			const original = sourceById(step.originalId);
			const previousRestore = db
				.select()
				.from(memorySourceRevisions)
				.where(
					and(
						eq(memorySourceRevisions.userId, ctx.row.userId),
						eq(
							memorySourceRevisions.eventId,
							`${ownRepairPrefix}${original.id}:restore`,
						),
					),
				)
				.get();
			if (
				previousRestore &&
				(previousRestore.bankId !== original.bankId ||
					previousRestore.epoch !== original.epoch ||
					previousRestore.predecessorSourceId !== original.id ||
					previousRestore.conversationId !== original.conversationId ||
					previousRestore.messageId !==
						sourceById(liveSources.get(original.id) ?? original.id).messageId ||
					previousRestore.lineageId !== original.lineageId ||
					previousRestore.textHash !== original.textHash ||
					previousRestore.state !== "repair_held" ||
					previousRestore.acceptedGeneration !== null)
			)
				throw new NativeMemoryError("memory_dependency_source_changed", true);
			const discarded = db
				.select()
				.from(memorySourceRevisions)
				.where(eq(memorySourceRevisions.id, step.replacementId))
				.get();
			if (discarded?.nativeSubmitted) {
				db.transaction((tx) => fence(tx, true));
				if (!discarded.nativeAcknowledged && discarded.nativeOperationId)
					await native.settle(
						client,
						[discarded.nativeOperationId],
						ctx.signal,
						true,
						"retain",
					);
				db.transaction((tx) => fence(tx, true));
				await client.deleteDocument(discarded.id);
				memories = await native.capture(client, ctx.signal);
				if (memories.some((m) => m.document_id === discarded.id))
					throw new NativeMemoryError("memory_edit_restore_incomplete", true);
			}
			if (
				previousRestore &&
				(previousRestore.nativeSubmitted ||
					memories.some((memory) => memory.document_id === previousRestore.id))
			)
				await deleteRepairDocument(previousRestore);
			await checkpoint((tx) => {
				fence(tx, true);
				if (discarded)
					tx.update(memorySourceRevisions)
						.set({ state: "revoked" })
						.where(eq(memorySourceRevisions.id, discarded.id))
						.run();
				step.replacementId = previousRestore?.id ?? randomUUID();
				step.operationId = randomUUID();
				step.compensating = true;
				step.submittedContext = undefined;
				if (previousRestore)
					tx.update(memorySourceRevisions)
						.set({
							state: "repair_held",
							controlRevision: ctx.row.controlRevision,
							nativeOperationId: step.operationId,
							nativeSubmitted: false,
							nativeAcknowledged: false,
							acknowledgedFactsJson: "[]",
						})
						.where(eq(memorySourceRevisions.id, previousRestore.id))
						.run();
				return active;
			});
		}
	}
	// Complete cleanup even while off, but never send any retain under disabled controls.
	for (const step of steps) {
		const original = sourceById(step.originalId);
		if (!step.deleted || memories.some((m) => m.document_id === original.id)) {
			db.transaction((tx) => assertStepCurrent(tx, original.id));
			await deleteRepairDocument(original);
			await checkpoint((tx) => {
				fence(tx);
				step.deleted = true;
				return active;
			});
		}
	}
	if (!steps.length)
		return {
			memories,
			originalFacts,
			withdrawnFactIds,
			withdrawnSourceIds: withdrawals,
			sourceIds: [] as string[],
			sourceAssertions: [],
			assertContextCurrent: undefined,
			replays: [],
			apply: (tx: Tx) => {
				fence(tx);
				verifyWithdrawn(tx);
			},
		};
	async function pauseIfDisabled() {
		if (
			db
				.select({ enabled: users.memoryEnabled })
				.from(users)
				.where(eq(users.id, ctx.row.userId))
				.get()?.enabled
		)
			return;
		for (const step of steps) {
			const replacement = db
				.select()
				.from(memorySourceRevisions)
				.where(eq(memorySourceRevisions.id, step.replacementId))
				.get();
			if (!replacement?.nativeSubmitted) continue;
			if (!replacement.nativeAcknowledged && replacement.nativeOperationId)
				await native.settle(
					client,
					[replacement.nativeOperationId],
					ctx.signal,
					true,
					"retain",
				);
			await client.deleteDocument(replacement.id);
			const remaining = await native.capture(client, ctx.signal);
			if (remaining.some((m) => m.document_id === replacement.id))
				throw new NativeMemoryError(
					"memory_dependency_cleanup_incomplete",
					true,
				);
			await checkpoint((tx) => {
				fence(tx);
				resetSubmission(tx, step);
				return active;
			});
		}
		throw new NativeMemoryError("memory_dependency_repair_paused", true);
	}
	await pauseIfDisabled();
	if (
		sourceCleanup &&
		db.transaction((tx) => {
			const bank = fence(tx, true);
			return tx
				.select({ id: memoryActions.id })
				.from(memoryActions)
				.where(
					and(
						eq(memoryActions.userId, ctx.row.userId),
						eq(memoryActions.bankId, bank.id),
						eq(memoryActions.epoch, bank.epoch),
						eq(memoryActions.kind, "edit"),
						eq(memoryActions.cleanupPending, true),
						sql`json_extract(${memoryActions.intentJson}, '$.rollbackPending') = 1`,
						or(
							sql`exists (
								select 1 from json_each(${memoryActions.intentJson}, '$.sourceIds')
								where value in ${withdrawals}
							)`,
							sql`exists (
								select 1 from json_each(${memoryActions.intentJson}, '$.dependencyRepair.steps')
								where json_extract(value, '$.originalId') in ${withdrawals}
							)`,
						),
					),
				)
				.get();
		})
	)
		throw new NativeMemoryError("memory_dependency_restore_pending", true);
	try {
		for (const step of steps) {
			const original = sourceById(step.originalId);
			const staged = db
				.select()
				.from(memorySourceRevisions)
				.where(eq(memorySourceRevisions.id, step.replacementId))
				.get();
			if (
				staged?.nativeSubmitted &&
				step.submittedContext !== undefined &&
				db.transaction((tx) => resolveContext(tx, step)) !==
					step.submittedContext
			) {
				if (
					staged.state !== "repair_held" ||
					staged.acceptedGeneration !== null ||
					staged.predecessorSourceId !== original.id ||
					staged.userId !== ctx.row.userId ||
					staged.bankId !== ctx.row.bankId ||
					staged.epoch !== ctx.row.epoch
				)
					throw new NativeMemoryError("memory_dependency_source_changed", true);
				await deleteRepairDocument(staged);
				await checkpoint((tx) => {
					assertStepCurrent(tx, original.id, true);
					resetSubmission(tx, step);
					return active;
				});
			}
			await write(ctx, (tx) => {
				const { live } = assertStepCurrent(tx, original.id, true);
				const context = JSON.stringify({
					...stepContext(
						original.context,
						(id) =>
							replacements.get(physicalId(id)) ??
							steps.find((step) => step.originalId === physicalId(id))
								?.replacementId ??
							id,
					),
					withdrawnSourceIds: withdrawals,
				});
				tx.insert(memorySourceRevisions)
					.values({
						...original,
						context,
						messageId: live.messageId,
						createdAt: new Date(),
						id: step.replacementId,
						eventId: `${ownRepairPrefix}${original.id}${step.compensating ? ":restore" : ""}`,
						predecessorSourceId: original.id,
						nativeOperationId: step.operationId,
						nativeSubmitted: false,
						nativeAcknowledged: false,
						acceptedGeneration: null,
						acknowledgedFactsJson: "[]",
						state: "repair_held",
						controlRevision: ctx.row.controlRevision,
					})
					.onConflictDoNothing()
					.run();
				tx.update(memorySourceRevisions)
					.set({ context })
					.where(
						and(
							eq(memorySourceRevisions.id, step.replacementId),
							eq(memorySourceRevisions.nativeSubmitted, false),
						),
					)
					.run();
			});
			let replacement = sourceById(step.replacementId);
			if (!replacement.nativeAcknowledged) {
				await write(ctx, (tx) => {
					fence(tx, true);
					tx.update(memorySourceRevisions)
						.set({ nativeSubmitted: true })
						.where(eq(memorySourceRevisions.id, replacement.id))
						.run();
				});
				ctx.signal.throwIfAborted();

				const context = db.transaction((tx) => resolveContext(tx, step));
				await checkpoint((tx) => {
					fence(tx, true);
					step.submittedContext = context;
					return active;
				});
				// Recheck after persisting the exact context used by the preservation check.
				ctx.signal.throwIfAborted();
				if (db.transaction((tx) => resolveContext(tx, step)) !== context)
					throw new NativeMemoryError(
						"memory_dependency_context_changed",
						true,
					);
				await native.settle(
					client,
					await client.retain(
						{
							content: original.text,
							context,
							timestamp: (
								original.explicitEditAt ?? original.assertedAt
							).toISOString(),
							document_id: replacement.id,
							tags: [replacement.id],
							metadata: {
								source_revision: replacement.id,
								lineage: original.lineageId,
							},
						},
						step.operationId,
					),
					ctx.signal,
					false,
					"retain",
				);
				await write(ctx, (tx) => {
					fence(tx, true);
					tx.update(memorySourceRevisions)
						.set({ nativeAcknowledged: true })
						.where(eq(memorySourceRevisions.id, replacement.id))
						.run();
				});
			}
			replacement = sourceById(step.replacementId);
			replayed.push(await input.replay(replacement, original));
			await native.settle(client, [await client.consolidate()], ctx.signal);
			memories = await native.capture(client, ctx.signal);
			await write(ctx, (tx) => {
				fence(tx, true);
				tx.update(memorySourceRevisions)
					.set({
						acknowledgedFactsJson: JSON.stringify(
							memories
								.filter(
									(m) =>
										m.fact_type !== "observation" &&
										m.document_id === replacement.id,
								)
								.map(({ id, text }) => ({ id, text })),
						),
					})
					.where(eq(memorySourceRevisions.id, replacement.id))
					.run();
			});
		}
	} finally {
		await pauseIfDisabled();
	}

	const sourceIds = steps.map((s) => s.replacementId);
	const sourceAssertions = steps.map((step) => {
		const original = sourceById(step.originalId);
		const withdrawnContextSourceIds = new Set<string>();
		for (const sourceId of contextSourceIds(original)) {
			const id = withdrawnOriginals.get(sourceId) ?? sourceId;
			if (withdrawals.includes(id)) withdrawnContextSourceIds.add(id);
		}
		return {
			id: step.replacementId,
			originalSourceId: step.originalId,
			assertion: original.text,
			priorContext: step.submittedContext ?? "",
			withdrawnContextSourceIds: [...withdrawnContextSourceIds],
		};
	});
	const replays = replayed.flatMap((replay) => replay.checks);
	await input.verify?.({
		originalFacts,
		withdrawnFactIds,
		withdrawnSourceIds: withdrawals,
		memories,
		sourceIds,
		sourceAssertions,
		assertContextCurrent,
		replays,
	});
	return {
		memories,
		originalFacts,
		withdrawnFactIds,
		withdrawnSourceIds: withdrawals,
		sourceIds,
		sourceAssertions,
		assertContextCurrent,
		replays,
		apply: (tx: Tx) => {
			assertMemoryBankFence(tx, ctx.row.userId, ctx.row.bankId, ctx.row.epoch);
			fence(tx, true);
			verifyWithdrawn(tx);
			for (const replay of replayed) replay.apply(tx, memories);
			for (const step of steps) {
				const { live } = assertStepCurrent(tx, step.originalId, true);
				if (sourceById(step.replacementId).messageId !== live.messageId)
					throw new NativeMemoryError("memory_dependency_source_changed", true);
				tx.update(memorySourceRevisions)
					.set({ state: "revoked" })
					.where(inArray(memorySourceRevisions.id, [step.originalId, live.id]))
					.run();
				tx.update(memorySourceRevisions)
					.set({ state: "staged" })
					.where(eq(memorySourceRevisions.id, step.replacementId))
					.run();
			}
		},
	};
}
