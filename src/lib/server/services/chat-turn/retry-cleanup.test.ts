import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

vi.mock("$lib/server/services/honcho", () => ({
	deleteConversationHonchoState: vi.fn(async () => undefined),
}));

let dbPath: string;

function seedBaseData() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });

	db.insert(schema.users)
		.values({ id: "user-1", email: "user-1@example.com", passwordHash: "hash" })
		.run();
	db.insert(schema.conversations)
		.values({ id: "conv-1", userId: "user-1", title: "Owned conversation" })
		.run();
	db.insert(schema.messages)
		.values([
			{
				id: "assistant-0",
				conversationId: "conv-1",
				role: "assistant",
				content: "Created note.",
			},
			{
				id: "assistant-1",
				conversationId: "conv-1",
				role: "assistant",
				content: "Updated note.",
			},
			{
				id: "assistant-2",
				conversationId: "conv-1",
				role: "assistant",
				content: "Created temporary note.",
			},
		])
		.run();

	sqlite.close();
}

describe("retry cleanup skill side effects", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-retry-cleanup-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		process.env.COMPOSER_COMMAND_REGISTRY_ENABLED = "true";
		vi.resetModules();
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
			// Temporary DB cleanup is best-effort.
		}
		delete process.env.COMPOSER_COMMAND_REGISTRY_ENABLED;
	});

	it("rolls back note replacements and removes skill milestones tied to the retried assistant message", async () => {
		seedBaseData();
		const { createUserSkillDefinition } = await import("../skills/user-skills");
		const { startSkillSession, applySkillControlOperations } = await import(
			"../skills/sessions"
		);
		const { applySkillNoteOperations } = await import("../skills/notes");
		const { cleanupFailedTurn } = await import("./retry-cleanup");
		const { db } = await import("$lib/server/db");

		const skill = await createUserSkillDefinition("user-1", {
			displayName: "Meeting critic",
			description: "Reviews notes.",
			instructions: "Capture durable decisions.",
			durationPolicy: "session",
			notesPolicy: "create_private_notes",
		});
		const session = await startSkillSession("user-1", "conv-1", {
			id: skill.id,
			ownership: "user",
			displayName: skill.displayName,
		});
		const created = await applySkillNoteOperations({
			userId: "user-1",
			conversationId: "conv-1",
			sessionId: session.id,
			assistantMessageId: "assistant-0",
			operations: [
				{
					operationId: "note-create-0",
					kind: "note_intent",
					action: "create",
					title: "Decision",
					body: "Original body.",
				},
			],
		});
		const artifactId = created.applied[0]?.artifactId ?? "missing";

		await applySkillNoteOperations({
			userId: "user-1",
			conversationId: "conv-1",
			sessionId: session.id,
			assistantMessageId: "assistant-1",
			operations: [
				{
					operationId: "note-replace-1",
					kind: "note_intent",
					action: "replace",
					targetArtifactId: artifactId,
					body: "Replacement body.",
				},
			],
		});
		await applySkillControlOperations({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			operations: [
				{
					operationId: "awaiting-user-1",
					kind: "session_transition",
					transition: "awaiting_user",
				},
			],
		});

		await cleanupFailedTurn({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
		});

		const note = await db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, artifactId))
			.get();
		const operations = await db.select().from(schema.skillNoteOperations);
		const checkpoints = await db.select().from(schema.skillNoteCheckpoints);
		const milestones = await db.select().from(schema.skillSessionMilestones);

		expect(note?.contentText).toBe("Original body.");
		expect(operations.map((operation) => operation.operationId)).toEqual([
			"note-create-0",
		]);
		expect(checkpoints).toEqual([]);
		expect(
			milestones.map((milestone) => milestone.messageParamsJson).join("\n"),
		).not.toContain("assistant-1");
	});

	it("rolls back note appends tied to the retried assistant message", async () => {
		seedBaseData();
		const { createUserSkillDefinition } = await import("../skills/user-skills");
		const { startSkillSession } = await import("../skills/sessions");
		const { applySkillNoteOperations } = await import("../skills/notes");
		const { cleanupFailedTurn } = await import("./retry-cleanup");
		const { db } = await import("$lib/server/db");

		const skill = await createUserSkillDefinition("user-1", {
			displayName: "Meeting critic",
			description: "Reviews notes.",
			instructions: "Capture durable decisions.",
			durationPolicy: "session",
			notesPolicy: "create_private_notes",
		});
		const session = await startSkillSession("user-1", "conv-1", {
			id: skill.id,
			ownership: "user",
			displayName: skill.displayName,
		});
		const created = await applySkillNoteOperations({
			userId: "user-1",
			conversationId: "conv-1",
			sessionId: session.id,
			assistantMessageId: "assistant-0",
			operations: [
				{
					operationId: "note-create-0",
					kind: "note_intent",
					action: "create",
					title: "Decision",
					body: "Original body.",
				},
			],
		});
		const artifactId = created.applied[0]?.artifactId ?? "missing";

		await applySkillNoteOperations({
			userId: "user-1",
			conversationId: "conv-1",
			sessionId: session.id,
			assistantMessageId: "assistant-1",
			operations: [
				{
					operationId: "note-append-1",
					kind: "note_intent",
					action: "append",
					targetArtifactId: artifactId,
					body: "Appended body.",
				},
			],
		});

		await cleanupFailedTurn({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
		});

		const note = await db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, artifactId))
			.get();
		const operations = await db.select().from(schema.skillNoteOperations);
		const checkpoints = await db.select().from(schema.skillNoteCheckpoints);

		expect(note?.contentText).toBe("Original body.");
		expect(operations.map((operation) => operation.operationId)).toEqual([
			"note-create-0",
		]);
		expect(checkpoints).toEqual([]);
	});

	it("restores the pre-turn note body after multiple updates in one assistant message", async () => {
		seedBaseData();
		const { createUserSkillDefinition } = await import("../skills/user-skills");
		const { startSkillSession } = await import("../skills/sessions");
		const { applySkillNoteOperations } = await import("../skills/notes");
		const { cleanupFailedTurn } = await import("./retry-cleanup");
		const { db } = await import("$lib/server/db");

		const skill = await createUserSkillDefinition("user-1", {
			displayName: "Meeting critic",
			description: "Reviews notes.",
			instructions: "Capture durable decisions.",
			durationPolicy: "session",
			notesPolicy: "create_private_notes",
		});
		const session = await startSkillSession("user-1", "conv-1", {
			id: skill.id,
			ownership: "user",
			displayName: skill.displayName,
		});
		const created = await applySkillNoteOperations({
			userId: "user-1",
			conversationId: "conv-1",
			sessionId: session.id,
			assistantMessageId: "assistant-0",
			operations: [
				{
					operationId: "note-create-0",
					kind: "note_intent",
					action: "create",
					title: "Decision",
					body: "Original body.",
				},
			],
		});
		const artifactId = created.applied[0]?.artifactId ?? "missing";

		await applySkillNoteOperations({
			userId: "user-1",
			conversationId: "conv-1",
			sessionId: session.id,
			assistantMessageId: "assistant-1",
			operations: [
				{
					operationId: "note-replace-1",
					kind: "note_intent",
					action: "replace",
					targetArtifactId: artifactId,
					body: "Replacement body.",
				},
				{
					operationId: "note-replace-2",
					kind: "note_intent",
					action: "replace",
					targetArtifactId: artifactId,
					body: "Second replacement body.",
				},
			],
		});

		await cleanupFailedTurn({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
		});

		const note = await db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, artifactId))
			.get();
		const operations = await db.select().from(schema.skillNoteOperations);
		const checkpoints = await db.select().from(schema.skillNoteCheckpoints);

		expect(note?.contentText).toBe("Original body.");
		expect(operations.map((operation) => operation.operationId)).toEqual([
			"note-create-0",
		]);
		expect(checkpoints).toEqual([]);
	});

	it("deletes skill notes created by the retried assistant message", async () => {
		seedBaseData();
		const { createUserSkillDefinition } = await import("../skills/user-skills");
		const { startSkillSession } = await import("../skills/sessions");
		const { applySkillNoteOperations } = await import("../skills/notes");
		const { cleanupFailedTurn } = await import("./retry-cleanup");
		const { db } = await import("$lib/server/db");

		const skill = await createUserSkillDefinition("user-1", {
			displayName: "Meeting critic",
			description: "Reviews notes.",
			instructions: "Capture durable decisions.",
			durationPolicy: "session",
			notesPolicy: "create_private_notes",
		});
		const session = await startSkillSession("user-1", "conv-1", {
			id: skill.id,
			ownership: "user",
			displayName: skill.displayName,
		});
		const created = await applySkillNoteOperations({
			userId: "user-1",
			conversationId: "conv-1",
			sessionId: session.id,
			assistantMessageId: "assistant-2",
			operations: [
				{
					operationId: "note-create-2",
					kind: "note_intent",
					action: "create",
					title: "Temporary decision",
					body: "Temporary body.",
				},
			],
		});
		const artifactId = created.applied[0]?.artifactId ?? "missing";

		await cleanupFailedTurn({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-2",
		});

		const note = await db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, artifactId))
			.get();
		const operations = await db.select().from(schema.skillNoteOperations);

		expect(note).toBeUndefined();
		expect(operations).toEqual([]);
	});
});
