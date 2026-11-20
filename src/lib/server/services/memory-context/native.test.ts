import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

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
							recall(query, budget, signal),
						list: () => list(),
					},
	};
});
beforeEach(() => {
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

it("bounds native recall and rechecks revocation when the timed-out call returns", async () => {
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
			}),
		).toEqual([]);
		expect(timeout).toHaveBeenCalledWith(2000);
	} finally {
		timeout.mockRestore();
	}
});

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
it("rejects a combined recall if off-on changes control revision during native ranking", async () => {
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
		}),
	).toEqual([]);
});

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
	{ change: "no change", hold: "capability", allowedPosts: 2 },
	{ change: "off and on", hold: "capability", allowedPosts: 0 },
	{ change: "incognito", hold: "capability", allowedPosts: 0 },
	{ change: "project move", hold: "first recall", allowedPosts: 1 },
] as const)(
	"checks permission at the private recall dispatch ($change during $hold)",
	async ({ change, hold, allowedPosts }) => {
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
		const sentQueries: unknown[] = [];
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
			sentQueries.push(JSON.parse(String(init?.body)).query);
			if (sentQueries.length === 1 && hold === "first recall") {
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
		expect(sentQueries).toEqual(Array(allowedPosts).fill(query));
		expect(capabilities).toBe(change === "no change" ? 2 : 1);
		expect(recalled.map(({ text }) => text).sort()).toEqual(
			change === "no change" ? ["Personal preference", "Project decision"] : [],
		);
	},
);

it.each([
	"exact",
	"partial",
	"mixed",
	"hidden split",
	"late revoke",
	"new generation",
	"wrong direct support",
	"changed native raw",
] as const)(
	"uses only a unique currently admitted Edit result for replacement native ranks (%s)",
	async (mode) => {
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
		list.mockResolvedValue([
			{
				id: "native-new-id",
				fact_type: "observation",
				text: "Malicious native claim and quotation",
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
					id: mode === "wrong direct support" ? "n-b1" : "native-new-id",
					fact_type: "observation",
					text:
						mode === "wrong direct support"
							? "Accepted purple kayak"
							: "Malicious native claim and quotation",
					source_memory_ids:
						mode === "mixed"
							? ["f-b1", "not-admitted"]
							: mode === "wrong direct support"
								? ["wrong-raw"]
								: ["f-b1"],
				},
			];
		});
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
