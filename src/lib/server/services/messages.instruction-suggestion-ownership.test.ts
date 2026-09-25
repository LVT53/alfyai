/**
 * The instruction-suggestion write is the one place where a browser names, by
 * id, a row inside a conversation it does not have to own — the conversation
 * comes straight from the URL. So its ownership rules are checked against a
 * real database rather than through the mocked-drizzle seam `messages.test.ts`
 * uses: that mock's `where` ignores predicates, which means it cannot tell a
 * query scoped to the caller from one that is not scoped at all.
 *
 * Every refusal here is `null` (the route's 404 "nothing to move"), and the
 * offer's stored metadata has to be byte-identical afterwards.
 */
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import type { InstructionSuggestion } from "$lib/shared/instructions";

const OWNER = "owner-user";
const OTHER = "other-user";
const OWN_CONVERSATION = "conv-own";
const OTHER_CONVERSATION = "conv-other";
const OWN_ASSISTANT_MESSAGE = "msg-own-assistant";
const OWN_USER_MESSAGE = "msg-own-user";
const OTHER_ASSISTANT_MESSAGE = "msg-other-assistant";
const SUGGESTION_ID = "suggestion-1";

let dbPath: string;

function makeSuggestion(): InstructionSuggestion {
	return {
		id: SUGGESTION_ID,
		status: "pending",
		text: "Only suggest trains, no flights.",
		scope: { kind: "personal" },
		createdAt: 1_770_000_000_000,
	};
}

function seed() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });

	db.insert(schema.users)
		.values([
			{ id: OWNER, email: "owner@example.com", passwordHash: "hash" },
			{ id: OTHER, email: "other@example.com", passwordHash: "hash" },
		])
		.run();
	db.insert(schema.conversations)
		.values([
			{ id: OWN_CONVERSATION, userId: OWNER, title: "Owner chat" },
			{ id: OTHER_CONVERSATION, userId: OTHER, title: "Other chat" },
		])
		.run();
	db.insert(schema.messages)
		.values([
			{
				id: OWN_ASSISTANT_MESSAGE,
				conversationId: OWN_CONVERSATION,
				role: "assistant",
				content: "Should that be a standing rule?",
				metadataJson: JSON.stringify({
					instructionSuggestions: [makeSuggestion()],
				}),
			},
			{
				id: OWN_USER_MESSAGE,
				conversationId: OWN_CONVERSATION,
				role: "user",
				content: "Only suggest trains please.",
			},
			{
				id: OTHER_ASSISTANT_MESSAGE,
				conversationId: OTHER_CONVERSATION,
				role: "assistant",
				content: "Someone else's offer.",
				metadataJson: JSON.stringify({
					instructionSuggestions: [makeSuggestion()],
				}),
			},
		])
		.run();

	sqlite.close();
}

function readMetadataJson(messageId: string): string | null {
	const sqlite = new Database(dbPath);
	const db = drizzle(sqlite, { schema });
	const row = db
		.select({ metadataJson: schema.messages.metadataJson })
		.from(schema.messages)
		.where(eq(schema.messages.id, messageId))
		.get();
	sqlite.close();
	return row?.metadataJson ?? null;
}

function transition(params: {
	userId: string;
	conversationId: string;
	messageId: string;
	suggestionId?: string;
}) {
	return import("./messages").then(
		({ updateAssistantMessageInstructionSuggestionStatus }) =>
			updateAssistantMessageInstructionSuggestionStatus({
				userId: params.userId,
				conversationId: params.conversationId,
				messageId: params.messageId,
				suggestionId: params.suggestionId ?? SUGGESTION_ID,
				status: "reviewed",
			}),
	);
}

describe("updateAssistantMessageInstructionSuggestionStatus ownership", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-instruction-suggestion-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		seed();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The DB module may not have been imported if a test failed early.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Best-effort cleanup of the temporary database.
		}
	});

	it("moves the owner's own suggestion, leaving the offered text alone", async () => {
		const before = readMetadataJson(OWN_ASSISTANT_MESSAGE);

		await expect(
			transition({
				userId: OWNER,
				conversationId: OWN_CONVERSATION,
				messageId: OWN_ASSISTANT_MESSAGE,
			}),
		).resolves.toMatchObject({ id: SUGGESTION_ID, status: "reviewed" });

		const stored = JSON.parse(readMetadataJson(OWN_ASSISTANT_MESSAGE) ?? "{}");
		expect(before).not.toBe(readMetadataJson(OWN_ASSISTANT_MESSAGE));
		expect(stored.instructionSuggestions).toEqual([
			{ ...makeSuggestion(), status: "reviewed" },
		]);
	});

	it("refuses when the conversation belongs to somebody else", async () => {
		const before = readMetadataJson(OTHER_ASSISTANT_MESSAGE);

		await expect(
			transition({
				userId: OWNER,
				conversationId: OTHER_CONVERSATION,
				messageId: OTHER_ASSISTANT_MESSAGE,
			}),
		).resolves.toBeNull();

		expect(readMetadataJson(OTHER_ASSISTANT_MESSAGE)).toBe(before);
	});

	it("refuses a message from another conversation of the same user", async () => {
		const before = readMetadataJson(OTHER_ASSISTANT_MESSAGE);

		await expect(
			transition({
				userId: OTHER,
				conversationId: OWN_CONVERSATION,
				messageId: OTHER_ASSISTANT_MESSAGE,
			}),
		).resolves.toBeNull();

		expect(readMetadataJson(OTHER_ASSISTANT_MESSAGE)).toBe(before);
	});

	it("refuses a message that is not an assistant message", async () => {
		const before = readMetadataJson(OWN_USER_MESSAGE);

		await expect(
			transition({
				userId: OWNER,
				conversationId: OWN_CONVERSATION,
				messageId: OWN_USER_MESSAGE,
			}),
		).resolves.toBeNull();

		expect(readMetadataJson(OWN_USER_MESSAGE)).toBe(before);
	});

	it("refuses a suggestion id the message does not carry", async () => {
		const before = readMetadataJson(OWN_ASSISTANT_MESSAGE);

		await expect(
			transition({
				userId: OWNER,
				conversationId: OWN_CONVERSATION,
				messageId: OWN_ASSISTANT_MESSAGE,
				suggestionId: "suggestion-not-here",
			}),
		).resolves.toBeNull();

		expect(readMetadataJson(OWN_ASSISTANT_MESSAGE)).toBe(before);
	});
});
