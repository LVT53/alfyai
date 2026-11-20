import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import {
	memoryAccounts,
	memoryDeliveryJobs,
	memoryMigrationManifests,
	memoryRevocations,
	memorySourceRevisions,
} from "$lib/server/db/schema";
import { reopen } from "../jobs/ledger";
import type { Tx } from "../jobs/types";
import type { NativeMemory } from "./contracts";
import { memoryDeliveryJob } from "./delivery-job";
import { captureSettledNative } from "./delivery-runner";
import { nativeMemoryClient } from "./hindsight-client";
import { parseJsonRecord } from "./internal-json";
import {
	approvedMigrationObservationWording,
	assertDefaultHistoryWithdrawalBoundary,
	matchPlainMigrationRewind,
	matchPriorMigrationRepresentation,
	reconnectVerifiedObservations,
} from "./migration-observation-proof";
import {
	inspectMemoryMigration,
	latestManifest,
	verifyMemoryMigration,
} from "./migration-progress";
import {
	admittedNativeFacts,
	publishNativeSnapshot,
	readAcknowledgedFacts,
	readPublishedMemory,
} from "./publication";
import {
	assertMemoryBankFence,
	assertMemorySourceCurrent,
	memoryScopeKey,
	memoryTextHash,
} from "./revisions";

const recoveryErrors = new Set([
	"memory_preparation_failed",
	"native_consolidation_incomplete",
	"native_operation_timeout",
]);

function requireRecovery(condition: unknown): asserts condition {
	if (!condition) throw Error("memory_migration_recovery_unverified");
}

/** A reviewed verdict expires with any applicant, checkpoint, provenance or native snapshot change. */
function historicalMergeSnapshotHash(state: unknown, memories: NativeMemory[]) {
	return memoryTextHash(
		JSON.stringify([
			"reviewed-historical-merge-v1",
			state,
			[...memories].sort((a, b) => a.id.localeCompare(b.id)),
		]),
	);
}

/**
 * Reconcile an inactive bank whose native writes finished while publication was
 * held. This only reads native state. It cannot retry retain, waive a curation
 * check or change the account's serving authority.
 */
type SelectiveRepair = { sourceId: string; nativeFactId: string } & (
	| { snapshotHash: string }
	| { inspectOnly: true }
);

function rawProof(rows: NativeMemory[]) {
	return memoryTextHash(
		JSON.stringify(
			rows
				.filter((row) => row.fact_type !== "observation")
				.map(({ id, text, document_id, mentioned_at }) => [
					id,
					text,
					document_id,
					mentioned_at ?? null,
				])
				.sort(([a], [b]) => (a ?? "").localeCompare(b ?? "")),
		),
	);
}

function independentProof(rows: NativeMemory[], sourceId: string) {
	const own = new Set(
		rows
			.filter(
				(row) =>
					row.fact_type !== "observation" && row.document_id === sourceId,
			)
			.map((row) => row.id),
	);
	const matches = rows.filter(
		(row) =>
			row.fact_type === "observation" &&
			row.source_memory_ids?.length &&
			row.source_memory_ids.every((id) => own.has(id)),
	);
	const covered = new Set(
		matches.flatMap((row) => row.source_memory_ids ?? []),
	);
	const signatures = matches
		.map((row) =>
			JSON.stringify([row.text, [...(row.source_memory_ids ?? [])].sort()]),
		)
		.sort();
	requireRecovery(
		own.size > 0 &&
			covered.size === own.size &&
			new Set(signatures).size === signatures.length,
	);
	return memoryTextHash(JSON.stringify(signatures));
}

export async function recoverAcknowledgedHistoricalMigration(
	input: {
		userId: string;
		manifestId: string;
		bankId: string;
		selectiveRepair?: SelectiveRepair;
		reviewedMerge?: { sourceId: string } & (
			| { snapshotHash: string }
			| { inspectOnly: true }
		);
	},
	ordinaryApproval?: { manifestHash: string; sourceIds: string[] },
) {
	const { userId, manifestId, bankId, reviewedMerge, selectiveRepair } = input;
	requireRecovery(!selectiveRepair || (!reviewedMerge && !ordinaryApproval));
	requireRecovery(!reviewedMerge || !ordinaryApproval);
	const read = (tx: Tx) => {
		const config = getConfig();
		requireRecovery(
			!config.hindsightWorkerEnabled &&
				!config.hindsightNewAccountsEnabled &&
				!config.hindsightRestoreHold,
		);
		const account = tx
			.select()
			.from(memoryAccounts)
			.where(eq(memoryAccounts.userId, userId))
			.get();
		const manifest = latestManifest(userId);
		requireRecovery(
			account?.authority === "preparing" &&
				manifest?.id === manifestId &&
				manifest.epoch === account.epoch &&
				!verifyMemoryMigration(userId, manifestId).changed,
		);
		const bank = assertMemoryBankFence(tx, userId, bankId, account.epoch);
		requireRecovery(
			bank.status === "ready" &&
				bank.nativeBaseUrl &&
				bank.nativeCredentialHash,
		);
		const checkpoint = parseJsonRecord(manifest.checkpointJson);
		requireRecovery(
			Array.isArray(checkpoint.requestIds) &&
				Array.isArray(checkpoint.sourceIds),
		);
		const rewound = parseJsonRecord(
			JSON.stringify(checkpoint.migrationRewind ?? {}),
		);
		const renumbered =
			rewound.bankId === bankId && rewound.generation === bank.generation;
		requireRecovery(!checkpoint.migrationRewind || renumbered);
		const selectiveMarker = parseJsonRecord(
			JSON.stringify(rewound.selectiveRetain ?? {}),
		);
		if (rewound.selectiveRetain)
			requireRecovery(
				renumbered &&
					selectiveRepair &&
					"snapshotHash" in selectiveRepair &&
					selectiveMarker.sourceId === selectiveRepair.sourceId &&
					selectiveMarker.nativeFactId === selectiveRepair.nativeFactId &&
					selectiveMarker.snapshotHash === selectiveRepair.snapshotHash &&
					typeof selectiveMarker.targetTextHash === "string" &&
					typeof selectiveMarker.rawAfterHash === "string" &&
					typeof selectiveMarker.independentAfterHash === "string",
			);
		else if (selectiveRepair) requireRecovery(!renumbered);

		if (ordinaryApproval)
			requireRecovery(
				renumbered &&
					rewound.holdCorrectionConflict === false &&
					rewound.originalManifestHash === ordinaryApproval.manifestHash &&
					JSON.stringify(rewound.sourceIds) ===
						JSON.stringify(ordinaryApproval.sourceIds),
			);
		const requiredRequests = new Set(checkpoint.requestIds);
		const requiredSources = new Set(checkpoint.sourceIds);
		const inventory = inspectMemoryMigration(userId);
		const jobs = tx
			.select()
			.from(memoryDeliveryJobs)
			.where(
				and(
					eq(memoryDeliveryJobs.userId, userId),
					eq(memoryDeliveryJobs.epoch, account.epoch),
				),
			)
			.all();
		requireRecovery(
			jobs.every(
				(job) =>
					job.status !== "running" &&
					(job.bankId !== bankId ||
						job.kind === "source" ||
						job.status === "succeeded"),
			),
		);
		const revocations = tx
			.select()
			.from(memoryRevocations)
			.where(eq(memoryRevocations.bankId, bankId))
			.all();
		const entries = jobs.flatMap((job) => {
			if (
				job.bankId !== bankId ||
				job.kind !== "source" ||
				!job.sourceId ||
				!requiredSources.has(job.sourceId) ||
				!requiredRequests.has(job.requestId) ||
				(job.status !== "failed" && job.status !== "queued")
			)
				return [];
			const source = tx
				.select()
				.from(memorySourceRevisions)
				.where(eq(memorySourceRevisions.id, job.sourceId))
				.get();
			if (!source?.nativeAcknowledged || source.state === "accepted") return [];
			requireRecovery(
				source.state === "pending" &&
					source.nativeSubmitted &&
					source.nativeOperationId &&
					!source.predecessorSourceId &&
					source.bankId === bankId &&
					source.epoch === account.epoch &&
					source.userId === userId &&
					source.controlRevision === account.controlRevision &&
					job.controlRevision === account.controlRevision &&
					(job.status === "queued" ||
						recoveryErrors.has(job.errorCode ?? "")) &&
					!revocations.some((revocation) => revocation.sourceId === source.id),
			);
			assertMemorySourceCurrent(tx, source.id, userId, bankId);
			const context = parseJsonRecord(source.context);
			if (source.messageId) {
				const spec = inventory.sources.find(
					(item) => item.id === source.messageId,
				);
				requireRecovery(
					spec?.eligibility === "eligible" &&
						spec.defaultHistory &&
						!spec.replayActionIds?.length &&
						!spec.explicitEditAt &&
						spec.conversationId === source.conversationId &&
						spec.lineageId === source.lineageId &&
						spec.text === source.text &&
						spec.assertedAt === source.assertedAt.toISOString() &&
						memoryScopeKey(spec.scope) === bank.scopeKey &&
						context.migrationDefaultHistory === true &&
						Array.isArray(context.messages) &&
						!context.messages.length,
				);
			} else {
				const spec = inventory.actions.find(
					(a) => a.id === context.migrationAuthoredId,
				);
				requireRecovery(
					spec?.kind === "authored" &&
						spec.scope &&
						!inventory.exceptions.some((item) => item.id === spec.id) &&
						spec.id === source.lineageId &&
						spec.after === source.text &&
						spec.at === source.assertedAt.toISOString() &&
						memoryScopeKey(spec.scope) === bank.scopeKey,
				);
			}
			return [
				{
					job,
					source: { ...source, nativeOperationId: source.nativeOperationId },
				},
			];
		});
		return {
			tenantId: account.tenantId,
			bank,
			fingerprint: inventory.fingerprint,
			manifestJson: manifest.manifestJson,
			checkpointJson: manifest.checkpointJson,
			renumbered,
			ordinaryCoverage: renumbered && rewound.holdCorrectionConflict === false,
			selectiveMarker: rewound.selectiveRetain ? selectiveMarker : null,
			entries,
			revocations,
		};
	};
	let before = db.transaction(read);
	requireRecovery(before.entries.length > 0 || before.renumbered);
	if (reviewedMerge)
		requireRecovery(
			!before.renumbered &&
				before.entries.length === 1 &&
				before.entries[0].source.id === reviewedMerge.sourceId &&
				before.entries[0].job.status === "failed" &&
				before.entries[0].job.errorCode === "memory_preparation_failed" &&
				before.entries[0].source.messageId,
		);
	if (selectiveRepair)
		requireRecovery(
			before.entries.length === 1 &&
				before.entries[0].source.id === selectiveRepair.sourceId &&
				before.entries[0].job.status === "failed" &&
				before.entries[0].job.errorCode === "memory_preparation_failed" &&
				before.entries[0].source.messageId,
		);

	const { bank } = before;
	const signal = AbortSignal.timeout(180_000);
	const client = nativeMemoryClient(bankId, before.tenantId, signal, {
		baseUrl: bank.nativeBaseUrl ?? "",
		credentialHash: bank.nativeCredentialHash ?? "",
	});
	await client.verifyConfig();
	for (const { source } of before.entries)
		requireRecovery(
			(await client.operation(source.nativeOperationId)).status === "completed",
		);
	const sameState = (tx: Tx) =>
		requireRecovery(JSON.stringify(before) === JSON.stringify(read(tx)));
	if (selectiveRepair) {
		if (!before.selectiveMarker) {
			const observed = await captureSettledNative(client, signal);
			const reviewed = db.transaction((tx) => {
				sameState(tx);
				const prior = readPublishedMemory(userId, bankId, undefined, tx);
				const accepted = admittedNativeFacts(userId, bankId, tx);
				const approved = approvedMigrationObservationWording(
					tx,
					userId,
					bankId,
					prior,
				);
				const target = observed.find(
					(row) => row.id === selectiveRepair.nativeFactId,
				);
				requireRecovery(
					target &&
						target.fact_type !== "observation" &&
						target.document_id === selectiveRepair.sourceId,
				);
				const matching = observed.filter(
					(row) =>
						row.fact_type === "observation" &&
						row.source_memory_ids?.includes(target.id),
				);
				requireRecovery(matching.length === 1);
				const [changed] = matching;
				const original = prior.find((row) => row.nativeId === changed.id);
				requireRecovery(
					original &&
						approved.has(original.nativeId) &&
						changed.text !== original.nativeText,
				);
				const supported = readAcknowledgedFacts(
					original.sourceFingerprintsJson,
				);
				const exactRaw = new Map(
					observed
						.filter((row) => row.fact_type !== "observation")
						.map((row) => [row.id, row]),
				);
				requireRecovery(
					supported.length > 0 &&
						changed.source_memory_ids?.length === supported.length + 1 &&
						new Set(changed.source_memory_ids).size === supported.length + 1 &&
						supported.every(
							(fact) =>
								changed.source_memory_ids?.includes(fact.id) &&
								exactRaw.get(fact.id)?.text === fact.text &&
								(exactRaw.get(fact.id)?.mentioned_at ?? null) ===
									(fact.mentionedAt ?? null) &&
								typeof fact.assertedAtMs === "number" &&
								fact.assertedAtMs >
									before.entries[0].source.assertedAt.getTime(),
						),
				);
				const unaffected = observed.filter(
					(row) => row.id !== target.id && row.id !== changed.id,
				);
				const otherPrior = prior.filter((row) => row.id !== original.id);
				requireRecovery(
					reconnectVerifiedObservations(otherPrior, unaffected, approved),
				);
				const snapshotHash = historicalMergeSnapshotHash(
					{
						userId,
						manifestId,
						state: {
							...before,
							checkpointJson: JSON.stringify(
								parseJsonRecord(before.checkpointJson),
							),
						},
						prior,
						accepted,
					},
					observed,
				);
				const marker = {
					sourceId: selectiveRepair.sourceId,
					nativeFactId: target.id,
					snapshotHash,
					targetTextHash: memoryTextHash(target.text),
					rawAfterHash: rawProof(unaffected),
					independentAfterHash: independentProof(
						unaffected,
						selectiveRepair.sourceId,
					),
				};
				if ("snapshotHash" in selectiveRepair) {
					requireRecovery(selectiveRepair.snapshotHash === snapshotHash);
					const checkpoint = parseJsonRecord(before.checkpointJson);
					tx.update(memoryMigrationManifests)
						.set({
							checkpointJson: JSON.stringify({
								...checkpoint,
								migrationRewind: {
									bankId,
									generation: bank.generation,
									selectiveRetain: marker,
								},
							}),
						})
						.where(eq(memoryMigrationManifests.id, manifestId))
						.run();
				}
				return marker;
			});
			if ("inspectOnly" in selectiveRepair)
				return { reopened: 0, sources: 1, snapshotHash: reviewed.snapshotHash };
			before = db.transaction(read);
		}
		const marker = before.selectiveMarker;
		requireRecovery(marker && typeof marker.targetTextHash === "string");
		const target = {
			id: selectiveRepair.nativeFactId,
			textHash: marker.targetTextHash,
			sourceId: selectiveRepair.sourceId,
		};
		const guard = () => db.transaction(sameState);
		if (!(await client.matchesArchivedFact(target))) {
			const live = await captureSettledNative(client, signal);
			const prior = readPublishedMemory(userId, bankId);
			const accepted = admittedNativeFacts(userId, bankId);
			const checkpoint = parseJsonRecord(before.checkpointJson);
			delete checkpoint.migrationRewind;
			// If this process stopped before PATCH, require the original sealed
			// native evidence again before dispatching its exact archival.
			const nativeTarget = live.find((row) => row.id === target.id);
			requireRecovery(
				nativeTarget?.document_id === target.sourceId &&
					memoryTextHash(nativeTarget.text) === target.textHash,
			);
			const originalState = {
				...before,
				checkpointJson: JSON.stringify(checkpoint),
				renumbered: false,
				ordinaryCoverage: false,
				selectiveMarker: null,
			};
			requireRecovery(
				historicalMergeSnapshotHash(
					{ userId, manifestId, state: originalState, prior, accepted },
					live,
				) === marker.snapshotHash,
			);
			await client.editFact(
				target.id,
				{
					state: "invalidated",
					reason:
						"Verified historical conflict with a later authored correction",
				},
				guard,
			);
		}
		requireRecovery(await client.matchesArchivedFact(target));
		await client.consolidate(guard);
	}
	const memories = await captureSettledNative(client, signal);
	const raw = memories.filter((row) => row.fact_type !== "observation");
	return db.transaction((tx) => {
		const current = read(tx);
		sameState(tx);
		const accepted = admittedNativeFacts(userId, bankId, tx);
		const acceptedById = new Map(accepted.map((fact) => [fact.id, fact]));
		const selected = new Set(current.entries.map(({ source }) => source.id));
		requireRecovery(selected.size === current.entries.length);
		requireRecovery(
			raw.every((fact) => {
				const prior = acceptedById.get(fact.id);
				return prior
					? prior.text === fact.text && fact.document_id === prior.source.id
					: !!fact.document_id && selected.has(fact.document_id);
			}),
		);
		const rawById = new Map(raw.map((fact) => [fact.id, fact]));
		requireRecovery(
			accepted.every((fact) => {
				const live = rawById.get(fact.id);
				return live?.text === fact.text && live.document_id === fact.source.id;
			}),
		);
		const prior = readPublishedMemory(userId, bankId, undefined, tx);

		const approved = selectiveRepair
			? approvedMigrationObservationWording(tx, userId, bankId, prior)
			: new Map<string, string>();
		const selectivePrepared = selectiveRepair
			? reconnectVerifiedObservations(prior, memories, approved)
			: null;
		if (selectiveRepair) {
			const marker = current.selectiveMarker;
			requireRecovery(
				marker &&
					selectivePrepared &&
					rawProof(memories) === marker.rawAfterHash &&
					independentProof(memories, selectiveRepair.sourceId) ===
						marker.independentAfterHash &&
					!memories.some(
						(row) =>
							row.id === selectiveRepair.nativeFactId ||
							row.source_memory_ids?.includes(selectiveRepair.nativeFactId),
					),
			);
		}
		if (!current.ordinaryCoverage && !reviewedMerge)
			assertDefaultHistoryWithdrawalBoundary(
				tx,
				userId,
				bankId,
				bank.scopeKey,
				memories,
			);

		const representation = selectivePrepared
			? { exact: [], regenerated: null }
			: current.ordinaryCoverage || reviewedMerge
				? matchPlainMigrationRewind(
						tx,
						userId,
						bankId,
						bank.scopeKey,
						prior,
						memories,
						!!ordinaryApproval || !!reviewedMerge,
						reviewedMerge?.sourceId,
					)
				: matchPriorMigrationRepresentation(
						prior,
						memories,
						current.renumbered,
					);
		requireRecovery(representation);
		if (reviewedMerge) {
			const snapshotHash = historicalMergeSnapshotHash(
				{ userId, manifestId, state: current, prior, accepted },
				memories,
			);
			if ("inspectOnly" in reviewedMerge)
				return { reopened: 0, sources: 1, snapshotHash };
			requireRecovery(reviewedMerge.snapshotHash === snapshotHash);
		}
		for (const { source } of current.entries) {
			const acknowledgements = raw
				.filter((fact) => fact.document_id === source.id)
				.map(({ id, text }) => ({ id, text }));
			if (selectiveRepair) {
				const targetTextHash = current.selectiveMarker?.targetTextHash;
				requireRecovery(typeof targetTextHash === "string");
				tx.insert(memoryRevocations)
					.values({
						id: randomUUID(),
						userId,
						bankId,
						epoch: bank.epoch,
						nativeFactId: selectiveRepair.nativeFactId,
						nativeTextHash: targetTextHash,
					})
					.run();
			}
			tx.update(memorySourceRevisions)
				.set({
					state: "staged",
					...(selectiveRepair &&
					typeof current.selectiveMarker?.targetTextHash === "string"
						? {
								context: JSON.stringify({
									...parseJsonRecord(source.context),
									migrationSelectiveArchivedHash:
										current.selectiveMarker.targetTextHash,
								}),
							}
						: {}),
					acknowledgedFactsJson: JSON.stringify(acknowledgements),
				})
				.where(eq(memorySourceRevisions.id, source.id))
				.run();
		}
		publishNativeSnapshot(tx, {
			userId,
			bankId,
			epoch: bank.epoch,
			expectedRevision: bank.revision,
			memories,
			...(selectivePrepared ? { prepared: selectivePrepared } : {}),
			sourceIds: [...selected],
		});
		const supportProof = (row: (typeof prior)[number]) =>
			JSON.stringify(
				readAcknowledgedFacts(row.sourceFingerprintsJson).sort((a, b) =>
					a.id.localeCompare(b.id),
				),
			);
		const proof = (row: (typeof prior)[number]) =>
			JSON.stringify([row.text, row.nativeText, supportProof(row)]);
		const rows = readPublishedMemory(userId, bankId, undefined, tx);
		const published = new Set(rows.map(proof));
		requireRecovery(
			representation.exact.every((row) => published.has(proof(row))),
		);
		if (representation.regenerated) {
			const successor = rows.find(
				(row) => row.nativeId === representation.regenerated?.nativeId,
			);
			requireRecovery(
				successor &&
					supportProof(successor) ===
						supportProof(representation.regenerated.prior),
			);
		}
		if (ordinaryApproval || reviewedMerge || selectiveRepair) {
			const covered = new Set(
				rows
					.flatMap((row) => readAcknowledgedFacts(row.sourceFingerprintsJson))
					.map((fact) => JSON.stringify(fact)),
			);
			requireRecovery(
				prior.every((row) =>
					readAcknowledgedFacts(row.sourceFingerprintsJson).every((fact) =>
						covered.has(JSON.stringify(fact)),
					),
				),
			);
		}
		if (current.renumbered) {
			const checkpoint = parseJsonRecord(current.checkpointJson);
			delete checkpoint.migrationRewind;
			tx.update(memoryMigrationManifests)
				.set({ checkpointJson: JSON.stringify(checkpoint) })
				.where(eq(memoryMigrationManifests.id, manifestId))
				.run();
		}
		let reopened = 0;
		for (const { job } of current.entries) {
			if (job.status !== "failed") continue;
			requireRecovery(
				reopen(memoryDeliveryJob, job.id, {
					userId,
					from: ["failed"],
					keepCheckpoint: true,
					allow: (_tx, row) =>
						row.id === job.id &&
						row.sourceId === job.sourceId &&
						row.errorCode === job.errorCode,
				}),
			);
			reopened++;
		}
		return { reopened, sources: current.entries.length };
	});
}
