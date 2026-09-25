import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import { messageOrderAsc } from "./message-ordering";

// copyMetadata's rule under test (see conversation-forks.ts): projectFilesRead
// is derived from the same evidence summary it is written alongside (see
// readProjectFilesReadFromMetadata in messages.ts and countProjectFilesRead in
// message-evidence.ts), so a forked message's count must travel with its
// evidenceSummary — never survive on its own once the summary is dropped or
// relocated into forkEvidenceSnapshot.

const semanticRefreshQueue = vi.hoisted(() => vi.fn());

vi.mock("./semantic-embedding-refresh", () => ({
	queueArtifactSemanticEmbeddingRefresh: semanticRefreshQueue,
}));

let dbPath: string;

function openDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

function validEvidenceSummary() {
	return {
		structuredWebSearch: false,
		groups: [
			{
				sourceType: "document",
				label: "Documents",
				reranked: false,
				items: [
					{
						id: "doc-1",
						title: "Project file",
						sourceType: "document",
						status: "selected",
						artifactId: "artifact-1",
					},
				],
			},
		],
	};
}

/**
 * Seeds one user + one source conversation with a user message followed by
 * the assistant message tests fork from. Metadata for each message is
 * caller-supplied so each test isolates exactly the fields copyMetadata's
 * rule depends on (role and evidenceSummary shape), matching the pattern in
 * conversation-forks.test.ts.
 */
function seedConversation(options: {
	projectId: string | null;
	userMetadata?: Record<string, unknown>;
	assistantMetadata?: Record<string, unknown>;
}) {
	const { sqlite, db } = openDatabase();
	const now = new Date("2026-05-15T10:00:00.000Z");
	db.insert(schema.users)
		.values({
			id: "user-1",
			email: "forks-project-files@example.com",
			passwordHash: "hash",
		})
		.run();
	if (options.projectId) {
		db.insert(schema.projects)
			.values({
				id: options.projectId,
				userId: "user-1",
				name: "Forked project",
				createdAt: now,
				updatedAt: now,
			})
			.run();
	}
	db.insert(schema.conversations)
		.values({
			id: "source-conv",
			userId: "user-1",
			title: "Source title",
			projectId: options.projectId,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.messages)
		.values([
			{
				id: "source-user-1",
				conversationId: "source-conv",
				role: "user",
				content: "Question before fork",
				metadataJson: options.userMetadata
					? JSON.stringify(options.userMetadata)
					: null,
				createdAt: new Date("2026-05-15T10:00:01.000Z"),
			},
			{
				id: "source-assistant-1",
				conversationId: "source-conv",
				role: "assistant",
				content: "Assistant answer to fork from",
				metadataJson: options.assistantMetadata
					? JSON.stringify(options.assistantMetadata)
					: null,
				createdAt: new Date("2026-05-15T10:00:02.000Z"),
			},
		])
		.run();
	sqlite.close();
}

function readCopiedMetadata(forkConversationId: string) {
	const { sqlite, db } = openDatabase();
	const forkMessages = db
		.select()
		.from(schema.messages)
		.where(eq(schema.messages.conversationId, forkConversationId))
		.orderBy(...messageOrderAsc())
		.all();
	sqlite.close();
	return {
		user: JSON.parse(String(forkMessages[0]?.metadataJson ?? "{}")),
		assistant: JSON.parse(String(forkMessages[1]?.metadataJson ?? "{}")),
	};
}

describe("conversation forks — project files read count travels with the evidence summary", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-conversation-forks-pfr-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		semanticRefreshQueue.mockReset();
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
	});

	it("drops the project files read count when forked into a conversation with no project", async () => {
		seedConversation({
			projectId: null,
			assistantMetadata: {
				evidenceStatus: "ready",
				evidenceSummary: validEvidenceSummary(),
				projectFilesRead: 3,
			},
		});
		const { createConversationFork } = await import("./conversation-forks");

		const result = await createConversationFork({
			userId: "user-1",
			sourceConversationId: "source-conv",
			sourceMessageId: "source-assistant-1",
		});

		expect(result.conversation.projectId).toBeNull();
		const { assistant } = readCopiedMetadata(result.conversation.id);
		// The summary is re-keyed into forkEvidenceSnapshot, same as
		// conversation-forks.test.ts already covers.
		expect(assistant.forkEvidenceSnapshot).toMatchObject({
			sourceMessageId: "source-assistant-1",
			evidenceSummary: { groups: expect.any(Array) },
		});
		expect(assistant.evidenceSummary).toBeUndefined();
		// The count describes the same turn as the summary it was written
		// alongside; once the summary is relocated off the live key, a stale
		// count must not survive with it and misreport this turn's answer as
		// having consulted a project this conversation no longer has.
		expect(assistant.projectFilesRead).toBeUndefined();
	});

	it("keeps the project files read count wherever copyMetadata leaves the evidence summary itself in place", async () => {
		seedConversation({
			projectId: "project-1",
			// copyMetadata only relocates evidenceSummary for assistant messages;
			// a user message's evidenceSummary is copied through unchanged under
			// the live key, so its count must travel with it rather than being
			// unconditionally stripped.
			userMetadata: {
				evidenceSummary: validEvidenceSummary(),
				projectFilesRead: 2,
			},
		});
		const { createConversationFork } = await import("./conversation-forks");

		const result = await createConversationFork({
			userId: "user-1",
			sourceConversationId: "source-conv",
			sourceMessageId: "source-assistant-1",
		});

		const { user } = readCopiedMetadata(result.conversation.id);
		expect(user.evidenceSummary).toMatchObject({ groups: expect.any(Array) });
		expect(user.projectFilesRead).toBe(2);
	});

	it("leaves a message with no project files read count unchanged by the fork", async () => {
		seedConversation({
			projectId: "project-1",
			assistantMetadata: {
				evidenceStatus: "ready",
				evidenceSummary: validEvidenceSummary(),
				// No projectFilesRead: this turn read zero project files, which the
				// app represents as an absent field rather than a 0 (see
				// readProjectFilesReadFromMetadata in messages.ts).
			},
		});
		const { createConversationFork } = await import("./conversation-forks");

		const result = await createConversationFork({
			userId: "user-1",
			sourceConversationId: "source-conv",
			sourceMessageId: "source-assistant-1",
		});

		const { assistant } = readCopiedMetadata(result.conversation.id);
		expect(assistant.forkEvidenceSnapshot).toBeDefined();
		expect(assistant.projectFilesRead).toBeUndefined();
	});
});
