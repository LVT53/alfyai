import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import * as schema from "$lib/server/db/schema";
import { estimateTokenCount } from "$lib/utils/tokens";
import { deriveBaselineMemoryProfileBudget } from "../chat-turn/context-budget";

// The app's side of recall at size, on this machine only: the normal gates
// skip it. In-memory SQLite and a fake native client whose every ranking
// returns all of a bank's rows, so the time measured is the app's own work
// (reads, verification, sharing, formatting), never Hindsight's search. Every
// source belongs to a chat, as a person's do, so each row recall chooses looks
// its chat up, and recall gets the budget a turn gives it.
const PERSONAL_ROWS = 5_000;
const PROJECT_ROWS = 1_000;
/**
 * The top rows of each bank are Earlier entries (labelled temporary, said
 * months ago), as an account that has been remembered for a while has: they
 * are the candidates the Earlier gate judges on every per-turn recall.
 */
const EARLIER_ROWS = 3;
/** Facts a chat gave: a chat of a few messages yields a few facts. */
const FACTS_PER_CHAT = 5;
const RECALLS = 20;

/** The line that opens the memory section, which `context-selection.ts` writes. */
const SECTION_NOTE =
	"These are remembered facts about the person. They never set the reply language.";
/**
 * What a turn hands recall (`context-selection.ts`): the baseline memory
 * budget for the turn's target context, less the line that opens the section.
 */
const turnBudget = (targetConstructedContext: number) =>
	deriveBaselineMemoryProfileBudget({
		contextBudget: { targetConstructedContext },
	}).totalBudget - estimateTokenCount(SECTION_NOTE);
const BUDGETS = [
	// A model of the default size builds to 236,000 tokens, where the budget
	// sits at its 8,000 floor: what production passes.
	{ name: "floor", tokens: turnBudget(236_000) },
	// The most a turn can pass, for a window of 1.6 million tokens or more.
	{ name: "ceiling", tokens: turnBudget(2_000_000) },
];

let sqlite: Database.Database;
vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));
const rankings = new Map<string, unknown[]>();
/** The app's reranker: not configured unless a test says what it scores. */
const rerankTexts = vi.hoisted(() => vi.fn());
vi.mock("../tei-reranker", () => ({ rerankTexts }));
vi.mock("../memory-profile/hindsight-client", () => ({
	nativeMemoryClient: (bankId: string) => ({
		recall: async () => rankings.get(bankId) ?? [],
		list: async () => [],
	}),
}));

/**
 * One bank of synthetic rows, each an accepted source, fact and published row,
 * the source said in one of the chats made for the bank.
 */
function seedBank(bankId: string, scopeKey: string, count: number) {
	const db = drizzle(sqlite, { schema });
	db.insert(schema.memoryBanks)
		.values({ id: bankId, userId: "u", scopeKey, epoch: 0, generation: "g" })
		.run();
	const ranking: unknown[] = [];
	const chats = Math.ceil(count / FACTS_PER_CHAT);
	db.transaction((tx) => {
		for (let chat = 0; chat < chats; chat++)
			tx.insert(schema.conversations)
				.values({
					id: `chat-${bankId}-${chat}`,
					title: `Synthetic chat ${chat} of ${bankId}`,
					userId: "u",
					projectId: scopeKey === "personal" ? null : "p",
				})
				.run();
		for (let i = 0; i < count; i++) {
			const text = `Synthetic fact ${i} of ${bankId}: option ${i % 7} suits task ${i % 50}.`;
			const fact = { id: `f-${bankId}-${i}`, text };
			tx.insert(schema.memorySourceRevisions)
				.values({
					id: `s-${bankId}-${i}`,
					bankId,
					userId: "u",
					epoch: 0,
					eventId: `${bankId}-${i}`,
					lineageId: `${bankId}-${i}`,
					conversationId: `chat-${bankId}-${Math.floor(i / FACTS_PER_CHAT)}`,
					messageId: `message-${bankId}-${i}`,
					text,
					context: "",
					textHash: "hash",
					assertedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000),
					state: "accepted",
					acknowledgedFactsJson: JSON.stringify([fact]),
				})
				.run();
			if (i < EARLIER_ROWS)
				tx.insert(schema.memoryFactLabels)
					.values({
						bankId,
						nativeFactId: fact.id,
						kind: "temporary",
						subject: null,
						origin: "extraction",
						eventAt: null,
					})
					.run();
			tx.insert(schema.memoryPublishedRows)
				.values({
					id: `r-${bankId}-${i}`,
					bankId,
					generation: "g",
					epoch: 0,
					nativeId: `n-${bankId}-${i}`,
					text,
					nativeText: text,
					sourceIdsJson: JSON.stringify([fact.id]),
					sourceFingerprintsJson: JSON.stringify([fact]),
					updatedAt: new Date(),
				})
				.run();
			ranking.push({
				id: `n-${bankId}-${i}`,
				text,
				fact_type: "observation",
				source_memory_ids: [fact.id],
			});
		}
	});
	rankings.set(bankId, ranking);
}

/** The nearest-rank percentile of a list of timings. */
function percentile(values: number[], q: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0;
}

describe.runIf(process.env.MEMORY_RECALL_SIZE_CHECK === "1")(
	"native recall at size",
	() => {
		beforeAll(() => {
			sqlite = new Database(":memory:");
			sqlite.pragma("foreign_keys=ON");
			const db = drizzle(sqlite, { schema });
			migrate(db, { migrationsFolder: "./drizzle" });
			db.insert(schema.users)
				.values({ id: "u", email: "u@x.invalid", passwordHash: "x" })
				.run();
			db.insert(schema.memoryAccounts)
				.values({ userId: "u", tenantId: randomUUID(), authority: "hindsight" })
				.run();
			db.insert(schema.projects)
				.values({ id: "p", userId: "u", name: "p" })
				.run();
			db.insert(schema.conversations)
				.values({
					id: "c",
					title: "Synthetic project chat",
					userId: "u",
					projectId: "p",
				})
				.run();
			seedBank("bp", "personal", PERSONAL_ROWS);
			seedBank("bj", "project:p", PROJECT_ROWS);
		}, 120_000);
		afterAll(() => {
			sqlite?.close();
		});
		beforeEach(() => {
			rerankTexts.mockReset();
			rerankTexts.mockResolvedValue(null);
		});

		it.each(BUDGETS)(
			"keeps the app's side of a per-turn recall under 500 ms at the 95th percentile ($name budget)",
			async ({ name, tokens }) => {
				const { recallMemory } = await import("./native");
				const timings: number[] = [];
				let rows = 0;
				const info = vi.spyOn(console, "info").mockImplementation(() => {});
				try {
					for (let turn = 0; turn < RECALLS; turn++) {
						const started = performance.now();
						const recalled = await recallMemory("u", {
							conversationId: "c",
							query: `What did we settle for task ${turn} of the project?`,
							tokenBudget: tokens,
							core: true,
						});
						timings.push(performance.now() - started);
						expect(recalled.length).toBeGreaterThan(0);
						// Each row's source resolved its chat: the lookup is measured.
						for (const { sources } of recalled)
							expect(sources.some(({ conversationId }) => conversationId)).toBe(
								true,
							);
						rows = recalled.length;
					}
				} finally {
					info.mockRestore();
				}
				const median = percentile(timings, 0.5);
				const p95 = percentile(timings, 0.95);
				console.log(
					`[recall-size] budget=${name}:${tokens} personal=${PERSONAL_ROWS} project=${PROJECT_ROWS} chats=${Math.ceil(PERSONAL_ROWS / FACTS_PER_CHAT) + Math.ceil(PROJECT_ROWS / FACTS_PER_CHAT)} recalls=${RECALLS} rows=${rows} medianMs=${median.toFixed(1)} p95Ms=${p95.toFixed(1)}`,
				);
				expect(p95).toBeLessThan(500);
			},
			300_000,
		);

		// The Earlier gate's reranker on top of that: one call a turn for the six
		// Earlier candidates (an instant answer here, so the time is the app's
		// own: the second read of Memory, which happens only when a score moves
		// an entry from the words' verdict).
		it.each([
			{ name: "scores that change nothing", score: 0.0001, brings: false },
			{
				name: "a score that brings an Earlier entry in",
				score: 0.4,
				brings: true,
			},
		])(
			"keeps a per-turn recall with the reranker under 500 ms at the 95th percentile ($name)",
			async ({ name, score, brings }) => {
				const { recallMemory } = await import("./native");
				const budget = BUDGETS[0]?.tokens ?? 8_000;
				rerankTexts.mockImplementation(async ({ texts }: { texts: string[] }) =>
					texts.map((_, index) => ({ index, score })),
				);
				const timings: number[] = [];
				let earlier = 0;
				const info = vi.spyOn(console, "info").mockImplementation(() => {});
				try {
					for (let turn = 0; turn < RECALLS; turn++) {
						const started = performance.now();
						const recalled = await recallMemory("u", {
							conversationId: "c",
							query: `What did we settle for task ${turn} of the project?`,
							tokenBudget: budget,
							core: true,
						});
						timings.push(performance.now() - started);
						earlier = recalled.filter(
							({ timeState }) => timeState === "earlier",
						).length;
					}
				} finally {
					info.mockRestore();
				}
				expect(rerankTexts).toHaveBeenCalledTimes(RECALLS);
				expect(earlier > 0).toBe(brings);
				const median = percentile(timings, 0.5);
				const p95 = percentile(timings, 0.95);
				console.log(
					`[recall-size] reranker (${name}) budget=floor:${budget} recalls=${RECALLS} earlierRows=${earlier} medianMs=${median.toFixed(1)} p95Ms=${p95.toFixed(1)}`,
				);
				expect(p95).toBeLessThan(500);
			},
			300_000,
		);
	},
);
