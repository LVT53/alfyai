import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import {
	memoryAccounts,
	memoryActions,
	memoryBanks,
	memoryDeliveryAttempts,
	memoryDeliveryJobs,
	memoryResetGenerations,
	memorySourceRevisions,
} from "$lib/server/db/schema";
import { cancelAll, defineJobKind, enqueueAtomic, reopen } from "../jobs";
import type { Tx } from "../jobs/types";
import {
	NATIVE_BANK_CONFIG_LEGACY_UNKNOWN,
	NATIVE_BANK_CONFIG_PENDING,
	NATIVE_DELIVERY_ATTEMPT_LIMIT,
} from "./contracts";
import {
	type RepairPlan,
	readDependencyRepairPlan,
	unfinishedDependencyDraft,
	withdrawnDependencySourceId,
} from "./dependency-plan";
import {
	assertMemoryBankFence,
	assertMemoryDependencySourceCurrent,
} from "./revisions";

export const memoryDeliveryJob = defineJobKind({
	name: "memory",
	logPrefix: "[MEMORY]",
	tables: { jobs: memoryDeliveryJobs, attempts: memoryDeliveryAttempts },
	enabled: () => {
		const config = getConfig();
		return config.hindsightWorkerEnabled && !config.hindsightRestoreHold;
	},
	// One active mutation per user is stricter than per-bank and prevents native bank overlap.
	limits: () => ({ global: getConfig().hindsightConcurrency, perUser: 1 }),
	lease: () => ({ heartbeatMs: 15_000, staleAfterMs: 120_000 }),
	claimable: (jobs) =>
		sql`NOT EXISTS (
			SELECT 1 FROM memory_delivery_jobs running
			WHERE running.bank_id = ${jobs.bankId} AND running.status = 'running'
		) AND (
			${jobs.kind} <> 'source_cleanup' OR NOT EXISTS (
				WITH RECURSIVE resend(id, depth) AS (
					SELECT ${jobs.sourceId}, 0
					UNION ALL
					SELECT successor.id, resend.depth + 1
					FROM resend
					JOIN memory_source_revisions predecessor ON predecessor.id = resend.id
					JOIN memory_source_revisions successor ON successor.predecessor_source_id = predecessor.id
					WHERE resend.depth < 64
						AND predecessor.state = 'revoked'
						AND json_extract(
							CASE WHEN json_valid(predecessor.context) THEN predecessor.context ELSE '{}' END,
							'$.editResendWithdrawal'
						) = 1
						AND successor.event_id LIKE 'message:%'
						AND successor.user_id = ${jobs.userId}
						AND successor.bank_id = ${jobs.bankId}
						AND successor.epoch = ${jobs.epoch}
						AND successor.conversation_id = predecessor.conversation_id
						AND successor.lineage_id = predecessor.lineage_id
						AND (resend.depth = 0 OR (
							predecessor.text_hash = successor.text_hash
							AND predecessor.explicit_edit_at IS NULL
							AND predecessor.native_submitted = 0
							AND predecessor.native_acknowledged = 0
							AND predecessor.accepted_generation IS NULL
							AND predecessor.acknowledged_facts_json = '[]'
						))
				)
				SELECT 1
				FROM resend
				JOIN memory_source_revisions successor ON successor.id = resend.id
				JOIN memory_delivery_jobs delivery ON delivery.source_id = successor.id
				JOIN memory_accounts account ON account.user_id = successor.user_id
				WHERE resend.depth > 0 AND successor.state IN ('pending', 'staged')
					AND successor.control_revision = account.control_revision
					AND delivery.kind = 'source' AND delivery.status = 'queued'
			)
		)`,
	phases: ["prepare", "retain", "consolidate", "publish"],
	lostAttempt: () => ({
		code: "memory_worker_lost",
		message: "Memory preparation was interrupted.",
	}),
	onFailure: (failure, history) =>
		failure.retryable && history.attempts < NATIVE_DELIVERY_ATTEMPT_LIMIT
			? { requeue: true, delayMs: Math.min(60_000, 5_000 * history.attempts) }
			: { requeue: false, retryable: failure.retryable },
	userRetry: { from: ["failed"], requireRetryable: true },
	handler: () => import("./delivery-runner").then((m) => m.runMemoryDelivery),
});
export interface EnqueueMemoryDelivery {
	userId: string;
	bankId: string;
	epoch: number;
	kind:
		| "source"
		| "source_cleanup"
		| "action"
		| "cleanup"
		| "provision"
		| "quarantine_extract";
	sourceId?: string;
	actionId?: string;
	requestId: string;
	tenantId?: string;
	nativeBaseUrl?: string;
	nativeCredentialHash?: string;
	runAfter?: Date;
}
export async function enqueueMemoryDelivery(input: EnqueueMemoryDelivery) {
	const results = await enqueueMemoryMutation(() => [input]);
	return results[0];
}
export function enqueueMemoryMutation(
	prepare: (tx: Tx) => EnqueueMemoryDelivery[],
) {
	return enqueueAtomic(memoryDeliveryJob, (tx) =>
		prepare(tx).map((input) => deliveryInput(input, tx)),
	);
}
function deliveryInput(
	input: EnqueueMemoryDelivery,
	tx: Tx,
): import("../jobs/types").EnqueueInput<typeof memoryDeliveryJobs> {
	const { runAfter, ...values } = input;
	return {
		values: {
			...values,
			controlRevision: getControlRevision(input.userId, tx),
		},
		runAfter,
		idempotency: {
			find: (tx) =>
				tx
					.select()
					.from(memoryDeliveryJobs)
					.where(
						and(
							eq(memoryDeliveryJobs.userId, input.userId),
							eq(memoryDeliveryJobs.requestId, input.requestId),
						),
					)
					.get() ?? null,
			onExisting: (_tx, existing) => {
				if (
					existing.bankId !== input.bankId ||
					existing.epoch !== input.epoch ||
					existing.kind !== input.kind ||
					existing.sourceId !== (input.sourceId ?? null) ||
					existing.actionId !== (input.actionId ?? null) ||
					existing.tenantId !== (input.tenantId ?? null)
				)
					throw new Error("memory_request_conflict");
				return "reuse";
			},
		},
	};
}
function getControlRevision(userId: string, tx: Tx): number {
	return (
		tx
			.select({ revision: memoryAccounts.controlRevision })
			.from(memoryAccounts)
			.where(eq(memoryAccounts.userId, userId))
			.get()?.revision ?? 0
	);
}
/** Revocation and every cleanup intent commit atomically. Only retired epochs are captured. */
const erasureStates = [
	"erasing",
	"erasing_all_owned",
	"erasing_workspace",
	"erasing_account",
] as const;
type ErasureState = (typeof erasureStates)[number];
export async function prepareNativeMemoryErasure(
	userId: string,
	state: ErasureState = "erasing",
): Promise<string | null> {
	const token = randomUUID();
	let epoch: number | undefined;
	await enqueueAtomic(memoryDeliveryJob, (tx) => {
		tx.insert(memoryAccounts)
			.values({ userId, tenantId: randomUUID() })
			.onConflictDoNothing()
			.run();
		const account = tx
			.select()
			.from(memoryAccounts)
			.where(eq(memoryAccounts.userId, userId))
			.get();
		if (!account) throw new Error("memory_unauthorized");
		const states: readonly string[] = erasureStates;
		const current = states.indexOf(account.lifecycleState);
		if (current > erasureStates.indexOf(state)) return [];
		epoch = current === -1 ? account.epoch + 1 : account.epoch;
		if (current === -1) {
			const now = new Date();
			tx.insert(memoryResetGenerations)
				.values({
					userId,
					resetGeneration: 1,
					createdAt: now,
					updatedAt: now,
					advancedAt: now,
				})
				.onConflictDoUpdate({
					target: memoryResetGenerations.userId,
					set: {
						resetGeneration: sql`${memoryResetGenerations.resetGeneration}+1`,
						updatedAt: now,
						advancedAt: now,
					},
				})
				.run();
		}
		const banks = tx
			.select()
			.from(memoryBanks)
			.where(and(eq(memoryBanks.userId, userId), lt(memoryBanks.epoch, epoch)))
			.all();
		tx.update(memoryAccounts)
			.set({
				epoch,
				lifecycleState: state,
				erasureToken: token,
			})
			.where(eq(memoryAccounts.userId, userId))
			.run();
		return bankCleanupInputs(tx, account, banks);
	});
	if (epoch === undefined) return null;
	const retiredEpoch = epoch;
	await cancelAll(memoryDeliveryJob, {
		userId,
		where: (jobs) => lt(jobs.epoch, retiredEpoch),
	});
	db.transaction((tx) => {
		const owner = tx
			.select()
			.from(memoryAccounts)
			.where(
				and(
					eq(memoryAccounts.userId, userId),
					eq(memoryAccounts.erasureToken, token),
				),
			)
			.get();
		if (!owner) return;
		tx.delete(memoryDeliveryJobs)
			.where(
				and(
					eq(memoryDeliveryJobs.userId, userId),
					ne(memoryDeliveryJobs.kind, "cleanup"),
					lt(memoryDeliveryJobs.epoch, retiredEpoch),
				),
			)
			.run();
	});
	return token;
}

function bankCleanupInputs(
	tx: Tx,
	account: typeof memoryAccounts.$inferSelect,
	banks: Array<typeof memoryBanks.$inferSelect>,
): import("../jobs/types").EnqueueInput<typeof memoryDeliveryJobs>[] {
	return banks
		.filter((bank) => bank.nativeBaseUrl && bank.nativeCredentialHash)
		.map((bank) => ({
			idempotency: {
				find: (inner) =>
					inner
						.select()
						.from(memoryDeliveryJobs)
						.where(
							and(
								eq(memoryDeliveryJobs.userId, account.tenantId),
								eq(memoryDeliveryJobs.requestId, `erase:${bank.id}`),
							),
						)
						.get() ?? null,
				onExisting: () => "reuse" as const,
			},
			values: {
				userId: account.tenantId,
				tenantId: account.tenantId,
				bankId: bank.id,
				epoch: bank.epoch,
				kind: "cleanup",
				requestId: `erase:${bank.id}`,
				nativeBaseUrl: bank.nativeBaseUrl,
				nativeCredentialHash: bank.nativeCredentialHash,
				nativeOperationIdsJson: JSON.stringify([
					...(bank.nativeConfigVersion === NATIVE_BANK_CONFIG_PENDING
						? [NATIVE_BANK_CONFIG_PENDING]
						: bank.nativeConfigVersion === null
							? [NATIVE_BANK_CONFIG_LEGACY_UNKNOWN]
							: []),
					...tx
						.select()
						.from(memorySourceRevisions)
						.where(
							and(
								eq(memorySourceRevisions.bankId, bank.id),
								eq(memorySourceRevisions.nativeSubmitted, true),
								eq(memorySourceRevisions.nativeAcknowledged, false),
							),
						)
						.all()
						.map((source) => source.nativeOperationId)
						.filter(Boolean),
				]),
			},
		}));
}
/** Retire the whole scope, including manual data, atomically with the project mutation. */
export async function retireProjectMemory(
	userId: string,
	projectId: string,
	apply: (tx: Tx) => boolean,
): Promise<boolean> {
	let changed = false;
	await enqueueAtomic(memoryDeliveryJob, (tx) => {
		changed = apply(tx);
		if (!changed) return [];
		const account = tx
			.select()
			.from(memoryAccounts)
			.where(eq(memoryAccounts.userId, userId))
			.get();
		if (!account) return [];
		const banks = tx
			.select()
			.from(memoryBanks)
			.where(
				and(
					eq(memoryBanks.userId, userId),
					eq(memoryBanks.scopeKey, `project:${projectId}`),
				),
			)
			.all();
		for (const bank of banks)
			tx.update(memoryBanks)
				.set({ status: "retired" })
				.where(eq(memoryBanks.id, bank.id))
				.run();
		return bankCleanupInputs(tx, account, banks);
	});
	return changed;
}

/** Enabling resumes outstanding cleanup and restoration of previously accepted memory. */
export async function resumeDependencyRepairs(userId: string) {
	const candidates = db
		.select()
		.from(memoryDeliveryJobs)
		.where(
			and(
				eq(memoryDeliveryJobs.userId, userId),
				inArray(memoryDeliveryJobs.status, [
					"queued",
					"running",
					"failed",
					"cancelled",
				]),
			),
		)
		.all();
	for (const candidate of candidates) {
		const action = candidate.actionId
			? db
					.select()
					.from(memoryActions)
					.where(eq(memoryActions.id, candidate.actionId))
					.get()
			: null;
		const restoreCancelledEdit =
			action?.kind === "edit" &&
			JSON.parse(action.intentJson ?? "null")?.rollbackPending === true;
		if (
			candidate.kind !== "source_cleanup" &&
			!(
				candidate.kind === "action" &&
				((action?.kind === "remove" && action.exclusionAcknowledged) ||
					restoreCancelledEdit)
			)
		)
			continue;
		const raw = candidate.checkpoint ?? action?.intentJson;
		if (!raw && !restoreCancelledEdit) continue;
		let plan: RepairPlan | undefined;
		try {
			plan = readDependencyRepairPlan(raw ?? "{}", candidate);
		} catch {
			continue;
		}
		if (!plan && !restoreCancelledEdit) continue;
		const steps = plan?.steps ?? [];
		const originalIds = new Set(steps.map(({ originalId }) => originalId));
		let revision = candidate.controlRevision;

		const allow = (tx: Tx) => {
			try {
				const bank = assertMemoryBankFence(
					tx,
					userId,
					candidate.bankId,
					candidate.epoch,
				);
				const account = tx
					.select()
					.from(memoryAccounts)
					.where(eq(memoryAccounts.userId, userId))
					.get();
				if (!account) return false;
				revision = account.controlRevision;
				const retained = steps.filter(
					(step) =>
						!withdrawnDependencySourceId(tx, candidate, step.originalId) &&
						!unfinishedDependencyDraft(
							tx,
							candidate,
							originalIds,
							step.originalId,
						),
				);
				for (const step of retained)
					assertMemoryDependencySourceCurrent(tx, step.originalId, bank);
				for (const step of retained)
					tx.update(memorySourceRevisions)
						.set({ controlRevision: revision })
						.where(eq(memorySourceRevisions.id, step.replacementId))
						.run();
				return true;
			} catch {
				return false;
			}
		};
		if (candidate.status === "queued" || candidate.status === "running") {
			db.transaction((tx) => {
				if (allow(tx))
					tx.update(memoryDeliveryJobs)
						.set({ controlRevision: revision })
						.where(
							and(
								eq(memoryDeliveryJobs.id, candidate.id),
								inArray(memoryDeliveryJobs.status, ["queued", "running"]),
							),
						)
						.run();
			});
		} else
			await reopen(memoryDeliveryJob, candidate.id, {
				userId,
				from: ["failed", "cancelled"],
				keepCheckpoint: true,
				allow,
				patch: () => ({ controlRevision: revision }),
			});
	}
}
