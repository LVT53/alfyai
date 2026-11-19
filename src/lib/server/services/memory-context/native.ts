import { and, eq, inArray, ne } from "drizzle-orm";
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
import type { NativeMemory } from "../memory-profile/contracts";
import { nativeMemoryClient } from "../memory-profile/hindsight-client";
import {
	admittedNativeFacts,
	curatedNativeRankKeys,
	nativeRankSupportKey,
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
	const banks = db
		.select()
		.from(memoryBanks)
		.where(
			and(
				eq(memoryBanks.userId, userId),
				eq(memoryBanks.epoch, account.epoch),
				ne(memoryBanks.status, "retired"),
				inArray(memoryBanks.scopeKey, scopeKeys),
			),
		)
		.all();
	const rankings = new Map<string, NativeMemory[] | null>();
	for (const bank of banks) {
		let ranking: NativeMemory[] | null = null;
		try {
			const matches = await nativeMemoryClient(
				bank.id,
				account.tenantId,
				AbortSignal.timeout(2_000),
			).recall(input.query, Math.max(0, Math.floor(input.tokenBudget)));
			ranking = matches.filter((m) => m.fact_type === "observation");
		} catch {
			/* Last accepted view remains useful during native outages. */
		}
		rankings.set(bank.id, ranking);
	}
	// No asynchronous boundary inside final admission: every bank shares one live snapshot.
	return db.transaction((tx) => {
		const current = tx
			.select()
			.from(memoryAccounts)
			.where(eq(memoryAccounts.userId, userId))
			.get();
		const owner = tx.select().from(users).where(eq(users.id, userId)).get();
		const currentChat = tx
			.select()
			.from(conversations)
			.where(
				and(
					eq(conversations.id, input.conversationId),
					eq(conversations.userId, userId),
				),
			)
			.get();
		if (
			!owner?.memoryEnabled ||
			current?.authority !== "hindsight" ||
			current.lifecycleState !== "active" ||
			current.epoch !== account.epoch ||
			current.controlRevision !== account.controlRevision ||
			!currentChat ||
			currentChat.memoryIncognito ||
			currentChat.projectId !== chat.projectId
		)
			return [];
		const output: AdmittedMemoryEvidence[] = [];
		let remaining = Math.max(0, Math.floor(input.tokenBudget));
		for (const bank of banks) {
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
						if (byId.get(rank.id)?.nativeText !== rank.text) return true;
						if (!order.has(rank.id)) order.set(rank.id, index);
						return false;
					});
				if (
					unresolved.length &&
					bank.generation &&
					accepted[0]?.generation === bank.generation
				) {
					const curated = curatedNativeRankKeys(tx, bank);
					const counts = new Map<string, number>();
					for (const rank of ranking)
						for (const id of rank.source_memory_ids ?? [])
							counts.set(id, (counts.get(id) ?? 0) + 1);
					for (const { rank, index } of unresolved) {
						const ids = rank.source_memory_ids ?? [];
						if (ids.some((id) => counts.get(id) !== 1)) continue;
						const key = nativeRankSupportKey(ids);
						const approved = key && curated.get(key);
						if (approved && byId.has(approved) && !order.has(approved))
							order.set(approved, index);
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
