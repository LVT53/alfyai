import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import { createRetryCleanupFixture } from "./retry-cleanup.test-helpers";

vi.mock("$lib/server/services/honcho", () => ({
	deleteConversationHonchoState: vi.fn(async () => undefined),
}));

let dbPath: string;

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
		const {
			artifactId,
			applySkillControlOperations,
			applySkillNoteOperations,
			cleanupFailedTurn,
			db,
			sessionId,
		} = await createRetryCleanupFixture(dbPath);

		await applySkillNoteOperations({
			userId: "user-1",
			conversationId: "conv-1",
			sessionId,
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

	it("preserves user attachment links while deleting generated output links", async () => {
		const { cleanupFailedTurn, db } = await createRetryCleanupFixture(dbPath, {
			createInitialNote: false,
		});

		await db
			.insert(schema.messages)
			.values({
				id: "user-with-pdf",
				conversationId: "conv-1",
				role: "user",
				content: "Summarize the PDF.",
			})
			.run();
		await db
			.insert(schema.artifacts)
			.values([
				{
					id: "source-pdf-1",
					userId: "user-1",
					conversationId: "conv-1",
					type: "source_document",
					retrievalClass: "durable",
					name: "Report.pdf",
					mimeType: "application/pdf",
				},
				{
					id: "generated-output-1",
					userId: "user-1",
					conversationId: "conv-1",
					type: "generated_output",
					retrievalClass: "durable",
					name: "Draft.pdf",
					mimeType: "application/pdf",
				},
			])
			.run();
		await db
			.insert(schema.artifactLinks)
			.values([
				{
					id: "source-link-1",
					userId: "user-1",
					artifactId: "source-pdf-1",
					conversationId: "conv-1",
					messageId: "user-with-pdf",
					linkType: "attached_to_conversation",
				},
				{
					id: "generated-link-1",
					userId: "user-1",
					artifactId: "generated-output-1",
					conversationId: "conv-1",
					messageId: "assistant-1",
					linkType: "generated_output",
				},
			])
			.run();

		await cleanupFailedTurn({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
		});

		const remainingLinks = await db
			.select()
			.from(schema.artifactLinks)
			.orderBy(schema.artifactLinks.id);

		expect(remainingLinks.map((link) => link.id)).toEqual(["source-link-1"]);
		expect(remainingLinks[0]).toMatchObject({
			artifactId: "source-pdf-1",
			messageId: "user-with-pdf",
		});
	});

	it("rolls back note appends tied to the retried assistant message", async () => {
		const {
			artifactId,
			applySkillNoteOperations,
			cleanupFailedTurn,
			db,
			sessionId,
		} = await createRetryCleanupFixture(dbPath);

		await applySkillNoteOperations({
			userId: "user-1",
			conversationId: "conv-1",
			sessionId,
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
		const {
			artifactId,
			applySkillNoteOperations,
			cleanupFailedTurn,
			db,
			sessionId,
		} = await createRetryCleanupFixture(dbPath);

		await applySkillNoteOperations({
			userId: "user-1",
			conversationId: "conv-1",
			sessionId,
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
		const { applySkillNoteOperations, cleanupFailedTurn, db, sessionId } =
			await createRetryCleanupFixture(dbPath, {
				createInitialNote: false,
			});

		const created = await applySkillNoteOperations({
			userId: "user-1",
			conversationId: "conv-1",
			sessionId,
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
