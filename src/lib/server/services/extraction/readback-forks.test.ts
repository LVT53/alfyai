// OQ9: can forking a conversation collide on the ledger's unique index over
// `chat_generated_file_id`?
//
// The spec's answer is no, because a fork mints new chat-file ids and rewrites
// the copied artifact's `originalChatFileId` to point at them. That is an
// answer about someone else's module, so it is pinned here rather than
// asserted in prose: if `conversation-forks.ts` ever starts reusing a source
// file id, or starts copying ledger rows, this test fails instead of a
// production insert.

import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import { parseJsonRecord } from "$lib/server/utils/json";
import {
	createLedgerFixture,
	type LedgerFixture,
} from "./testing/ledger-fixtures";

vi.mock("$lib/server/services/semantic-embedding-refresh", () => ({
	queueArtifactSemanticEmbeddingRefresh: vi.fn(),
}));

let fixture: LedgerFixture;
let chatFilesDir: string;

const userId = "user-1";
const sourceConversationId = "source-conv";
const sourceFileId = "source-file-1";
const assistantMessageId = "source-assistant-1";

beforeEach(async () => {
	fixture = createLedgerFixture("readback-forks");
	fixture.seedUser(userId);
	fixture.seedConversation(sourceConversationId, userId);
	fixture.sqlite
		.prepare(
			`INSERT INTO messages (id, conversation_id, role, content, created_at)
			 VALUES ('source-user-1', ?, 'user', 'Make me a report', 1000),
			        (?, ?, 'assistant', 'Here is the report.', 2000)`,
		)
		.run(sourceConversationId, assistantMessageId, sourceConversationId);

	chatFilesDir = join(
		process.cwd(),
		"data",
		"chat-files",
		sourceConversationId,
	);
	await mkdir(chatFilesDir, { recursive: true });
	await writeFile(join(chatFilesDir, `${sourceFileId}.pdf`), "bytes", "utf8");

	fixture.sqlite
		.prepare(
			`INSERT INTO chat_generated_files
			 (id, conversation_id, assistant_message_id, user_id, filename, mime_type, size_bytes, storage_path, created_at)
			 VALUES (?, ?, ?, ?, 'report.pdf', 'application/pdf', 5, ?, 2100)`,
		)
		.run(
			sourceFileId,
			sourceConversationId,
			assistantMessageId,
			userId,
			join(sourceConversationId, `${sourceFileId}.pdf`),
		);

	fixture.db
		.insert(schema.artifacts)
		.values({
			id: "artifact-source",
			userId,
			conversationId: sourceConversationId,
			type: "generated_output",
			name: "report.pdf",
			mimeType: "text/markdown",
			extension: "md",
			contentText: "Generated file: report.pdf",
			metadataJson: JSON.stringify({
				generatedFile: true,
				originalChatFileId: sourceFileId,
				assistantMessageId,
				generatedFilename: "report.pdf",
				versionNumber: 1,
			}),
			createdAt: new Date("2026-09-20T09:00:00.000Z"),
			updatedAt: new Date("2026-09-20T09:00:00.000Z"),
		})
		.run();

	process.env.DATABASE_PATH = fixture.dbPath;
	vi.resetModules();
});

afterEach(async () => {
	fixture.cleanup();
	await rm(join(process.cwd(), "data", "chat-files", sourceConversationId), {
		recursive: true,
		force: true,
	});
	vi.restoreAllMocks();
});

describe("forking a conversation whose generated file is still being read back", () => {
	it("gives the copy its own file id, so the ledger's unique index cannot collide", async () => {
		const ledger = await import("./job-ledger");
		const { job: sourceJob } = await ledger.enqueueExtractionJob({
			userId,
			conversationId: sourceConversationId,
			origin: "generated_file_readback",
			intakeRoute: "mineru",
			fileName: "report.pdf",
			mimeType: "application/pdf",
			sizeBytes: 5,
			chatGeneratedFileId: sourceFileId,
			priority: 10,
		});

		const { createConversationFork } = await import("../conversation-forks");
		const fork = await createConversationFork({
			userId,
			sourceConversationId,
			sourceMessageId: assistantMessageId,
		});
		const forkConversationId = fork.conversation.id;

		const copiedFiles = fixture.db
			.select()
			.from(schema.chatGeneratedFiles)
			.where(eq(schema.chatGeneratedFiles.conversationId, forkConversationId))
			.all();
		expect(copiedFiles).toHaveLength(1);
		const copiedFileId = copiedFiles[0].id;
		expect(copiedFileId).not.toBe(sourceFileId);

		// The fork copies files and artifacts; it does not copy ledger rows.
		const jobsAfterFork = fixture.db
			.select()
			.from(schema.documentExtractionJobs)
			.all();
		expect(jobsAfterFork).toHaveLength(1);
		expect(jobsAfterFork[0].chatGeneratedFileId).toBe(sourceFileId);

		// The copied artifact points at the copied file, so a readback queued for
		// the fork lands on the fork's own artifact, never the source's.
		const copiedArtifact = fixture.db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.conversationId, forkConversationId))
			.all()
			.find((row) => row.type === "generated_output");
		expect(
			parseJsonRecord(copiedArtifact?.metadataJson ?? null)?.originalChatFileId,
		).toBe(copiedFileId);

		// The insert the unique index would refuse if the ids were shared.
		const { job: forkJob } = await ledger.enqueueExtractionJob({
			userId,
			conversationId: forkConversationId,
			origin: "generated_file_readback",
			intakeRoute: "mineru",
			fileName: "report.pdf",
			mimeType: "application/pdf",
			sizeBytes: 5,
			chatGeneratedFileId: copiedFileId,
			priority: 10,
		});
		expect(forkJob.id).not.toBe(sourceJob.id);
		expect(
			fixture.db.select().from(schema.documentExtractionJobs).all(),
		).toHaveLength(2);
	});

	it("keeps the unique index on the ONE job per chat file", async () => {
		const ledger = await import("./job-ledger");
		const first = await ledger.enqueueExtractionJob({
			userId,
			conversationId: sourceConversationId,
			origin: "generated_file_readback",
			intakeRoute: "mineru",
			fileName: "report.pdf",
			mimeType: "application/pdf",
			sizeBytes: 5,
			chatGeneratedFileId: sourceFileId,
			priority: 10,
		});
		const second = await ledger.enqueueExtractionJob({
			userId,
			conversationId: sourceConversationId,
			origin: "generated_file_readback",
			intakeRoute: "mineru",
			fileName: "report.pdf",
			mimeType: "application/pdf",
			sizeBytes: 5,
			chatGeneratedFileId: sourceFileId,
			priority: 10,
		});

		expect(second.reused).toBe(true);
		expect(second.job.id).toBe(first.job.id);
		expect(() =>
			fixture.sqlite
				.prepare(
					`INSERT INTO document_extraction_jobs
					 (id, user_id, conversation_id, chat_generated_file_id, origin, intake_route, file_name, status, created_at, updated_at)
					 VALUES (?, ?, ?, ?, 'generated_file_readback', 'mineru', 'report.pdf', 'queued', 1, 1)`,
				)
				.run(randomUUID(), userId, sourceConversationId, sourceFileId),
		).toThrow(/UNIQUE/);
	});
});
