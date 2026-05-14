import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import * as schema from "$lib/server/db/schema";

let dbPath: string;

function seedBaseData() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });

	db.insert(schema.users)
		.values([
			{ id: "user-1", email: "user-1@example.com", passwordHash: "hash" },
			{ id: "user-2", email: "user-2@example.com", passwordHash: "hash" },
		])
		.run();

	db.insert(schema.conversations)
		.values([
			{ id: "conv-1", userId: "user-1", title: "Owned conversation" },
			{ id: "conv-2", userId: "user-2", title: "Other conversation" },
		])
		.run();

	sqlite.close();
}

describe("skill sessions", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-skill-sessions-${randomUUID()}.db`;
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

	it("starts one durable active session per conversation with an immutable skill snapshot", async () => {
		seedBaseData();
		const { createUserSkillDefinition, updateUserSkillDefinition } = await import("./user-skills");
		const { getActiveSkillSession, serializePublicSkillSession, startSkillSession } =
			await import("./sessions");

		const skill = await createUserSkillDefinition("user-1", {
			displayName: "Meeting critic",
			description: "Reviews notes.",
			instructions: "Find weak claims and missing owners.",
			activationExamples: ["review these notes"],
			durationPolicy: "session",
			questionPolicy: "ask_when_needed",
			notesPolicy: "create_private_notes",
			sourceScope: "selected_sources_only",
		});

		const started = await startSkillSession("user-1", "conv-1", {
			id: skill.id,
			ownership: "user",
			displayName: "Meeting critic",
		});
		const repeated = await startSkillSession("user-1", "conv-1", {
			id: skill.id,
			ownership: "user",
			displayName: "Meeting critic",
		});

		expect(repeated.id).toBe(started.id);
		expect(started).toMatchObject({
			userId: "user-1",
			conversationId: "conv-1",
			skillId: skill.id,
			skillOwnership: "user",
			status: "active",
			skillDisplayName: "Meeting critic",
			skillDescription: "Reviews notes.",
			skillInstructions: "Find weak claims and missing owners.",
			activationExamples: ["review these notes"],
			durationPolicy: "session",
			questionPolicy: "ask_when_needed",
			notesPolicy: "create_private_notes",
			sourceScope: "selected_sources_only",
			skillVersion: 1,
			startedFrom: "pending_skill",
			milestones: [
				expect.objectContaining({
					kind: "started",
					messageKey: "skillSessions.milestones.started",
				}),
			],
		});

		await updateUserSkillDefinition("user-1", skill.id, {
			displayName: "Meeting critic v2",
			instructions: "Changed instructions.",
		});

		await expect(getActiveSkillSession("user-1", "conv-1")).resolves.toMatchObject({
			id: started.id,
			status: "active",
			skillDisplayName: "Meeting critic",
			skillInstructions: "Find weak claims and missing owners.",
			skillVersion: 1,
		});

		const publicSession = serializePublicSkillSession(started);
		expect(publicSession).toMatchObject({
			id: started.id,
			skillDisplayName: "Meeting critic",
		});
		expect(publicSession).not.toHaveProperty("skillInstructions");
	});

	it("enforces ownership, feature flag, unavailable skill pause, and end milestones", async () => {
		seedBaseData();
		const { createUserSkillDefinition, updateUserSkillDefinition } = await import("./user-skills");
		const { endSkillSession, getActiveSkillSession, startSkillSession } = await import("./sessions");

		const skill = await createUserSkillDefinition("user-1", {
			displayName: "Interview coach",
			description: "Asks follow-up questions.",
			instructions: "Ask short questions first.",
		});

		await expect(
			startSkillSession("user-2", "conv-1", {
				id: skill.id,
				ownership: "user",
				displayName: skill.displayName,
			}),
		).rejects.toMatchObject({ code: "conversation_not_found", status: 404 });

		const started = await startSkillSession("user-1", "conv-1", {
			id: skill.id,
			ownership: "user",
			displayName: skill.displayName,
		});

		process.env.COMPOSER_COMMAND_REGISTRY_ENABLED = "false";
		vi.resetModules();
		const disabledModule = await import("./sessions");
		await expect(
			disabledModule.startSkillSession("user-1", "conv-1", {
				id: skill.id,
				ownership: "user",
				displayName: skill.displayName,
			}),
		).rejects.toMatchObject({ code: "skill_sessions_disabled", status: 403 });

		process.env.COMPOSER_COMMAND_REGISTRY_ENABLED = "true";
		vi.resetModules();
		const { getActiveSkillSession: getAfterFlagReset, endSkillSession: endAfterFlagReset } =
			await import("./sessions");

		await updateUserSkillDefinition("user-1", skill.id, { enabled: false });
		const paused = await getAfterFlagReset("user-1", "conv-1");
		expect(paused).toMatchObject({
			id: started.id,
			status: "paused",
			pauseReason: "unavailable",
			milestones: expect.arrayContaining([
				expect.objectContaining({
					kind: "unavailable",
					messageKey: "skillSessions.milestones.unavailable",
				}),
			]),
		});

		const ended = await endAfterFlagReset("user-1", "conv-1", "dismissed");
		expect(ended).toMatchObject({
			id: started.id,
			status: "ended",
			endReason: "dismissed",
			milestones: expect.arrayContaining([
				expect.objectContaining({
					kind: "dismissed",
					messageKey: "skillSessions.milestones.dismissed",
				}),
			]),
		});

		await expect(getActiveSkillSession("user-1", "conv-1")).resolves.toBeNull();
	});

	it("applies Skill Control Envelope transitions once per operation id", async () => {
		seedBaseData();
		const { createUserSkillDefinition } = await import("./user-skills");
		const { applySkillControlOperations, getActiveSkillSession, startSkillSession } =
			await import("./sessions");

		const skill = await createUserSkillDefinition("user-1", {
			displayName: "Interview coach",
			description: "Asks follow-up questions.",
			instructions: "Ask short questions first.",
			questionPolicy: "ask_when_needed",
		});
		const started = await startSkillSession("user-1", "conv-1", {
			id: skill.id,
			ownership: "user",
			displayName: skill.displayName,
		});

		await applySkillControlOperations({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			operations: [
				{
					operationId: "ask-deadline",
					kind: "session_transition",
					transition: "awaiting_user",
				},
			],
		});
		await applySkillControlOperations({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-1",
			operations: [
				{
					operationId: "ask-deadline",
					kind: "session_transition",
					transition: "awaiting_user",
				},
			],
		});

		const session = await getActiveSkillSession("user-1", "conv-1");
		expect(session).toMatchObject({
			id: started.id,
			status: "active",
			milestones: expect.arrayContaining([
				expect.objectContaining({
					kind: "awaiting_user",
					messageKey: "skillSessions.milestones.awaitingUser",
					messageParams: expect.objectContaining({
						envelopeOperationId: "ask-deadline",
						assistantMessageId: "assistant-1",
					}),
				}),
			]),
		});
		expect(
			session?.milestones.filter(
				(milestone) =>
					milestone.messageParams.envelopeOperationId === "ask-deadline",
			),
		).toHaveLength(1);
	});

	it("maps terminal Skill Control Envelope transitions to ended sessions", async () => {
		seedBaseData();
		const { createUserSkillDefinition } = await import("./user-skills");
		const { applySkillControlOperations, getActiveSkillSession, startSkillSession } =
			await import("./sessions");

		const skill = await createUserSkillDefinition("user-1", {
			displayName: "Planner",
			description: "Plans work.",
			instructions: "Keep the plan moving.",
		});
		const started = await startSkillSession("user-1", "conv-1", {
			id: skill.id,
			ownership: "user",
			displayName: skill.displayName,
		});

		const ended = await applySkillControlOperations({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "assistant-2",
			operations: [
				{
					operationId: "finish-session",
					kind: "session_transition",
					transition: "finished",
				},
			],
		});

		expect(ended).toMatchObject({
			id: started.id,
			status: "ended",
			endReason: "ended",
			milestones: expect.arrayContaining([
				expect.objectContaining({
					kind: "ended",
					messageParams: expect.objectContaining({
						envelopeOperationId: "finish-session",
					}),
				}),
			]),
		});
		await expect(getActiveSkillSession("user-1", "conv-1")).resolves.toBeNull();
	});
});
