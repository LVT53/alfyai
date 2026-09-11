import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import {
	createQueryExecutor,
	type QueryExecutor,
} from "$lib/server/db/query-executor";
import * as schema from "$lib/server/db/schema";

vi.mock("./privacy-controls", () => ({
	DETACHED_SHARED_CONTENT_OWNER_ID: "detached-shared-content-owner",
	eraseUserAccountAsAdmin: vi.fn(),
}));

const { listManagedUsers } = await import("./user-admin");

let memory: InMemoryDatabase;
let executor: QueryExecutor;

/**
 * One person who typed two questions, against a usage ledger holding seven
 * billed calls: the two that answered them plus five made on their behalf in
 * the background (the thought-step classifier, an Atlas stage, a Parallel
 * search). The Users pane has to tell those two numbers apart — "Messages"
 * and "Conversations" describe the person, tokens describe the bill.
 */
function seedOneWriterWithBackgroundSpend() {
	const now = new Date("2026-06-15T13:00:00.000Z");
	memory.db
		.insert(schema.users)
		.values({
			id: "writer-1",
			email: "writer@example.com",
			name: "Writer One",
			passwordHash: "hash",
			role: "user",
			createdAt: now,
			updatedAt: now,
		})
		.run();

	memory.db
		.insert(schema.conversations)
		.values([
			{
				id: "conv-tracked",
				userId: "writer-1",
				title: "Tracked",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "conv-incognito",
				userId: "writer-1",
				title: "Untracked",
				memoryIncognito: true,
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "conv-empty",
				userId: "writer-1",
				title: "Opened and abandoned",
				createdAt: now,
				updatedAt: now,
			},
		])
		.run();

	memory.db
		.insert(schema.messages)
		.values([
			{
				id: "ask-1",
				conversationId: "conv-tracked",
				messageSequence: 1,
				role: "user",
				content: "First question",
				createdAt: now,
			},
			{
				id: "answer-1",
				conversationId: "conv-tracked",
				messageSequence: 2,
				role: "assistant",
				content: "First answer",
				createdAt: now,
			},
			{
				id: "tool-1",
				conversationId: "conv-tracked",
				messageSequence: 3,
				role: "tool",
				content: "{}",
				createdAt: now,
			},
			{
				id: "ask-2",
				conversationId: "conv-tracked",
				messageSequence: 4,
				role: "user",
				content: "Second question",
				createdAt: now,
			},
			{
				id: "answer-2",
				conversationId: "conv-tracked",
				messageSequence: 5,
				role: "assistant",
				content: "Second answer",
				createdAt: now,
			},
			{
				id: "ask-incognito",
				conversationId: "conv-incognito",
				messageSequence: 1,
				role: "user",
				content: "Off the record",
				createdAt: now,
			},
		])
		.run();

	const usageDefaults = {
		userId: "writer-1",
		conversationId: "conv-tracked",
		promptTokens: 100,
		completionTokens: 10,
		totalTokens: 110,
		billingMonth: "2026-06",
		costUsdMicros: 1_000_000,
		createdAt: now,
	};
	memory.db
		.insert(schema.usageEvents)
		.values([
			{
				...usageDefaults,
				id: "usage-answer-1",
				messageId: "answer-1",
				modelId: "model1",
			},
			{
				...usageDefaults,
				id: "usage-answer-2",
				messageId: "answer-2",
				modelId: "model1",
			},
			{
				...usageDefaults,
				id: "usage-classifier-1",
				messageId: "turn_acknowledgment:1",
				modelId: "model2",
			},
			{
				...usageDefaults,
				id: "usage-classifier-2",
				messageId: "turn_acknowledgment:2",
				modelId: "model2",
			},
			{
				...usageDefaults,
				id: "usage-classifier-3",
				messageId: "turn_acknowledgment:3",
				modelId: "model2",
			},
			{
				...usageDefaults,
				id: "usage-atlas",
				messageId: "atlas-job-1",
				modelId: "atlas",
			},
			{
				...usageDefaults,
				id: "usage-parallel",
				messageId: "parallel:call-1",
				modelId: "parallel:turbo",
			},
		])
		.run();

	// Only the foreground turn path writes message_analytics, which is what
	// makes it the marker for "this call answered a persisted message".
	memory.db
		.insert(schema.messageAnalytics)
		.values([
			{
				id: "ma-1",
				messageId: "answer-1",
				userId: "writer-1",
				model: "model1",
				generationTimeMs: 500,
			},
			{
				id: "ma-2",
				messageId: "answer-2",
				userId: "writer-1",
				model: "model1",
				generationTimeMs: 600,
			},
		])
		.run();

	// A conversation snapshot exists for the abandoned conversation too — the
	// old count came from this table and would have reported three.
	memory.db
		.insert(schema.analyticsConversations)
		.values([
			{
				id: "ac-tracked",
				conversationId: "conv-tracked",
				userId: "writer-1",
				billingMonth: "2026-06",
				conversationCreatedAt: now,
			},
			{
				id: "ac-empty",
				conversationId: "conv-empty",
				userId: "writer-1",
				billingMonth: "2026-06",
				conversationCreatedAt: now,
			},
		])
		.run();
}

describe("listManagedUsers message and conversation counts", () => {
	beforeEach(() => {
		memory = createInMemoryDatabase();
		executor = createQueryExecutor(memory.db);
		seedOneWriterWithBackgroundSpend();
	});

	afterEach(() => {
		memory.close();
	});

	it("counts the messages the person wrote, not the calls the platform billed", async () => {
		const [row] = await listManagedUsers(executor);

		expect(row.messageCount).toBe(2);
		expect(row.modelCalls).toBe(7);
	});

	it("ignores assistant, tool and incognito rows when counting messages", async () => {
		const [row] = await listManagedUsers(executor);

		// Six message rows exist for this person; two of them are theirs and
		// tracked. The assistant replies, the tool result and the incognito
		// question are all excluded.
		expect(row.messageCount).toBe(2);
	});

	it("counts only conversations that carry at least one user message", async () => {
		const [row] = await listManagedUsers(executor);

		// Three conversations exist and two have analytics snapshots; one was
		// opened and never used, and one is incognito.
		expect(row.conversationCount).toBe(1);
	});

	it("keeps token totals wholesale over usage_events, background calls included", async () => {
		const [row] = await listManagedUsers(executor);

		expect(row.promptTokens).toBe(700);
		expect(row.completionTokens).toBe(70);
		expect(row.totalTokenCount).toBe(770);
	});

	it("names the model that answers as the favourite, not the busiest background model", async () => {
		const [row] = await listManagedUsers(executor);

		// model2 booked three calls to model1's two and still loses: none of
		// them answered a message.
		expect(row.favoriteModel).toBe("model1");
	});
});
