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
} from "./contracts";
import { decideMemoryDeliveryFailure } from "./delivery-policy";
import {
	type RepairPlan,
	readDependencyRepairPlan,
	unfinishedDependencyDraft,
	withdrawnDependencySourceId,
} from "./dependency-plan";
import {
	assertMemoryBankFence,
	assertMemoryDependencySourceCurrent,
	retainEndRecorded,
} from "./revisions";

/**
 * A bank's work in flight, as the FROM and WHERE of a subquery over `flight`
 * (the job) and `sent` (a chat delivery's source revision): a chat delivery
 * whose chat was sent, or a person's action or a source cleanup that an
 * attempt began and the failure policy put back (waiting on Hindsight, a
 * counted retry, a lost worker; a Retry or an operator's reopen clears the
 * code), or a chat delivery put back with a dependency repair in its
 * checkpoint (an unchanged resend sends no chat, but its repair retains
 * replacements). Hindsight may hold its writes while nothing published them.
 * Any other chat put back before it was sent holds nothing there, so it
 * holds no bank. `instr`, not `json_extract`: a malformed checkpoint must not
 * throw inside the claim. Uncorrelated, so SQLite reads it once per claim,
 * not once per queued row.
 */
const IN_FLIGHT = sql`
	FROM memory_delivery_jobs flight
	LEFT JOIN memory_source_revisions sent
		ON flight.kind = 'source' AND sent.id = flight.source_id
	WHERE flight.status = 'queued'
		AND flight.bank_id IS NOT NULL
		AND (
			sent.native_submitted = 1
			OR (flight.started_at IS NOT NULL
				AND flight.error_code IS NOT NULL
				AND (flight.kind IN ('action', 'source_cleanup')
					OR (flight.kind = 'source'
						AND instr(coalesce(flight.checkpoint_json, ''), '"dependencyRepair"') > 0)))
		)`;

/** Whether Memory jobs may run in this process: the worker switch, and no restore hold. */
export function memoryDeliveryEnabled(): boolean {
	const config = getConfig();
	return config.hindsightWorkerEnabled && !config.hindsightRestoreHold;
}
export const memoryDeliveryJob = defineJobKind({
	name: "memory",
	logPrefix: "[MEMORY]",
	tables: { jobs: memoryDeliveryJobs, attempts: memoryDeliveryAttempts },
	enabled: memoryDeliveryEnabled,
	// One active mutation per user is stricter than per-bank and prevents native bank overlap.
	limits: () => ({ global: getConfig().hindsightConcurrency, perUser: 1 }),
	lease: () => ({ heartbeatMs: 15_000, staleAfterMs: 120_000 }),
	// A job put back mid-flight is queued, not running, yet its writes may sit
	// in Hindsight unpublished, and publication refuses every observation on
	// another chat's unpublished fact: an import's delivery waited on
	// Hindsight, the next one was sent meanwhile, each refused the other's
	// publication and every later delivery of the bank failed (2026-11-25).
	// So while a bank has work in flight (`IN_FLIGHT`), only its first piece
	// (a sent chat first, then the earliest started) may be claimed among its
	// chat deliveries, and every new chat delivery waits behind it. A person's
	// action and a source cleanup are never held: a pending Remove or Edit
	// already holds the bank's publications until it ends
	// (`assertCurationPublication`), so holding it behind a chat would leave
	// each waiting for the other, and a cleanup takes a withdrawn chat out of
	// Hindsight (it waits before its own repair writes anything while a chat
	// is in flight). The runner checks again before a chat's first send
	// (`unpublishedChats`), so a bank whose unpublished chat failed for good
	// takes in no chat until it is repaired.
	claimable: (jobs) =>
		sql`NOT EXISTS (
			SELECT 1 FROM memory_delivery_jobs running
			WHERE running.bank_id = ${jobs.bankId} AND running.status = 'running'
		) AND (
			${jobs.kind} <> 'source'
			OR ${jobs.bankId} NOT IN (SELECT flight.bank_id ${IN_FLIGHT})
			OR ${jobs.id} IN (
				SELECT id FROM (
					SELECT flight.id AS id, row_number() OVER (
						PARTITION BY flight.bank_id
						ORDER BY coalesce(sent.native_submitted, 0) DESC,
							flight.started_at IS NULL, flight.started_at, flight.rowid
					) AS place
					${IN_FLIGHT}
				) WHERE place = 1
			)
		) AND (
			${jobs.kind} = 'cleanup' OR NOT EXISTS (
			SELECT 1 FROM memory_migration_manifests m
			WHERE m.user_id = ${jobs.userId} AND m.epoch = ${jobs.epoch}
			AND json_extract(m.checkpoint_json, '$.migrationRewind.bankId') = ${jobs.bankId}
			)
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
	// Waiting on Hindsight spends no attempt; see delivery-policy.ts.
	onFailure: (failure, history) =>
		decideMemoryDeliveryFailure(failure, history),
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
	/** Lower is claimed first (the engine's default is 0). */
	priority?: number;
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
	const { runAfter, priority, ...values } = input;
	return {
		values: {
			...values,
			controlRevision: getControlRevision(input.userId, tx),
		},
		runAfter,
		priority,
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

/**
 * The erasure's own cleanup jobs for retired banks. A restart passes its own
 * prefix: the person's cleanup status leaves those out, and verify waits for
 * them.
 */
export function bankCleanupInputs(
	tx: Tx,
	account: typeof memoryAccounts.$inferSelect,
	banks: Array<typeof memoryBanks.$inferSelect>,
	prefix: "erase" | "restart-erase" = "erase",
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
								eq(memoryDeliveryJobs.requestId, `${prefix}:${bank.id}`),
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
				requestId: `${prefix}:${bank.id}`,
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
						// An ended retain is never sent again: nothing to settle.
						.filter((source) => !retainEndRecorded(source))
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
