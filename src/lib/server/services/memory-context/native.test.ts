import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import { estimateTokenCount } from "$lib/utils/tokens";
import {
	formatRecalledMemory,
	RECALL_PROJECT_HEADING,
	RECALL_TIMES_NOTE,
	recallLineTokens,
} from "./recall-format";
import { CORE_MEMORY_QUERY } from "./recall-query";

/** The line on what the times mean: recall reserves it like the heading. */
const N = estimateTokenCount(RECALL_TIMES_NOTE);

let sqlite: Database.Database;
vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));
const recall = vi.fn();
const list = vi.fn();
const wireEndpoint = "http://127.0.0.1:18890";
let wire: typeof fetch | undefined;
vi.mock("../memory-profile/hindsight-client", async (importOriginal) => {
	const { HindsightClient } =
		await importOriginal<typeof import("../memory-profile/hindsight-client")>();
	return {
		nativeMemoryClient: (
			bankId: string,
			tenantId: string,
			signal: AbortSignal,
		) =>
			wire
				? new HindsightClient({
						baseUrl: wireEndpoint,
						allowedUrls: [wireEndpoint],
						bankId,
						tenantId,
						apiKey: "synthetic-key",
						fetcher: wire,
						signal,
					})
				: {
						recall: (query: string, budget: number) =>
							recall(query, budget, signal, bankId),
						list: () => list(),
					},
	};
});
let shares = { corePercent: 25, projectPercent: 50 };
vi.mock("$lib/server/config-store", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/server/config-store")>()),
	getMemoryRecallShares: () => shares,
}));
beforeEach(() => {
	shares = { corePercent: 25, projectPercent: 50 };
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
	for (const p of ["p", "other"])
		db.insert(schema.projects).values({ id: p, userId: "u", name: p }).run();
	db.insert(schema.conversations)
		.values([
			{ id: "c", title: "chat", userId: "u", projectId: "p" },
			{ id: "personal", title: "personal", userId: "u" },
		])
		.run();
	recall.mockClear();
	list.mockClear();
	recall.mockRejectedValue(new Error("offline"));
	list.mockResolvedValue([]);
});
afterEach(() => {
	wire = undefined;
	sqlite.close();
});
function seed(bankId: string, scopeKey: string, text: string) {
	const db = drizzle(sqlite, { schema });
	db.insert(schema.memoryBanks)
		.values({ id: bankId, userId: "u", scopeKey, epoch: 0, generation: "g" })
		.run();
	db.insert(schema.memorySourceRevisions)
		.values({
			id: `s-${bankId}`,
			bankId,
			userId: "u",
			epoch: 0,
			eventId: bankId,
			lineageId: bankId,
			text,
			context: "",
			textHash: "hash",
			assertedAt: new Date(),
			state: "accepted",
			acknowledgedFactsJson: JSON.stringify([{ id: `f-${bankId}`, text }]),
		})
		.run();
	db.insert(schema.memoryPublishedRows)
		.values({
			id: `r-${bankId}`,
			bankId,
			generation: "g",
			epoch: 0,
			nativeId: `n-${bankId}`,
			text,
			nativeText: text,
			sourceIdsJson: JSON.stringify([`f-${bankId}`]),
			sourceFingerprintsJson: JSON.stringify([{ id: `f-${bankId}`, text }]),
			updatedAt: new Date(),
		})
		.run();
}
/** One bank with one accepted source, fact and published row per text. */
function seedBankRows(bankId: string, scopeKey: string, texts: string[]) {
	const db = drizzle(sqlite, { schema });
	db.insert(schema.memoryBanks)
		.values({ id: bankId, userId: "u", scopeKey, epoch: 0, generation: "g" })
		.run();
	for (const [i, text] of texts.entries()) {
		const fact = { id: `f-${bankId}-${i}`, text };
		db.insert(schema.memorySourceRevisions)
			.values({
				id: `s-${bankId}-${i}`,
				bankId,
				userId: "u",
				epoch: 0,
				eventId: `${bankId}-${i}`,
				lineageId: `${bankId}-${i}`,
				text,
				context: "",
				textHash: "hash",
				assertedAt: new Date(),
				state: "accepted",
				acknowledgedFactsJson: JSON.stringify([fact]),
			})
			.run();
		db.insert(schema.memoryPublishedRows)
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
	}
}
/** The observations Hindsight would rank for those rows: direct matches. */
const ranked = (bankId: string, texts: string[], indices: number[]) =>
	indices.map((i) => ({
		id: `n-${bankId}-${i}`,
		text: texts[i],
		fact_type: "observation",
		source_memory_ids: [`f-${bankId}-${i}`],
	}));
const personalTexts = Array.from(
	{ length: 40 },
	(_, i) => `Personal fact ${String(i).padStart(2, "0")}`,
);
const projectTexts = (n: number) =>
	Array.from(
		{ length: n },
		(_, i) => `Project fact ${String(i).padStart(2, "0")}`,
	);
/** Personal bank `bp` and project bank `bj`, each ranked whole and in order. */
function seedFairSplit(projectCount: number) {
	const project = projectTexts(projectCount);
	seedBankRows("bp", "personal", personalTexts);
	seedBankRows("bj", "project:p", project);
	recall.mockImplementation(
		async (
			_query: string,
			_budget: number,
			_signal: AbortSignal,
			bankId: string,
		) =>
			bankId === "bp"
				? ranked("bp", personalTexts, [...personalTexts.keys()])
				: ranked("bj", project, [...project.keys()]),
	);
}
it("recalls accepted personal and own-project only when native is offline", async () => {
	seed("b1", "personal", "Personal preference");
	seed("b2", "project:p", "Project decision");
	seed("b3", "project:other", "Other secret");
	const { recallMemory } = await import("./native");
	const result = await recallMemory("u", {
		conversationId: "c",
		query: "preferences",
		tokenBudget: 1000,
	});
	expect(result.map((x) => x.text)).toEqual([
		"Personal preference",
		"Project decision",
	]);
	const personal = await recallMemory("u", {
		conversationId: "personal",
		query: "preferences",
		tokenBudget: 1000,
	});
	expect(personal.map((x) => x.text)).toEqual(["Personal preference"]);
});
it("reports the newest date among an entry's sources", async () => {
	const db = drizzle(sqlite, { schema });
	db.insert(schema.memoryBanks)
		.values({
			id: "b1",
			userId: "u",
			scopeKey: "personal",
			epoch: 0,
			generation: "g",
		})
		.run();
	const facts = [
		{ id: "f1", text: "Drinks green tea" },
		{ id: "f2", text: "Drinks it hot" },
	];
	const source = {
		bankId: "b1",
		userId: "u",
		epoch: 0,
		context: "",
		textHash: "hash",
		state: "accepted",
	};
	db.insert(schema.memorySourceRevisions)
		.values([
			{
				...source,
				id: "s1",
				eventId: "e-b1-1",
				lineageId: "e-b1-1",
				text: facts[0].text,
				assertedAt: new Date("2026-10-01T00:00:00Z"),
				acknowledgedFactsJson: JSON.stringify([facts[0]]),
			},
			{
				...source,
				id: "s2",
				eventId: "e-b1-2",
				lineageId: "e-b1-2",
				text: facts[1].text,
				assertedAt: new Date("2026-11-01T00:00:00Z"),
				explicitEditAt: new Date("2026-11-10T00:00:00Z"),
				acknowledgedFactsJson: JSON.stringify([facts[1]]),
			},
		])
		.run();
	db.insert(schema.memoryPublishedRows)
		.values({
			id: "r-b1",
			bankId: "b1",
			generation: "g",
			epoch: 0,
			nativeId: "n-b1",
			text: "Drinks green tea hot",
			nativeText: "Drinks green tea hot",
			sourceIdsJson: JSON.stringify(["f1", "f2"]),
			sourceFingerprintsJson: JSON.stringify(facts),
			updatedAt: new Date(),
		})
		.run();
	const { recallMemory } = await import("./native");
	const result = await recallMemory("u", {
		conversationId: "personal",
		query: "tea",
		tokenBudget: 1000,
	});
	expect(result.map(({ text }) => text)).toEqual(["Drinks green tea hot"]);
	expect(result[0].lastMentionedAt).toBe("2026-11-10T00:00:00.000Z");
});
it("fits the formatted section in its budget", async () => {
	seed("b1", "personal", "Personal preference");
	seed("b2", "project:p", "Project decision");
	const budget =
		recallLineTokens("Personal preference") +
		recallLineTokens("Project decision") +
		estimateTokenCount(RECALL_PROJECT_HEADING) +
		N;
	const { recallMemory } = await import("./native");
	const both = await recallMemory("u", {
		conversationId: "c",
		query: "preferences",
		tokenBudget: budget,
	});
	expect(both.map(({ text }) => text)).toEqual([
		"Personal preference",
		"Project decision",
	]);
	// The line on what the times mean is part of what must fit.
	expect(formatRecalledMemory(both, new Date())).toContain(RECALL_TIMES_NOTE);
	expect(
		estimateTokenCount(formatRecalledMemory(both, new Date())),
	).toBeLessThanOrEqual(budget);
	const tight = await recallMemory("u", {
		conversationId: "c",
		query: "preferences",
		tokenBudget: budget - 1,
	});
	// The project's share fills first, so the one entry that fits is the
	// project's own.
	expect(tight.map(({ text }) => text)).toEqual(["Project decision"]);
	expect(
		estimateTokenCount(formatRecalledMemory(tight, new Date())),
	).toBeLessThanOrEqual(budget - 1);
});
it("gives a project chat's own entries their share even when the person's entries alone would fill it", async () => {
	const L = recallLineTokens("Personal fact 00");
	const H = estimateTokenCount(RECALL_PROJECT_HEADING);
	expect(L).toBe(recallLineTokens("Project fact 00"));
	seedFairSplit(20);
	const budget = 20 * L + H + N;
	const { recallMemory } = await import("./native");
	const result = await recallMemory("u", {
		conversationId: "c",
		query: "facts",
		tokenBudget: budget,
	});
	// Ten from the project's share, then both banks in turn: five each.
	expect(result.map(({ text }) => text)).toEqual([
		...personalTexts.slice(0, 5),
		...projectTexts(15),
	]);
	expect(result.filter(({ ref }) => ref.scope.kind === "project")).toHaveLength(
		15,
	);
	expect(
		estimateTokenCount(formatRecalledMemory(result, new Date())),
	).toBeLessThanOrEqual(budget);
});
it("fills the rest with personal entries when the project has few", async () => {
	const L = recallLineTokens("Personal fact 00");
	const H = estimateTokenCount(RECALL_PROJECT_HEADING);
	expect(L).toBe(recallLineTokens("Project fact 00"));
	seedFairSplit(2);
	const { recallMemory } = await import("./native");
	const result = await recallMemory("u", {
		conversationId: "c",
		query: "facts",
		tokenBudget: 20 * L + H + N,
	});
	expect(result.map(({ text }) => text)).toEqual([
		...personalTexts.slice(0, 18),
		...projectTexts(2),
	]);
});
it("keeps a personal chat's recall in ranking order", async () => {
	const L = recallLineTokens("Personal fact 00");
	seedFairSplit(20);
	const { recallMemory } = await import("./native");
	const result = await recallMemory("u", {
		conversationId: "personal",
		query: "facts",
		tokenBudget: 10 * L + N,
	});
	expect(result.map(({ text }) => text)).toEqual(personalTexts.slice(0, 10));
});
it("writes nothing while recalling", async () => {
	seedFairSplit(5);
	const changes = () =>
		(sqlite.prepare("select total_changes() as n").get() as { n: number }).n;
	const before = changes();
	const { recallMemory } = await import("./native");
	const result = await recallMemory("u", {
		conversationId: "c",
		query: "facts",
		tokenBudget: 1000,
	});
	expect(result.length).toBeGreaterThan(0);
	expect(changes()).toBe(before);
});
it("does not expose native raw/source expansion or an unaccepted changed observation", async () => {
	seed("b1", "personal", "Accepted");
	recall.mockResolvedValue([
		{ id: "n-b1", text: "Unaccepted rewrite", fact_type: "observation" },
		{ id: "raw", text: "Raw secret", fact_type: "world" },
	]);
	const { recallMemory } = await import("./native");
	expect(
		await recallMemory("u", {
			conversationId: "c",
			query: "query",
			tokenBudget: 1000,
		}),
	).toEqual([]);
});
it("applies live revocations on fallback and refuses foreign conversations", async () => {
	seed("b1", "personal", "Removed");
	drizzle(sqlite, { schema })
		.insert(schema.memoryRevocations)
		.values({
			id: "revoked",
			userId: "u",
			bankId: "b1",
			epoch: 0,
			sourceId: "s-b1",
		})
		.run();
	const { recallMemory } = await import("./native");
	expect(
		await recallMemory("u", {
			conversationId: "c",
			query: "x",
			tokenBudget: 1000,
		}),
	).toEqual([]);
	expect(
		await recallMemory("other", {
			conversationId: "c",
			query: "x",
			tokenBudget: 1000,
		}),
	).toEqual([]);
});

it.each([false, true])(
	"bounds native recall and rechecks revocation when the timed-out call returns (core: %s)",
	async (core) => {
		seed("b1", "personal", "Now removed");
		const controller = new AbortController();
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockReturnValue(controller.signal);
		recall.mockImplementation(
			async (_query: string, _budget: number, signal: AbortSignal) => {
				drizzle(sqlite, { schema })
					.insert(schema.memoryRevocations)
					.values({
						id: "late",
						userId: "u",
						bankId: "b1",
						epoch: 0,
						sourceId: "s-b1",
					})
					.onConflictDoNothing()
					.run();
				controller.abort();
				signal.throwIfAborted();
				return [];
			},
		);
		try {
			const { recallMemory } = await import("./native");
			expect(
				await recallMemory("u", {
					conversationId: "personal",
					query: "x",
					tokenBudget: 1000,
					core,
				}),
			).toEqual([]);
			expect(timeout).toHaveBeenCalledWith(2000);
		} finally {
			timeout.mockRestore();
		}
	},
);

it("revalidates all banks together after the last native await", async () => {
	seed("b1", "personal", "Removed during project recall");
	seed("b2", "project:p", "Project decision");
	let calls = 0;
	recall.mockImplementation(async () => {
		if (++calls === 2)
			drizzle(sqlite, { schema })
				.insert(schema.memoryRevocations)
				.values({
					id: "late-combined",
					userId: "u",
					bankId: "b1",
					epoch: 0,
					sourceId: "s-b1",
				})
				.run();
		throw new Error("offline");
	});
	const { recallMemory } = await import("./native");
	const result = await recallMemory("u", {
		conversationId: "c",
		query: "x",
		tokenBudget: 1000,
	});
	expect(result.map((r) => r.text)).toEqual(["Project decision"]);
	expect(result[0].ref.rowId).toBe("n-b2");
});
it.each([false, true])(
	"rejects a combined recall if off-on changes control revision during native ranking (core: %s)",
	async (core) => {
		seed("b1", "personal", "Old control");
		recall.mockImplementation(async () => {
			drizzle(sqlite, { schema })
				.update(schema.memoryAccounts)
				.set({ controlRevision: 2 })
				.run();
			throw new Error("offline");
		});
		const { recallMemory } = await import("./native");
		expect(
			await recallMemory("u", {
				conversationId: "c",
				query: "x",
				tokenBudget: 1000,
				core,
			}),
		).toEqual([]);
	},
);

it.each([
	{ held: ["b2"], expected: ["Personal preference"] },
	{ held: ["b1"], expected: ["Project decision"] },
	{ held: ["b1", "b2"], expected: [] },
	{ held: [], expected: ["Personal preference"] },
])(
	"keeps healthy recall scopes available with repair holds ($held)",
	async ({ held, expected }) => {
		seed("b1", "personal", "Personal preference");
		seed("b2", "project:p", "Project decision");
		const db = drizzle(sqlite, { schema });
		const hold = (id: string) =>
			db
				.update(schema.memoryBanks)
				.set({ status: "repair_blocked" })
				.where(eq(schema.memoryBanks.id, id))
				.run();
		for (const id of held) hold(id);
		recall.mockClear();
		if (!held.length) {
			let calls = 0;
			recall.mockImplementation(async () => {
				if (++calls === 2) hold("b2");
				throw new Error("offline");
			});
		}
		const { recallMemory } = await import("./native");
		const result = await recallMemory("u", {
			conversationId: "c",
			query: "preferences",
			tokenBudget: 1000,
		});
		expect(result.map(({ text }) => text)).toEqual(expected);
		expect(recall).toHaveBeenCalledTimes(2 - held.length);
	},
);

it.each([
	{ change: "no change", hold: "capability", core: false },
	{ change: "off and on", hold: "capability", core: false },
	{ change: "incognito", hold: "capability", core: false },
	{ change: "project move", hold: "first recall", core: false },
	{ change: "no change", hold: "capability", core: true },
	{ change: "off and on", hold: "capability", core: true },
	{ change: "incognito", hold: "capability", core: true },
	{ change: "project move", hold: "first recall", core: true },
] as const)(
	"checks permission at the private recall dispatch ($change during $hold, core: $core)",
	async ({ change, hold, core }) => {
		seed("b1", "personal", "Personal preference");
		seed("b2", "project:p", "Project decision");
		const db = drizzle(sqlite, { schema });
		const account = db.select().from(schema.memoryAccounts).get();
		if (!account) throw new Error("Missing synthetic Memory account");
		const { tenantId } = account;
		const { HINDSIGHT_ENGINE_COMMIT } = await import(
			"../memory-profile/contracts"
		);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const query = "Synthetic private query";
		// Each post as `bank|query`.
		const sent: string[] = [];
		let capabilities = 0;
		wire = async (input, init) => {
			const path = new URL(String(input)).pathname;
			if (path === "/ext/alfyai/capabilities") {
				if (++capabilities === 1 && hold === "capability") {
					entered.resolve();
					await release.promise;
				}
				return Response.json({
					engine_commit: HINDSIGHT_ENGINE_COMMIT,
					extension: "alfyai-identity-v1",
					tenant_extension: "AlfyTenant",
					tenant_binding: createHash("sha256")
						.update(`alfyai_t_${tenantId.replaceAll("-", "_")}`)
						.digest("hex"),
				});
			}
			expect(path).toMatch(/\/banks\/b[12]\/memories\/recall$/);
			expect(init?.method).toBe("POST");
			sent.push(
				`${path.match(/\/banks\/(b[12])\//)?.[1]}|${JSON.parse(String(init?.body)).query}`,
			);
			if (sent.length === 1 && hold === "first recall") {
				entered.resolve();
				await release.promise;
			}
			const personal = path.includes("/banks/b1/");
			return Response.json({
				results: [
					{
						id: personal ? "n-b1" : "n-b2",
						text: personal ? "Personal preference" : "Project decision",
						type: "observation",
						source_fact_ids: [personal ? "f-b1" : "f-b2"],
					},
				],
			});
		};
		const { recallMemory } = await import("./native");
		const result = recallMemory("u", {
			conversationId: "c",
			query,
			tokenBudget: 1000,
			core,
		});
		await entered.promise;
		try {
			if (change === "off and on") {
				db.update(schema.users).set({ memoryEnabled: false }).run();
				db.update(schema.memoryAccounts).set({ controlRevision: 1 }).run();
				db.update(schema.users).set({ memoryEnabled: true }).run();
				db.update(schema.memoryAccounts).set({ controlRevision: 2 }).run();
			} else if (change === "incognito") {
				db.update(schema.conversations)
					.set({ memoryIncognito: true })
					.where(eq(schema.conversations.id, "c"))
					.run();
			} else if (change === "project move") {
				db.update(schema.conversations)
					.set({ projectId: "other" })
					.where(eq(schema.conversations.id, "c"))
					.run();
			}
		} finally {
			release.resolve();
		}

		const recalled = await result;
		// The per-turn path adds the chat's title ("chat") to this short
		// message and searches the core beside it.
		const searched = core ? [`chat: ${query}`, CORE_MEMORY_QUERY] : [query];
		if (change === "no change")
			expect([...sent].sort()).toEqual(
				["b1", "b2"]
					.flatMap((bank) => searched.map((q) => `${bank}|${q}`))
					.sort(),
			);
		else if (change === "project move") {
			// Only the personal bank's searches, none for the project's.
			expect(sent.length).toBeGreaterThanOrEqual(1);
			expect(sent.length).toBeLessThanOrEqual(searched.length);
			for (const post of sent)
				expect(searched.map((q) => `b1|${q}`)).toContain(post);
		} else expect(sent).toEqual([]);
		expect(capabilities).toBe(change === "no change" ? 2 : 1);
		expect(recalled.map(({ text }) => text).sort()).toEqual(
			change === "no change" ? ["Personal preference", "Project decision"] : [],
		);
	},
);

const EDIT_RESULT_MODES = [
	"exact",
	"partial",
	"mixed",
	"hidden split",
	"late revoke",
	"new generation",
	"wrong direct support",
	"changed native raw",
	"hidden native split",
	"direct native hidden split",
] as const;
/** An accepted personal row an Edit made; `recall` ranks the Edit's result. */
async function seedEditResult(mode: (typeof EDIT_RESULT_MODES)[number]) {
	seed("b1", "personal", "Accepted purple kayak");
	const db = drizzle(sqlite, { schema });
	const { memoryPresentationFingerprint, memorySupportFingerprint } =
		await import("../memory-profile/publication");
	const source = db.select().from(schema.memorySourceRevisions).get();
	if (!source) throw Error("test_source_missing");
	const timing = {
		mentionedAt: null,
		assertedAtMs: source.assertedAt.getTime(),
	};
	const facts = [{ id: "f-b1", text: "Accepted purple kayak", ...timing }];
	db.update(schema.memoryPublishedRows)
		.set({ sourceFingerprintsJson: JSON.stringify(facts) })
		.run();
	if (mode === "partial") {
		facts.push({
			id: "second",
			text: "A second accepted assertion",
			...timing,
		});
		db.update(schema.memorySourceRevisions)
			.set({ acknowledgedFactsJson: JSON.stringify(facts) })
			.run();
		db.update(schema.memoryPublishedRows)
			.set({
				sourceFingerprintsJson: JSON.stringify(facts),
				sourceIdsJson: JSON.stringify(facts.map(({ id }) => id)),
			})
			.run();
	}
	if (mode === "hidden split")
		db.insert(schema.memoryPublishedRows)
			.values({
				id: "hidden",
				bankId: "b1",
				epoch: 0,
				generation: "g",
				nativeId: "hidden",
				text: "Hidden split",
				nativeText: "Hidden split",
				sourceFingerprintsJson: JSON.stringify([
					...facts,
					{ id: "withdrawn", text: "Revoked source" },
				]),
				sourceIdsJson: JSON.stringify(["f-b1", "withdrawn"]),
				updatedAt: new Date(),
			})
			.run();
	const requestId = randomUUID();
	db.insert(schema.memoryActions)
		.values({
			id: "edit",
			userId: "u",
			bankId: "b1",
			epoch: 0,
			kind: "edit",
			requestId,
			rowId: "older",
			generation: "original",
			resultRowId: "n-b1",
			text: "Accepted purple kayak",
			previousText: "Old kayak",
			intentJson: JSON.stringify({
				request: {
					kind: "edit",
					requestId,
					ref: {
						scope: { kind: "personal" },
						generation: "original",
						rowId: "older",
					},
					text: "Accepted purple kayak",
				},
				facts: [],
				sourceIds: [],
				before: "Old kayak",
				outcome: "accepted",
				resultGeneration: "g",
				resultSupport: memorySupportFingerprint(facts),
				resultPresentation: memoryPresentationFingerprint(
					"Accepted purple kayak",
					"Accepted purple kayak",
				),
			}),
		})
		.run();
	const isDirect =
		mode === "direct native hidden split" || mode === "wrong direct support";
	const rankId = isDirect ? "n-b1" : "native-new-id";
	const rankText = isDirect
		? "Accepted purple kayak"
		: "Malicious native claim and quotation";
	list.mockResolvedValue([
		{
			id: rankId,
			fact_type: "observation",
			text: rankText,
			source_memory_ids: ["f-b1"],
		},
		{
			id: "f-b1",
			fact_type: "world",
			document_id: "s-b1",
			text:
				mode === "changed native raw"
					? "Wrong raw text"
					: "Accepted purple kayak",
		},
		...(mode === "hidden native split" || mode === "direct native hidden split"
			? [
					{
						id: "hidden-live-split",
						fact_type: "observation",
						text: "New mixed evidence",
						source_memory_ids: ["f-b1", "unknown"],
					},
				]
			: []),
	]);
	recall.mockImplementation(async () => {
		if (mode === "late revoke")
			db.insert(schema.memoryRevocations)
				.values({
					id: "late",
					userId: "u",
					bankId: "b1",
					epoch: 0,
					sourceId: "s-b1",
				})
				.run();
		if (mode === "new generation") {
			db.update(schema.memoryBanks)
				.set({ generation: "new", previousGeneration: "g" })
				.where(eq(schema.memoryBanks.id, "b1"))
				.run();
			db.insert(schema.memoryPublishedRows)
				.values({
					id: "new-row",
					bankId: "b1",
					epoch: 0,
					generation: "new",
					nativeId: "different-new-id",
					text: "Accepted purple kayak",
					nativeText: "Accepted purple kayak",
					sourceFingerprintsJson: JSON.stringify(facts),
					sourceIdsJson: JSON.stringify(["f-b1"]),
					updatedAt: new Date(),
				})
				.run();
		}
		return [
			{
				id: rankId,
				fact_type: "observation",
				text: rankText,
				source_memory_ids:
					mode === "mixed"
						? ["f-b1", "not-admitted"]
						: mode === "wrong direct support"
							? ["wrong-raw"]
							: ["f-b1"],
			},
		];
	});
}
it.each(EDIT_RESULT_MODES)(
	"uses only a unique currently admitted Edit result for replacement native ranks (%s)",
	async (mode) => {
		await seedEditResult(mode);
		const { recallMemory } = await import("./native");
		const result = await recallMemory("u", {
			conversationId: "personal",
			query: "kayak",
			tokenBudget: 500,
		});
		if (mode === "exact")
			expect(result).toEqual([
				expect.objectContaining({
					ref: { scope: { kind: "personal" }, generation: "g", rowId: "n-b1" },
					text: "Accepted purple kayak",
					sources: [expect.objectContaining({ quote: "" })],
				}),
			]);
		else expect(result).toEqual([]);
	},
);
it("keeps the answered rankings when the evidence snapshot fails", async () => {
	await seedEditResult("exact");
	list.mockRejectedValue(new Error("offline"));
	const { recallMemory } = await import("./native");
	const input = {
		conversationId: "personal",
		query: "kayak",
		tokenBudget: 500,
	};
	const tool = await recallMemory("u", input);
	const turn = await recallMemory("u", { ...input, core: true });
	expect(turn.map(({ ref }) => ref.rowId).sort()).toEqual(
		tool.map(({ ref }) => ref.rowId).sort(),
	);
	// As today: the unconfirmed Edit result is not offered, and the answered
	// search keeps stored order out.
	expect(tool).toEqual([]);
});
it("searches with the message and the core on the per-turn path", async () => {
	seedFairSplit(3);
	const message = "What should I cook tonight?";
	recall.mockImplementation(
		async (
			query: string,
			_budget: number,
			_signal: AbortSignal,
			bankId: string,
		) =>
			bankId === "bp"
				? ranked(
						"bp",
						personalTexts,
						query === CORE_MEMORY_QUERY ? [0, 1] : [2, 3],
					)
				: [],
	);
	const { recallMemory } = await import("./native");
	const result = await recallMemory("u", {
		conversationId: "c",
		query: message,
		tokenBudget: 1000,
		core: true,
	});
	expect(
		recall.mock.calls.map(([query, , , bankId]) => `${bankId}|${query}`).sort(),
	).toEqual(
		[
			`bj|${CORE_MEMORY_QUERY}`,
			`bj|${message}`,
			`bp|${CORE_MEMORY_QUERY}`,
			`bp|${message}`,
		].sort(),
	);
	expect(result.map(({ text }) => text)).toEqual(personalTexts.slice(0, 4));
});
it("adds the chat's title to a short follow-up", async () => {
	seedFairSplit(3);
	const { recallMemory } = await import("./native");
	await recallMemory("u", {
		conversationId: "c",
		query: "yes, do that",
		tokenBudget: 1000,
		core: true,
	});
	expect(new Set(recall.mock.calls.map(([query]) => query))).toEqual(
		new Set(["chat: yes, do that", CORE_MEMORY_QUERY]),
	);
});
it("keeps the basics when the message has no words", async () => {
	drizzle(sqlite, { schema })
		.insert(schema.conversations)
		.values({ id: "fresh", title: "New Conversation", userId: "u" })
		.run();
	seedBankRows("bp", "personal", personalTexts);
	recall.mockImplementation(async (query: string) =>
		ranked("bp", personalTexts, query === CORE_MEMORY_QUERY ? [4, 5] : [0]),
	);
	const { recallMemory } = await import("./native");
	const result = await recallMemory("u", {
		conversationId: "fresh",
		query: "  ",
		tokenBudget: 1000,
		core: true,
	});
	expect(recall.mock.calls.map(([query]) => query)).toEqual([
		CORE_MEMORY_QUERY,
	]);
	expect(result.map(({ text }) => text)).toEqual([
		"Personal fact 04",
		"Personal fact 05",
	]);
});
it("uses the search that answered when the other fails", async () => {
	seedBankRows("bp", "personal", personalTexts);
	recall.mockImplementation(async (query: string) => {
		if (query === CORE_MEMORY_QUERY) return ranked("bp", personalTexts, [3, 1]);
		throw new Error("offline");
	});
	const { recallMemory } = await import("./native");
	const result = await recallMemory("u", {
		conversationId: "personal",
		query: "What should I cook tonight?",
		tokenBudget: 1000,
		core: true,
	});
	expect(result.map(({ text }) => text)).toEqual([
		"Personal fact 03",
		"Personal fact 01",
	]);
});
it("searches once with the query on the tool path", async () => {
	seedFairSplit(3);
	const { recallMemory } = await import("./native");
	await recallMemory("u", {
		conversationId: "c",
		query: "yes",
		tokenBudget: 1000,
	});
	expect(
		recall.mock.calls.map(([query, , , bankId]) => `${bankId}|${query}`).sort(),
	).toEqual(["bj|yes", "bp|yes"]);
});
it("cuts a long message before searching", async () => {
	seedFairSplit(3);
	const { recallMemory } = await import("./native");
	await recallMemory("u", {
		conversationId: "c",
		query: "word ".repeat(1000),
		tokenBudget: 1000,
		core: true,
	});
	expect(recall).toHaveBeenCalled();
	for (const [query] of recall.mock.calls)
		expect(Array.from(String(query)).length).toBeLessThanOrEqual(505);
});
it("brings the project entry whose text the message quotes", async () => {
	const L = recallLineTokens("Personal fact 00");
	const H = estimateTokenCount(RECALL_PROJECT_HEADING);
	seedFairSplit(20);
	const project = projectTexts(20);
	recall.mockImplementation(
		async (
			query: string,
			_budget: number,
			_signal: AbortSignal,
			bankId: string,
		) =>
			bankId === "bp"
				? ranked("bp", personalTexts, [...personalTexts.keys()])
				: ranked(
						"bj",
						project,
						query === "Project fact 07"
							? [7, ...[...project.keys()].filter((i) => i !== 7)]
							: [...project.keys()],
					),
	);
	const { recallMemory } = await import("./native");
	const result = await recallMemory("u", {
		conversationId: "c",
		query: "Project fact 07",
		// The person's entries alone would fill this budget.
		tokenBudget: 4 * L + H + N,
	});
	expect(result.map(({ text }) => text)).toContain("Project fact 07");
});
it("logs one content-free line per bank", async () => {
	seedFairSplit(3);
	const message = "What should I cook tonight?";
	const project = projectTexts(3);
	recall.mockImplementation(
		async (
			query: string,
			_budget: number,
			signal: AbortSignal,
			bankId: string,
		) => {
			// The personal bank's message search waits out the bank's timeout.
			if (bankId === "bp" && query !== CORE_MEMORY_QUERY)
				return new Promise((_, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				});
			return bankId === "bp"
				? ranked("bp", personalTexts, [0, 1])
				: ranked("bj", project, [0, 1]);
		},
	);
	const info = vi.spyOn(console, "info").mockImplementation(() => {});
	try {
		const { recallMemory } = await import("./native");
		await recallMemory("u", {
			conversationId: "c",
			query: message,
			tokenBudget: 1000,
			core: true,
		});
		const lines = info.mock.calls.filter(
			([tag]) => tag === "[KNOWLEDGE_MEMORY] Recall",
		);
		const byBank = new Map(
			lines.map(([, summary]) => [(summary as { bank: string }).bank, summary]),
		);
		expect(lines).toHaveLength(2);
		expect(byBank.get("personal")).toEqual({
			mode: "turn",
			bank: "personal",
			searches: 2,
			answered: 1,
			timedOut: 1,
			failed: 0,
			slowestMs: expect.any(Number),
			fallback: false,
			rows: 2,
		});
		expect(byBank.get("project")).toEqual(
			expect.objectContaining({
				mode: "turn",
				bank: "project",
				searches: 2,
				answered: 2,
				timedOut: 0,
				failed: 0,
				fallback: false,
				rows: 2,
			}),
		);
		for (const call of lines) {
			const text = JSON.stringify(call);
			expect(text).not.toContain(message);
			expect(text).not.toContain("Personal fact");
		}
	} finally {
		info.mockRestore();
	}
}, 10_000);
/**
 * Separate core and message rankings for the share tests: the person's core
 * search ranks their entries 00-19 and the message search 20-39; the
 * project's message search ranks its entries 00-09 and its core search 10-19.
 */
function seedShareRankings() {
	const project = projectTexts(20);
	seedBankRows("bp", "personal", personalTexts);
	seedBankRows("bj", "project:p", project);
	const range = (from: number, to: number) =>
		Array.from({ length: to - from }, (_, i) => from + i);
	recall.mockImplementation(
		async (
			query: string,
			_budget: number,
			_signal: AbortSignal,
			bankId: string,
		) => {
			const core = query === CORE_MEMORY_QUERY;
			return bankId === "bp"
				? ranked("bp", personalTexts, core ? range(0, 20) : range(20, 40))
				: ranked("bj", project, core ? range(10, 20) : range(0, 10));
		},
	);
}
it.each([
	{
		corePercent: 25,
		expected: [...personalTexts.slice(0, 5), ...personalTexts.slice(20, 35)],
	},
	{
		corePercent: 50,
		expected: [...personalTexts.slice(0, 10), ...personalTexts.slice(20, 30)],
	},
])(
	"keeps the basics to their share in a personal chat (core $corePercent%)",
	async ({ corePercent, expected }) => {
		shares = { corePercent, projectPercent: 50 };
		seedShareRankings();
		const L = recallLineTokens("Personal fact 00");
		const { recallMemory } = await import("./native");
		const result = await recallMemory("u", {
			conversationId: "personal",
			query: "What should I cook tonight?",
			tokenBudget: 20 * L + N,
			core: true,
		});
		expect(result.map(({ text }) => text)).toEqual(expected);
	},
);
it.each([
	{
		chosen: { corePercent: 25, projectPercent: 50 },
		personal: [...personalTexts.slice(0, 5), ...personalTexts.slice(20, 25)],
		project: projectTexts(10),
	},
	{
		chosen: { corePercent: 50, projectPercent: 80 },
		personal: personalTexts.slice(0, 4),
		project: projectTexts(16),
	},
])(
	"gives a project chat's lanes their shares (project $chosen.projectPercent%, core $chosen.corePercent%)",
	async ({ chosen, personal, project }) => {
		shares = chosen;
		seedShareRankings();
		const L = recallLineTokens("Personal fact 00");
		const H = estimateTokenCount(RECALL_PROJECT_HEADING);
		const { recallMemory } = await import("./native");
		const result = await recallMemory("u", {
			conversationId: "c",
			query: "What should I cook tonight?",
			tokenBudget: 20 * L + H + N,
			core: true,
		});
		// Project lane, then the basics, then the message lane in turn.
		expect(result.map(({ text }) => text)).toEqual([...personal, ...project]);
	},
);
