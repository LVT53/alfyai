import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let sqlite: Database.Database;
const enqueue = vi.fn(
	async (_input: { runAfter?: Date; [key: string]: unknown }) => ({
		id: "job",
	}),
);
vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));
vi.mock("./delivery-job", () => ({
	enqueueMemoryMutation: async (
		prepare: (tx: unknown) => Array<Record<string, unknown>>,
	) => {
		const inputs = drizzle(sqlite, { schema }).transaction((tx) => prepare(tx));
		return Promise.all(inputs.map((input) => enqueue(input)));
	},
}));
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-11-18T20:00:00Z"));
	enqueue.mockClear();
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
		.values({ id: "p", userId: "u", name: "Project" })
		.run();
	db.insert(schema.conversations)
		.values({ id: "c", title: "chat", userId: "u", projectId: "p" })
		.run();
	db.insert(schema.messages)
		.values([
			{
				id: "m",
				conversationId: "c",
				role: "user",
				content: "I prefer short replies.",
				messageSequence: 1,
			},
			{
				id: "a",
				conversationId: "c",
				role: "assistant",
				content: "You own a green kayak.",
				messageSequence: 2,
			},
		])
		.run();
});
afterEach(() => {
	sqlite.close();
	vi.useRealTimers();
});
describe("native chat ingestion", () => {
	it("keeps project preferences in the project and assistant content as labeled context", async () => {
		const { deliverCompletedMemoryTurn, captureMemoryTurnAcceptance } =
			await import("./chat-delivery");
		await deliverCompletedMemoryTurn({
			memoryAcceptance: captureMemoryTurnAcceptance("u", "c"),
			userId: "u",
			conversationId: "c",
			userMessageId: "m",
			assistantMessageId: "a",
		});
		const db = drizzle(sqlite, { schema });
		const sources = db.select().from(schema.memorySourceRevisions).all();
		expect(sources).toHaveLength(1);
		expect(sources[0].text).toBe("I prefer short replies.");
		expect(sources[0].context).toContain('"role":"assistant"');
		expect(db.select().from(schema.memoryBanks).get()?.scopeKey).toBe(
			"project:p",
		);
		await deliverCompletedMemoryTurn({
			memoryAcceptance: captureMemoryTurnAcceptance("u", "c"),
			userId: "u",
			conversationId: "c",
			userMessageId: "m",
			assistantMessageId: "a",
		});
		expect(db.select().from(schema.memorySourceRevisions).all()).toHaveLength(
			1,
		);
	});
	it("does not ingest missing assistant receipts, copied forks or unknown accounts", async () => {
		const { deliverCompletedMemoryTurn, captureMemoryTurnAcceptance } =
			await import("./chat-delivery");
		await deliverCompletedMemoryTurn({
			memoryAcceptance: captureMemoryTurnAcceptance("u", "c"),
			userId: "u",
			conversationId: "c",
			userMessageId: "m",
			assistantMessageId: "missing",
		});
		drizzle(sqlite, { schema })
			.update(schema.messages)
			.set({
				metadataJson: JSON.stringify({
					forkCopy: { sourceMessageId: "original" },
				}),
			})
			.run();
		await deliverCompletedMemoryTurn({
			memoryAcceptance: captureMemoryTurnAcceptance("u", "c"),
			userId: "u",
			conversationId: "c",
			userMessageId: "m",
			assistantMessageId: "a",
		});
		await deliverCompletedMemoryTurn({
			memoryAcceptance: captureMemoryTurnAcceptance("u", "c"),
			userId: "other",
			conversationId: "c",
			userMessageId: "m",
			assistantMessageId: "a",
		});
		expect(
			drizzle(sqlite, { schema })
				.select()
				.from(schema.memorySourceRevisions)
				.all(),
		).toHaveLength(0);
	});
	it("uses explicit deleted message identity for an edit and never guesses by sequence", async () => {
		const {
			deliverCompletedMemoryTurn,
			revokeDeletedMemoryMessages,
			captureMemoryTurnAcceptance,
		} = await import("./chat-delivery");
		await deliverCompletedMemoryTurn({
			memoryAcceptance: captureMemoryTurnAcceptance("u", "c"),
			userId: "u",
			conversationId: "c",
			userMessageId: "m",
			assistantMessageId: "a",
		});
		await revokeDeletedMemoryMessages(["m"], { editSourceMessageId: "m" });
		expect(enqueue.mock.calls.at(-1)?.[0].runAfter?.getTime()).toBeGreaterThan(
			Date.now(),
		);
		const db = drizzle(sqlite, { schema });
		db.insert(schema.messages)
			.values([
				{
					id: "edited",
					conversationId: "c",
					role: "user",
					content: "Use long replies.",
					messageSequence: 50,
				},
				{
					id: "edited-reply",
					conversationId: "c",
					role: "assistant",
					content: "",
					messageSequence: 51,
				},
			])
			.run();
		await deliverCompletedMemoryTurn({
			memoryAcceptance: captureMemoryTurnAcceptance("u", "c"),
			userId: "u",
			conversationId: "c",
			userMessageId: "edited",
			assistantMessageId: "edited-reply",
			turnOrigin: "edit_resend",
			editSourceMessageId: "m",
		});
		const sources = db.select().from(schema.memorySourceRevisions).all();
		const edited = sources.find((s) => s.messageId === "edited");
		expect(edited?.lineageId).toBe("m");
		expect(edited?.explicitEditAt).not.toBeNull();
	});
	it("revokes admitted source immediately when messages are deleted", async () => {
		const {
			deliverCompletedMemoryTurn,
			revokeDeletedMemoryMessages,
			captureMemoryTurnAcceptance,
		} = await import("./chat-delivery");
		await deliverCompletedMemoryTurn({
			memoryAcceptance: captureMemoryTurnAcceptance("u", "c"),
			userId: "u",
			conversationId: "c",
			userMessageId: "m",
			assistantMessageId: "a",
		});
		await revokeDeletedMemoryMessages(["m"]);
		expect(
			drizzle(sqlite, { schema })
				.select()
				.from(schema.memorySourceRevisions)
				.get()?.state,
		).toBe("revoked");
	});
});

it("does not learn a turn admitted while off after controls are reenabled", async () => {
	const db = drizzle(sqlite, { schema });
	db.update(schema.users).set({ memoryEnabled: false }).run();
	const { captureMemoryTurnAcceptance, deliverCompletedMemoryTurn } =
		await import("./chat-delivery");
	const stamp = captureMemoryTurnAcceptance("u", "c");
	db.update(schema.users).set({ memoryEnabled: true }).run();
	await deliverCompletedMemoryTurn({
		userId: "u",
		conversationId: "c",
		userMessageId: "m",
		assistantMessageId: "a",
		memoryAcceptance: stamp,
	});
	expect(db.select().from(schema.memorySourceRevisions).all()).toEqual([]);
});
it("does not rehome a delayed project turn into personal memory", async () => {
	const db = drizzle(sqlite, { schema });
	const { captureMemoryTurnAcceptance, deliverCompletedMemoryTurn } =
		await import("./chat-delivery");
	const stamp = captureMemoryTurnAcceptance("u", "c");
	db.update(schema.conversations).set({ projectId: null }).run();
	await deliverCompletedMemoryTurn({
		userId: "u",
		conversationId: "c",
		userMessageId: "m",
		assistantMessageId: "a",
		memoryAcceptance: stamp,
	});
	expect(db.select().from(schema.memorySourceRevisions).all()).toEqual([]);
});

it("bounds context eligibility work to preceding message dependencies in a large bank", async () => {
	const db = drizzle(sqlite, { schema });
	const { ensureMemoryBank } = await import("./revisions");
	const bank = ensureMemoryBank("u", { kind: "project", projectId: "p" });
	db.insert(schema.messages)
		.values({
			id: "preceding",
			conversationId: "c",
			role: "user",
			content: "Earlier statement",
			messageSequence: 0,
		})
		.run();
	const rows = Array.from({ length: 501 }, (_, i) => ({
		id: `bulk-${i}`,
		userId: "u",
		bankId: bank.id,
		epoch: 0,
		eventId: `bulk-${i}`,
		lineageId: `bulk-${i}`,
		messageId: i === 0 ? "preceding" : `unrelated-${i}`,
		text: "Earlier statement",
		context: "",
		textHash: "hash",
		assertedAt: new Date(),
		state: "accepted",
	}));
	for (let i = 0; i < rows.length; i += 100)
		db.insert(schema.memorySourceRevisions)
			.values(rows.slice(i, i + 100))
			.run();
	const policy = await import("./history-eligibility");
	const eligibility = vi
		.spyOn(policy, "isHistoricalMemorySourceEligible")
		.mockResolvedValue(true);
	const { captureMemoryTurnAcceptance, deliverCompletedMemoryTurn } =
		await import("./chat-delivery");
	await deliverCompletedMemoryTurn({
		userId: "u",
		conversationId: "c",
		userMessageId: "m",
		assistantMessageId: "a",
		memoryAcceptance: captureMemoryTurnAcceptance("u", "c"),
	});
	expect(eligibility).toHaveBeenCalledTimes(1);
	eligibility.mockRestore();
});
