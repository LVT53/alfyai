import { randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
	memoryActions,
	memoryBanks,
	memoryRevocations,
	memorySourceRevisions,
} from "$lib/server/db/schema";
import type { Tx } from "../jobs/types";
import { NativeMemoryError } from "./contracts";
import { carriedMemorySources } from "./curation-lineage";

type Source = typeof memorySourceRevisions.$inferSelect;
const LIMIT = 64;

/** A revoked revision can also be a superseded repair. Require exact withdrawal authority. */
export function withdrawnDependencySourceId(
	tx: Tx,
	owner: Pick<Source, "userId" | "bankId" | "epoch">,
	sourceId: string,
) {
	const source = tx
		.select()
		.from(memorySourceRevisions)
		.where(
			and(
				eq(memorySourceRevisions.id, sourceId),
				eq(memorySourceRevisions.userId, owner.userId),
				eq(memorySourceRevisions.bankId, owner.bankId),
				eq(memorySourceRevisions.epoch, owner.epoch),
			),
		)
		.get();
	if (!source) return;
	const sourceIds = [source.id];
	if (
		source.predecessorSourceId &&
		source.eventId.startsWith("dependency:") &&
		source.state !== "accepted" &&
		source.acceptedGeneration === null
	)
		sourceIds.push(source.predecessorSourceId);
	const withdrawn = tx
		.select({ id: memorySourceRevisions.id })
		.from(memorySourceRevisions)
		.innerJoin(
			memoryRevocations,
			and(
				eq(memoryRevocations.sourceId, memorySourceRevisions.id),
				eq(memoryRevocations.userId, owner.userId),
				eq(memoryRevocations.bankId, owner.bankId),
				eq(memoryRevocations.epoch, owner.epoch),
			),
		)
		.where(
			and(
				inArray(memorySourceRevisions.id, sourceIds),
				eq(memorySourceRevisions.userId, owner.userId),
				eq(memorySourceRevisions.bankId, owner.bankId),
				eq(memorySourceRevisions.epoch, owner.epoch),
				eq(memorySourceRevisions.state, "revoked"),
				eq(memorySourceRevisions.lineageId, source.lineageId),
				eq(memorySourceRevisions.textHash, source.textHash),
				sql`${memorySourceRevisions.conversationId} IS ${source.conversationId}`,
				sql`${memorySourceRevisions.messageId} IS ${source.messageId}`,
			),
		)
		.get();
	return withdrawn?.id;
}

/** A staged repair of another planned reply contributes no separate assertion. */
export function unfinishedDependencyDraft(
	tx: Tx,
	owner: Pick<Source, "userId" | "bankId" | "epoch">,
	originalIds: ReadonlySet<string>,
	sourceId: string,
) {
	const source = tx
		.select()
		.from(memorySourceRevisions)
		.where(eq(memorySourceRevisions.id, sourceId))
		.get();
	if (
		!source ||
		source.acceptedGeneration ||
		!source.eventId.startsWith("dependency:") ||
		!source.predecessorSourceId ||
		!originalIds.has(source.predecessorSourceId)
	)
		return undefined;
	const predecessor = tx
		.select()
		.from(memorySourceRevisions)
		.where(eq(memorySourceRevisions.id, source.predecessorSourceId))
		.get();
	if (
		!predecessor ||
		source.userId !== owner.userId ||
		source.bankId !== owner.bankId ||
		source.epoch !== owner.epoch ||
		source.userId !== predecessor.userId ||
		source.bankId !== predecessor.bankId ||
		source.epoch !== predecessor.epoch ||
		source.conversationId !== predecessor.conversationId ||
		source.lineageId !== predecessor.lineageId ||
		source.textHash !== predecessor.textHash
	)
		throw new NativeMemoryError("memory_dependency_source_changed", true);
	return source;
}

/** Corrections saved after an exact resend are carried through accepted action receipts. */
function correctionCarriers(
	tx: Tx,
	userId: string,
	bankId: string,
	epoch: number,
	roots: string[],
) {
	const scoped = and(
		eq(memorySourceRevisions.userId, userId),
		eq(memorySourceRevisions.bankId, bankId),
		eq(memorySourceRevisions.epoch, epoch),
	);
	const corrections = new Set(
		tx
			.select({ id: memorySourceRevisions.id })
			.from(memorySourceRevisions)
			.innerJoin(
				memoryActions,
				and(
					eq(memoryActions.userId, userId),
					eq(memoryActions.bankId, bankId),
					eq(memoryActions.epoch, epoch),
					eq(memoryActions.kind, "edit"),
					sql`${memorySourceRevisions.eventId} = 'manual:' || ${memoryActions.id}`,
					sql`json_extract(${memoryActions.intentJson}, '$.addedSourceId') = ${memorySourceRevisions.id}`,
					sql`json_extract(${memoryActions.intentJson}, '$.outcome') = 'accepted'`,
				),
			)
			.where(and(scoped, inArray(memorySourceRevisions.id, roots)))
			.all()
			.map(({ id }) => id),
	);
	if (!corrections.size) return [];
	// Finding candidates by exact saved inputs keeps unrelated resends out of
	// the owner check. Walk across successive correction receipts as needed.
	const inputs = tx.all<{
		conversationId: string | null;
		lineageId: string | null;
	}>(
		sql`
			WITH RECURSIVE correction_inputs(id) AS (
				SELECT id FROM memory_source_revisions
				WHERE id IN (${sql.join(
					[...corrections].map((id) => sql`${id}`),
					sql`, `,
				)})
				UNION
				SELECT input.value
				FROM correction_inputs
				JOIN memory_source_revisions revision ON revision.id = correction_inputs.id
				JOIN memory_actions action ON action.id = substr(revision.event_id, 8)
				JOIN json_each(action.intent_json, '$.sourceIds') input
				WHERE revision.user_id = ${userId} AND revision.bank_id = ${bankId}
					AND revision.epoch = ${epoch} AND revision.event_id = 'manual:' || action.id
					AND action.user_id = ${userId} AND action.bank_id = ${bankId}
					AND action.epoch = ${epoch} AND action.kind = 'edit'
					AND json_extract(action.intent_json, '$.outcome') = 'accepted'
					AND json_extract(action.intent_json, '$.addedSourceId') = revision.id
				LIMIT ${LIMIT + 1}
			)
			SELECT revision.conversation_id AS conversationId, revision.lineage_id AS lineageId
			FROM correction_inputs
			LEFT JOIN memory_source_revisions revision ON revision.id = correction_inputs.id
				AND revision.user_id = ${userId} AND revision.bank_id = ${bankId} AND revision.epoch = ${epoch}
		`,
	);
	if (inputs.length > LIMIT)
		throw new NativeMemoryError("memory_dependency_limit", false);
	const lineages = inputs.flatMap(({ conversationId, lineageId }) =>
		conversationId && lineageId
			? [
					and(
						eq(memorySourceRevisions.conversationId, conversationId),
						eq(memorySourceRevisions.lineageId, lineageId),
					),
				]
			: [],
	);
	if (!lineages.length) return [];
	const bank = tx
		.select()
		.from(memoryBanks)
		.where(
			and(
				eq(memoryBanks.id, bankId),
				eq(memoryBanks.userId, userId),
				eq(memoryBanks.epoch, epoch),
			),
		)
		.get();
	if (!bank?.generation) return [];
	const carriers = tx
		.select()
		.from(memorySourceRevisions)
		.where(
			and(
				scoped,
				eq(memorySourceRevisions.state, "accepted"),
				eq(memorySourceRevisions.acceptedGeneration, bank.generation),
				sql`${memorySourceRevisions.predecessorSourceId} IS NOT NULL`,
				or(...lineages),
			),
		)
		.all();
	const result: string[] = [];
	for (const carrier of carriers) {
		if (
			carriedMemorySources(tx, carrier, bank)?.some(({ id }) =>
				corrections.has(id),
			)
		)
			result.push(carrier.id);
		if (result.length > LIMIT)
			throw new NativeMemoryError("memory_dependency_limit", false);
	}
	return result;
}

/** Exact stored provenance only. Discovery is bounded before any mutation or acknowledgement. */
export function holdExplicitDependents(
	tx: Tx,
	userId: string,
	bankId: string,
	epoch: number,
	roots: string[],
): Source[] {
	const seen = new Set(roots);
	const rootCount = seen.size;
	const rootIds = new Set(roots);
	const dependents = new Map<string, Source>();
	const lateCarriers = correctionCarriers(tx, userId, bankId, epoch, roots);
	for (const carrier of lateCarriers) seen.add(carrier);
	let frontier = [...seen];
	while (frontier.length) {
		const ids = sql.join(
			frontier.map((id) => sql`${id}`),
			sql`, `,
		);
		const context = sql`CASE WHEN json_valid(${memorySourceRevisions.context}) THEN ${memorySourceRevisions.context} ELSE '{}' END`;
		const depends = sql<number>`EXISTS (
			SELECT 1 FROM json_each(${context}, '$.messages') dependency
			WHERE json_extract(dependency.value, '$.sourceId') IN (${ids})
		)`;
		// A physical owner can feed later replies through a logical chat
		// revision. Walk that edge without treating the carrier as a reply.
		const rows = tx
			.select({ source: memorySourceRevisions, depends })
			.from(memorySourceRevisions)
			.where(
				and(
					eq(memorySourceRevisions.userId, userId),
					eq(memorySourceRevisions.bankId, bankId),
					eq(memorySourceRevisions.epoch, epoch),
					inArray(memorySourceRevisions.state, [
						"pending",
						"staged",
						"accepted",
						"repair_held",
					]),
					sql`(${depends} OR (
						${memorySourceRevisions.acceptedGeneration} IS NOT NULL
						AND (
							EXISTS (
								SELECT 1 FROM json_each(${context}, '$.carriedSourceIds') owner
								WHERE owner.value IN (${ids})
							)
							OR EXISTS (
								SELECT 1 FROM memory_actions action
								JOIN json_each(action.intent_json, '$.sourceIds') owner
								WHERE action.kind = 'source_edit'
									AND action.request_id = ${memorySourceRevisions.id}
									AND action.user_id = ${memorySourceRevisions.userId}
									AND action.bank_id = ${memorySourceRevisions.bankId}
									AND action.epoch = ${memorySourceRevisions.epoch}
									AND json_extract(action.intent_json, '$.outcome') = 'accepted'
									AND owner.value IN (${ids})
							)
						)
					))`,
				),
			)
			.limit(LIMIT + 1)
			.all();
		frontier = [];
		for (const { source, depends } of rows) {
			if (depends && !rootIds.has(source.id)) dependents.set(source.id, source);
			if (seen.has(source.id)) continue;
			seen.add(source.id);
			frontier.push(source.id);
		}
		if (rows.length > LIMIT || seen.size > rootCount + LIMIT)
			throw new NativeMemoryError("memory_dependency_limit", false);
	}
	// Queued unsent sources are handled by the final live-context resolver, never promoted into repair work.
	const submitted = [...dependents.values()].filter(
		(source) => source.nativeSubmitted,
	);
	const ordered = orderDependencySources(submitted);
	if (submitted.length)
		tx.update(memorySourceRevisions)
			.set({ state: "repair_held" })
			.where(
				inArray(
					memorySourceRevisions.id,
					submitted.map((s) => s.id),
				),
			)
			.run();
	return ordered;
}

export function orderDependencySources<
	T extends Pick<Source, "id" | "context">,
>(sources: T[]): T[] {
	if (sources.length > LIMIT)
		throw new NativeMemoryError("memory_dependency_limit", false);
	const ordered: T[] = [];
	const waiting = new Map(sources.map((source) => [source.id, source]));
	while (waiting.size) {
		const ready = [...waiting.values()].filter((source) => {
			const envelope = JSON.parse(source.context) as {
				messages?: Array<{ sourceId?: string }>;
			};
			return !(envelope.messages ?? []).some(
				(message) => message.sourceId && waiting.has(message.sourceId),
			);
		});
		if (!ready.length)
			throw new NativeMemoryError("memory_dependency_cycle", false);
		for (const source of ready) {
			ordered.push(source);
			waiting.delete(source.id);
		}
	}
	return ordered;
}
type RepairStep = {
	originalId: string;
	replacementId: string;
	operationId: string;
	deleted: boolean;
	submittedContext?: string;
	compensating?: boolean;
};
export type RepairPlan = {
	version: 1;
	bankId: string;
	epoch: number;
	revision: number;
	roots: string[];
	steps: RepairStep[];
	originalFacts: Array<{ id: string; text: string; sourceId: string }>;
};
export function createDependencyRepairPlan(
	tx: Tx,
	userId: string,
	bankId: string,
	epoch: number,
	roots: string[],
): RepairPlan {
	const sources = holdExplicitDependents(tx, userId, bankId, epoch, roots);
	return {
		version: 1,
		bankId,
		epoch,
		revision: 0,
		roots,
		steps: sources.map((s) => ({
			originalId: s.id,
			replacementId: randomUUID(),
			operationId: randomUUID(),
			deleted: !s.nativeSubmitted,
		})),
		originalFacts: sources.flatMap((s) =>
			(
				JSON.parse(s.acknowledgedFactsJson) as Array<{
					id: string;
					text: string;
				}>
			).map(({ id, text }) => ({ id, text, sourceId: s.id })),
		),
	};
}

export function readDependencyRepairPlan(
	json: string,
	owner: Pick<RepairPlan, "bankId" | "epoch">,
): RepairPlan | undefined {
	const parsed = JSON.parse(json) as {
		dependencyRepair?: RepairPlan;
	};
	const plan = parsed.dependencyRepair;
	if (
		plan &&
		(plan.version !== 1 ||
			plan.bankId !== owner.bankId ||
			plan.epoch !== owner.epoch ||
			!Array.isArray(plan.steps) ||
			plan.steps.length > LIMIT)
	)
		throw new NativeMemoryError("memory_dependency_plan_corrupt", false);
	return plan;
}
