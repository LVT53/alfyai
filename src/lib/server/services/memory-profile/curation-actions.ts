import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { MemoryOperation, MemoryScope } from "$lib/memory-types";
import { db } from "$lib/server/db";
import {
	conversations,
	memoryAccounts,
	memoryActions,
	memoryBanks,
	memoryDeliveryJobs,
	memoryRevocations,
	memorySourceRevisions,
} from "$lib/server/db/schema";
import { enqueueAtomic, retry } from "../jobs";
import { type ActionIntentRecord, parseActionIntent } from "./curation-intent";
import { memoryDeliveryJob, resumeDependencyRepairs } from "./delivery-job";
import { createDependencyRepairPlan } from "./dependency-plan";
import { isJsonRecord } from "./internal-json";
import { MemoryRequestError, parseMemoryAction } from "./memory-request";
import {
	getMemoryDetail,
	readMemoryScope,
	verifiedMemoryHistory,
} from "./native-read";
import {
	assertCurationPublication,
	readAcknowledgedFacts,
	readPublishedMemory,
} from "./publication";
import { ensureMemoryBank, memoryTextHash } from "./revisions";
export async function submitMemoryAction(
	userId: string,
	payload: unknown,
	originConversationId?: string,
): Promise<MemoryOperation> {
	const action = parseMemoryAction(payload);
	const scope = action.kind === "add" ? action.scope : action.ref.scope;
	const info = readMemoryScope(userId, scope);
	if (!info.user.memoryEnabled) throw new MemoryRequestError("memory_off", 409);
	if (info.account?.authority !== "hindsight")
		throw new MemoryRequestError("memory_not_ready", 409);
	let existing = db
		.select()
		.from(memoryActions)
		.where(
			and(
				eq(memoryActions.userId, userId),
				eq(memoryActions.requestId, action.requestId),
			),
		)
		.get();
	if (existing) {
		const saved = parseActionIntent(existing.intentJson);
		if (JSON.stringify(saved.request) !== JSON.stringify(action))
			throw new MemoryRequestError("request_conflict", 409);
		const job = db
			.select()
			.from(memoryDeliveryJobs)
			.where(
				and(
					eq(memoryDeliveryJobs.userId, userId),
					eq(memoryDeliveryJobs.actionId, existing.id),
				),
			)
			.get();
		if (saved.rollbackPending && job?.status === "cancelled") {
			await resumeDependencyRepairs(userId);
		} else if (job?.status === "failed" && job.retryable)
			await retry(memoryDeliveryJob, job.id, { userId });
		return getMemoryOperation(userId, { id: existing.id });
	}
	const bank = ensureMemoryBank(userId, scope);
	await enqueueAtomic(memoryDeliveryJob, (tx) => {
		// Recheck inside the atomic action/revocation/job transaction.
		const account = tx
			.select()
			.from(memoryAccounts)
			.where(eq(memoryAccounts.userId, userId))
			.get();
		const current = tx
			.select()
			.from(memoryBanks)
			.where(eq(memoryBanks.id, bank.id))
			.get();
		if (
			!account ||
			account.authority !== "hindsight" ||
			account.epoch !== bank.epoch ||
			!current
		)
			throw new MemoryRequestError("stale_memory", 409);
		existing = tx
			.select()
			.from(memoryActions)
			.where(
				and(
					eq(memoryActions.userId, userId),
					eq(memoryActions.requestId, action.requestId),
				),
			)
			.get();
		if (existing) {
			if (
				JSON.stringify(parseActionIntent(existing.intentJson).request) !==
				JSON.stringify(action)
			)
				throw new MemoryRequestError("request_conflict", 409);
			return [];
		}
		try {
			assertCurationPublication(tx, bank.id, bank.epoch);
		} catch (error) {
			if (
				error instanceof Error &&
				error.message === "memory_curation_publication_held"
			)
				throw new MemoryRequestError("memory_action_pending", 409);
			throw error;
		}
		let before = "";
		let previousResultActionId: string | undefined;
		let sourceIds: string[] = [];
		let facts: ActionIntentRecord["facts"] = [];
		let targetIds = new Set<string>();
		if (action.kind !== "add") {
			if (current.generation !== action.ref.generation)
				throw new MemoryRequestError("stale_memory", 409);
			{
				const pending = tx
					.select()
					.from(memoryDeliveryJobs)
					.where(
						and(
							eq(memoryDeliveryJobs.bankId, bank.id),
							eq(memoryDeliveryJobs.kind, "action"),
						),
					)
					.all();
				if (
					pending.some((j) => j.status === "queued" || j.status === "running")
				)
					throw new MemoryRequestError("memory_action_pending", 409);
			}
			getMemoryDetail(userId, action.ref);
			const row = readPublishedMemory(
				userId,
				bank.id,
				action.ref.generation,
			).find((r) => r.nativeId === action.ref.rowId);
			if (!row) throw new MemoryRequestError("stale_memory", 409);
			before = row.text;
			if (action.kind === "edit") {
				const previous = verifiedMemoryHistory(
					userId,
					bank.id,
					bank.epoch,
					row.nativeId,
				)[0];
				if (
					previous?.kind === "edit" &&
					parseActionIntent(previous.intentJson).resultSupport
				)
					previousResultActionId = previous.id;
			}
			targetIds = new Set(
				readAcknowledgedFacts(row.sourceFingerprintsJson).map((f) => f.id),
			);
			const sources = tx
				.select()
				.from(memorySourceRevisions)
				.where(
					and(
						eq(memorySourceRevisions.bankId, bank.id),
						eq(memorySourceRevisions.state, "accepted"),
					),
				)
				.all()
				.filter((s) =>
					readAcknowledgedFacts(s.acknowledgedFactsJson).some((f) =>
						targetIds.has(f.id),
					),
				);
			sourceIds = sources.map((s) => s.id);
			facts = sources.flatMap((s) =>
				readAcknowledgedFacts(s.acknowledgedFactsJson).map((f) => ({
					...f,
					sourceId: s.id,
				})),
			);
			if (!sourceIds.length || facts.length > 100)
				throw new MemoryRequestError("memory_edit_too_large", 422);
		}
		const dependencyRepair =
			action.kind === "remove"
				? createDependencyRepairPlan(tx, userId, bank.id, bank.epoch, sourceIds)
				: undefined;
		const id = randomUUID();
		const intent: ActionIntentRecord = {
			revision: current.revision,
			dependencyRepair,
			originConversationId,
			previousResultActionId,
			request: action,
			before,
			sourceIds,
			facts,
		};
		tx.insert(memoryActions)
			.values({
				id,
				userId,
				bankId: bank.id,
				epoch: bank.epoch,
				requestId: action.requestId,
				kind: action.kind,
				generation: action.kind === "add" ? null : action.ref.generation,
				rowId: action.kind === "add" ? null : action.ref.rowId,
				text: action.kind === "remove" ? null : action.text,
				previousText: action.kind === "add" ? null : before,
				intentJson: JSON.stringify(intent),
				exclusionAcknowledged: action.kind === "remove",
				cleanupPending: action.kind === "remove",
			})
			.run();
		if (action.kind === "remove")
			for (const fact of facts.filter((f) => targetIds.has(f.id)))
				tx.insert(memoryRevocations)
					.values({
						id: randomUUID(),
						userId,
						bankId: bank.id,
						epoch: bank.epoch,
						nativeFactId: fact.id,
						nativeTextHash: memoryTextHash(fact.text),
						actionId: id,
					})
					.run();
		return [
			{
				values: {
					userId,
					bankId: bank.id,
					epoch: bank.epoch,
					kind: "action",
					actionId: id,
					requestId: `action:${action.requestId}`,
					controlRevision: account.controlRevision,
				},
			},
		];
	});
	return getMemoryOperation(userId, { requestId: action.requestId });
}
export function getMemoryOperation(
	userId: string,
	lookup: { id?: string; requestId?: string },
): MemoryOperation {
	const action = db
		.select()
		.from(memoryActions)
		.where(
			and(
				eq(memoryActions.userId, userId),
				lookup.id
					? eq(memoryActions.id, lookup.id)
					: eq(memoryActions.requestId, lookup.requestId ?? ""),
			),
		)
		.get();
	if (!action) throw new MemoryRequestError("not_found", 404);
	const bank = db
		.select()
		.from(memoryBanks)
		.where(
			and(eq(memoryBanks.id, action.bankId), eq(memoryBanks.userId, userId)),
		)
		.get();
	const account = db
		.select()
		.from(memoryAccounts)
		.where(eq(memoryAccounts.userId, userId))
		.get();
	if (
		!bank ||
		account?.epoch !== action.epoch ||
		account.authority !== "hindsight"
	)
		throw new MemoryRequestError("not_found", 404);
	const job = db
		.select()
		.from(memoryDeliveryJobs)
		.where(
			and(
				eq(memoryDeliveryJobs.userId, userId),
				eq(memoryDeliveryJobs.actionId, action.id),
			),
		)
		.get();
	const intent = parseActionIntent(action.intentJson);
	if (!job && intent.outcome !== "accepted")
		throw new MemoryRequestError("operation_unavailable", 503);
	const status =
		intent.outcome === "accepted"
			? "applied"
			: job?.status === "running"
				? "working"
				: job?.status === "queued"
					? "queued"
					: job?.errorCode === "stale_memory"
						? "stale"
						: "failed";
	const scope: MemoryScope =
		bank.scopeKey === "personal"
			? { kind: "personal" }
			: { kind: "project", projectId: bank.scopeKey.slice(8) };
	return {
		id: action.id,
		status,
		retryable:
			intent.outcome !== "accepted" &&
			((job?.retryable ?? false) ||
				(intent.rollbackPending === true && job?.status === "cancelled")),
		errorCode: intent.outcome === "accepted" ? null : (job?.errorCode ?? null),
		exclusionAcknowledged: action.exclusionAcknowledged,
		cleanupPending: action.cleanupPending,
		ref:
			action.resultRowId && intent.resultGeneration
				? {
						scope,
						generation: intent.resultGeneration,
						rowId: action.resultRowId,
					}
				: null,
	};
}

export async function submitRememberNote(
	userId: string,
	body: unknown,
): Promise<MemoryOperation> {
	if (
		!isJsonRecord(body) ||
		typeof body.text !== "string" ||
		typeof body.requestId !== "string"
	)
		throw new MemoryRequestError("invalid_action");
	let scope: MemoryScope = { kind: "personal" };
	if (body.conversationId !== null && body.conversationId !== undefined) {
		if (typeof body.conversationId !== "string")
			throw new MemoryRequestError("invalid_action");
		const chat = db
			.select()
			.from(conversations)
			.where(
				and(
					eq(conversations.id, body.conversationId),
					eq(conversations.userId, userId),
				),
			)
			.get();
		const { isMemoryActiveForConversation } = await import(
			"../memory-controls"
		);
		if (
			!chat ||
			!(await isMemoryActiveForConversation({
				userId,
				conversationId: body.conversationId,
			}))
		)
			throw new MemoryRequestError("memory_unavailable", 409);
		scope = chat.projectId
			? { kind: "project", projectId: chat.projectId }
			: { kind: "personal" };
	}
	return submitMemoryAction(
		userId,
		{
			kind: "add",
			text: body.text,
			requestId: body.requestId,
			scope,
		},
		typeof body.conversationId === "string" ? body.conversationId : undefined,
	);
}
