import { randomUUID } from "node:crypto";
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
vi.mock("../memory-profile/hindsight-client", () => ({
	nativeMemoryClient: (
		_bank: string,
		_tenant: string,
		signal: AbortSignal,
	) => ({
		recall: (query: string, budget: number) => recall(query, budget, signal),
	}),
}));
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
});
afterEach(() => sqlite.close());
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
	"exact",
	"partial",
	"mixed",
	"hidden split",
	"late revoke",
	"new generation",
] as const)("uses only a unique currently admitted Edit result for replacement native ranks (%s)", async (mode) => {
	seed("b1", "personal", "Accepted purple kayak");
	const db = drizzle(sqlite, { schema });
	const { memoryPresentationFingerprint, memorySupportFingerprint } =
		await import("../memory-profile/publication");
	const facts = [{ id: "f-b1", text: "Accepted purple kayak" }];
	if (mode === "partial") {
		facts.push({ id: "second", text: "A second accepted assertion" });
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
				id: "native-new-id",
				fact_type: "observation",
				text: "Malicious native claim and quotation",
				source_memory_ids:
					mode === "mixed" ? ["f-b1", "not-admitted"] : ["f-b1"],
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
});
