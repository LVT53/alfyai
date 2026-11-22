import { and, eq, sql } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import {
	conversations,
	memoryAccounts,
	memoryControlIntervals,
	memoryEvents,
	memoryMigrationManifests,
	memoryQuarantineSessions,
	memoryResetGenerations,
	memoryRevocations,
	memorySourceRevisions,
	messages,
	projects,
	users,
} from "$lib/server/db/schema";
import type { Tx } from "../jobs/types";
import { nativeCurationForMigration } from "./curation-lineage";
import { historicalMemoryExclusion } from "./history-eligibility";
import { parseJsonRecord } from "./internal-json";
import type { inspectMemoryMigration } from "./migration-progress";
import { memoryScopeKey, memoryTextHash } from "./revisions";

export const QUARANTINE_REVIEW_POLICY = "1";

type Manifest = typeof memoryMigrationManifests.$inferSelect;
export type QuarantineSource = ReturnType<
	typeof inspectMemoryMigration
>["sources"][number];

function manifestInventory(manifest: Manifest) {
	// This uses the same durable, server-owned inventory as preparation/verify.
	return JSON.parse(manifest.manifestJson) as ReturnType<
		typeof inspectMemoryMigration
	>;
}

function heldCohort(inventory: ReturnType<typeof inspectMemoryMigration>) {
	return inventory.sources.filter(
		(source) =>
			source.eligibility === "held" &&
			source.reason === "unknown_exclusion_boundary",
	);
}

export function quarantineSessionFor(tx: Tx, userId: string) {
	const config = getConfig();
	if (!config.hindsightQuarantineEnabled || config.hindsightRestoreHold) return;
	const session = tx
		.select()
		.from(memoryQuarantineSessions)
		.where(eq(memoryQuarantineSessions.userId, userId))
		.get();
	if (!session || session.reviewPolicyVersion !== QUARANTINE_REVIEW_POLICY)
		return;
	const account = tx
		.select()
		.from(memoryAccounts)
		.where(eq(memoryAccounts.userId, userId))
		.get();
	const user = tx
		.select({ enabled: users.memoryEnabled })
		.from(users)
		.where(eq(users.id, userId))
		.get();
	if (
		!account ||
		!user?.enabled ||
		!["preparing", "hindsight"].includes(account.authority) ||
		account.lifecycleState !== "active" ||
		account.historyChoice !== "include" ||
		account.historyPolicyVersion !== session.policyVersion ||
		account.historyCutoff?.getTime() !== session.cutoff.getTime() ||
		account.epoch !== session.epoch ||
		account.controlRevision !== session.controlRevision
	)
		return;
	const manifest = tx
		.select()
		.from(memoryMigrationManifests)
		.where(
			and(
				eq(memoryMigrationManifests.id, session.manifestId),
				eq(memoryMigrationManifests.userId, userId),
				eq(memoryMigrationManifests.epoch, session.epoch),
			),
		)
		.get();
	if (
		!manifest ||
		memoryTextHash(manifest.manifestJson) !== session.manifestHash
	)
		return;
	const inventory = manifestInventory(manifest);
	const cohort = heldCohort(inventory);
	if (
		cohort.length !== session.cohortCount ||
		memoryTextHash(JSON.stringify(cohort.map((row) => row.id).sort())) !==
			session.cohortHash
	)
		return;
	const denied: unknown = JSON.parse(session.deniedSourceIdsJson);
	if (!Array.isArray(denied) || denied.some((id) => typeof id !== "string"))
		return;
	const deniedIds = new Set(denied);
	const allowed = cohort.filter((source) => !deniedIds.has(source.id));
	if (
		cohort.length - allowed.length !== deniedIds.size ||
		memoryTextHash(JSON.stringify(allowed.map(({ id }) => id).sort())) !==
			session.allowedCohortHash
	)
		return;
	return { session, account, inventory, cohort, deniedIds, allowed };
}

type ActiveSession = NonNullable<ReturnType<typeof quarantineSessionFor>>;

export const normalizeQuarantineText = (value: string) =>
	value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

export function knownQuarantineWithdrawal(
	inventory: ReturnType<typeof inspectMemoryMigration>,
	source: QuarantineSource,
	content: string,
) {
	if (
		inventory.exceptions.some(
			({ reason, sourceIds }) =>
				reason !== "unknown_exclusion_boundary" &&
				sourceIds.includes(source.id),
		)
	)
		return true;
	const normalizedContent = normalizeQuarantineText(content);
	return inventory.actions.some((action) => {
		if (action.kind !== "edit" && action.kind !== "remove") return false;
		if (action.sourceIds.includes(source.id)) return true;
		return action.before.split(/\r?\n/u).some((fragment) => {
			const known = normalizeQuarantineText(fragment);
			return known.length > 0 && normalizedContent.includes(known);
		});
	});
}

export function eligibleQuarantineSource(
	tx: Tx,
	active: ActiveSession,
	source: QuarantineSource,
	currentInventory: ReturnType<typeof inspectMemoryMigration>,
) {
	const { account, session, inventory, deniedIds } = active;
	if (deniedIds.has(source.id)) return;
	const row = tx
		.select({ message: messages, chat: conversations })
		.from(messages)
		.innerJoin(conversations, eq(conversations.id, messages.conversationId))
		.where(
			and(eq(messages.id, source.id), eq(conversations.userId, session.userId)),
		)
		.get();
	if (
		row?.message.role !== "user" ||
		row.message.importSource ||
		row.chat.id !== source.conversationId ||
		row.chat.memoryIncognito ||
		row.message.content !== source.text ||
		!row.message.content.trim() ||
		Buffer.byteLength(row.message.content) > 8192 ||
		(source.explicitEditAt !== undefined && source.explicitEditAt !== null) ||
		row.message.createdAt.toISOString() !== source.messageAt ||
		row.message.createdAt.getTime() > session.cutoff.getTime() ||
		source.replayActionIds?.length ||
		parseJsonRecord(row.message.metadataJson).forkCopy ||
		(source.scope.kind === "personal"
			? row.chat.projectId !== null
			: row.chat.projectId !== source.scope.projectId ||
				!tx
					.select({ id: projects.id })
					.from(projects)
					.where(
						and(
							eq(projects.id, source.scope.projectId),
							eq(projects.userId, session.userId),
						),
					)
					.get())
	)
		return;
	const moved = tx
		.select({ id: memoryEvents.id })
		.from(memoryEvents)
		.where(
			and(
				eq(memoryEvents.userId, session.userId),
				eq(memoryEvents.conversationId, row.chat.id),
				eq(memoryEvents.eventType, "memory_scope_moved"),
			),
		)
		.get();
	if (moved) return;
	const current = currentInventory.sources.find(
		(candidate) => candidate.id === source.id,
	);
	if (
		current?.eligibility !== "held" ||
		current.reason !== "unknown_exclusion_boundary" ||
		current.assertedAt !== source.assertedAt ||
		current.explicitEditAt !== source.explicitEditAt ||
		current.lineageId !== source.lineageId ||
		knownQuarantineWithdrawal(inventory, source, row.message.content) ||
		knownQuarantineWithdrawal(currentInventory, source, row.message.content)
	)
		return;
	const intervals = tx
		.select()
		.from(memoryControlIntervals)
		.where(eq(memoryControlIntervals.userId, session.userId))
		.all();
	const reset = tx
		.select({ at: memoryResetGenerations.advancedAt })
		.from(memoryResetGenerations)
		.where(eq(memoryResetGenerations.userId, session.userId))
		.get();
	if (
		historicalMemoryExclusion(
			{ account, intervals, resetAt: reset?.at, enabled: true },
			{
				assertedAt: new Date(source.explicitEditAt ?? source.assertedAt),
				incognito: row.chat.memoryIncognito,
			},
		)
	)
		return;
	const revoked = tx
		.select({ id: memoryRevocations.id })
		.from(memoryRevocations)
		.innerJoin(
			memorySourceRevisions,
			eq(memorySourceRevisions.id, memoryRevocations.sourceId),
		)
		.where(
			and(
				eq(memoryRevocations.userId, session.userId),
				eq(memorySourceRevisions.userId, session.userId),
				sql`(${memorySourceRevisions.messageId}=${source.id} OR ${memorySourceRevisions.lineageId}=${source.lineageId})`,
			),
		)
		.get();
	if (revoked) return;
	// The ordinary migration inspector does not plan native replay for held
	// candidates. Here a replay need blocks the whole authored source.
	const replay = nativeCurationForMigration(
		tx,
		session.userId,
		session.epoch,
	).plan(
		{
			userId: session.userId,
			epoch: session.epoch,
			messageId: source.id,
			conversationId: source.conversationId,
			lineageId: source.lineageId,
			textHash: memoryTextHash(row.message.content),
			assertedAt: new Date(source.assertedAt),
			explicitEditAt: null,
		},
		memoryScopeKey(source.scope),
		row.message.createdAt,
	);
	if (replay.blocked || replay.ids.length) return;
	return row.message;
}
