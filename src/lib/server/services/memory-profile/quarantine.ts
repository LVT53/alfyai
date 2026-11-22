import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type {
	MemoryQuarantineCandidate as Candidate,
	MemoryQuarantine as View,
} from "$lib/memory-types";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import {
	memoryAccounts,
	memoryActions,
	memoryBanks,
	memoryDeliveryJobs,
	memoryMigrationManifests,
	memoryQuarantineDrafts,
	memoryQuarantineSessions,
	users,
} from "$lib/server/db/schema";
import { retry } from "../jobs";
import type { Tx } from "../jobs/types";
import type { ActionIntentRecord } from "./curation-intent";
import { enqueueMemoryMutation, memoryDeliveryJob } from "./delivery-job";
import { MemoryRequestError, parseMemoryAction } from "./memory-request";
import { inspectMemoryMigration } from "./migration-progress";
import { assertCurationPublication } from "./publication";
import {
	eligibleQuarantineSource,
	knownQuarantineWithdrawal,
	QUARANTINE_REVIEW_POLICY,
	type QuarantineSource,
	quarantineSessionFor,
} from "./quarantine-policy";
import { ensureMemoryBank, memoryTextHash } from "./revisions";

type Session = typeof memoryQuarantineSessions.$inferSelect;
type Draft = typeof memoryQuarantineDrafts.$inferSelect;
type Account = typeof memoryAccounts.$inferSelect;

type ResolveInput = {
	id: string;
	requestId: string;
	decision: "keep" | "discard";
	text?: string;
};

const unavailable = () =>
	new MemoryRequestError("memory_quarantine_unavailable", 409);
const stale = () => new MemoryRequestError("stale_memory", 409);
const requestIdValid = (value: string) =>
	typeof value === "string" && /^[-0-9a-f]{36}$/i.test(value);

/** Restored pending review drafts cannot be re-admitted from an old SQLite backup. */
export function purgeRestoredMemoryQuarantine() {
	if (!getConfig().hindsightRestoreHold) return;
	db.delete(memoryQuarantineSessions).run();
}

/** Operator-only grant after separate, explicit processing consent for a fixed inventory. */
export function authorizeMemoryQuarantine(
	userId: string,
	input: {
		email: string;
		manifestId: string;
		manifestHash: string;
		allowedCohortHash: string;
		deniedSourceIds: string[];
		cohortHash: string;
		cohortCount: number;
		cutoff: string;
	},
) {
	if (
		!getConfig().hindsightQuarantineEnabled ||
		typeof input.cutoff !== "string" ||
		typeof input.email !== "string" ||
		!input.email ||
		input.email.trim() !== input.email ||
		![input.cohortHash, input.manifestHash, input.allowedCohortHash].every(
			(hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
		) ||
		!Array.isArray(input.deniedSourceIds) ||
		input.deniedSourceIds.length > input.cohortCount ||
		input.deniedSourceIds.some(
			(id) => typeof id !== "string" || !id || id.length > 200,
		) ||
		new Set(input.deniedSourceIds).size !== input.deniedSourceIds.length ||
		!Number.isSafeInteger(input.cohortCount) ||
		input.cohortCount < 1 ||
		input.cohortCount > 1000
	)
		throw unavailable();
	return db.transaction((tx) => {
		const matches = tx
			.select({ id: users.id })
			.from(users)
			.where(sql`${users.email} COLLATE BINARY = ${input.email}`)
			.limit(2)
			.all();
		if (matches.length !== 1 || matches[0].id !== userId) throw unavailable();
		const account = tx
			.select()
			.from(memoryAccounts)
			.where(eq(memoryAccounts.userId, userId))
			.get();
		if (account?.historyCutoff?.toISOString() !== input.cutoff)
			throw unavailable();
		const manifest = tx
			.select()
			.from(memoryMigrationManifests)
			.where(
				and(
					eq(memoryMigrationManifests.userId, userId),
					eq(memoryMigrationManifests.id, input.manifestId),
				),
			)
			.get();
		if (
			!manifest ||
			memoryTextHash(manifest.manifestJson) !== input.manifestHash
		)
			throw unavailable();
		const existing = tx
			.select()
			.from(memoryQuarantineSessions)
			.where(eq(memoryQuarantineSessions.userId, userId))
			.get();
		if (
			existing &&
			(existing.manifestId !== input.manifestId ||
				existing.cohortCount !== input.cohortCount ||
				existing.cohortHash !== input.cohortHash ||
				existing.manifestHash !== input.manifestHash ||
				existing.allowedCohortHash !== input.allowedCohortHash)
		)
			throw stale();
		tx.insert(memoryQuarantineSessions)
			.values({
				userId,
				manifestId: input.manifestId,
				cohortHash: input.cohortHash,
				cohortCount: input.cohortCount,
				manifestHash: input.manifestHash,
				allowedCohortHash: input.allowedCohortHash,
				deniedSourceIdsJson: JSON.stringify([...input.deniedSourceIds].sort()),
				epoch: account.epoch,
				controlRevision: account.controlRevision,
				cutoff: account.historyCutoff,
				policyVersion: account.historyPolicyVersion,
				reviewPolicyVersion: QUARANTINE_REVIEW_POLICY,
			})
			.onConflictDoNothing()
			.run();
		const active = quarantineSessionFor(tx, userId);
		if (!active) throw unavailable();
		const inventory = inspectMemoryMigration(userId);
		const eligible = active.allowed.filter((source) =>
			eligibleQuarantineSource(tx, active, source, inventory),
		).length;
		return {
			cohortCount: active.cohort.length,
			operatorExcluded: active.deniedIds.size,
			dispatchEligible: eligible,
			heldBySourceFences: active.allowed.length - eligible,
		};
	});
}

function jobsFor(tx: Tx, session: Session) {
	return tx
		.select({ status: memoryDeliveryJobs.status })
		.from(memoryDeliveryJobs)
		.where(
			and(
				eq(memoryDeliveryJobs.userId, session.userId),
				eq(memoryDeliveryJobs.epoch, session.epoch),
				eq(memoryDeliveryJobs.kind, "quarantine_extract"),
				sql`${memoryDeliveryJobs.requestId} LIKE ${`quarantine:${session.startRequestId}:%`}`,
			),
		)
		.all();
}

function approvalRows(tx: Tx, userId: string) {
	return tx
		.select({
			id: memoryQuarantineDrafts.id,
			text: memoryActions.text,
			status: memoryDeliveryJobs.status,
			retryable: memoryDeliveryJobs.retryable,
		})
		.from(memoryQuarantineDrafts)
		.innerJoin(
			memoryActions,
			and(
				eq(memoryActions.userId, memoryQuarantineDrafts.userId),
				eq(memoryActions.requestId, memoryQuarantineDrafts.decisionRequestId),
			),
		)
		.innerJoin(
			memoryDeliveryJobs,
			and(
				eq(memoryDeliveryJobs.userId, memoryActions.userId),
				eq(memoryDeliveryJobs.actionId, memoryActions.id),
			),
		)
		.where(
			and(
				eq(memoryQuarantineDrafts.userId, userId),
				eq(memoryQuarantineDrafts.decision, "keep"),
			),
		)
		.all()
		.flatMap((row) =>
			row.text
				? [
						{
							id: row.id,
							text: row.text,
							status:
								row.status === "succeeded"
									? ("succeeded" as const)
									: row.status === "queued" || row.status === "running"
										? ("queued" as const)
										: ("failed" as const),
							retryable: row.status === "failed" && row.retryable,
						},
					]
				: [],
		);
}

export async function retryMemoryQuarantineApproval(
	userId: string,
	input: { id: string },
) {
	if (!requestIdValid(input.id)) throw new MemoryRequestError("invalid_action");
	const job = db.transaction((tx) => {
		if (!quarantineSessionFor(tx, userId)) throw unavailable();
		return tx
			.select({
				id: memoryDeliveryJobs.id,
				status: memoryDeliveryJobs.status,
				retryable: memoryDeliveryJobs.retryable,
			})
			.from(memoryQuarantineDrafts)
			.innerJoin(
				memoryActions,
				and(
					eq(memoryActions.userId, memoryQuarantineDrafts.userId),
					eq(memoryActions.requestId, memoryQuarantineDrafts.decisionRequestId),
				),
			)
			.innerJoin(
				memoryDeliveryJobs,
				and(
					eq(memoryDeliveryJobs.userId, memoryActions.userId),
					eq(memoryDeliveryJobs.actionId, memoryActions.id),
				),
			)
			.where(
				and(
					eq(memoryQuarantineDrafts.userId, userId),
					eq(memoryQuarantineDrafts.id, input.id),
					eq(memoryQuarantineDrafts.decision, "keep"),
				),
			)
			.get();
	});
	if (!job) throw stale();
	if (job.status === "failed" && job.retryable)
		await retry(memoryDeliveryJob, job.id, { userId });
	return getMemoryQuarantine(userId);
}

export function getMemoryQuarantine(userId: string): View {
	return db.transaction((tx) => {
		const active = quarantineSessionFor(tx, userId);
		if (!active) return { status: "unavailable", candidates: [] };
		if (!active.session.startRequestId)
			return { status: "idle", candidates: [] };
		const drafts = tx
			.select()
			.from(memoryQuarantineDrafts)
			.where(
				and(
					eq(memoryQuarantineDrafts.userId, userId),
					sql`${memoryQuarantineDrafts.decision} IS NULL`,
				),
			)
			.all();
		const current = drafts.length ? inspectMemoryMigration(userId) : undefined;
		const byId = new Map(active.cohort.map((source) => [source.id, source]));
		const candidates = drafts.flatMap((draft): Candidate[] => {
			const source = draft.messageId ? byId.get(draft.messageId) : undefined;
			if (
				!source?.conversationId ||
				!draft.text ||
				!current ||
				!eligibleQuarantineSource(tx, active, source, current)
			)
				return [];
			if (
				knownQuarantineWithdrawal(current, source, draft.text) ||
				knownQuarantineWithdrawal(active.inventory, source, draft.text)
			)
				return [];
			return [
				{
					id: draft.id,
					text: draft.text,
					scope: source.scope,
					source: {
						conversationId: source.conversationId,
						messageId: source.id,
						assertedAt: source.assertedAt,
					},
				},
			];
		});
		candidates.splice(50);
		const jobs = jobsFor(tx, active.session);
		const approvals = approvalRows(tx, userId);
		const view = { candidates, ...(approvals.length ? { approvals } : {}) };
		if (jobs.some(({ status }) => status === "queued" || status === "running"))
			return { status: "working", ...view };
		if (candidates.length) return { status: "pending", ...view };
		if (
			jobs.some(({ status }) => status === "failed" || status === "cancelled")
		)
			return { status: "held", ...view };
		return { status: "complete", ...view };
	});
}

export async function startMemoryQuarantine(
	userId: string,
	input: { requestId: string },
) {
	if (!requestIdValid(input.requestId))
		throw new MemoryRequestError("invalid_action");
	await enqueueMemoryMutation((tx) => {
		const active = quarantineSessionFor(tx, userId);
		if (!active) throw unavailable();
		if (active.session.startRequestId) {
			if (active.session.startRequestId !== input.requestId)
				throw new MemoryRequestError("request_conflict", 409);
			return [];
		}
		const current = inspectMemoryMigration(userId);
		const bank = tx
			.select()
			.from(memoryBanks)
			.where(
				and(
					eq(memoryBanks.userId, userId),
					eq(memoryBanks.epoch, active.session.epoch),
					eq(memoryBanks.scopeKey, "personal"),
				),
			)
			.get();
		if (!bank?.nativeBaseUrl || !bank.nativeCredentialHash) throw unavailable();
		tx.update(memoryQuarantineSessions)
			.set({ startRequestId: input.requestId, startedAt: new Date() })
			.where(eq(memoryQuarantineSessions.userId, userId))
			.run();
		return active.allowed.flatMap((source) => {
			if (!eligibleQuarantineSource(tx, active, source, current)) return [];
			return [
				{
					userId,
					bankId: bank.id,
					epoch: active.session.epoch,
					kind: "quarantine_extract" as const,
					sourceId: source.id,
					requestId: `quarantine:${input.requestId}:${source.id}`,
				},
			];
		});
	});
	return getMemoryQuarantine(userId);
}

function validateResolution(input: ResolveInput) {
	if (
		!requestIdValid(input.requestId) ||
		!requestIdValid(input.id) ||
		!["keep", "discard"].includes(input.decision) ||
		(input.text !== undefined &&
			(input.decision !== "keep" ||
				typeof input.text !== "string" ||
				!input.text.trim() ||
				input.text.length > 16000))
	)
		throw new MemoryRequestError("invalid_action");
}

function decisionHash(input: ResolveInput) {
	return memoryTextHash(JSON.stringify([input.decision, input.text ?? null]));
}

function queueKeptDraft(
	tx: Tx,
	account: Account,
	draft: Draft,
	source: QuarantineSource,
	input: ResolveInput,
) {
	const action = parseMemoryAction({
		kind: "add",
		scope: source.scope,
		text: input.text ?? draft.text,
		requestId: input.requestId,
	});
	if (action.kind !== "add") throw new MemoryRequestError("invalid_action");
	const reused = tx
		.select({ id: memoryActions.id })
		.from(memoryActions)
		.where(
			and(
				eq(memoryActions.userId, account.userId),
				eq(memoryActions.requestId, action.requestId),
			),
		)
		.get();
	if (reused) throw new MemoryRequestError("request_conflict", 409);
	const bank = ensureMemoryBank(account.userId, source.scope);
	assertCurationPublication(tx, bank.id, bank.epoch);
	const actionId = randomUUID();
	const intent: ActionIntentRecord = {
		request: action,
		before: "",
		sourceIds: [],
		facts: [],
		revision: bank.revision,
	};
	tx.insert(memoryActions)
		.values({
			id: actionId,
			userId: account.userId,
			bankId: bank.id,
			epoch: bank.epoch,
			kind: "add",
			requestId: action.requestId,
			text: action.text,
			intentJson: JSON.stringify(intent),
		})
		.run();
	return [
		{
			userId: account.userId,
			bankId: bank.id,
			epoch: bank.epoch,
			kind: "action" as const,
			actionId,
			requestId: `action:${action.requestId}`,
		},
	];
}

export async function resolveMemoryQuarantineCandidate(
	userId: string,
	input: ResolveInput,
) {
	validateResolution(input);
	await enqueueMemoryMutation((tx) => {
		const active = quarantineSessionFor(tx, userId);
		if (!active?.session.startRequestId) throw unavailable();
		const draft = tx
			.select()
			.from(memoryQuarantineDrafts)
			.where(
				and(
					eq(memoryQuarantineDrafts.userId, userId),
					eq(memoryQuarantineDrafts.id, input.id),
				),
			)
			.get();
		if (!draft) throw stale();
		const used = tx
			.select({ id: memoryQuarantineDrafts.id })
			.from(memoryQuarantineDrafts)
			.where(
				and(
					eq(memoryQuarantineDrafts.userId, userId),
					eq(memoryQuarantineDrafts.decisionRequestId, input.requestId),
				),
			)
			.get();
		if (used && used.id !== draft.id)
			throw new MemoryRequestError("request_conflict", 409);
		if (draft.decision) {
			if (
				draft.decisionRequestId !== input.requestId ||
				draft.decisionTextHash !== decisionHash(input)
			)
				throw new MemoryRequestError("request_conflict", 409);
			return [];
		}
		const source = active.cohort.find(({ id }) => id === draft.messageId);
		const inventory = inspectMemoryMigration(userId);
		if (
			!draft.text ||
			!source ||
			!eligibleQuarantineSource(tx, active, source, inventory) ||
			knownQuarantineWithdrawal(inventory, source, draft.text) ||
			knownQuarantineWithdrawal(active.inventory, source, draft.text)
		)
			throw stale();
		if (
			input.text !== undefined &&
			(knownQuarantineWithdrawal(inventory, source, input.text) ||
				knownQuarantineWithdrawal(active.inventory, source, input.text))
		)
			throw new MemoryRequestError("invalid_action");
		const jobs =
			input.decision === "keep"
				? queueKeptDraft(tx, active.account, draft, source, input)
				: [];
		tx.update(memoryQuarantineDrafts)
			.set({
				text: null,
				decision: input.decision,
				decisionRequestId: input.requestId,
				decisionTextHash: decisionHash(input),
			})
			.where(eq(memoryQuarantineDrafts.id, draft.id))
			.run();
		return jobs;
	});
	return getMemoryQuarantine(userId);
}
