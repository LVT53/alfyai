import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type {
	AdmittedMemoryEvidence,
	MemoryScope,
	MemorySource,
} from "$lib/memory-types";
import { db } from "$lib/server/db";
import {
	conversations,
	memoryAccounts,
	memoryBanks,
	users,
} from "$lib/server/db/schema";
import { estimateTokenCount } from "$lib/utils/tokens";
import { isMemoryActiveForConversation } from "../memory-controls";
import {
	type NativeMemory,
	NativeMemoryError,
} from "../memory-profile/contracts";
import { nativeMemoryClient } from "../memory-profile/hindsight-client";
import {
	admittedNativeFacts,
	curatedNativeRankKeys,
	nativeRankSupportKey,
	readAcknowledgedFacts,
	readPublishedMemory,
} from "../memory-profile/publication";
import { getMemoryAccount } from "../memory-profile/revisions";
/** Native ranking can select only exact, still-admitted accepted observations. */
export async function recallMemory(
	userId: string,
	input: { conversationId: string; query: string; tokenBudget: number },
): Promise<AdmittedMemoryEvidence[]> {
	if (
		!(await isMemoryActiveForConversation({
			userId,
			conversationId: input.conversationId,
		}).catch(() => false))
	)
		return [];
	const account = getMemoryAccount(userId);
	if (account?.authority !== "hindsight") return [];
	const chat = db
		.select()
		.from(conversations)
		.where(
			and(
				eq(conversations.id, input.conversationId),
				eq(conversations.userId, userId),
			),
		)
		.get();
	if (!chat) return [];
	const scopeKeys = [
		"personal",
		...(chat.projectId ? [`project:${chat.projectId}`] : []),
	];
	const isStillActive = (database: Pick<typeof db, "select">) =>
		Boolean(
			database
				.select({ id: conversations.id })
				.from(conversations)
				.innerJoin(users, eq(users.id, conversations.userId))
				.innerJoin(memoryAccounts, eq(memoryAccounts.userId, users.id))
				.where(
					and(
						eq(conversations.id, input.conversationId),
						eq(conversations.userId, userId),
						eq(conversations.memoryIncognito, false),
						chat.projectId === null
							? isNull(conversations.projectId)
							: eq(conversations.projectId, chat.projectId),
						eq(users.memoryEnabled, true),
						eq(memoryAccounts.authority, "hindsight"),
						eq(memoryAccounts.lifecycleState, "active"),
						eq(memoryAccounts.tenantId, account.tenantId),
						eq(memoryAccounts.epoch, account.epoch),
						eq(memoryAccounts.controlRevision, account.controlRevision),
					),
				)
				.get(),
		);
	const readableBanks = (database: Pick<typeof db, "select">) =>
		database
			.select()
			.from(memoryBanks)
			.where(
				and(
					eq(memoryBanks.userId, userId),
					eq(memoryBanks.epoch, account.epoch),
					notInArray(memoryBanks.status, ["retired", "repair_blocked"]),
					inArray(memoryBanks.scopeKey, scopeKeys),
				),
			)
			.all();
	const banks = readableBanks(db);
	const rankings = new Map<string, NativeMemory[] | null>();
	const confirmedEvidence = new Map<string, Map<string, NativeMemory>>();
	for (const bank of banks) {
		if (!isStillActive(db)) return [];
		let ranking: NativeMemory[] | null = null;
		try {
			const client = nativeMemoryClient(
				bank.id,
				account.tenantId,
				AbortSignal.timeout(2_000),
			);
			const matches = await client.recall(
				input.query,
				Math.max(0, Math.floor(input.tokenBudget)),
				() => {
					// Capability verification and name resolution can outlast consent.
					if (
						!readableBanks(db).some(({ id }) => id === bank.id) ||
						!isStillActive(db)
					)
						throw new NativeMemoryError("native_cancelled", false);
				},
			);
			ranking = matches.filter((m) => m.fact_type === "observation");
			const accepted = readPublishedMemory(userId, bank.id);
			const byId = new Map(accepted.map((row) => [row.nativeId, row]));
			const unmatched = ranking.filter(
				(rank) => byId.get(rank.id)?.nativeText !== rank.text,
			);
			if (unmatched.length && isStillActive(db)) {
				const bridge = db.transaction((tx) => curatedNativeRankKeys(tx, bank));
				if (
					unmatched.some((rank) => {
						const key = nativeRankSupportKey(rank.source_memory_ids ?? []);
						return key && bridge.has(key);
					})
				) {
					const snapshot = await client.list();
					confirmedEvidence.set(
						bank.id,
						new Map(snapshot.map((row) => [row.id, row])),
					);
				}
			}
		} catch {
			/* Last accepted view remains useful during native outages. */
		}
		rankings.set(bank.id, ranking);
	}
	// Every eligible bank shares one live snapshot, including holds set during a native call.
	return db.transaction((tx) => {
		if (!isStillActive(tx)) return [];
		const readableIds = new Set(readableBanks(tx).map(({ id }) => id));
		const output: AdmittedMemoryEvidence[] = [];
		let remaining = Math.max(0, Math.floor(input.tokenBudget));
		for (const bank of banks) {
			if (!readableIds.has(bank.id)) continue;
			const ranking = rankings.get(bank.id) ?? null;
			const accepted = readPublishedMemory(userId, bank.id, undefined, tx);
			const facts = admittedNativeFacts(userId, bank.id, tx);
			const scope: MemoryScope =
				bank.scopeKey === "personal"
					? { kind: "personal" }
					: { kind: "project", projectId: bank.scopeKey.slice(8) };
			const order = new Map<string, number>();
			if (ranking) {
				const byId = new Map(accepted.map((row) => [row.nativeId, row]));
				const unresolved = ranking
					.map((rank, index) => ({ rank, index }))
					.filter(({ rank, index }) => {
						const row = byId.get(rank.id);
						const key = nativeRankSupportKey(rank.source_memory_ids ?? []);
						if (
							!row ||
							row.nativeText !== rank.text ||
							!key ||
							key !==
								nativeRankSupportKey(
									readAcknowledgedFacts(row.sourceFingerprintsJson).map(
										(fact) => fact.id,
									),
								)
						)
							return true;
						if (!order.has(rank.id)) order.set(rank.id, index);
						return false;
					});
				if (
					unresolved.length &&
					bank.generation &&
					accepted[0]?.generation === bank.generation
				) {
					const curated = curatedNativeRankKeys(tx, bank);
					const acceptedById = new Map(facts.map((fact) => [fact.id, fact]));
					const counts = new Map<string, number>();
					for (const rank of ranking)
						for (const id of rank.source_memory_ids ?? [])
							counts.set(id, (counts.get(id) ?? 0) + 1);
					for (const { rank, index } of unresolved) {
						const ids = rank.source_memory_ids ?? [];
						if (ids.some((id) => counts.get(id) !== 1)) continue;
						const key = nativeRankSupportKey(ids);
						const approved = key && curated.get(key);
						const row = approved ? byId.get(approved) : undefined;
						const evidence = confirmedEvidence.get(bank.id);
						const live = evidence?.get(rank.id);
						if (
							!row ||
							!live ||
							live.fact_type !== "observation" ||
							live.text !== rank.text ||
							nativeRankSupportKey(live.source_memory_ids ?? []) !== key ||
							order.has(row.nativeId)
						)
							continue;
						if (
							readAcknowledgedFacts(row.sourceFingerprintsJson).every(
								(fact) => {
									const raw = evidence?.get(fact.id);
									const source = acceptedById.get(fact.id)?.source;
									return (
										!!raw &&
										raw.fact_type !== "observation" &&
										!!source &&
										raw.document_id === source.id &&
										raw.text === fact.text &&
										(raw.mentioned_at ?? null) === (fact.mentionedAt ?? null) &&
										fact.assertedAtMs ===
											(source.explicitEditAt ?? source.assertedAt).getTime()
									);
								},
							)
						)
							order.set(row.nativeId, index);
					}
				}
				accepted.sort(
					(a, b) =>
						(order.get(a.nativeId) ?? Infinity) -
						(order.get(b.nativeId) ?? Infinity),
				);
			}
			for (const row of accepted) {
				if (ranking && !order.has(row.nativeId)) continue;
				const tokens = estimateTokenCount(row.text);
				if (tokens > remaining) continue;
				const ids: unknown = JSON.parse(row.sourceIdsJson);
				if (!Array.isArray(ids)) continue;
				const sources: MemorySource[] = [];
				const seen = new Set<string>();
				for (const fact of facts.filter((f) => ids.includes(f.id))) {
					const source = fact.source;
					if (seen.has(source.id)) continue;
					seen.add(source.id);
					const origin = source.conversationId
						? tx
								.select()
								.from(conversations)
								.where(
									and(
										eq(conversations.id, source.conversationId),
										eq(conversations.userId, userId),
									),
								)
								.get()
						: null;
					// Do not expand source text into recall; the accepted row is the entire model-facing text.
					sources.push({
						id: source.id,
						conversationId: origin?.id ?? null,
						messageId: origin ? source.messageId : null,
						title: origin?.title ?? "Memory",
						quote: "",
						assertedAt: source.assertedAt.toISOString(),
						available: source.conversationId === null || Boolean(origin),
					});
				}
				output.push({
					ref: { scope, generation: row.generation, rowId: row.nativeId },
					text: row.text,
					sources,
				});
				remaining -= tokens;
			}
		}
		return output;
	});
}
