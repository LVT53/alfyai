import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type {
	AdmittedMemoryEvidence,
	MemoryScope,
	MemorySource,
} from "$lib/memory-types";
import { getMemoryRecallShares } from "$lib/server/config-store";
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
	approvedMigrationRankFamily,
	curatedNativeRankKeys,
	matchVerifiedObservationRows,
	nativeRankSupportKey,
	readAcknowledgedFacts,
	readPublishedMemory,
} from "../memory-profile/publication";
import { getMemoryAccount } from "../memory-profile/revisions";
import {
	allocateRecall,
	type RecallCandidate,
	type RecallLane,
} from "./recall-allocation";
import { RECALL_PROJECT_HEADING, recallLineTokens } from "./recall-format";

/** An accepted row recall may offer, with what its entry is built from. */
interface OfferedRow {
	row: ReturnType<typeof readPublishedMemory>[number];
	scope: MemoryScope;
	facts: ReturnType<typeof admittedNativeFacts>;
	ids: unknown[];
}

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
			if (ranking.length && isStillActive(db)) {
				const { bridge, family } = db.transaction((tx) => ({
					bridge: curatedNativeRankKeys(tx, bank),
					family: approvedMigrationRankFamily(
						tx,
						userId,
						bank.id,
						readPublishedMemory(userId, bank.id, undefined, tx),
					),
				}));
				if (
					ranking.some((rank) => {
						const support = rank.source_memory_ids ?? [];
						const key = nativeRankSupportKey(support);
						return (
							support.some((id) => family?.ids.has(id)) ||
							(key && bridge.has(key))
						);
					})
				) {
					const snapshot = await client.list();
					const unique = new Map(snapshot.map((row) => [row.id, row]));
					if (unique.size === snapshot.length)
						confirmedEvidence.set(bank.id, unique);
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
		// The section goes into the prompt whole, so the budget holds every
		// formatted line and, in a project chat, the project's heading.
		const budget = Math.max(
			0,
			Math.floor(input.tokenBudget) -
				(chat.projectId ? estimateTokenCount(RECALL_PROJECT_HEADING) : 0),
		);
		const offered = new Map<string, OfferedRow>();
		const personalRows: RecallCandidate[] = [];
		const projectRows: RecallCandidate[] = [];
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
				const bridge =
					accepted[0]?.generation === bank.generation
						? curatedNativeRankKeys(tx, bank)
						: new Map<string, string>();
				const bridged = new Set(bridge.values());
				const evidence = confirmedEvidence.get(bank.id);
				const acceptedById = new Map(facts.map((fact) => [fact.id, fact]));
				const family = approvedMigrationRankFamily(
					tx,
					userId,
					bank.id,
					accepted,
				);
				const familyRows = new Set(family?.rows.map((row) => row.nativeId));
				const verifiedFamily =
					family &&
					evidence &&
					matchVerifiedObservationRows(
						family.rows,
						[...evidence.values()],
						family.approved,
					);
				const exactRankEvidence = (row: (typeof accepted)[number]) =>
					readAcknowledgedFacts(row.sourceFingerprintsJson).every((fact) => {
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
					});
				const liveCoverage = new Map<string, number>();
				for (const live of evidence?.values() ?? [])
					if (live.fact_type === "observation")
						for (const id of new Set(live.source_memory_ids ?? []))
							liveCoverage.set(id, (liveCoverage.get(id) ?? 0) + 1);
				for (const [index, rank] of ranking.entries()) {
					const support = rank.source_memory_ids ?? [];
					const key = nativeRankSupportKey(support);
					if (!key) continue;
					const direct = byId.get(rank.id);
					const matchesDirect =
						direct &&
						direct.nativeText === rank.text &&
						key ===
							nativeRankSupportKey(
								readAcknowledgedFacts(direct.sourceFingerprintsJson).map(
									(fact) => fact.id,
								),
							);
					if (
						(direct && familyRows.has(direct.nativeId)) ||
						support.some((id) => family?.ids.has(id))
					) {
						const match = verifiedFamily?.get(rank.id);
						const live = evidence?.get(rank.id);
						if (
							match &&
							match.text === match.prior.text &&
							live?.text === rank.text &&
							nativeRankSupportKey(live.source_memory_ids ?? []) === key &&
							family?.rows.every(exactRankEvidence) &&
							!order.has(match.prior.nativeId)
						)
							order.set(match.prior.nativeId, index);
						continue;
					}
					if (matchesDirect && !bridged.has(direct.nativeId)) {
						if (!order.has(direct.nativeId)) order.set(direct.nativeId, index);
						continue;
					}
					const mapped = bridge.get(key);
					const row = mapped ? byId.get(mapped) : undefined;
					const live = evidence?.get(rank.id);
					if (
						!row ||
						!live ||
						live.fact_type !== "observation" ||
						live.text !== rank.text ||
						nativeRankSupportKey(live.source_memory_ids ?? []) !== key ||
						order.has(row.nativeId) ||
						support.some((id) => liveCoverage.get(id) !== 1)
					)
						continue;
					if (exactRankEvidence(row)) order.set(row.nativeId, index);
				}
				accepted.sort(
					(a, b) =>
						(order.get(a.nativeId) ?? Infinity) -
						(order.get(b.nativeId) ?? Infinity),
				);
			}
			// The verified ranking's order, or every accepted row in stored order.
			const rows = scope.kind === "personal" ? personalRows : projectRows;
			for (const row of accepted) {
				if (ranking && !order.has(row.nativeId)) continue;
				const ids: unknown = JSON.parse(row.sourceIdsJson);
				if (!Array.isArray(ids)) continue;
				const key = `${bank.id}:${row.nativeId}`;
				offered.set(key, { row, scope, facts, ids });
				rows.push({ key, tokens: recallLineTokens(row.text) });
			}
		}
		// In a project chat the project's own entries get their share first,
		// then both banks take turns; a share left unused passes on.
		const { projectPercent } = getMemoryRecallShares();
		const lanes: RecallLane[] = chat.projectId
			? [
					{
						lists: [projectRows],
						capTokens: Math.floor((budget * projectPercent) / 100),
					},
					{ lists: [personalRows, projectRows], capTokens: budget },
				]
			: [{ lists: [personalRows], capTokens: budget }];
		const chosen = allocateRecall(lanes, budget).flatMap((key) => {
			const entry = offered.get(key);
			return entry ? [entry] : [];
		});
		// The person's entries first, then the project's, each in the order chosen.
		return [
			...chosen.filter(({ scope }) => scope.kind === "personal"),
			...chosen.filter(({ scope }) => scope.kind === "project"),
		].map(({ row, scope, facts, ids }): AdmittedMemoryEvidence => {
			const sources: MemorySource[] = [];
			const seen = new Set<string>();
			let lastMentionedMs: number | null = null;
			for (const fact of facts.filter((f) => ids.includes(f.id))) {
				const source = fact.source;
				const saidMs = (source.explicitEditAt ?? source.assertedAt).getTime();
				if (lastMentionedMs === null || saidMs > lastMentionedMs)
					lastMentionedMs = saidMs;
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
			return {
				ref: { scope, generation: row.generation, rowId: row.nativeId },
				text: row.text,
				sources,
				lastMentionedAt:
					lastMentionedMs === null
						? null
						: new Date(lastMentionedMs).toISOString(),
			};
		});
	});
}
