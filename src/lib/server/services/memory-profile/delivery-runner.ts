import { and, eq, ne } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	memoryAccounts,
	memoryBanks,
	memoryDeliveryJobs,
	memorySourceRevisions,
	users,
} from "$lib/server/db/schema";
import type { JobRunContext, Tx } from "../jobs/types";
import {
	ensureConfiguredBank,
	verifySubmittedBankConfig,
} from "./bank-configuration";
import {
	EXPLICIT_EDIT_RETENTION_GUIDANCE,
	NATIVE_BANK_CONFIG_LEGACY_UNKNOWN,
	NATIVE_BANK_CONFIG_PENDING,
	type NativeMemory,
} from "./contracts";
import { memoryResendTransitions } from "./curation-lineage";
import { runDependencyRepair } from "./dependency-repair";
import {
	configuredNativeBinding,
	type HindsightClient,
	NativeMemoryError,
	nativeMemoryClient,
} from "./hindsight-client";
import { parseJsonRecord } from "./internal-json";
import {
	assertDefaultHistoryWithdrawalBoundary,
	assertHistoryPreservesAuthoredObservations,
	reconnectVerifiedObservations,
} from "./migration-observation-proof";
import {
	inspectMemoryMigration,
	latestManifest,
	settleMemoryMigration,
} from "./migration-progress";
import {
	admittedNativeFacts,
	approvedMigrationObservationWording,
	assertCurationPublication,
	prepareNativeSnapshot,
	publishNativeSnapshot,
	readAcknowledgedFacts,
	readPublishedMemory,
	verifiedSourceCleanupSnapshot,
} from "./publication";
import {
	assertMemoryBankFence,
	assertMemorySourceCurrent,
	isEditResendWithdrawal,
	resolveMemorySourceContext,
} from "./revisions";

async function pause(signal: AbortSignal) {
	signal.throwIfAborted();
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(done, 500);
		function done() {
			signal.removeEventListener("abort", abort);
			resolve();
		}
		function abort() {
			clearTimeout(timer);
			reject(new NativeMemoryError("native_cancelled", false));
		}
		signal.addEventListener("abort", abort, { once: true });
	});
}
async function settle(
	client: HindsightClient,
	ids: string[],
	signal: AbortSignal,
	cleanup = false,
) {
	const deadline = Date.now() + 180000;
	while (Date.now() < deadline) {
		signal.throwIfAborted();
		const ops = await Promise.all(ids.map((id) => client.operation(id)));
		if (ops.some((o) => o.status === "not_found"))
			throw new NativeMemoryError("native_acknowledgement_unknown", true);
		if (!cleanup && ops.some((o) => ["failed", "cancelled"].includes(o.status)))
			throw new NativeMemoryError("native_operation_failed", false);
		if (
			ops.every((o) => ["completed", "failed", "cancelled"].includes(o.status))
		)
			return;
		await pause(signal);
	}
	throw new NativeMemoryError("native_operation_timeout", true);
}
async function drainNative(client: HindsightClient, signal: AbortSignal) {
	const deadline = Date.now() + 180000;
	while (Date.now() < deadline) {
		const pending = await client.pendingOperations();
		if (!pending.length) return;
		await settle(
			client,
			pending.map((o) => o.id),
			signal,
			true,
		);
		await pause(signal);
	}
	throw new NativeMemoryError("native_bank_busy", true);
}
/** Two identical complete captures bracketed by bank quiescence, including chained consolidation rounds. */
export async function captureSettledNative(
	client: HindsightClient,
	signal: AbortSignal,
): Promise<NativeMemory[]> {
	await drainNative(client, signal);
	const first = await client.list();
	await drainNative(client, signal);
	const second = await client.list();
	if ((await client.pendingOperations()).length)
		throw new NativeMemoryError("native_capture_unstable", true);
	const canonical = (rows: NativeMemory[]) =>
		JSON.stringify([...rows].sort((a, b) => a.id.localeCompare(b.id)));
	if (canonical(first) !== canonical(second))
		throw new NativeMemoryError("native_capture_unstable", true);
	if (
		second.some(
			(f) =>
				f.fact_type !== "observation" &&
				(!f.consolidated_at || f.consolidation_failed_at),
		)
	)
		throw new NativeMemoryError("native_consolidation_incomplete", true);
	return second;
}
function assertDelivery(tx: Tx, row: typeof memoryDeliveryJobs.$inferSelect) {
	const bank = assertMemoryBankFence(tx, row.userId, row.bankId, row.epoch);
	const account = tx
		.select()
		.from(memoryAccounts)
		.where(eq(memoryAccounts.userId, row.userId))
		.get();
	if (account?.controlRevision !== row.controlRevision)
		throw new NativeMemoryError("memory_control_changed", false);
	if (!row.sourceId)
		throw new NativeMemoryError("memory_source_missing", false);
	const source = assertMemorySourceCurrent(
		tx,
		row.sourceId,
		row.userId,
		row.bankId,
	);
	if (
		source.state === "repair_held" ||
		source.controlRevision !== row.controlRevision ||
		source.epoch !== row.epoch
	)
		throw new NativeMemoryError("memory_source_control_changed", false);
	if (parseJsonRecord(source.context).migrationDefaultHistory === true) {
		const intended = inspectMemoryMigration(row.userId).sources.find(
			({ id }) => id === source.messageId,
		);
		if (intended?.eligibility !== "eligible" || !intended.defaultHistory)
			throw new NativeMemoryError(
				"memory_historical_permission_changed",
				false,
			);
	}
	return { bank, source, transitions: memoryResendTransitions(tx, source) };
}

function finishEditResend(
	tx: Tx,
	previous: typeof memorySourceRevisions.$inferSelect,
) {
	if (isEditResendWithdrawal(previous))
		tx.update(memorySourceRevisions)
			.set({
				context: JSON.stringify({
					...parseJsonRecord(previous.context),
					editResendWithdrawal: false,
				}),
			})
			.where(eq(memorySourceRevisions.id, previous.id))
			.run();
}
export async function runMemoryDelivery(
	ctx: JobRunContext<typeof memoryDeliveryJobs>,
): Promise<void> {
	try {
		const row = ctx.row;
		const account = db
			.select()
			.from(memoryAccounts)
			.where(eq(memoryAccounts.userId, row.userId))
			.get();
		const tenant = row.kind === "cleanup" ? row.tenantId : account?.tenantId;
		if (!tenant) throw new NativeMemoryError("memory_account_missing", false);
		if (row.kind === "cleanup") {
			// A restart and a later erasure can each queue a cleanup for the same
			// retired bank. Once one has deleted it and confirmed it gone, the
			// other has nothing left to settle there.
			if (
				db
					.select({ id: memoryDeliveryJobs.id })
					.from(memoryDeliveryJobs)
					.where(
						and(
							eq(memoryDeliveryJobs.userId, row.userId),
							eq(memoryDeliveryJobs.kind, "cleanup"),
							eq(memoryDeliveryJobs.bankId, row.bankId),
							eq(memoryDeliveryJobs.status, "succeeded"),
							ne(memoryDeliveryJobs.id, row.id),
						),
					)
					.get()
			) {
				await ctx.succeed();
				return;
			}
			if (!row.nativeBaseUrl || !row.nativeCredentialHash)
				throw new NativeMemoryError("memory_cleanup_corrupt", false);
			const client = nativeMemoryClient(row.bankId, tenant, ctx.signal, {
				baseUrl: row.nativeBaseUrl,
				credentialHash: row.nativeCredentialHash,
			});
			const ids: unknown = JSON.parse(row.nativeOperationIdsJson);
			if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
				throw new NativeMemoryError("memory_cleanup_corrupt", false);
			const legacyConfigUnknown = ids.includes(
				NATIVE_BANK_CONFIG_LEGACY_UNKNOWN,
			);
			if (legacyConfigUnknown)
				throw new NativeMemoryError("native_config_unconfirmed", true);
			const pendingConfig = ids.includes(NATIVE_BANK_CONFIG_PENDING);
			if (ids.length === 0 && !(await client.bankExists())) {
				await ctx.succeed();
				return;
			}
			if (!row.cleanupSettled) {
				if (pendingConfig) await verifySubmittedBankConfig(client);
				await settle(
					client,
					ids.filter((id) => id !== NATIVE_BANK_CONFIG_PENDING),
					ctx.signal,
					true,
				);
				await drainNative(client, ctx.signal);
				if (
					!(await ctx.write((tx) => {
						tx.update(memoryDeliveryJobs)
							.set({ cleanupSettled: true })
							.where(eq(memoryDeliveryJobs.id, row.id))
							.run();
					}))
				)
					return;
			}
			await client.deleteBank();
			if (await client.bankExists())
				throw new NativeMemoryError("memory_cleanup_incomplete", true);
			await ctx.succeed();
			return;
		}
		const bank = db
			.select()
			.from(memoryBanks)
			.where(eq(memoryBanks.id, row.bankId))
			.get();
		if (!bank || bank.userId !== row.userId)
			throw new NativeMemoryError("memory_bank_missing", false);
		const binding =
			bank.nativeBaseUrl && bank.nativeCredentialHash
				? {
						baseUrl: bank.nativeBaseUrl,
						credentialHash: bank.nativeCredentialHash,
					}
				: configuredNativeBinding(tenant);
		const client = nativeMemoryClient(row.bankId, tenant, ctx.signal, binding);
		if (row.kind === "quarantine_extract") {
			if (!bank.nativeBaseUrl || !bank.nativeCredentialHash)
				throw new NativeMemoryError("native_config_unconfirmed", false);
			const { runMemoryQuarantineExtraction } = await import(
				"./quarantine-worker"
			);
			await runMemoryQuarantineExtraction(ctx, (input, beforeDispatch) =>
				client.extractDrafts(input, beforeDispatch),
			);
			return;
		}
		if (row.kind === "provision") {
			const fence = (tx: Tx) => {
				const fenced = assertMemoryBankFence(
					tx,
					row.userId,
					row.bankId,
					row.epoch,
				);
				const current = tx
					.select()
					.from(memoryAccounts)
					.where(eq(memoryAccounts.userId, row.userId))
					.get();
				if (current?.controlRevision !== row.controlRevision)
					throw new NativeMemoryError("memory_control_changed", false);
				return fenced;
			};
			await ensureConfiguredBank(ctx, client, binding, fence);
			await ctx.succeed({ apply: fence });
			return;
		}
		if (row.kind === "source_cleanup") {
			const source = row.sourceId
				? db
						.select()
						.from(memorySourceRevisions)
						.where(eq(memorySourceRevisions.id, row.sourceId))
						.get()
				: null;
			if (!source || source.bankId !== bank.id)
				throw new NativeMemoryError("memory_source_missing", false);
			if (source.state === "accepted") {
				await ctx.succeed();
				return;
			}
			// A queued successor has claim priority over this cleanup. Once cleanup
			// is claimed, close the transition before removing its native evidence.
			if (
				isEditResendWithdrawal(source) &&
				!(await ctx.write((tx) => finishEditResend(tx, source)))
			)
				return;
			if (source.nativeSubmitted) {
				if (!source.nativeAcknowledged && source.nativeOperationId)
					await settle(client, [source.nativeOperationId], ctx.signal, true);
				await drainNative(client, ctx.signal);
				await client.deleteDocument(source.id);
			}
			const memories = await captureSettledNative(client, ctx.signal);
			if (memories.some((f) => f.document_id === source.id))
				throw new NativeMemoryError("memory_cleanup_incomplete", true);
			const { checkDeletedSourceRepair, replaySourceCuration } = await import(
				"./curation-runner"
			);
			const repair = await runDependencyRepair(
				ctx,
				client,
				{ capture: captureSettledNative, settle },
				{
					rootSourceIds: [source.id],
					memories,
					verify: (result) => checkDeletedSourceRepair(ctx, result),
					replay: (replacement, original) =>
						replaySourceCuration(ctx, client, replacement, undefined, {
							replacesSourceId: original.id,
						}),
				},
			);
			const recoveryInput = {
				userId: row.userId,
				bankId: row.bankId,
				epoch: row.epoch,
				expectedRevision: bank.revision,
				withdrawnSourceId: source.id,
				memories: repair.memories,
			};
			const assertPublicationCurrent = (tx: Tx) => {
				assertMemoryBankFence(tx, row.userId, row.bankId, row.epoch);
				const account = tx
					.select({ revision: memoryAccounts.controlRevision })
					.from(memoryAccounts)
					.where(eq(memoryAccounts.userId, row.userId))
					.get();
				const job = tx
					.select({ revision: memoryDeliveryJobs.controlRevision })
					.from(memoryDeliveryJobs)
					.where(eq(memoryDeliveryJobs.id, row.id))
					.get();
				if (!account || account.revision !== job?.revision)
					throw new NativeMemoryError("memory_control_changed", true);
			};
			await ctx.succeed({
				apply: (tx) => {
					repair.assertContextCurrent?.(tx);
					repair.apply(tx);
					if (repair.sourceIds.length) {
						publishNativeSnapshot(tx, {
							userId: row.userId,
							bankId: row.bankId,
							epoch: row.epoch,
							expectedRevision: bank.revision,
							memories: repair.memories,
							checkedActionIds: repair.replays.map((r) => r.actionId),
							sourceIds: repair.sourceIds,
						});
						return;
					}
					const user = tx
						.select({ learningEnabled: users.memoryEnabled })
						.from(users)
						.where(eq(users.id, row.userId))
						.get();
					const learningEnabled = !!user?.learningEnabled;
					const recovery = verifiedSourceCleanupSnapshot(tx, {
						...recoveryInput,
						learningEnabled,
					});
					if (!recovery) return;
					if (!learningEnabled)
						throw new NativeMemoryError("memory_dependency_paused", true);
					assertPublicationCurrent(tx);
					if (recovery.kind !== "exact")
						throw new NativeMemoryError(
							recovery.kind === "waiting"
								? "memory_cleanup_publication_pending"
								: "memory_cleanup_publication_unverified",
							true,
						);
					publishNativeSnapshot(tx, {
						...recoveryInput,
						prepared: recovery.prepared,
					});
				},
			});
			return;
		}
		if (row.kind === "action") {
			const { runMemoryAction } = await import("./curation-runner");
			await runMemoryAction(
				ctx,
				client,
				{
					capture: captureSettledNative,
					settle,
				},
				binding,
			);
			return;
		}
		await ensureConfiguredBank(
			ctx,
			client,
			binding,
			(tx) => assertDelivery(tx, row).bank,
		);
		// Wait for any remote work left by an earlier cancelled/failed local attempt before a new write.
		const outstanding = db
			.select()
			.from(memorySourceRevisions)
			.where(eq(memorySourceRevisions.bankId, bank.id))
			.all()
			.filter(
				(s) =>
					s.nativeSubmitted &&
					!s.nativeAcknowledged &&
					s.state !== "accepted" &&
					s.id !== row.sourceId &&
					s.nativeOperationId,
			);
		await settle(
			client,
			outstanding.map((s) => s.nativeOperationId as string),
			ctx.signal,
			true,
		);
		await drainNative(client, ctx.signal);
		const delivery = db.transaction((tx) => assertDelivery(tx, row));
		let source = delivery.source;
		const migrationContext = parseJsonRecord(source.context);
		if (
			account?.authority === "preparing" &&
			source.state === "accepted" &&
			source.nativeAcknowledged &&
			source.acceptedGeneration === bank.generation &&
			(migrationContext.migrationDefaultHistory === true ||
				typeof migrationContext.migrationAuthoredId === "string")
		) {
			const manifest = latestManifest(row.userId);
			const checkpoint = parseJsonRecord(manifest?.checkpointJson ?? null);
			if (
				!source.nativeOperationId ||
				!Array.isArray(checkpoint.requestIds) ||
				!checkpoint.requestIds.includes(row.requestId) ||
				!Array.isArray(checkpoint.sourceIds) ||
				!checkpoint.sourceIds.includes(source.id)
			)
				throw new NativeMemoryError(
					"memory_migration_recovery_unverified",
					false,
				);
			const replaySnapshot = await captureSettledNative(client, ctx.signal);
			const raw = replaySnapshot.filter(
				(fact) =>
					fact.fact_type !== "observation" && fact.document_id === source.id,
			);
			const expected = readAcknowledgedFacts(source.acknowledgedFactsJson);
			if (
				expected.length !== raw.length ||
				expected.some(
					(fact) =>
						!raw.some((live) => live.id === fact.id && live.text === fact.text),
				)
			)
				throw new NativeMemoryError(
					"memory_migration_recovery_unverified",
					false,
				);
			await ctx.succeed({
				apply: (tx) => {
					const current = assertDelivery(tx, row);
					assertCurationPublication(tx, bank.id, bank.epoch);
					if (
						current.bank.revision !== bank.revision ||
						current.source.state !== "accepted" ||
						current.source.acceptedGeneration !== bank.generation ||
						current.source.acknowledgedFactsJson !==
							source.acknowledgedFactsJson
					)
						throw Error("memory_migration_recovery_unverified");
					if (
						typeof migrationContext.migrationSelectiveArchivedHash === "string"
					) {
						const prior = readPublishedMemory(
							row.userId,
							bank.id,
							undefined,
							tx,
						);
						const expectedFacts = admittedNativeFacts(row.userId, bank.id, tx);
						const rawRows = replaySnapshot.filter(
							(fact) => fact.fact_type !== "observation",
						);
						if (
							rawRows.length !== expectedFacts.length ||
							expectedFacts.some(
								(fact) =>
									!rawRows.some(
										(live) =>
											live.id === fact.id &&
											live.text === fact.text &&
											live.document_id === fact.source.id,
									),
							)
						)
							throw Error("memory_migration_recovery_unverified");
						assertDefaultHistoryWithdrawalBoundary(
							tx,
							row.userId,
							bank.id,
							bank.scopeKey,
							replaySnapshot,
						);
						const prepared = reconnectVerifiedObservations(
							prior,
							replaySnapshot,
							approvedMigrationObservationWording(
								tx,
								row.userId,
								bank.id,
								prior,
								true,
							),
						);
						if (
							!prepared ||
							prepared.size !== replaySnapshot.length - rawRows.length
						)
							throw Error("memory_migration_recovery_unverified");
						if (
							prior.some(
								(previous) =>
									!replaySnapshot.some(
										(next) =>
											next.fact_type === "observation" &&
											next.id === previous.nativeId &&
											next.text === previous.nativeText,
									),
							)
						)
							publishNativeSnapshot(tx, {
								userId: row.userId,
								bankId: bank.id,
								epoch: bank.epoch,
								expectedRevision: bank.revision,
								memories: replaySnapshot,
								prepared,
							});
					}
				},
			});
			return;
		}
		if (!source.nativeOperationId)
			throw new NativeMemoryError("memory_operation_identity_missing", false);
		const predecessor = source.predecessorSourceId
			? db
					.select()
					.from(memorySourceRevisions)
					.where(eq(memorySourceRevisions.id, source.predecessorSourceId))
					.get()
			: null;
		// Backfill can carry an existing edited revision into an empty bank.
		// Its immutable dates and persisted message are fenced by assertDelivery.
		if (
			source.explicitEditAt &&
			!predecessor &&
			parseJsonRecord(source.context).migration !== true
		)
			throw new NativeMemoryError("memory_predecessor_missing", false);
		if (
			predecessor &&
			(predecessor.userId !== source.userId ||
				predecessor.bankId !== source.bankId ||
				predecessor.epoch !== source.epoch ||
				predecessor.lineageId !== source.lineageId ||
				predecessor.conversationId !== source.conversationId ||
				(!source.explicitEditAt && predecessor.textHash !== source.textHash))
		)
			throw new NativeMemoryError("memory_predecessor_invalid", false);
		const unchanged =
			predecessor?.textHash === source.textHash
				? (delivery.transitions.at(-1) ?? predecessor)
				: null;
		const unchangedRoots = unchanged
			? delivery.transitions.length
				? delivery.transitions.map(({ id }) => id)
				: [unchanged.id]
			: [];
		const {
			replaySourceCuration,
			prepareSourceCuration,
			prepareUnchangedSourceCuration,
			unchangedSourceInventory,
			checkSourceDependencyCuration,
			verifyNewAssertionCuration,
		} = await import("./curation-runner");
		const checkPendingCuration = (tx: Tx) =>
			assertCurationPublication(tx, bank.id, bank.epoch, {
				replaySourceIds: unchanged ? undefined : [source.id],
			});
		const accepted = unchanged
			? db.transaction((tx) => {
					checkPendingCuration(tx);
					return unchangedSourceInventory(tx, source, unchanged);
				})
			: null;
		if (unchanged && accepted) {
			const replayed = prepareUnchangedSourceCuration(
				ctx,
				source,
				unchanged,
				accepted,
			);
			if (source.nativeSubmitted) {
				if (!source.nativeAcknowledged)
					await settle(client, [source.nativeOperationId], ctx.signal, true);
				db.transaction((tx) => assertDelivery(tx, row));
				await client.deleteDocument(source.id);
			}
			const memories = await captureSettledNative(client, ctx.signal);
			if (memories.some((fact) => fact.document_id === source.id))
				throw new NativeMemoryError("memory_cleanup_incomplete", true);
			replayed.verify(memories);
			const repair = await runDependencyRepair(
				ctx,
				client,
				{ capture: captureSettledNative, settle },
				{
					rootSourceIds: unchangedRoots,
					verifiedRoots: new Map(
						unchangedRoots.map((id) => [id, replayed.sourceIds]),
					),
					assertVerifiedRoots: (tx) => {
						assertDelivery(tx, row);
						replayed.assertCurrent(tx);
					},
					memories,
					replay: (replacement, original) =>
						replaySourceCuration(ctx, client, replacement, undefined, {
							replacesSourceId: original.id,
						}),
				},
			);
			await replayed.verifyDependencies(repair);
			await ctx.succeed({
				apply: (tx) => {
					const { transitions } = assertDelivery(tx, row);
					repair.assertContextCurrent?.(tx);
					replayed.apply(tx, repair.memories);
					repair.apply(tx);
					for (const previous of transitions) finishEditResend(tx, previous);
					tx.update(memorySourceRevisions)
						.set({
							state: "staged",
							explicitEditAt: unchanged.explicitEditAt,
							nativeSubmitted: false,
							nativeAcknowledged: false,
							acknowledgedFactsJson: "[]",
						})
						.where(eq(memorySourceRevisions.id, source.id))
						.run();
					publishNativeSnapshot(tx, {
						userId: row.userId,
						bankId: row.bankId,
						epoch: row.epoch,
						expectedRevision: bank.revision,
						memories: repair.memories,
						sourceIds: [
							...new Set([
								source.id,
								...replayed.sourceIds,
								...repair.sourceIds,
							]),
						],
						checkedActionIds: [...replayed.checks, ...repair.replays].map(
							(entry) => entry.actionId,
						),
					});
				},
			});
			return;
		}
		const assertedAt =
			unchanged?.explicitEditAt ?? source.explicitEditAt ?? source.assertedAt;
		{
			if (
				!(await ctx.write((tx) => {
					source = assertDelivery(tx, row).source;
					checkPendingCuration(tx);
					tx.update(memorySourceRevisions)
						.set({ nativeSubmitted: true })
						.where(eq(memorySourceRevisions.id, source.id))
						.run();
				}))
			)
				return;
			// Recheck admission and certified facts immediately before making the retain call.
			ctx.signal.throwIfAborted();
			const context = db.transaction((tx) => {
				checkPendingCuration(tx);
				source = assertDelivery(tx, row).source;
				if (
					unchanged &&
					unchangedSourceInventory(tx, source, unchanged) !== null
				)
					throw new NativeMemoryError(
						"memory_unchanged_source_unverified",
						true,
					);
				return resolveMemorySourceContext(tx, source);
			});
			if (!source.nativeOperationId)
				throw new NativeMemoryError("memory_operation_identity_missing", false);
			const explicitEditAt =
				predecessor && !unchanged ? source.explicitEditAt : null;
			const content =
				predecessor && explicitEditAt
					? JSON.stringify({
							kind: "source_edit",
							before: predecessor.text,
							after: source.text,
							original_asserted_at: source.assertedAt.toISOString(),
							explicit_edit_at: explicitEditAt.toISOString(),
						})
					: source.text;
			const operations = await client.retain(
				{
					content,
					context: explicitEditAt
						? JSON.stringify({
								...parseJsonRecord(context),
								edit_guidance: EXPLICIT_EDIT_RETENTION_GUIDANCE,
							})
						: context,
					timestamp: assertedAt.toISOString(),
					document_id: source.id,
					tags: [source.id],
					metadata: { source_revision: source.id, lineage: source.lineageId },
				},
				source.nativeOperationId,
			);
			await settle(client, operations, ctx.signal);
			// Remote receipt TTL must not erase our knowledge that this retain finished.
			if (
				!(await ctx.write((tx) => {
					tx.update(memorySourceRevisions)
						.set({ nativeAcknowledged: true })
						.where(eq(memorySourceRevisions.id, source.id))
						.run();
				}))
			)
				return;
		}
		const consolidation = await client.consolidate();
		await settle(client, [consolidation], ctx.signal);
		let memories = await captureSettledNative(client, ctx.signal);
		const replayed = await replaySourceCuration(ctx, client, source);
		if (replayed.sourceIds.length)
			await settle(client, [await client.consolidate()], ctx.signal);
		memories = await captureSettledNative(client, ctx.signal);

		const curated =
			predecessor && !unchanged
				? await prepareSourceCuration(ctx, client, source, predecessor, {
						capture: captureSettledNative,
						settle,
					})
				: null;
		if (curated) memories = curated.memories;
		const repair = await runDependencyRepair(
			ctx,
			client,
			{ capture: captureSettledNative, settle },
			{
				rootSourceIds: curated?.sourceIds ?? [
					...new Set([...unchangedRoots, ...replayed.sourceIds]),
				],
				verifiedRoots:
					curated?.verifiedRoots ??
					new Map([
						...replayed.sourceIds.map((id) => [id, id] as const),
						...unchangedRoots.map((id) => [id, source.id] as const),
					]),
				memories,
				replay: (replacement, original) =>
					replaySourceCuration(ctx, client, replacement, undefined, {
						replacesSourceId: original.id,
					}),
			},
		);
		if (curated) await checkSourceDependencyCuration(ctx, source, repair);
		else await replayed.verifyDependencies(repair);
		memories = repair.memories;
		const acknowledged = memories
			.filter(
				(m) => m.fact_type !== "observation" && m.document_id === source.id,
			)
			.map(({ id, text }) => ({ id, text }));
		const prepared = prepareNativeSnapshot(memories);
		const verifiedCuratedChanges =
			!!curated || replayed.checks.length > 0 || repair.replays.length > 0;
		const verifiedCuratedDiff =
			verifiedCuratedChanges || unchanged
				? undefined
				: await verifyNewAssertionCuration(ctx, source.id, memories, prepared);
		await ctx.succeed({
			apply: (tx) => {
				const { transitions } = assertDelivery(tx, row);
				const defaultHistory =
					migrationContext.migrationDefaultHistory === true;
				if (account?.authority === "preparing") {
					if (
						defaultHistory ||
						migrationContext.migration === true ||
						typeof migrationContext.migrationAuthoredId === "string"
					)
						assertDefaultHistoryWithdrawalBoundary(
							tx,
							row.userId,
							row.bankId,
							bank.scopeKey,
							memories,
							defaultHistory,
						);
					if (defaultHistory)
						assertHistoryPreservesAuthoredObservations(
							tx,
							row.userId,
							row.bankId,
							memories,
							{ sourceId: source.id, scopeKey: bank.scopeKey },
						);
				}
				verifiedCuratedDiff?.assertCurrent(tx);
				repair.assertContextCurrent?.(tx);
				replayed.apply(tx, memories);
				curated?.apply(tx);
				repair.apply(tx);
				for (const previous of transitions) finishEditResend(tx, previous);
				tx.update(memorySourceRevisions)
					.set({
						state: "staged",
						...(unchanged ? { explicitEditAt: unchanged.explicitEditAt } : {}),
						acknowledgedFactsJson: JSON.stringify(acknowledged),
					})
					.where(eq(memorySourceRevisions.id, source.id))
					.run();
				publishNativeSnapshot(tx, {
					userId: row.userId,
					bankId: row.bankId,
					epoch: row.epoch,
					expectedRevision: bank.revision,
					memories,
					prepared,
					verifiedCuratedChanges,
					verifiedCuratedDiff,
					checkedActionIds: [...replayed.checks, ...repair.replays].map(
						(r) => r.actionId,
					),
					sourceIds: [
						...new Set([
							...(curated?.sourceIds ?? [source.id]),
							...repair.sourceIds,
							...replayed.sourceIds,
						]),
					],
				});
			},
		});
	} catch (error) {
		if (ctx.signal.aborted) return;
		const native =
			error instanceof NativeMemoryError
				? error
				: new NativeMemoryError("memory_preparation_failed", false);
		await ctx.fail({
			code: native.code,
			message: "Memory preparation could not complete.",
			retryable: native.retryable,
		});
	} finally {
		// The job engine remains the lifecycle owner; manifests only summarize settled delivery.
		if (ctx.row.kind !== "quarantine_extract")
			settleMemoryMigration(ctx.row.userId);
	}
}
