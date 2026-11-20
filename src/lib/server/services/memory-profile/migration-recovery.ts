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
	assertDefaultHistoryWithdrawalBoundary,
	matchPlainMigrationRewind,
	matchPriorMigrationRepresentation,
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
export async function recoverAcknowledgedHistoricalMigration(
	input: {
		userId: string;
		manifestId: string;
		bankId: string;
		reviewedMerge?: { sourceId: string } & (
			| { snapshotHash: string }
			| { inspectOnly: true }
		);
	},
	ordinaryApproval?: { manifestHash: string; sourceIds: string[] },
) {
	const { userId, manifestId, bankId, reviewedMerge } = input;
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
			entries,
			revocations,
		};
	};
	const before = db.transaction(read);
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
	const memories = await captureSettledNative(client, signal);
	const raw = memories.filter((row) => row.fact_type !== "observation");
	return db.transaction((tx) => {
		const current = read(tx);
		requireRecovery(JSON.stringify(before) === JSON.stringify(current));
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
		if (!current.ordinaryCoverage && !reviewedMerge)
			assertDefaultHistoryWithdrawalBoundary(
				tx,
				userId,
				bankId,
				bank.scopeKey,
				memories,
			);

		const representation =
			current.ordinaryCoverage || reviewedMerge
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
			tx.update(memorySourceRevisions)
				.set({
					state: "staged",
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
		if (ordinaryApproval || reviewedMerge) {
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
