import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

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
		.values({
			id: "assistant-1",
			conversationId: "conv-1",
			role: "assistant",
			content: "I captured that.",
		})
		.run();

	sqlite.close();
}

describe("skill notes", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-skill-notes-${randomUUID()}.db`;
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

	it("creates a living skill_note artifact through a validated note operation", async () => {
		seedBaseData();
		const { createUserSkillDefinition } = await import("./user-skills");
		const { startSkillSession } = await import("./sessions");
		const { applySkillNoteOperations } = await import("./notes");
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

		const result = await applySkillNoteOperations({
			userId: "user-1",
			conversationId: "conv-1",
			sessionId: session.id,
			assistantMessageId: "assistant-1",
			operations: [
				{
					operationId: "note-create-1",
					kind: "note_intent",
					action: "create",
					title: "Pricing decision",
					body: "Use the short pricing plan.",
				},
			],
		});

		expect(result.applied).toHaveLength(1);
		expect(result.failures).toEqual([]);

		const [artifact] = await db
			.select()
			.from(schema.artifacts)
			.where(
				eq(schema.artifacts.id, result.applied[0]?.artifactId ?? "missing"),
			);

		expect(artifact).toMatchObject({
			userId: "user-1",
			conversationId: "conv-1",
			type: "skill_note",
			name: "Pricing decision",
			mimeType: "text/markdown",
			extension: "md",
			contentText: "Use the short pricing plan.",
		});
		expect(JSON.parse(artifact.metadataJson ?? "{}")).toMatchObject({
			source: "skill_note",
			skillSessionId: session.id,
			createdByAssistantMessageId: "assistant-1",
			lastOperationId: "note-create-1",
		});
	});

	it("replaces with a checkpoint, appends idempotently, and rejects non-note targets", async () => {
		seedBaseData();
		const { createUserSkillDefinition } = await import("./user-skills");
		const { startSkillSession } = await import("./sessions");
		const { applySkillNoteOperations } = await import("./notes");
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
			assistantMessageId: "assistant-1",
			operations: [
				{
					operationId: "note-create-1",
					kind: "note_intent",
					action: "create",
					title: "Pricing decision",
					body: "Original decision.",
				},
			],
		});
		const noteArtifactId = created.applied[0]?.artifactId ?? "missing";
		db.insert(schema.artifacts)
			.values({
				id: "uploaded-doc-1",
				userId: "user-1",
				conversationId: "conv-1",
				type: "source_document",
				name: "Uploaded notes.md",
				contentText: "Do not mutate me.",
			})
			.run();

		const updated = await applySkillNoteOperations({
			userId: "user-1",
			conversationId: "conv-1",
			sessionId: session.id,
			assistantMessageId: "assistant-1",
			operations: [
				{
					operationId: "note-replace-1",
					kind: "note_intent",
					action: "replace",
					targetArtifactId: noteArtifactId,
					body: "Replacement decision.",
				},
				{
					operationId: "note-append-1",
					kind: "note_intent",
					action: "append",
					targetArtifactId: noteArtifactId,
					body: "Follow-up entry.",
				},
				{
					operationId: "bad-replace-1",
					kind: "note_intent",
					action: "replace",
					targetArtifactId: "uploaded-doc-1",
					body: "Should not land.",
				},
			],
		});
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
					targetArtifactId: noteArtifactId,
					body: "Follow-up entry.",
				},
			],
		});

		expect(updated.applied.map((operation) => operation.action)).toEqual([
			"replace",
			"append",
		]);
		expect(updated.failures).toEqual([
			expect.objectContaining({
				operationId: "bad-replace-1",
				code: "invalid_note_target",
			}),
		]);

		const [note] = await db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, noteArtifactId));
		expect(note.contentText).toBe("Replacement decision.\n\nFollow-up entry.");

		const checkpoints = await db
			.select()
			.from(schema.skillNoteCheckpoints)
			.where(eq(schema.skillNoteCheckpoints.noteArtifactId, noteArtifactId));
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]).toMatchObject({
			previousBody: "Original decision.",
			operationId: "note-replace-1",
		});

		const [uploaded] = await db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, "uploaded-doc-1"));
		expect(uploaded.contentText).toBe("Do not mutate me.");
	});

	it("rejects oversized note operation batches before mutating any artifacts", async () => {
		seedBaseData();
		const { createUserSkillDefinition } = await import("./user-skills");
		const { startSkillSession } = await import("./sessions");
		const { applySkillNoteOperations } = await import("./notes");
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

		const result = await applySkillNoteOperations({
			userId: "user-1",
			conversationId: "conv-1",
			sessionId: session.id,
			assistantMessageId: "assistant-1",
			operations: Array.from({ length: 9 }, (_, index) => ({
				operationId: `note-create-${index}`,
				kind: "note_intent" as const,
				action: "create" as const,
				title: `Decision ${index}`,
				body: `Decision body ${index}.`,
			})),
		});

		expect(result.applied).toEqual([]);
		expect(result.failures).toEqual([
			expect.objectContaining({
				operationId: "note-create-0",
				code: "too_many_note_operations",
			}),
		]);

		const rows = await db.select().from(schema.artifacts);
		expect(rows).toEqual([]);
	});

	it("rejects oversized note bodies and final append bodies without partial mutation", async () => {
		seedBaseData();
		const { createUserSkillDefinition } = await import("./user-skills");
		const { startSkillSession } = await import("./sessions");
		const { applySkillNoteOperations } = await import("./notes");
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

		const oversizedCreate = await applySkillNoteOperations({
			userId: "user-1",
			conversationId: "conv-1",
			sessionId: session.id,
			assistantMessageId: "assistant-1",
			operations: [
				{
					operationId: "note-create-before-too-large",
					kind: "note_intent",
					action: "create",
					title: "Should not land",
					body: "This valid operation must not be partially applied.",
				},
				{
					operationId: "note-create-too-large",
					kind: "note_intent",
					action: "create",
					title: "Large note",
					body: "x".repeat(20_001),
				},
			],
		});
		expect(oversizedCreate.applied).toEqual([]);
		expect(oversizedCreate.failures).toEqual([
			expect.objectContaining({
				operationId: "note-create-too-large",
				code: "note_operation_body_too_large",
			}),
		]);
		const afterOversizedCreate = await db.select().from(schema.artifacts);
		expect(afterOversizedCreate).toEqual([]);

		const noteArtifactId = "legacy-large-note";
		db.insert(schema.artifacts)
			.values({
				id: noteArtifactId,
				userId: "user-1",
				conversationId: "conv-1",
				type: "skill_note",
				name: "Legacy large note",
				contentText: "a".repeat(49_990),
			})
			.run();
		const oversizedAppend = await applySkillNoteOperations({
			userId: "user-1",
			conversationId: "conv-1",
			sessionId: session.id,
			assistantMessageId: "assistant-1",
			operations: [
				{
					operationId: "note-append-too-large",
					kind: "note_intent",
					action: "append",
					targetArtifactId: noteArtifactId,
					body: "b".repeat(20),
				},
			],
		});

		expect(oversizedAppend.applied).toEqual([]);
		expect(oversizedAppend.failures).toEqual([
			expect.objectContaining({
				operationId: "note-append-too-large",
				code: "note_final_body_too_large",
			}),
		]);

		const [note] = await db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, noteArtifactId));
		expect(note.contentText).toBe("a".repeat(49_990));
	});

	it("stores complete rollback checkpoints instead of truncating previous note bodies", async () => {
		seedBaseData();
		const { createUserSkillDefinition } = await import("./user-skills");
		const { startSkillSession } = await import("./sessions");
		const { applySkillNoteOperations } = await import("./notes");
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
		const legacyBody = "legacy body ".repeat(4_800);
		db.insert(schema.artifacts)
			.values({
				id: "legacy-note-1",
				userId: "user-1",
				conversationId: "conv-1",
				type: "skill_note",
				name: "Legacy note",
				contentText: legacyBody,
			})
			.run();

		await applySkillNoteOperations({
			userId: "user-1",
			conversationId: "conv-1",
			sessionId: session.id,
			assistantMessageId: "assistant-1",
			operations: [
				{
					operationId: "note-replace-legacy",
					kind: "note_intent",
					action: "replace",
					targetArtifactId: "legacy-note-1",
					body: "Replacement.",
				},
			],
		});

		const checkpoints = await db
			.select()
			.from(schema.skillNoteCheckpoints)
			.where(eq(schema.skillNoteCheckpoints.noteArtifactId, "legacy-note-1"));
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]?.previousBody).toBe(legacyBody);
	});
});
