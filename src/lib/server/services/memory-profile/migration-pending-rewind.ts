import { and, eq, sql } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import {
	memoryAccounts,
	memoryDeliveryJobs,
	memoryMigrationManifests,
	memorySourceRevisions,
} from "$lib/server/db/schema";
import { cancelAll } from "../jobs/index";
import type { Tx } from "../jobs/types";
import { memoryDeliveryJob } from "./delivery-job";
import { captureSettledNative } from "./delivery-runner";
import { nativeMemoryClient } from "./hindsight-client";
import { parseJsonRecord } from "./internal-json";
import { prepareMemoryMigration } from "./migration";
import {
	matchApprovedOrdinaryRecovery,
	matchPriorMigrationRepresentation,
	protectedMigrationObservations,
	samePriorObservation,
} from "./migration-observation-proof";
import {
	inspectMemoryMigration,
	latestManifest,
	verifyMemoryMigration,
} from "./migration-progress";
import { recoverAcknowledgedHistoricalMigration } from "./migration-recovery";
import {
	admittedNativeFacts,
	assertCurationPublication,
	readAcknowledgedFacts,
	readPublishedMemory,
} from "./publication";
import {
	assertMemoryBankFence,
	assertMemorySourceCurrent,
	memoryScopeKey,
	memoryTextHash,
	revokeMemorySources,
} from "./revisions";

function requireRewind(condition: unknown): asserts condition {
	if (!condition) throw Error("memory_migration_rewind_unverified");
}

/** Rewind only exact, unpublished evidence revisions proved to have changed a prior observation. */
export async function rewindUnpublishedMigrationSources(input: {
	userId: string;
	manifestId: string;
	bankId: string;
	manifestHash: string;
	sourceIds: string[];
	holdCorrectionConflict?: boolean;
	allowOrdinaryConsolidation?: boolean;
}) {
	const { userId, manifestId, bankId, manifestHash } = input;
	requireRewind(
		Array.isArray(input.sourceIds) &&
			input.sourceIds.length > 0 &&
			input.sourceIds.length <= 32 &&
			input.sourceIds.every((id) => typeof id === "string" && id.length > 0) &&
			new Set(input.sourceIds).size === input.sourceIds.length,
	);
	const ids = [...input.sourceIds].sort();
	const holdConflict = input.holdCorrectionConflict === true;
	const allowOrdinary = input.allowOrdinaryConsolidation === true;
	requireRewind(!allowOrdinary || !holdConflict);

	const read = (tx: Tx) => {
		const c = getConfig();
		requireRewind(
			!c.hindsightWorkerEnabled &&
				!c.hindsightNewAccountsEnabled &&
				!c.hindsightRestoreHold,
		);
		const a = tx
			.select()
			.from(memoryAccounts)
			.where(eq(memoryAccounts.userId, userId))
			.get();
		requireRewind(a?.authority === "preparing");
		const manifest = latestManifest(userId);
		requireRewind(
			manifest?.id === manifestId &&
				manifest.epoch === a.epoch &&
				!verifyMemoryMigration(userId, manifestId).changed,
		);
		const bank = assertMemoryBankFence(tx, userId, bankId, a.epoch);
		requireRewind(
			bank.status === "ready" &&
				bank.generation &&
				bank.nativeBaseUrl &&
				bank.nativeCredentialHash,
		);
		assertCurationPublication(tx, bankId, a.epoch);
		const checkpoint = parseJsonRecord(manifest.checkpointJson);
		const marker = parseJsonRecord(
			JSON.stringify(checkpoint.migrationRewind ?? {}),
		);
		const ongoing =
			marker.bankId === bankId &&
			marker.generation === bank.generation &&
			JSON.stringify(marker.sourceIds) === JSON.stringify(ids) &&
			(marker.holdCorrectionConflict === true) === holdConflict;
		requireRewind(
			(!checkpoint.migrationRewind || ongoing) && (!allowOrdinary || ongoing),
		);
		requireRewind(
			memoryTextHash(manifest.manifestJson) === manifestHash ||
				(ongoing && marker.originalManifestHash === manifestHash),
		);
		const jobs = tx
			.select()
			.from(memoryDeliveryJobs)
			.where(eq(memoryDeliveryJobs.userId, userId))
			.all();
		requireRewind(
			jobs.every(
				(j) =>
					j.status !== "running" &&
					(j.bankId !== bankId ||
						j.kind === "source" ||
						j.status === "succeeded"),
			),
		);

		const inventory = inspectMemoryMigration(userId);
		const entries = ids.map((id) => {
			const source = tx
				.select()
				.from(memorySourceRevisions)
				.where(
					and(
						eq(memorySourceRevisions.id, id),
						eq(memorySourceRevisions.userId, userId),
						eq(memorySourceRevisions.bankId, bankId),
						eq(memorySourceRevisions.epoch, a.epoch),
					),
				)
				.get();
			requireRewind(
				source?.nativeAcknowledged &&
					source.nativeSubmitted &&
					source.nativeOperationId &&
					(source.state === "pending" ||
						(ongoing && source.state === "revoked")) &&
					!source.acceptedGeneration &&
					!source.predecessorSourceId &&
					readAcknowledgedFacts(source.acknowledgedFactsJson).length === 0 &&
					source.controlRevision === a.controlRevision,
			);
			if (!ongoing) {
				requireRewind(
					Array.isArray(checkpoint.sourceIds) &&
						checkpoint.sourceIds.includes(id) &&
						Array.isArray(checkpoint.requestIds) &&
						jobs.some(
							(j) =>
								j.sourceId === id &&
								j.kind === "source" &&
								(checkpoint.requestIds as unknown[]).includes(j.requestId),
						),
				);
				assertMemorySourceCurrent(tx, id, userId, bankId);
			}
			const spec = inventory.sources.find((s) => s.id === source.messageId);
			const meta = parseJsonRecord(source.context);
			requireRewind(
				spec &&
					(spec.eligibility === "eligible" ||
						(ongoing &&
							holdConflict &&
							spec.reason === "held_conflict_with_later_correction")) &&
					spec.defaultHistory &&
					!spec.explicitEditAt &&
					!spec.replayActionIds?.length &&
					spec.text === source.text &&
					spec.assertedAt === source.assertedAt.toISOString() &&
					spec.lineageId === source.lineageId &&
					spec.conversationId === source.conversationId &&
					memoryScopeKey(spec.scope) === bank.scopeKey &&
					meta.migrationDefaultHistory === true &&
					Array.isArray(meta.messages) &&
					!meta.messages.length,
			);
			return { source, operationId: source.nativeOperationId };
		});
		const accepted = admittedNativeFacts(userId, bankId, tx);
		requireRewind(accepted.every((fact) => !ids.includes(fact.source.id)));
		const published = readPublishedMemory(userId, bankId, undefined, tx);
		return {
			bank,
			manifest,
			checkpoint,
			ongoing,
			tenantId: a.tenantId,
			entries,
			accepted,
			published,
			protected: protectedMigrationObservations(tx, userId, bankId),
		};
	};
	const before = db.transaction(read);
	const signal = AbortSignal.timeout(180_000);
	const client = nativeMemoryClient(bankId, before.tenantId, signal, {
		baseUrl: before.bank.nativeBaseUrl ?? "",
		credentialHash: before.bank.nativeCredentialHash ?? "",
	});
	await client.verifyConfig();
	if (!before.ongoing) {
		for (const { operationId } of before.entries)
			requireRewind(
				(await client.operation(operationId)).status === "completed",
			);
		const memories = await captureSettledNative(client, signal);
		const raw = new Map(
			memories
				.filter((m) => m.fact_type !== "observation")
				.map((m) => [m.id, m]),
		);
		const byId = new Map(memories.map((m) => [m.id, m]));
		const contributors = new Set<string>();
		const conflictingFacts = new Set<string>();
		const changedObservations = new Set<string>();
		const protectedEvidence = new Map<string, Set<string>>();
		const admitted = new Map(
			before.accepted.map((fact) => [fact.id, fact.source]),
		);
		const origins = new Map(
			before.entries.map(({ source }) => [source.id, source]),
		);
		for (const prior of before.published) {
			const live = byId.get(prior.nativeId);
			requireRewind(live?.fact_type === "observation");
			if (samePriorObservation(prior, live, raw)) continue;
			const support = readAcknowledgedFacts(prior.sourceFingerprintsJson);
			const current = new Set(live.source_memory_ids ?? []);
			requireRewind(
				support.every((s) => {
					const item = raw.get(s.id);
					return (
						current.has(s.id) &&
						item?.text === s.text &&
						(item.mentioned_at ?? null) === (s.mentionedAt ?? null)
					);
				}),
			);
			const previous = new Set(support.map((s) => s.id));
			const appended = [...current].filter((id) => !previous.has(id));
			requireRewind(appended.length > 0);
			for (const id of appended) {
				const owner = raw.get(id)?.document_id;
				requireRewind(owner && ids.includes(owner));
				contributors.add(owner);
				if (holdConflict) {
					requireRewind(live.text !== prior.nativeText);
					const older = origins.get(owner);
					requireRewind(older);
					const protectedSupport = support.flatMap((fact) => {
						const source = admitted.get(fact.id);
						return source &&
							(typeof parseJsonRecord(source.context).migrationAuthoredId ===
								"string" ||
								source.explicitEditAt)
							? [{ source, assertedAtMs: fact.assertedAtMs }]
							: [];
					});
					requireRewind(
						protectedSupport.length > 0 &&
							protectedSupport.every(
								({ source, assertedAtMs }) =>
									source.bankId === bankId &&
									typeof assertedAtMs === "number" &&
									assertedAtMs > older.assertedAt.getTime(),
							),
					);
					const evidence = protectedEvidence.get(owner) ?? new Set<string>();
					for (const { source } of protectedSupport) evidence.add(source.id);
					protectedEvidence.set(owner, evidence);
					conflictingFacts.add(id);
					changedObservations.add(live.id);
				}
			}
		}
		requireRewind(contributors.size === ids.length);
		let correctionHolds: Array<{
			messageId: string;
			textHash: string;
			assertedAt: string;
			scopeKey: string;
			protectedSourceIds: string[];
		}> = [];
		if (holdConflict) {
			// A mixed source that also supports independent observations needs a
			// different disposition. Do not hold those unrelated assertions.
			requireRewind(
				[...raw.values()].every(
					(fact) =>
						!fact.document_id ||
						!contributors.has(fact.document_id) ||
						conflictingFacts.has(fact.id),
				),
			);
			requireRewind(
				memories.every(
					(row) =>
						row.fact_type !== "observation" ||
						changedObservations.has(row.id) ||
						!(row.source_memory_ids ?? []).some((id) =>
							conflictingFacts.has(id),
						),
				),
			);
			correctionHolds = before.entries.map(({ source }) => {
				const evidence = protectedEvidence.get(source.id);
				requireRewind(source.messageId && evidence?.size);
				return {
					messageId: source.messageId,
					textHash: source.textHash,
					assertedAt: source.assertedAt.toISOString(),
					scopeKey: before.bank.scopeKey,
					protectedSourceIds: [...evidence].sort(),
				};
			});
		}
		db.transaction((tx) => {
			requireRewind(JSON.stringify(read(tx)) === JSON.stringify(before));
			tx.update(memoryMigrationManifests)
				.set({
					checkpointJson: JSON.stringify({
						...before.checkpoint,
						migrationRewind: {
							bankId,
							generation: before.bank.generation,
							sourceIds: ids,
							originalManifestHash: manifestHash,
							holdCorrectionConflict: holdConflict,
							correctionHolds,
						},
					}),
				})
				.where(eq(memoryMigrationManifests.id, manifestId))
				.run();
			revokeMemorySources(userId, ids);
		});
	}
	await cancelAll(memoryDeliveryJob, {
		userId,
		where: (jobs) =>
			sql`${jobs.kind} = 'source' AND ${jobs.bankId} = ${bankId}
				AND ${jobs.sourceId} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`,
	});
	const saved = db.transaction(read);
	requireRewind(saved.ongoing);
	const assertCurrent = (tx: Tx) => {
		requireRewind(JSON.stringify(read(tx)) === JSON.stringify(saved));
	};
	const guard = () => db.transaction(assertCurrent);
	for (const id of ids) await client.deleteDocument(id, guard);
	await client.consolidate(guard);
	const restored = await captureSettledNative(client, signal);
	requireRewind(
		restored.every(
			(row) => !row.document_id || !ids.includes(row.document_id),
		) &&
			(allowOrdinary
				? db.transaction((tx) =>
						matchApprovedOrdinaryRecovery(
							tx,
							userId,
							bankId,
							saved.bank.scopeKey,
							saved.published,
							restored,
						),
					)
				: matchPriorMigrationRepresentation(
						saved.published,
						restored,
						true,
						holdConflict ? undefined : saved.protected,
					)),
	);
	guard();
	const prepared = await prepareMemoryMigration(
		userId,
		holdConflict || allowOrdinary
			? { bankId, assertCurrent, holdCorrectionConflict: holdConflict }
			: undefined,
	);
	requireRewind(prepared.id === manifestId);
	const result = await recoverAcknowledgedHistoricalMigration(
		{
			userId,
			manifestId,
			bankId,
		},
		allowOrdinary ? { manifestHash, sourceIds: ids } : undefined,
	);
	return {
		replacedSources: holdConflict ? 0 : ids.length,
		heldConflicts: holdConflict ? ids.length : 0,
		...result,
	};
}
