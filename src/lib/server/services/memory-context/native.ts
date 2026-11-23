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
import {
	RECALL_PROJECT_HEADING,
	RECALL_TIMES_NOTE,
	recallLineTokens,
} from "./recall-format";
import { CORE_MEMORY_QUERY, messageRecallQuery } from "./recall-query";

/** An accepted row recall may offer, with what its entry is built from. */
interface OfferedRow {
	bankId: string;
	row: ReturnType<typeof readPublishedMemory>[number];
	scope: MemoryScope;
	facts: ReturnType<typeof admittedNativeFacts>;
	ids: unknown[];
}

/** The searches recall runs on a bank: the message's, and the basics'. */
type RecallList = "message" | "core";

/** How one bank's searches ended, for its lists and its log line. */
interface BankSearch {
	/** The observations each answered search ranked. */
	rankings: Map<RecallList, NativeMemory[]>;
	outcomes: ("answered" | "timed_out" | "failed")[];
	slowestMs: number;
}

/**
 * Native ranking can select only exact, still-admitted accepted observations.
 * Each bank is searched with the person's message and, with `core` (the
 * per-turn section), also for their basics; the tool searches with its query
 * alone. Makes no model call.
 */
export async function recallMemory(
	userId: string,
	input: {
		conversationId: string;
		query: string;
		tokenBudget: number;
		core?: boolean;
	},
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
	const budget = Math.max(0, Math.floor(input.tokenBudget));
	const message = messageRecallQuery(
		input.query,
		input.core ? chat.title : undefined,
	);
	const searches: { list: RecallList; query: string }[] = [
		...(message === null ? [] : [{ list: "message" as const, query: message }]),
		...(input.core
			? [{ list: "core" as const, query: CORE_MEMORY_QUERY }]
			: []),
	];
	const searched = new Map<string, BankSearch>();
	const confirmedEvidence = new Map<string, Map<string, NativeMemory>>();
	for (const bank of banks) {
		if (!isStillActive(db)) return [];
		const search: BankSearch = {
			rankings: new Map(),
			outcomes: [],
			slowestMs: 0,
		};
		searched.set(bank.id, search);
		const signal = AbortSignal.timeout(2_000);
		let client: ReturnType<typeof nativeMemoryClient>;
		try {
			client = nativeMemoryClient(bank.id, account.tenantId, signal);
		} catch {
			search.outcomes = searches.map(() => "failed");
			continue;
		}
		const beforeDispatch = () => {
			// Capability verification and name resolution can outlast consent.
			if (
				!readableBanks(db).some(({ id }) => id === bank.id) ||
				!isStillActive(db)
			)
				throw new NativeMemoryError("native_cancelled", false);
		};
		// One client, so one capability check serves the bank's searches; each
		// ends on its own, and a search that fails after the bank's time is up
		// timed out.
		const results = await Promise.all(
			searches.map(async ({ list, query }) => {
				const started = performance.now();
				try {
					const matches = await client.recall(query, budget, beforeDispatch);
					search.rankings.set(
						list,
						matches.filter((m) => m.fact_type === "observation"),
					);
					return "answered" as const;
				} catch {
					return signal.aborted ? ("timed_out" as const) : ("failed" as const);
				} finally {
					search.slowestMs = Math.max(
						search.slowestMs,
						Math.round(performance.now() - started),
					);
				}
			}),
		);
		search.outcomes = results;
		const answered = [...search.rankings.values()];
		try {
			if (answered.some((ranking) => ranking.length) && isStillActive(db)) {
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
					answered.some((ranking) =>
						ranking.some((rank) => {
							const support = rank.source_memory_ids ?? [];
							const key = nativeRankSupportKey(support);
							return (
								support.some((id) => family?.ids.has(id)) ||
								(key && bridge.has(key))
							);
						}),
					)
				) {
					// One evidence snapshot per bank, after its searches.
					const snapshot = await client.list();
					const unique = new Map(snapshot.map((row) => [row.id, row]));
					if (unique.size === snapshot.length)
						confirmedEvidence.set(bank.id, unique);
				}
			}
		} catch {
			/* A failed snapshot keeps the answered rankings, unconfirmed. */
		}
	}
	// Every eligible bank shares one live snapshot, including holds set during a native call.
	const entries = db.transaction((tx) => {
		if (!isStillActive(tx)) return [];
		const readableIds = new Set(readableBanks(tx).map(({ id }) => id));
		// The section goes into the prompt whole, so the budget holds every
		// formatted line, the line on what the times mean and, in a project
		// chat, the project's heading.
		const sectionBudget = Math.max(
			0,
			budget -
				estimateTokenCount(RECALL_TIMES_NOTE) -
				(chat.projectId ? estimateTokenCount(RECALL_PROJECT_HEADING) : 0),
		);
		const offered = new Map<string, OfferedRow>();
		const rows: Record<
			MemoryScope["kind"],
			Record<RecallList, RecallCandidate[]>
		> = {
			personal: { message: [], core: [] },
			project: { message: [], core: [] },
		};
		for (const bank of banks) {
			if (!readableIds.has(bank.id)) continue;
			const search = searched.get(bank.id);
			const accepted = readPublishedMemory(userId, bank.id, undefined, tx);
			const facts = admittedNativeFacts(userId, bank.id, tx);
			const scope: MemoryScope =
				bank.scopeKey === "personal"
					? { kind: "personal" }
					: { kind: "project", projectId: bank.scopeKey.slice(8) };
			// Only a row whose sources can be read is offered.
			const offerable = accepted.flatMap((row) => {
				const ids: unknown = JSON.parse(row.sourceIdsJson);
				return Array.isArray(ids) ? [{ row, ids }] : [];
			});
			// A bank whose every search failed offers every row in stored order.
			const answered = search?.outcomes.includes("answered") ?? false;
			let verifiedOrder = (_ranking: NativeMemory[]) =>
				new Map<string, number>();
			if (answered) {
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
				verifiedOrder = (ranking) => {
					const order = new Map<string, number>();
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
							if (!order.has(direct.nativeId))
								order.set(direct.nativeId, index);
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
					return order;
				};
			}
			// Each list holds the verified rows of its own search, in its order:
			// none when that search failed while another answered.
			const listRows = (list: RecallList) => {
				if (!answered) return offerable;
				const ranking = search?.rankings.get(list);
				if (!ranking) return [];
				const order = verifiedOrder(ranking);
				return offerable
					.filter(({ row }) => order.has(row.nativeId))
					.sort(
						(a, b) =>
							(order.get(a.row.nativeId) ?? 0) -
							(order.get(b.row.nativeId) ?? 0),
					);
			};
			const lists: RecallList[] = input.core
				? ["message", "core"]
				: ["message"];
			for (const list of lists)
				for (const { row, ids } of listRows(list)) {
					const key = `${bank.id}:${row.nativeId}`;
					if (!offered.has(key))
						offered.set(key, { bankId: bank.id, row, scope, facts, ids });
					rows[scope.kind][list].push({
						key,
						tokens: recallLineTokens(row.text),
					});
				}
		}
		// The project's own entries get their share first, then the person's
		// basics theirs; what the message is about fills the rest, both banks
		// in turn, and a share left unused passes on.
		const { corePercent, projectPercent } = getMemoryRecallShares();
		const share = (percent: number) =>
			Math.floor((sectionBudget * percent) / 100);
		const lanes: RecallLane[] = [
			...(chat.projectId
				? [
						{
							lists: [[...rows.project.message, ...rows.project.core]],
							capTokens: share(projectPercent),
						},
					]
				: []),
			...(input.core
				? [{ lists: [rows.personal.core], capTokens: share(corePercent) }]
				: []),
			{
				lists: chat.projectId
					? [rows.personal.message, rows.project.message]
					: [rows.personal.message],
				capTokens: sectionBudget,
			},
		];
		const chosen = allocateRecall(lanes, sectionBudget).flatMap((key) => {
			const entry = offered.get(key);
			return entry ? [entry] : [];
		});
		// The person's entries first, then the project's, each in the order chosen.
		return [
			...chosen.filter(({ scope }) => scope.kind === "personal"),
			...chosen.filter(({ scope }) => scope.kind === "project"),
		].map(({ bankId, row, scope, facts, ids }) => {
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
			const entry: AdmittedMemoryEvidence = {
				ref: { scope, generation: row.generation, rowId: row.nativeId },
				text: row.text,
				sources,
				lastMentionedAt:
					lastMentionedMs === null
						? null
						: new Date(lastMentionedMs).toISOString(),
			};
			return { bankId, entry };
		});
	});
	for (const bank of banks) {
		const search = searched.get(bank.id);
		if (!search) continue;
		const count = (outcome: BankSearch["outcomes"][number]) =>
			search.outcomes.filter((ended) => ended === outcome).length;
		// Content-free (services/AGENTS.md): no query, entry text or id.
		console.info("[KNOWLEDGE_MEMORY] Recall", {
			mode: input.core ? "turn" : "tool",
			bank: bank.scopeKey === "personal" ? "personal" : "project",
			searches: searches.length,
			answered: count("answered"),
			timedOut: count("timed_out"),
			failed: count("failed"),
			slowestMs: search.slowestMs,
			fallback: count("answered") === 0,
			rows: entries.filter(({ bankId }) => bankId === bank.id).length,
		});
	}
	return entries.map(({ entry }) => entry);
}
