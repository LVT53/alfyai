import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import {
	createQueryExecutor,
	type QueryExecutor,
} from "$lib/server/db/query-executor";
import * as schema from "$lib/server/db/schema";
import {
	clearConversationDraft,
	getConversationDraft,
	upsertConversationDraft,
} from "./conversation-drafts";

let memory: InMemoryDatabase;
let executor: QueryExecutor;

function seedConversation() {
	memory.db
		.insert(schema.users)
		.values({ id: "user-1", email: "user-1@example.com", passwordHash: "hash" })
		.run();
	memory.db
		.insert(schema.conversations)
		.values({ id: "conv-1", userId: "user-1", title: "Draft test" })
		.run();
}

describe("conversation drafts", () => {
	beforeEach(() => {
		memory = createInMemoryDatabase();
		executor = createQueryExecutor(memory.db);
	});

	afterEach(() => {
		memory.close();
	});

	it("round-trips full pending skill selection metadata", async () => {
		seedConversation();

		await upsertConversationDraft(
			{
				userId: "user-1",
				conversationId: "conv-1",
				draftText: "Use this variant later",
				selectedAttachmentIds: [],
				selectedLinkedSources: [],
				pendingSkill: {
					id: "variant-1",
					ownership: "user",
					skillKind: "skill_variant",
					displayName: "Daily workbook variant",
					baseSkillId: "system:spreadsheet-builder",
					baseSkillDisplayName: "Spreadsheet Builder",
					unavailable: true,
				},
			},
			executor,
		);

		await expect(
			getConversationDraft("user-1", "conv-1", executor),
		).resolves.toMatchObject({
			pendingSkill: {
				id: "variant-1",
				ownership: "user",
				skillKind: "skill_variant",
				displayName: "Daily workbook variant",
				baseSkillId: "system:spreadsheet-builder",
				baseSkillDisplayName: "Spreadsheet Builder",
				unavailable: true,
			},
		});
	});

	it("clears a draft when the update leaves nothing meaningful behind", async () => {
		seedConversation();

		await upsertConversationDraft(
			{
				userId: "user-1",
				conversationId: "conv-1",
				draftText: "Something in progress",
				selectedAttachmentIds: [],
			},
			executor,
		);
		await expect(
			getConversationDraft("user-1", "conv-1", executor),
		).resolves.not.toBeNull();

		await upsertConversationDraft(
			{
				userId: "user-1",
				conversationId: "conv-1",
				draftText: "",
				selectedAttachmentIds: [],
			},
			executor,
		);

		await expect(
			getConversationDraft("user-1", "conv-1", executor),
		).resolves.toBeNull();
	});

	it("clearConversationDraft removes a stored draft", async () => {
		seedConversation();

		await upsertConversationDraft(
			{
				userId: "user-1",
				conversationId: "conv-1",
				draftText: "Draft to clear",
				selectedAttachmentIds: [],
			},
			executor,
		);
		await expect(
			getConversationDraft("user-1", "conv-1", executor),
		).resolves.not.toBeNull();

		await clearConversationDraft("user-1", "conv-1", executor);

		await expect(
			getConversationDraft("user-1", "conv-1", executor),
		).resolves.toBeNull();
	});
});
