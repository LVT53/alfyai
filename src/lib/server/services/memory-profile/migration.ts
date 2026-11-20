import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import {
	conversations,
	memoryAccounts,
	memoryActions,
	memoryBanks,
	memoryControlIntervals,
	memoryDeliveryJobs,
	memoryMigrationManifests,
	memoryResetGenerations,
	memoryRevocations,
	memorySourceRevisions,
	messages,
	users,
} from "$lib/server/db/schema";
import { cancelAll, retry } from "../jobs";
import type { Tx } from "../jobs/types";
import { HINDSIGHT_ENGINE_COMMIT } from "./contracts";
import type { ActionIntentRecord } from "./curation-intent";
import { readNativeCurationLineage } from "./curation-lineage";
import {
	type EnqueueMemoryDelivery,
	enqueueMemoryMutation,
	memoryDeliveryJob,
} from "./delivery-job";
import { historicalMemoryExclusion } from "./history-eligibility";
import { parseJsonRecord } from "./internal-json";
import {
	inspectMemoryMigration,
	latestManifest,
	settleMemoryMigration,
	verifyMemoryMigration,
} from "./migration-progress";
import {
	ensureMemoryBank,
	isLearnedProjectSource,
	memoryScopeKey,
	memoryTextHash,
	recordMemorySource,
	revokeMemorySources,
} from "./revisions";
import {
	hasConflictingScopeOrigin,
	readMemoryScopeMoves,
} from "./scope-history";

export {
	inspectMemoryMigration,
	verifyMemoryMigration,
} from "./migration-progress";

/** The existing delivery job owns retries/checkpoints; this snapshot only inventories intent. */
export async function prepareMemoryMigration(
	userId: string,
	restoredRewind?: {
		bankId: string;
		assertCurrent: (tx: Tx) => void;
		holdCorrectionConflict: boolean;
	},
) {
	let manifestId = "";
	const results = await enqueueMemoryMutation((tx) => {
		restoredRewind?.assertCurrent(tx);
		const personalBank = ensureMemoryBank(userId, { kind: "personal" });
		const account = tx
			.select()
			.from(memoryAccounts)
			.where(eq(memoryAccounts.userId, userId))
			.get();
		if (account?.lifecycleState !== "active")
			throw Error("memory_account_unavailable");
		// Take only the legacy → preparing transition inside the same write barrier
		// as the checkpoint. A concurrent cutover/rollback cannot be overwritten.
		if (account.authority === "legacy")
			tx.update(memoryAccounts)
				.set({ authority: "preparing" })
				.where(
					and(
						eq(memoryAccounts.userId, userId),
						eq(memoryAccounts.authority, "legacy"),
					),
				)
				.run();
		if (restoredRewind?.holdCorrectionConflict) {
			const previous = latestManifest(userId);
			const checkpoint = parseJsonRecord(previous?.checkpointJson ?? null);
			const rewind = parseJsonRecord(
				JSON.stringify(checkpoint.migrationRewind ?? {}),
			);
			if (
				!previous ||
				previous.epoch !== account.epoch ||
				account.authority !== "preparing" ||
				rewind.bankId !== restoredRewind.bankId ||
				!Array.isArray(rewind.correctionHolds) ||
				!rewind.correctionHolds.length
			)
				throw Error("memory_migration_rewind_unverified");
			const previousHolds = Array.isArray(checkpoint.migrationCorrectionHolds)
				? checkpoint.migrationCorrectionHolds
				: [];
			const holds = [
				...new Map(
					[...previousHolds, ...rewind.correctionHolds].map((hold) => [
						JSON.stringify(hold),
						hold,
					]),
				).values(),
			];
			tx.update(memoryMigrationManifests)
				.set({
					checkpointJson: JSON.stringify({
						...checkpoint,
						migrationCorrectionHolds: holds,
					}),
				})
				.where(eq(memoryMigrationManifests.id, previous.id))
				.run();
		}
		const user = tx.select().from(users).where(eq(users.id, userId)).get();
		if (!user) throw Error("memory_unauthorized");
		const intervals = tx
			.select()
			.from(memoryControlIntervals)
			.where(eq(memoryControlIntervals.userId, userId))
			.all();
		if (!intervals.some((i) => !i.endedAt)) {
			const interval = {
				id: randomUUID(),
				userId,
				enabled: user.memoryEnabled,
				epoch: account.epoch,
				startedAt: new Date(),
				endedAt: null,
			};
			tx.insert(memoryControlIntervals).values(interval).run();
			intervals.push(interval);
		}
		const reset = tx
			.select({ at: memoryResetGenerations.advancedAt })
			.from(memoryResetGenerations)
			.where(eq(memoryResetGenerations.userId, userId))
			.get();
		const controls = {
			account,
			intervals,
			resetAt: reset?.at,
			enabled: user.memoryEnabled,
		};
		const inventory = inspectMemoryMigration(userId);
		const previous = latestManifest(userId);
		const id = previous?.epoch === inventory.epoch ? previous.id : randomUUID();
		manifestId = id;
		const jobs: EnqueueMemoryDelivery[] = [];
		const eligible = inventory.sources.filter(
			(s) => s.eligibility === "eligible",
		);
		const old = tx
			.select()
			.from(memorySourceRevisions)
			.where(
				and(
					eq(memorySourceRevisions.userId, userId),
					eq(memorySourceRevisions.epoch, inventory.epoch),
				),
			)
			.all();
		const scopeByBank = new Map(
			tx
				.select({ id: memoryBanks.id, scopeKey: memoryBanks.scopeKey })
				.from(memoryBanks)
				.where(
					and(
						eq(memoryBanks.userId, userId),
						eq(memoryBanks.epoch, inventory.epoch),
					),
				)
				.all()
				.map((bank) => [bank.id, bank.scopeKey]),
		);
		const inventoryByMessage = new Map(
			inventory.sources.map((source) => [source.id, source]),
		);
		const durableControls = { ...controls, enabled: true };
		const incognitoChats = user.memoryEnabled
			? new Set<string>()
			: new Set(
					tx
						.select({ id: conversations.id })
						.from(conversations)
						.where(
							and(
								eq(conversations.userId, userId),
								eq(conversations.memoryIncognito, true),
							),
						)
						.all()
						.map(({ id }) => id),
				);
		const sourceActions = (messageId: string) =>
			inventory.actions.filter((action) =>
				action.sourceIds.includes(messageId),
			);
		const sourceRequestId = (id: string, actions: typeof inventory.actions) =>
			`source:${id}:${memoryTextHash(JSON.stringify(actions))}`;
		const authored = new Map(
			inventory.actions
				.filter(
					(a) =>
						a.kind === "authored" &&
						a.at &&
						a.scope &&
						!inventory.exceptions.some((e) => e.id === a.id) &&
						historicalMemoryExclusion(durableControls, {
							assertedAt: new Date(a.at),
							userAuthored: true,
						}) === null,
				)
				.map((a) => [a.id, a]),
		);
		for (const source of old) {
			if (source.state === "revoked") continue;
			const storedContext = parseJsonRecord(source.context);
			const authoredId =
				typeof storedContext.migrationAuthoredId === "string"
					? storedContext.migrationAuthoredId
					: source.eventId;
			const authoredAction = authored.get(authoredId);
			const current = inventoryByMessage.get(source.messageId ?? "");
			const scopeKey = scopeByBank.get(source.bankId);
			const inOriginalScope =
				current && memoryScopeKey(current.scope) === scopeKey;
			if (
				storedContext.migration === true &&
				current &&
				source.acceptedGeneration &&
				(source.state === "accepted" || source.state === "repair_held") &&
				current.messageAt ===
					(storedContext.migrationMessageAt ??
						source.assertedAt.toISOString()) &&
				memoryTextHash(current.text) === source.textHash
			) {
				// The toggle pauses delivery. Only durable exclusions can retire a learned source.
				if (
					current.reason === "memory_off" &&
					!inventory.holdHistory &&
					(inOriginalScope || isLearnedProjectSource(tx, source, scopeKey)) &&
					historicalMemoryExclusion(durableControls, {
						assertedAt: new Date(current.explicitEditAt ?? current.assertedAt),
						incognito: incognitoChats.has(current.conversationId ?? ""),
					}) === null
				)
					continue;
				if (
					inOriginalScope &&
					current.eligibility === "eligible" &&
					source.state === "accepted"
				) {
					const actions = sourceActions(current.id);
					if (
						!actions.length ||
						source.controlRevision === inventory.controlRevision ||
						account.authority === "hindsight" ||
						tx
							.select({ id: memoryDeliveryJobs.id })
							.from(memoryDeliveryJobs)
							.where(
								and(
									eq(memoryDeliveryJobs.userId, userId),
									eq(
										memoryDeliveryJobs.requestId,
										sourceRequestId(source.id, actions),
									),
									eq(memoryDeliveryJobs.status, "succeeded"),
								),
							)
							.get()
					)
						continue;
				}
			}
			// Accepted project documents keep their identity across moves and control
			// revisions as long as the persisted source remains eligible.
			if (
				storedContext.migration === true &&
				current &&
				(current.eligibility === "eligible" ||
					(!inOriginalScope &&
						current.reason === "native_curation_scope_unresolved")) &&
				(!inOriginalScope || source.state === "accepted") &&
				memoryTextHash(current.text) === source.textHash &&
				isLearnedProjectSource(tx, source, scopeKey)
			)
				continue;
			const stale =
				storedContext.migration === true
					? current?.eligibility !== "eligible" ||
						memoryTextHash(current.text) !== source.textHash ||
						memoryScopeKey(current.scope) !== scopeKey ||
						source.controlRevision !== inventory.controlRevision
					: authoredId.startsWith("authored:") &&
						(!authoredAction?.scope ||
							memoryScopeKey(authoredAction.scope) !== scopeKey);
			if (!stale) continue;
			revokeMemorySources(userId, [source.id]);
			jobs.push({
				userId,
				bankId: source.bankId,
				epoch: inventory.epoch,
				kind: "source_cleanup",
				sourceId: source.id,
				requestId: `source-cleanup:${source.id}`,
			});
		}
		if (
			!eligible.some((source) => source.scope.kind === "personal") &&
			user.memoryEnabled
		) {
			jobs.push({
				userId,
				bankId: personalBank.id,
				epoch: inventory.epoch,
				kind: "provision",
				requestId: `migration-provision:${personalBank.id}`,
			});
		}
		const recorded = new Map<string, ReturnType<typeof recordMemorySource>>();
		const replayTargets = new Map<
			string,
			Array<{
				source: ReturnType<typeof recordMemorySource>;
				scope: (typeof eligible)[number]["scope"];
			}>
		>();
		const currentRows = tx
			.select()
			.from(memorySourceRevisions)
			.where(
				and(
					eq(memorySourceRevisions.userId, userId),
					eq(memorySourceRevisions.epoch, inventory.epoch),
				),
			)
			.all();
		const liveSources = new Set(
			currentRows
				.filter((source) => source.state !== "revoked")
				.map((source) => source.id),
		);
		const scopeMoves = readMemoryScopeMoves(tx, userId, inventory.epoch);
		for (const source of eligible) {
			const bank = ensureMemoryBank(userId, source.scope);
			const contextRows = tx
				.select()
				.from(messages)
				.where(eq(messages.conversationId, source.conversationId ?? ""))
				.all()
				.sort((a, b) => (a.messageSequence ?? 0) - (b.messageSequence ?? 0));
			const context: Array<{
				id: string;
				role: string;
				sourceId: string;
				textHash: string;
				messageTextHash: string;
			}> = [];
			let authority: ReturnType<typeof recordMemorySource> | undefined;
			for (const message of source.defaultHistory ? [] : contextRows) {
				if (message.id === source.id) break;
				if (message.role === "user") authority = recorded.get(message.id);
				if (
					authority &&
					(message.role === "user" ||
						(message.role === "assistant" &&
							!message.importSource &&
							!parseJsonRecord(message.metadataJson).forkCopy &&
							!hasConflictingScopeOrigin(
								scopeMoves.get(message.conversationId) ?? [],
								bank.scopeKey,
								message.createdAt,
							) &&
							historicalMemoryExclusion(controls, {
								assertedAt: message.createdAt,
							}) === null))
				)
					context.push({
						id: message.id,
						role: message.role,
						sourceId: authority.id,
						textHash: authority.textHash,
						messageTextHash: memoryTextHash(message.content),
					});
			}
			const row =
				currentRows.find(
					(s) =>
						s.messageId === source.id &&
						s.textHash === memoryTextHash(source.text) &&
						s.state !== "revoked" &&
						s.bankId === bank.id &&
						(s.controlRevision === inventory.controlRevision ||
							(s.state === "accepted" && s.acceptedGeneration)),
				) ??
				recordMemorySource({
					userId,
					bankId: bank.id,
					epoch: inventory.epoch,
					eventId: `migration-message:${source.id}:${bank.id}:${old.filter((s) => s.messageId === source.id && s.bankId === bank.id).length}`,
					lineageId: source.lineageId,
					text: source.text,
					context: JSON.stringify({
						migration: true,
						migrationMessageAt: source.messageAt,
						migrationDefaultHistory: source.defaultHistory,
						messages: source.defaultHistory
							? []
							: [
									...context.slice(-5),
									{
										id: source.id,
										role: "user",
										sourceId: "$current",
										textHash: memoryTextHash(source.text),
									},
								],
					}),
					assertedAt: new Date(source.assertedAt),
					explicitEditAt: source.explicitEditAt
						? new Date(source.explicitEditAt)
						: undefined,
					conversationId: source.conversationId,
					messageId: source.id,
				});
			recorded.set(source.id, row);
			if (row.state !== "accepted") {
				for (const actionId of source.replayActionIds ?? []) {
					const targets = replayTargets.get(actionId) ?? [];
					targets.push({ source: row, scope: source.scope });
					replayTargets.set(actionId, targets);
				}
			}
			if (
				row.state !== "revoked" &&
				!(
					row.state === "accepted" &&
					(account.authority === "hindsight" ||
						row.controlRevision !== inventory.controlRevision)
				)
			)
				jobs.push({
					userId,
					bankId: bank.id,
					epoch: inventory.epoch,
					kind: "source",
					sourceId: row.id,
					requestId: sourceRequestId(row.id, sourceActions(source.id)),
				});
		}
		if (replayTargets.size)
			for (const {
				action,
				intent: original,
				order,
				correction,
			} of readNativeCurationLineage(
				tx,
				userId,
				inventory.epoch,
				currentRows,
			)) {
				const targets = replayTargets.get(action.id);
				if (!targets?.length) continue;
				for (const bankId of new Set(
					targets.map((target) => target.source.bankId),
				)) {
					const local = targets.filter(
						(target) => target.source.bankId === bankId,
					);
					const sourceIds = local.map(({ source }) => source.id);
					const requestId = deterministicId(
						`native-migration-replay:${action.id}:${bankId}:${sourceIds.sort().join(",")}`,
					);
					const edit = action.kind === "edit";
					const ref = {
						scope: local[0].scope,
						generation: "migration",
						rowId: action.id,
					};
					const intent: ActionIntentRecord = {
						request: edit
							? { kind: "edit", text: action.text ?? "", requestId, ref }
							: { kind: "remove", requestId, ref },
						outcome: "accepted",
						replayOriginActionId: action.id,
						replayOrder: order,
						before: original.before,
						sourceIds,
						facts: [],
						plan: original.plan,
						// An existing assertion can only support replay in its own bank.
						addedSourceId:
							correction?.bankId === bankId && correction.state === "accepted"
								? correction.id
								: undefined,
					};
					tx.insert(memoryActions)
						.values({
							id: randomUUID(),
							userId,
							bankId,
							epoch: inventory.epoch,
							requestId,
							kind: edit ? "migration_edit" : "migration_remove",
							previousText: original.before,
							text: edit ? action.text : null,
							intentJson: JSON.stringify(intent),
							exclusionAcknowledged: true,
							createdAt: action.createdAt,
						})
						.onConflictDoNothing()
						.run();
				}
			}
		for (const action of inventory.actions) {
			if (
				inventory.exceptions.some((e) => e.id === action.id) ||
				action.kind === "endorsement" ||
				!action.at
			)
				continue;
			if (action.kind === "authored") {
				if (!user.memoryEnabled || !action.scope || !authored.has(action.id))
					continue;
				const bank = ensureMemoryBank(userId, action.scope);
				const scopedRows = currentRows.filter(
					(s) => s.bankId === bank.id && s.lineageId === action.id,
				);
				const source =
					scopedRows.find((s) => s.state !== "revoked") ??
					recordMemorySource({
						userId,
						bankId: bank.id,
						epoch: inventory.epoch,
						eventId:
							scopedRows.length || old.some((s) => s.eventId === action.id)
								? `authored:${bank.id}:${scopedRows.length}:${action.id}`
								: action.id,
						lineageId: action.id,
						text: action.after,
						context: JSON.stringify({
							migrationAuthoredId: action.id,
							legacyItemId: action.itemId,
							legacyReviewResolutionId: action.reviewResolutionId,
						}),
						assertedAt: new Date(action.at),
					});
				recorded.set(action.id, source);
				jobs.push({
					userId,
					bankId: bank.id,
					epoch: inventory.epoch,
					kind: "source",
					sourceId: source.id,
					requestId: `source:${source.id}`,
				});
				continue;
			}
			const sources = action.sourceIds
				.map((id) => recorded.get(id))
				.filter((x) => x !== undefined);
			for (const bankId of new Set(sources.map((s) => s.bankId))) {
				const linked = sources.filter((s) => s.bankId === bankId);
				const requestId = deterministicId(`migration:${action.id}:${bankId}`);
				const scope = eligible.find((s) => s.id === linked[0].messageId)
					?.scope ?? { kind: "personal" };
				const intent: ActionIntentRecord = {
					// Old sources retain their own dates. Remove the superseded text
					// here; the current authored replacement has its own source.
					request: {
						kind: "remove",
						requestId,
						ref: { scope, generation: "migration", rowId: action.id },
					},
					before: action.before,
					sourceIds: linked.map((s) => s.id),
					facts: [],
				};
				const previousAction = tx
					.select()
					.from(memoryActions)
					.where(
						and(
							eq(memoryActions.userId, userId),
							eq(memoryActions.requestId, requestId),
						),
					)
					.get();
				if (previousAction?.intentJson) {
					const previousIntent: ActionIntentRecord = JSON.parse(
						previousAction.intentJson,
					);
					const merged = {
						...previousIntent,
						sourceIds: [
							...new Set([
								...previousIntent.sourceIds.filter((id) => liveSources.has(id)),
								...intent.sourceIds,
							]),
						],
						facts: previousIntent.facts.filter(({ sourceId }) =>
							liveSources.has(sourceId),
						),
					};
					tx.update(memoryActions)
						.set({ intentJson: JSON.stringify(merged) })
						.where(eq(memoryActions.id, previousAction.id))
						.run();
				}
				tx.insert(memoryActions)
					.values({
						id: randomUUID(),
						userId,
						bankId,
						epoch: inventory.epoch,
						requestId,
						kind: "migration_remove",
						previousText: action.before,
						intentJson: JSON.stringify(intent),
						exclusionAcknowledged: true,
						cleanupPending: true,
						createdAt: new Date(action.at ?? ""),
					})
					.onConflictDoNothing()
					.run();
			}
		}
		tx.insert(memoryMigrationManifests)
			.values({
				id,
				userId,
				epoch: inventory.epoch,
				status: "preparing",
				manifestJson: JSON.stringify(inventory),
				checkpointJson: JSON.stringify({
					...parseJsonRecord(previous?.checkpointJson ?? null),
					fingerprint: inventory.fingerprint,
					sourceIds: [...recorded.values()].map((s) => s.id),
					requestIds: jobs.map((job) => job.requestId),
				}),
			})
			.onConflictDoUpdate({
				target: memoryMigrationManifests.id,
				set: {
					status: "preparing",
					manifestJson: JSON.stringify(inventory),
					checkpointJson: JSON.stringify({
						...parseJsonRecord(previous?.checkpointJson ?? null),
						fingerprint: inventory.fingerprint,
						sourceIds: [...recorded.values()].map((s) => s.id),
						requestIds: jobs.map((job) => job.requestId),
					}),
				},
			})
			.run();
		tx.update(memoryAccounts)
			.set({
				historyStatus:
					inventory.exceptions.length ||
					inventory.sources.some(
						(s) => s.eligibility === "held" || s.eligibility === "uncertain",
					)
						? "held"
						: "working",
			})
			.where(eq(memoryAccounts.userId, userId))
			.run();
		return jobs;
	});
	await cancelAll(memoryDeliveryJob, {
		userId,
		where: (jobs) =>
			sql`${jobs.kind} = 'source' AND EXISTS (SELECT 1 FROM memory_source_revisions source WHERE source.id = ${jobs.sourceId} AND source.state = 'revoked')`,
	});
	for (const { row } of results)
		if (row.status === "failed" && row.retryable)
			await retry(memoryDeliveryJob, row.id, { userId });
	settleMemoryMigration(userId);
	return { id: manifestId, ...verifyMemoryMigration(userId, manifestId) };
}
export function cutoverMemoryMigration(userId: string, id: string) {
	return db.transaction((tx) => {
		const report = verifyMemoryMigration(userId, id);
		if (!report.ready) throw Error("memory_migration_not_ready");
		const account = tx
			.select()
			.from(memoryAccounts)
			.where(eq(memoryAccounts.userId, userId))
			.get();
		if (account?.lifecycleState !== "active")
			throw Error("memory_migration_not_ready");
		if (account.authority === "hindsight") {
			const existing = tx
				.select()
				.from(memoryMigrationManifests)
				.where(eq(memoryMigrationManifests.id, id))
				.get();
			if (!parseJsonRecord(existing?.checkpointJson ?? null).cutoverAt)
				throw Error("memory_migration_already_native");
			return report;
		}
		if (account.authority !== "preparing")
			throw Error("memory_migration_not_ready");
		const banks = tx
			.select()
			.from(memoryBanks)
			.where(
				and(
					eq(memoryBanks.userId, userId),
					eq(memoryBanks.epoch, account.epoch),
				),
			)
			.all();
		// Empty banks need native capability validation too; no activation based on a local row alone.
		if (
			banks.some(
				(b) =>
					b.status !== "retired" &&
					(!b.nativeBaseUrl ||
						!b.nativeCredentialHash ||
						b.nativeConfigVersion !== HINDSIGHT_ENGINE_COMMIT ||
						b.status !== "ready"),
			)
		)
			throw Error("memory_migration_not_ready");
		tx.update(memoryAccounts)
			.set({
				authority: "hindsight",
				historyStatus: report.held || report.uncertain ? "held" : "complete",
			})
			.where(eq(memoryAccounts.userId, userId))
			.run();
		tx.update(memoryMigrationManifests)
			.set({
				status: "cutover",
				checkpointJson: JSON.stringify({
					...parseJsonRecord(
						tx
							.select()
							.from(memoryMigrationManifests)
							.where(eq(memoryMigrationManifests.id, id))
							.get()?.checkpointJson ?? null,
					),
					cutoverAt: new Date().toISOString(),
					rollbackUntil: new Date(Date.now() + 30 * 86400000).toISOString(),
					epoch: account.epoch,
					controlRevision: account.controlRevision,
					rollbackFingerprint: rollbackFingerprint(userId),
				}),
			})
			.where(eq(memoryMigrationManifests.id, id))
			.run();
		return report;
	});
}
/** Fail closed if a native-era choice cannot be represented in legacy authority. Never resurrect. */
export function rollbackMemoryMigration(userId: string, id: string) {
	return db.transaction((tx) => {
		const m = tx
			.select()
			.from(memoryMigrationManifests)
			.where(
				and(
					eq(memoryMigrationManifests.id, id),
					eq(memoryMigrationManifests.userId, userId),
				),
			)
			.get();
		const account = tx
			.select()
			.from(memoryAccounts)
			.where(eq(memoryAccounts.userId, userId))
			.get();
		if (!m || !account || !parseJsonRecord(m.checkpointJson).cutoverAt)
			throw Error("memory_migration_not_cutover");
		const checkpoint = parseJsonRecord(m.checkpointJson);
		const cutoverAt =
			typeof checkpoint.cutoverAt === "string"
				? Date.parse(checkpoint.cutoverAt)
				: NaN;
		const until =
			typeof checkpoint.rollbackUntil === "string"
				? Date.parse(checkpoint.rollbackUntil)
				: NaN;
		const changed =
			account.epoch !== checkpoint.epoch ||
			account.controlRevision !== checkpoint.controlRevision ||
			!Number.isFinite(cutoverAt) ||
			!Number.isFinite(until) ||
			Date.now() > until ||
			checkpoint.rollbackFingerprint !== rollbackFingerprint(userId);
		tx.update(memoryAccounts)
			.set(
				changed
					? { lifecycleState: "rollback_blocked", historyStatus: "held" }
					: { authority: "legacy" },
			)
			.where(eq(memoryAccounts.userId, userId))
			.run();
		tx.update(memoryMigrationManifests)
			.set({ status: changed ? "rollback_blocked" : "rolled_back" })
			.where(eq(memoryMigrationManifests.id, id))
			.run();
		return { available: !changed };
	});
}

function rollbackFingerprint(userId: string) {
	return memoryTextHash(
		JSON.stringify({
			inventory: inspectMemoryMigration(userId).fingerprint,
			actions: db
				.select()
				.from(memoryActions)
				.where(eq(memoryActions.userId, userId))
				.all(),
			revocations: db
				.select()
				.from(memoryRevocations)
				.where(eq(memoryRevocations.userId, userId))
				.all(),
			sources: db
				.select()
				.from(memorySourceRevisions)
				.where(eq(memorySourceRevisions.userId, userId))
				.all(),
		}),
	);
}

function deterministicId(value: string) {
	const h = memoryTextHash(value);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
/** Only the new-user insertion transaction calls this: missing existing accounts stay legacy. */
export function initializeNewMemoryAccount(tx: Tx, userId: string): void {
	if (!getConfig().hindsightNewAccountsEnabled) return;
	const user = tx.select().from(users).where(eq(users.id, userId)).get();
	if (!user) throw Error("memory_unauthorized");
	tx.insert(memoryAccounts)
		.values({ userId, tenantId: randomUUID(), authority: "hindsight" })
		.run();
	tx.insert(memoryControlIntervals)
		.values({
			id: randomUUID(),
			userId,
			enabled: user.memoryEnabled,
			epoch: 0,
			startedAt: user.createdAt,
		})
		.run();
	tx.insert(memoryBanks)
		.values({ id: randomUUID(), userId, scopeKey: "personal", epoch: 0 })
		.run();
}
