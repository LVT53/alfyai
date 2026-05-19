import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as schema from "$lib/server/db/schema";
import { messageOrderAsc } from "./message-ordering";

const semanticRefreshQueue = vi.hoisted(() => vi.fn());

vi.mock("./semantic-embedding-refresh", () => ({
	queueArtifactSemanticEmbeddingRefresh: semanticRefreshQueue,
}));

let dbPath: string;
let testStoredChatPaths: string[] = [];

function openDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

function seedTextConversation() {
	const { sqlite, db } = openDatabase();
	const now = new Date("2026-05-15T10:00:00.000Z");
	db.insert(schema.users)
		.values({
			id: "user-1",
			email: "forks@example.com",
			passwordHash: "hash",
		})
		.run();
	db.insert(schema.projects)
		.values({
			id: "project-1",
			userId: "user-1",
			name: "Forked work",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.conversations)
		.values({
			id: "source-conv",
			userId: "user-1",
			title: "Source title",
			projectId: "project-1",
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
				createdAt: new Date("2026-05-15T10:00:01.000Z"),
			},
			{
				id: "source-assistant-1",
				conversationId: "source-conv",
				role: "assistant",
				content: "Assistant answer to fork from",
				thinking: "Considered the source.",
				toolCalls: JSON.stringify([{ type: "text", content: "Considered the source." }]),
				metadataJson: JSON.stringify({
					evidenceStatus: "ready",
					evidenceSummary: {
						structuredWebSearch: false,
						groups: [
							{
								sourceType: "document",
								label: "Documents",
								reranked: false,
								items: [
									{
										id: "doc-1",
										title: "Source evidence",
										sourceType: "document",
										status: "selected",
										artifactId: "artifact-1",
										reason: "Used before fork",
									},
								],
							},
						],
					},
				}),
				createdAt: new Date("2026-05-15T10:00:02.000Z"),
			},
			{
				id: "source-user-later",
				conversationId: "source-conv",
				role: "user",
				content: "Later message excluded",
				createdAt: new Date("2026-05-15T10:00:03.000Z"),
			},
		])
		.run();
	sqlite.close();
}

function readForkRows(forkConversationId: string) {
	const { sqlite, db } = openDatabase();
	const forkConversation = db
		.select()
		.from(schema.conversations)
		.where(eq(schema.conversations.id, forkConversationId))
		.get();
	const forkMessages = db
		.select()
		.from(schema.messages)
		.where(eq(schema.messages.conversationId, forkConversationId))
		.orderBy(...messageOrderAsc())
		.all();
	const lineage = db
		.select()
		.from(schema.conversationForks)
		.where(eq(schema.conversationForks.forkConversationId, forkConversationId))
		.get();
	sqlite.close();
	return { forkConversation, forkMessages, lineage };
}

function readSideEffectCounts() {
	const { sqlite, db } = openDatabase();
	const counts = {
		usageEvents: db.select().from(schema.usageEvents).all().length,
		messageAnalytics: db.select().from(schema.messageAnalytics).all().length,
		analyticsConversations: db.select().from(schema.analyticsConversations).all().length,
		conversationSummaries: db.select().from(schema.conversationSummaries).all().length,
		taskStates: db.select().from(schema.conversationTaskStates).all().length,
		workingSetItems: db.select().from(schema.conversationWorkingSetItems).all().length,
		generatedFiles: db.select().from(schema.chatGeneratedFiles).all().length,
		fileProductionJobs: db.select().from(schema.fileProductionJobs).all().length,
		generatedArtifacts: db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.type, "generated_output"))
			.all().length,
		workCapsules: db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.type, "work_capsule"))
			.all().length,
	};
	sqlite.close();
	return counts;
}

function readMemoryEvents() {
	const { sqlite, db } = openDatabase();
	const events = db.select().from(schema.memoryEvents).all();
	sqlite.close();
	return events;
}

function readArtifactRows() {
	const { sqlite, db } = openDatabase();
	const artifacts = db.select().from(schema.artifacts).all();
	const links = db
		.select()
		.from(schema.artifactLinks)
		.orderBy(schema.artifactLinks.createdAt)
		.all();
	sqlite.close();
	return { artifacts, links };
}

function readAllForkArtifacts() {
	const { sqlite, db } = openDatabase();
	const forkConversations = db
		.select()
		.from(schema.conversations)
		.where(eq(schema.conversations.title, "Source title (fork 1)"))
		.all();
	const forkMessages = db
		.select()
		.from(schema.messages)
		.where(eq(schema.messages.conversationId, forkConversations[0]?.id ?? "missing"))
		.all();
	const forkLinks = db
		.select()
		.from(schema.artifactLinks)
		.where(eq(schema.artifactLinks.conversationId, forkConversations[0]?.id ?? "missing"))
		.all();
	sqlite.close();
	return { forkConversations, forkMessages, forkLinks };
}

function chatFilesRoot() {
	return join(process.cwd(), "data", "chat-files");
}

function writeStoredChatFile(storagePath: string, content: string) {
	const fullPath = join(chatFilesRoot(), storagePath);
	mkdirSync(dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, content);
	testStoredChatPaths.push(fullPath);
	return fullPath;
}

function trackStoredChatPath(storagePath: string | null | undefined) {
	if (!storagePath) return;
	testStoredChatPaths.push(join(chatFilesRoot(), storagePath));
}

function readStoredChatFile(storagePath: string) {
	return readFileSync(join(chatFilesRoot(), storagePath), "utf8");
}

function listStoredChatFilePaths(root = chatFilesRoot(), prefix = ""): string[] {
	if (!existsSync(root)) return [];
	const paths: string[] = [];
	for (const entry of readdirSync(root)) {
		const fullPath = join(root, entry);
		const relativePath = prefix ? `${prefix}/${entry}` : entry;
		if (statSync(fullPath).isDirectory()) {
			paths.push(...listStoredChatFilePaths(fullPath, relativePath));
		} else {
			paths.push(relativePath);
		}
	}
	return paths.sort();
}

function readGeneratedWorkRows(conversationId: string) {
	const { sqlite, db } = openDatabase();
	const generatedFiles = db
		.select()
		.from(schema.chatGeneratedFiles)
		.where(eq(schema.chatGeneratedFiles.conversationId, conversationId))
		.all();
	const fileProductionJobs = db
		.select()
		.from(schema.fileProductionJobs)
		.where(eq(schema.fileProductionJobs.conversationId, conversationId))
		.all();
	const fileProductionJobFiles = db
		.select()
		.from(schema.fileProductionJobFiles)
		.all()
		.filter((link) => fileProductionJobs.some((job) => job.id === link.jobId));
	sqlite.close();
	return { generatedFiles, fileProductionJobs, fileProductionJobFiles };
}

function readGeneratedArtifacts(conversationId: string) {
	const { sqlite, db } = openDatabase();
	const generatedArtifacts = db
		.select()
		.from(schema.artifacts)
		.where(eq(schema.artifacts.conversationId, conversationId))
		.all()
		.filter((artifact) => artifact.type === "generated_output");
	const chunks = db
		.select()
		.from(schema.artifactChunks)
		.all()
		.filter((chunk) =>
			generatedArtifacts.some((artifact) => artifact.id === chunk.artifactId),
		);
	const links = db
		.select()
		.from(schema.artifactLinks)
		.all()
		.filter((link) =>
			generatedArtifacts.some((artifact) => artifact.id === link.artifactId),
		);
	sqlite.close();
	return { generatedArtifacts, chunks, links };
}

function readForkRowsAfterFailure() {
	const { sqlite, db } = openDatabase();
	const forkConversations = db
		.select()
		.from(schema.conversations)
		.where(eq(schema.conversations.title, "Source title (fork 1)"))
		.all();
	const forkConversationIds = forkConversations.map((conversation) => conversation.id);
	const generatedFiles = db
		.select()
		.from(schema.chatGeneratedFiles)
		.all()
		.filter((file) => forkConversationIds.includes(file.conversationId));
	const fileProductionJobs = db
		.select()
		.from(schema.fileProductionJobs)
		.all()
		.filter((job) => forkConversationIds.includes(job.conversationId));
	const generatedArtifacts = db
		.select()
		.from(schema.artifacts)
		.all()
		.filter((artifact) => forkConversationIds.includes(artifact.conversationId ?? ""));
	const forkMessages = db
		.select()
		.from(schema.messages)
		.all()
		.filter((message) => forkConversationIds.includes(message.conversationId));
	sqlite.close();
	return { forkConversations, forkMessages, generatedFiles, fileProductionJobs, generatedArtifacts };
}

describe("conversation forks", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-conversation-forks-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		testStoredChatPaths = [];
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
		const storedPaths = Array.from(new Set(testStoredChatPaths));
		for (const storedPath of storedPaths) {
			try {
				rmSync(storedPath, { force: true });
			} catch {
				// Temporary chat-file cleanup is best-effort.
			}
		}
		for (const storedPath of storedPaths) {
			try {
				rmSync(dirname(storedPath), { recursive: true, force: true });
			} catch {
				// Temporary chat-file cleanup is best-effort.
			}
		}
	});

	it("creates a text-only fork through the selected assistant response with copied lineage metadata", async () => {
		seedTextConversation();
		const { createConversationFork, getConversationForkOrigin } = await import(
			"./conversation-forks"
		);

		const result = await createConversationFork({
			userId: "user-1",
			sourceConversationId: "source-conv",
			sourceMessageId: "source-assistant-1",
		});
		const { listMessages } = await import("./messages");

		expect(result.conversation).toMatchObject({
			title: "Source title (fork 1)",
			projectId: "project-1",
		});
		expect(result.forkOrigin).toMatchObject({
			sourceConversationId: "source-conv",
			sourceAssistantMessageId: "source-assistant-1",
			sourceTitle: "Source title",
			forkSequence: 1,
		});

		const { forkConversation, forkMessages, lineage } = readForkRows(
			result.conversation.id,
		);
		expect(forkConversation?.userId).toBe("user-1");
		expect(forkMessages.map((message) => message.content)).toEqual([
			"Question before fork",
			"Assistant answer to fork from",
		]);
		expect(forkMessages.map((message) => message.id)).not.toContain(
			"source-assistant-1",
		);
		expect(forkMessages[1]?.thinking).toBe("Considered the source.");
		expect(forkMessages[1]?.toolCalls).toBe(
			JSON.stringify([{ type: "text", content: "Considered the source." }]),
		);
		const copiedAssistantMetadata = JSON.parse(String(forkMessages[1]?.metadataJson));
		expect(copiedAssistantMetadata).toMatchObject({
			forkCopy: {
				sourceMessageId: "source-assistant-1",
				sourceConversationId: "source-conv",
				sourceRole: "assistant",
				sourceCreatedAt: "2026-05-15T10:00:02.000Z",
			},
			forkEvidenceSnapshot: {
				sourceMessageId: "source-assistant-1",
				sourceConversationId: "source-conv",
			},
		});
		expect(copiedAssistantMetadata.evidenceSummary).toBeUndefined();
		expect(lineage).toMatchObject({
			forkConversationId: result.conversation.id,
			sourceConversationId: "source-conv",
			sourceAssistantMessageId: "source-assistant-1",
			copiedForkPointMessageId: forkMessages[1]?.id,
			sourceTitle: "Source title",
			forkSequence: 1,
			userId: "user-1",
		});
		await expect(getConversationForkOrigin(result.conversation.id)).resolves.toMatchObject({
			copiedForkPointMessageId: forkMessages[1]?.id,
			sourceTitle: "Source title",
		});
		const listedMessages = await listMessages(result.conversation.id);
		expect(listedMessages).toMatchObject([
			{
				forkCopy: {
					sourceMessageId: "source-user-1",
					sourceConversationId: "source-conv",
				},
			},
			{
				forkCopy: {
					sourceMessageId: "source-assistant-1",
					sourceConversationId: "source-conv",
				},
				forkEvidenceSnapshot: {
					sourceMessageId: "source-assistant-1",
					sourceConversationId: "source-conv",
				},
				evidenceSummary: {
					groups: [
						expect.objectContaining({
							items: [
								expect.objectContaining({
									id: "doc-1",
									title: "Source evidence",
								}),
							],
						}),
					],
				},
			},
		]);
		const copiedAssistant = listedMessages[1];
		const { getMessageEvidenceState } = await import("./messages");
		await expect(
			getMessageEvidenceState(result.conversation.id, copiedAssistant?.id ?? ""),
		).resolves.toMatchObject({
			status: "ready",
			evidenceSummary: {
				groups: [
					expect.objectContaining({
						items: [
							expect.objectContaining({
								id: "doc-1",
								title: "Source evidence",
							}),
						],
					}),
				],
			},
			forkEvidenceSnapshot: {
				sourceMessageId: "source-assistant-1",
				sourceConversationId: "source-conv",
			},
		});
		expect(readSideEffectCounts()).toEqual({
			usageEvents: 0,
			messageAnalytics: 0,
			analyticsConversations: 0,
			conversationSummaries: 0,
			taskStates: 0,
			workingSetItems: 0,
			generatedFiles: 0,
			fileProductionJobs: 0,
			generatedArtifacts: 0,
			workCapsules: 0,
		});
		expect(readMemoryEvents()).toEqual([
			expect.objectContaining({
				eventKey: `u:user-1:conversation_fork_created:${result.conversation.id}`,
				userId: "user-1",
				conversationId: result.conversation.id,
				messageId: copiedAssistant?.id,
				domain: "conversation",
				eventType: "conversation_fork_created",
				subjectId: result.conversation.id,
				relatedId: "source-conv",
				payloadJson: expect.stringContaining('"sourceAssistantMessageId":"source-assistant-1"'),
			}),
		]);
	});

	it("copies assistant messages as passive history without inherited live metadata", async () => {
		seedTextConversation();
		const { sqlite, db } = openDatabase();
		db.update(schema.messages)
			.set({
				metadataJson: JSON.stringify({
					evidenceStatus: "pending",
					modelDisplayName: "Source Model",
					webCitationAudit: {
						status: "unsupported_citations",
						retrievedSourceCount: 1,
						citedUrlCount: 1,
						supportedCitationCount: 0,
						unsupportedCitationCount: 1,
						citations: [],
					},
					honchoContext: {
						source: "snapshot",
						waitedMs: 20,
						queuePendingWorkUnits: 0,
						queueInProgressWorkUnits: 0,
						fallbackReason: "timeout",
						snapshotCreatedAt: 123,
					},
					honchoSnapshot: {
						createdAt: 123,
						summary: "Source-only Honcho summary",
						messages: [],
					},
					skillQuestion: true,
					pendingSkillNoteIntents: [
						{
							operationId: "note-1",
							kind: "note_intent",
							action: "create",
							title: "Inherited note",
							body: "Should not remain actionable.",
						},
					],
					skillDrafts: [
						{
							id: "draft-1",
							status: "proposed",
							displayName: "Inherited draft",
							description: "Should not remain actionable.",
							instructions: "Do not save from copied history.",
							activationExamples: ["use the inherited draft"],
							durationPolicy: "next_message",
							questionPolicy: "none",
							notesPolicy: "none",
							sourceScope: "selected_sources_only",
						},
					],
					skillControl: {
						envelopeVersion: 1,
						malformedEnvelopeCount: 0,
						operations: [
							{
								operationId: "draft-op-1",
								kind: "skill_draft",
								draft: {
									id: "draft-1",
									status: "proposed",
									displayName: "Inherited draft",
									description: "Should not remain actionable.",
									instructions: "Do not save from copied history.",
									activationExamples: ["use the inherited draft"],
									durationPolicy: "next_message",
									questionPolicy: "none",
									notesPolicy: "none",
									sourceScope: "selected_sources_only",
								},
							},
						],
					},
				}),
			})
			.where(eq(schema.messages.id, "source-assistant-1"))
			.run();
		sqlite.close();
		const { createConversationFork } = await import("./conversation-forks");

		const result = await createConversationFork({
			userId: "user-1",
			sourceConversationId: "source-conv",
			sourceMessageId: "source-assistant-1",
		});
		const { forkMessages } = readForkRows(result.conversation.id);
		const copiedAssistantMetadata = JSON.parse(String(forkMessages[1]?.metadataJson));

		expect(copiedAssistantMetadata).toMatchObject({
			modelDisplayName: "Source Model",
			webCitationAudit: {
				status: "unsupported_citations",
				unsupportedCitationCount: 1,
			},
			forkCopy: {
				sourceMessageId: "source-assistant-1",
				sourceConversationId: "source-conv",
			},
		});
		expect(copiedAssistantMetadata.evidenceStatus).toBeUndefined();
		expect(copiedAssistantMetadata.evidenceSummary).toBeUndefined();
		expect(copiedAssistantMetadata.forkEvidenceSnapshot).toBeUndefined();
		expect(copiedAssistantMetadata.honchoContext).toBeUndefined();
		expect(copiedAssistantMetadata.honchoSnapshot).toBeUndefined();
		expect(copiedAssistantMetadata.skillQuestion).toBeUndefined();
		expect(copiedAssistantMetadata.pendingSkillNoteIntents).toBeUndefined();
		expect(copiedAssistantMetadata.skillDrafts).toBeUndefined();
		expect(copiedAssistantMetadata.skillControl).toBeUndefined();

		const { listMessages, getMessageEvidenceState } = await import("./messages");
		const listedMessages = await listMessages(result.conversation.id);
		expect(listedMessages[1]).toMatchObject({
			modelDisplayName: "Source Model",
			webCitationAudit: expect.objectContaining({
				status: "unsupported_citations",
			}),
			forkCopy: expect.objectContaining({
				sourceMessageId: "source-assistant-1",
			}),
		});
		expect(listedMessages[1]?.evidencePending).toBe(false);
		expect(listedMessages[1]?.honchoContext).toBeUndefined();
		expect(listedMessages[1]?.skillQuestion).toBeUndefined();
		expect(listedMessages[1]?.pendingSkillNoteIntents).toBeUndefined();
		expect(listedMessages[1]?.skillDrafts).toBeUndefined();
		expect(listedMessages[1]?.skillControl).toBeUndefined();
		await expect(
			getMessageEvidenceState(result.conversation.id, forkMessages[1]?.id ?? ""),
		).resolves.toMatchObject({
			status: "none",
			evidenceSummary: null,
		});
	});

	it("uses lineage-based fork sequencing for repeated forks from the same assistant response", async () => {
		seedTextConversation();
		const { createConversationFork } = await import("./conversation-forks");

		const firstFork = await createConversationFork({
			userId: "user-1",
			sourceConversationId: "source-conv",
			sourceMessageId: "source-assistant-1",
		});
		const { updateConversationTitle } = await import("./conversations");
		await updateConversationTitle(
			"user-1",
			firstFork.conversation.id,
			"Renamed fork",
		);
		const secondFork = await createConversationFork({
			userId: "user-1",
			sourceConversationId: "source-conv",
			sourceMessageId: "source-assistant-1",
		});

		expect(secondFork.conversation.title).toBe("Source title (fork 2)");
		expect(secondFork.forkOrigin.forkSequence).toBe(2);
	});

	it("enforces unique fork sequences per user and source assistant response", () => {
		seedTextConversation();
		const { sqlite, db } = openDatabase();
		const now = new Date("2026-05-15T10:01:00.000Z");
		db.insert(schema.conversations)
			.values([
				{
					id: "fork-conv-one",
					userId: "user-1",
					title: "Source title (fork 1)",
					createdAt: now,
					updatedAt: now,
				},
				{
					id: "fork-conv-two",
					userId: "user-1",
					title: "Source title (fork 1 duplicate)",
					createdAt: now,
					updatedAt: now,
				},
			])
			.run();
		db.insert(schema.messages)
			.values([
				{
					id: "fork-one-assistant-copy",
					conversationId: "fork-conv-one",
					role: "assistant",
					content: "Assistant answer to fork from",
					createdAt: now,
				},
				{
					id: "fork-two-assistant-copy",
					conversationId: "fork-conv-two",
					role: "assistant",
					content: "Assistant answer to fork from",
					createdAt: now,
				},
			])
			.run();
		db.insert(schema.conversationForks)
			.values({
				id: "lineage-one",
				forkConversationId: "fork-conv-one",
				userId: "user-1",
				sourceConversationId: "source-conv",
				sourceConversationIdSnapshot: "source-conv",
				sourceAssistantMessageId: "source-assistant-1",
				sourceAssistantMessageIdSnapshot: "source-assistant-1",
				copiedForkPointMessageId: "fork-one-assistant-copy",
				sourceTitle: "Source title",
				forkSequence: 1,
				createdAt: now,
			})
			.run();

		expect(() =>
			db.insert(schema.conversationForks)
				.values({
					id: "lineage-two",
					forkConversationId: "fork-conv-two",
					userId: "user-1",
					sourceConversationId: "source-conv",
					sourceConversationIdSnapshot: "source-conv",
					sourceAssistantMessageId: "source-assistant-1",
					sourceAssistantMessageIdSnapshot: "source-assistant-1",
					copiedForkPointMessageId: "fork-two-assistant-copy",
					sourceTitle: "Source title",
					forkSequence: 1,
					createdAt: now,
				})
				.run(),
		).toThrow(/unique/i);
		sqlite.close();
	});

	it("copies message attachment links onto the copied message ids without duplicating artifacts", async () => {
		seedTextConversation();
		const { sqlite, db } = openDatabase();
		db.insert(schema.artifacts)
			.values({
				id: "attachment-source-doc",
				userId: "user-1",
				conversationId: null,
				type: "source_document",
				retrievalClass: "durable",
				name: "Brief.pdf",
				mimeType: "application/pdf",
				sizeBytes: 1234,
				createdAt: new Date("2026-05-15T10:00:01.500Z"),
				updatedAt: new Date("2026-05-15T10:00:01.500Z"),
			})
			.run();
		db.insert(schema.artifactLinks)
			.values({
				id: "source-message-attachment-link",
				userId: "user-1",
				artifactId: "attachment-source-doc",
				conversationId: "source-conv",
				messageId: "source-user-1",
				linkType: "attached_to_conversation",
				createdAt: new Date("2026-05-15T10:00:01.600Z"),
			})
			.run();
		sqlite.close();
		const { createConversationFork } = await import("./conversation-forks");
		const { listMessageAttachments } = await import("./knowledge");

		const result = await createConversationFork({
			userId: "user-1",
			sourceConversationId: "source-conv",
			sourceMessageId: "source-assistant-1",
		});
		const { forkMessages } = readForkRows(result.conversation.id);
		const copiedUserMessageId = forkMessages[0]?.id ?? "";
		const forkAttachments = await listMessageAttachments(result.conversation.id);
		const { artifacts, links } = readArtifactRows();

		expect(forkAttachments.get(copiedUserMessageId)).toEqual([
			expect.objectContaining({
				artifactId: "attachment-source-doc",
				messageId: copiedUserMessageId,
				name: "Brief.pdf",
				type: "source_document",
			}),
		]);
		expect(artifacts.filter((artifact) => artifact.id === "attachment-source-doc")).toHaveLength(1);
		expect(links).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "source-message-attachment-link",
					conversationId: "source-conv",
					messageId: "source-user-1",
					artifactId: "attachment-source-doc",
				}),
				expect.objectContaining({
					conversationId: result.conversation.id,
					messageId: copiedUserMessageId,
					artifactId: "attachment-source-doc",
					linkType: "attached_to_conversation",
				}),
			]),
		);
	});

	it("fails clearly when a copied visible attachment type cannot be preserved", async () => {
		seedTextConversation();
		const { sqlite, db } = openDatabase();
		db.insert(schema.artifacts)
			.values({
				id: "source-skill-note",
				userId: "user-1",
				conversationId: "source-conv",
				type: "skill_note",
				retrievalClass: "durable",
				name: "Visible skill note",
				contentText: "A visible non-document attachment",
				createdAt: new Date("2026-05-15T10:00:01.500Z"),
				updatedAt: new Date("2026-05-15T10:00:01.500Z"),
			})
			.run();
		db.insert(schema.artifactLinks)
			.values({
				id: "source-skill-note-attachment-link",
				userId: "user-1",
				artifactId: "source-skill-note",
				conversationId: "source-conv",
				messageId: "source-user-1",
				linkType: "attached_to_conversation",
				createdAt: new Date("2026-05-15T10:00:01.600Z"),
			})
			.run();
		sqlite.close();
		const { createConversationFork } = await import("./conversation-forks");

		await expect(
			createConversationFork({
				userId: "user-1",
				sourceConversationId: "source-conv",
				sourceMessageId: "source-assistant-1",
			}),
		).rejects.toMatchObject({
			code: "required_artifact_unavailable",
			status: 409,
		});
		expect(readAllForkArtifacts()).toEqual({
			forkConversations: [],
			forkMessages: [],
			forkLinks: [],
		});
	});

	it("fails clearly when a visible generated-output attachment is not snapshotted", async () => {
		seedTextConversation();
		const { sqlite, db } = openDatabase();
		db.insert(schema.artifacts)
			.values({
				id: "source-generated-unassociated",
				userId: "user-1",
				conversationId: "source-conv",
				type: "generated_output",
				retrievalClass: "durable",
				name: "Detached generated output",
				contentText: "Generated output without fork-copy metadata",
				metadataJson: JSON.stringify({
					documentFamilyId: "detached-family",
					documentFamilyStatus: "active",
				}),
				createdAt: new Date("2026-05-15T10:00:01.500Z"),
				updatedAt: new Date("2026-05-15T10:00:01.500Z"),
			})
			.run();
		db.insert(schema.artifactLinks)
			.values({
				id: "source-detached-generated-attachment-link",
				userId: "user-1",
				artifactId: "source-generated-unassociated",
				conversationId: "source-conv",
				messageId: "source-user-1",
				linkType: "attached_to_conversation",
				createdAt: new Date("2026-05-15T10:00:01.600Z"),
			})
			.run();
		sqlite.close();
		const { createConversationFork } = await import("./conversation-forks");

		await expect(
			createConversationFork({
				userId: "user-1",
				sourceConversationId: "source-conv",
				sourceMessageId: "source-assistant-1",
			}),
		).rejects.toMatchObject({
			code: "required_generated_work_unavailable",
			status: 409,
		});
		expect(readAllForkArtifacts()).toEqual({
			forkConversations: [],
			forkMessages: [],
			forkLinks: [],
		});
	});

	it("links only fork-point-visible durable conversation documents into the fork without duplicating artifacts", async () => {
		seedTextConversation();
		const { sqlite, db } = openDatabase();
		const recentDocumentTime = new Date();
		db.insert(schema.artifacts)
			.values([
				{
					id: "source-doc-visible",
					userId: "user-1",
					conversationId: "source-conv",
					type: "source_document",
					retrievalClass: "durable",
					name: "Research packet.pdf",
					mimeType: "application/pdf",
					contentText: "Research packet source text",
					summary: "Research packet",
					createdAt: recentDocumentTime,
					updatedAt: recentDocumentTime,
				},
				{
					id: "normalized-doc-visible",
					userId: "user-1",
					conversationId: "source-conv",
					type: "normalized_document",
					retrievalClass: "durable",
					name: "Research packet",
					mimeType: "text/markdown",
					contentText: "Normalized research packet text about durable context",
					summary: "Normalized research packet",
					createdAt: recentDocumentTime,
					updatedAt: recentDocumentTime,
				},
				{
					id: "source-doc-later",
					userId: "user-1",
					conversationId: "source-conv",
					type: "source_document",
					retrievalClass: "durable",
					name: "Later packet.pdf",
					mimeType: "application/pdf",
					contentText: "Later packet source text",
					summary: "Later packet",
					createdAt: recentDocumentTime,
					updatedAt: recentDocumentTime,
				},
				{
					id: "normalized-doc-later",
					userId: "user-1",
					conversationId: "source-conv",
					type: "normalized_document",
					retrievalClass: "durable",
					name: "Later packet",
					mimeType: "text/markdown",
					contentText: "Normalized later packet text",
					summary: "Normalized later packet",
					createdAt: recentDocumentTime,
					updatedAt: recentDocumentTime,
				},
			])
			.run();
		db.insert(schema.artifactLinks)
			.values([
				{
					id: "source-conversation-source-link",
					userId: "user-1",
					artifactId: "source-doc-visible",
					conversationId: "source-conv",
					messageId: null,
					linkType: "attached_to_conversation",
					createdAt: new Date("2026-05-15T10:00:01.400Z"),
				},
				{
					id: "source-conversation-normalized-link",
					userId: "user-1",
					artifactId: "normalized-doc-visible",
					conversationId: "source-conv",
					messageId: null,
					linkType: "attached_to_conversation",
					createdAt: new Date("2026-05-15T10:00:01.500Z"),
				},
				{
					id: "normalized-derived-from-source",
					userId: "user-1",
					artifactId: "normalized-doc-visible",
					relatedArtifactId: "source-doc-visible",
					linkType: "derived_from",
					createdAt: new Date("2026-05-15T10:00:01.600Z"),
				},
				{
					id: "source-conversation-later-source-link",
					userId: "user-1",
					artifactId: "source-doc-later",
					conversationId: "source-conv",
					messageId: null,
					linkType: "attached_to_conversation",
					createdAt: new Date("2026-05-15T10:00:04.000Z"),
				},
				{
					id: "source-conversation-later-normalized-link",
					userId: "user-1",
					artifactId: "normalized-doc-later",
					conversationId: "source-conv",
					messageId: null,
					linkType: "attached_to_conversation",
					createdAt: new Date("2026-05-15T10:00:04.000Z"),
				},
				{
					id: "normalized-later-derived-from-source",
					userId: "user-1",
					artifactId: "normalized-doc-later",
					relatedArtifactId: "source-doc-later",
					linkType: "derived_from",
					createdAt: new Date("2026-05-15T10:00:04.000Z"),
				},
			])
			.run();
		sqlite.close();
		const { createConversationFork } = await import("./conversation-forks");
		const { listConversationSourceArtifactIds, refreshConversationWorkingSet } = await import(
			"./knowledge"
		);

		const result = await createConversationFork({
			userId: "user-1",
			sourceConversationId: "source-conv",
			sourceMessageId: "source-assistant-1",
		});
		const forkSourceArtifactIds = await listConversationSourceArtifactIds(
			"user-1",
			result.conversation.id,
		);
		const workingSet = await refreshConversationWorkingSet({
			userId: "user-1",
			conversationId: result.conversation.id,
			message: "Use the durable context from the research packet",
			attachmentIds: ["normalized-doc-visible", "source-doc-visible"],
		});
		const { artifacts, links } = readArtifactRows();

		expect(forkSourceArtifactIds.sort()).toEqual([
			"normalized-doc-visible",
			"source-doc-visible",
		]);
		expect(workingSet.map((artifact) => artifact.id)).toEqual(
			expect.arrayContaining(["normalized-doc-visible", "source-doc-visible"]),
		);
		expect(artifacts.filter((artifact) => artifact.id === "source-doc-visible")).toHaveLength(1);
		expect(artifacts.filter((artifact) => artifact.id === "normalized-doc-visible")).toHaveLength(1);
		expect(links).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					conversationId: result.conversation.id,
					messageId: null,
					artifactId: "source-doc-visible",
					linkType: "attached_to_conversation",
				}),
				expect.objectContaining({
					conversationId: result.conversation.id,
					messageId: null,
					artifactId: "normalized-doc-visible",
					linkType: "attached_to_conversation",
				}),
			]),
		);
	});

	it("snapshots generated file rows, bytes, and file-production jobs onto copied fork assistant messages", async () => {
		seedTextConversation();
		writeStoredChatFile("source-conv/source-file-1.txt", "fork me as bytes");
		const { sqlite, db } = openDatabase();
		db.insert(schema.chatGeneratedFiles)
			.values({
				id: "source-file-1",
				conversationId: "source-conv",
				assistantMessageId: "source-assistant-1",
				userId: "user-1",
				filename: "report.txt",
				mimeType: "text/plain",
				sizeBytes: "fork me as bytes".length,
				storagePath: "source-conv/source-file-1.txt",
				createdAt: new Date("2026-05-15T10:00:02.500Z"),
			})
			.run();
		db.insert(schema.fileProductionJobs)
			.values({
				id: "source-job-1",
				conversationId: "source-conv",
				assistantMessageId: "source-assistant-1",
				userId: "user-1",
				title: "Generated report",
				status: "succeeded",
				stage: null,
				origin: "tool",
				retryable: false,
				idempotencyKey: "source-idempotency-key",
				requestJson: JSON.stringify({ requestedOutputs: [{ filename: "report.txt" }] }),
				sourceMode: "program",
				documentIntent: "report",
				completedAt: new Date("2026-05-15T10:00:03.000Z"),
				createdAt: new Date("2026-05-15T10:00:02.100Z"),
				updatedAt: new Date("2026-05-15T10:00:03.000Z"),
			})
			.run();
		db.insert(schema.fileProductionJobFiles)
			.values({
				id: "source-job-file-1",
				jobId: "source-job-1",
				chatGeneratedFileId: "source-file-1",
				sortOrder: 0,
				createdAt: new Date("2026-05-15T10:00:03.000Z"),
			})
			.run();
		sqlite.close();
		const { createConversationFork } = await import("./conversation-forks");

		const result = await createConversationFork({
			userId: "user-1",
			sourceConversationId: "source-conv",
			sourceMessageId: "source-assistant-1",
		});
		const { forkMessages } = readForkRows(result.conversation.id);
		const copiedAssistantMessageId = forkMessages[1]?.id;
		const forkGeneratedWork = readGeneratedWorkRows(result.conversation.id);

		expect(forkGeneratedWork.generatedFiles).toEqual([
			expect.objectContaining({
				conversationId: result.conversation.id,
				assistantMessageId: copiedAssistantMessageId,
				userId: "user-1",
				filename: "report.txt",
				mimeType: "text/plain",
				sizeBytes: "fork me as bytes".length,
			}),
		]);
		const copiedFile = forkGeneratedWork.generatedFiles[0];
		trackStoredChatPath(copiedFile?.storagePath);
		expect(copiedFile?.id).not.toBe("source-file-1");
		expect(copiedFile?.storagePath).not.toBe("source-conv/source-file-1.txt");
		expect(copiedFile?.storagePath.startsWith(`${result.conversation.id}/`)).toBe(true);
		expect(readStoredChatFile(copiedFile?.storagePath ?? "")).toBe("fork me as bytes");
		expect(forkGeneratedWork.fileProductionJobs).toEqual([
			expect.objectContaining({
				conversationId: result.conversation.id,
				assistantMessageId: copiedAssistantMessageId,
				userId: "user-1",
				title: "Generated report",
				status: "succeeded",
				origin: "tool",
				sourceMode: "program",
				documentIntent: "report",
			}),
		]);
		expect(forkGeneratedWork.fileProductionJobs[0]?.id).not.toBe("source-job-1");
		expect(forkGeneratedWork.fileProductionJobs[0]?.idempotencyKey).not.toBe(
			"source-idempotency-key",
		);
		expect(forkGeneratedWork.fileProductionJobFiles).toEqual([
			expect.objectContaining({
				jobId: forkGeneratedWork.fileProductionJobs[0]?.id,
				chatGeneratedFileId: copiedFile?.id,
				sortOrder: 0,
			}),
		]);
		expect(existsSync(join(chatFilesRoot(), "source-conv/source-file-1.txt"))).toBe(true);

		const sourceCleanup = openDatabase();
		sourceCleanup.db
			.delete(schema.chatGeneratedFiles)
			.where(eq(schema.chatGeneratedFiles.id, "source-file-1"))
			.run();
		sourceCleanup.sqlite.close();
		rmSync(join(chatFilesRoot(), "source-conv/source-file-1.txt"), { force: true });
		const { getChatFiles } = await import("./chat-files");
		const { listConversationFileProductionJobs } = await import("./file-production");
		await expect(getChatFiles(result.conversation.id)).resolves.toEqual([
			expect.objectContaining({
				id: copiedFile?.id,
				conversationId: result.conversation.id,
				filename: "report.txt",
			}),
		]);
		await expect(
			listConversationFileProductionJobs("user-1", result.conversation.id),
		).resolves.toEqual([
			expect.objectContaining({
				id: forkGeneratedWork.fileProductionJobs[0]?.id,
				files: [
					expect.objectContaining({
						id: copiedFile?.id,
						filename: "report.txt",
					}),
				],
			}),
		]);
		expect(readStoredChatFile(copiedFile?.storagePath ?? "")).toBe("fork me as bytes");
	});

	it("fails clearly without creating a fork when copied history has non-terminal file-production work", async () => {
		seedTextConversation();
		const { sqlite, db } = openDatabase();
		const freshJobTime = new Date();
		db.insert(schema.fileProductionJobs)
			.values({
				id: "source-job-queued",
				conversationId: "source-conv",
				assistantMessageId: "source-assistant-1",
				userId: "user-1",
				title: "Queued report",
				status: "queued",
				stage: "rendering",
				origin: "tool",
				retryable: false,
				idempotencyKey: "source-queued-idempotency-key",
				requestJson: JSON.stringify({ requestedOutputs: [{ filename: "queued.pdf" }] }),
				sourceMode: "program",
				documentIntent: "report",
				createdAt: freshJobTime,
				updatedAt: freshJobTime,
			})
			.run();
		sqlite.close();
		const { createConversationFork } = await import("./conversation-forks");

		await expect(
			createConversationFork({
				userId: "user-1",
				sourceConversationId: "source-conv",
				sourceMessageId: "source-assistant-1",
			}),
		).rejects.toMatchObject({
			code: "required_generated_work_unavailable",
			status: 409,
		});

		expect(readForkRowsAfterFailure()).toEqual({
			forkConversations: [],
			forkMessages: [],
			generatedFiles: [],
			fileProductionJobs: [],
			generatedArtifacts: [],
		});
	});

	it("reconciles stale file-production work before fork gating", async () => {
		seedTextConversation();
		const { sqlite, db } = openDatabase();
		const staleJobTime = new Date("2026-05-03T19:43:00.000Z");
		db.insert(schema.fileProductionJobs)
			.values({
				id: "source-job-stale-queued",
				conversationId: "source-conv",
				assistantMessageId: "source-assistant-1",
				userId: "user-1",
				title: "Stale queued report",
				status: "queued",
				stage: "rendering",
				origin: "tool",
				retryable: false,
				idempotencyKey: "source-stale-queued-idempotency-key",
				requestJson: JSON.stringify({ requestedOutputs: [{ filename: "queued.pdf" }] }),
				sourceMode: "program",
				documentIntent: "report",
				createdAt: staleJobTime,
				updatedAt: staleJobTime,
			})
			.run();
		sqlite.close();
		const { createConversationFork } = await import("./conversation-forks");

		const result = await createConversationFork({
			userId: "user-1",
			sourceConversationId: "source-conv",
			sourceMessageId: "source-assistant-1",
		});
		const sourceRows = readGeneratedWorkRows("source-conv");
		const forkRows = readGeneratedWorkRows(result.conversation.id);

		expect(result.forkOrigin.forkSequence).toBe(1);
		expect(sourceRows.fileProductionJobs).toEqual([
			expect.objectContaining({
				id: "source-job-stale-queued",
				status: "failed",
				errorCode: "worker_queue_timeout",
				retryable: true,
			}),
		]);
		expect(forkRows.fileProductionJobs).toEqual([
			expect.objectContaining({
				conversationId: result.conversation.id,
				title: "Stale queued report",
				status: "failed",
				errorCode: "worker_queue_timeout",
				retryable: true,
			}),
		]);
		expect(forkRows.fileProductionJobs[0]?.id).not.toBe("source-job-stale-queued");
	});

	it("snapshots cancelled file-production jobs as terminal copied history", async () => {
		seedTextConversation();
		const { sqlite, db } = openDatabase();
		db.insert(schema.fileProductionJobs)
			.values({
				id: "source-job-cancelled",
				conversationId: "source-conv",
				assistantMessageId: "source-assistant-1",
				userId: "user-1",
				title: "Cancelled report",
				status: "cancelled",
				stage: null,
				origin: "tool",
				retryable: false,
				idempotencyKey: "source-cancelled-idempotency-key",
				requestJson: JSON.stringify({ requestedOutputs: [{ filename: "cancelled.pdf" }] }),
				sourceMode: "program",
				documentIntent: "report",
				cancelRequestedAt: new Date("2026-05-15T10:00:02.500Z"),
				completedAt: new Date("2026-05-15T10:00:03.000Z"),
				createdAt: new Date("2026-05-15T10:00:02.100Z"),
				updatedAt: new Date("2026-05-15T10:00:03.000Z"),
			})
			.run();
		sqlite.close();
		const { createConversationFork } = await import("./conversation-forks");

		const result = await createConversationFork({
			userId: "user-1",
			sourceConversationId: "source-conv",
			sourceMessageId: "source-assistant-1",
		});
		const { forkMessages } = readForkRows(result.conversation.id);
		const copiedAssistantMessageId = forkMessages[1]?.id;
		const forkGeneratedWork = readGeneratedWorkRows(result.conversation.id);

		expect(forkGeneratedWork.fileProductionJobs).toEqual([
			expect.objectContaining({
				conversationId: result.conversation.id,
				assistantMessageId: copiedAssistantMessageId,
				userId: "user-1",
				title: "Cancelled report",
				status: "cancelled",
				origin: "tool",
				sourceMode: "program",
				documentIntent: "report",
			}),
		]);
		expect(forkGeneratedWork.fileProductionJobs[0]?.id).not.toBe(
			"source-job-cancelled",
		);
		expect(forkGeneratedWork.fileProductionJobs[0]?.idempotencyKey).not.toBe(
			"source-cancelled-idempotency-key",
		);
		expect(forkGeneratedWork.generatedFiles).toEqual([]);
		expect(forkGeneratedWork.fileProductionJobFiles).toEqual([]);
	});

	it("copies generated-output artifacts into fork-local document families with origin lineage", async () => {
		seedTextConversation();
		writeStoredChatFile("source-conv/source-file-1.txt", "fork me as bytes");
		const { sqlite, db } = openDatabase();
		const createdAt = new Date("2026-05-15T10:00:02.500Z");
		db.insert(schema.chatGeneratedFiles)
			.values({
				id: "source-file-1",
				conversationId: "source-conv",
				assistantMessageId: "source-assistant-1",
				userId: "user-1",
				filename: "report.txt",
				mimeType: "text/plain",
				sizeBytes: "fork me as bytes".length,
				storagePath: "source-conv/source-file-1.txt",
				createdAt,
			})
			.run();
		db.insert(schema.artifacts)
			.values([
				{
					id: "source-generated-previous",
					userId: "user-1",
					conversationId: "source-conv",
					type: "generated_output",
					retrievalClass: "durable",
					name: "Previous report",
					mimeType: "text/plain",
					contentText: "Previous report content",
					summary: "Previous report summary",
					metadataJson: JSON.stringify({
						originalChatFileId: "source-previous-file",
						documentFamilyId: "source-family-1",
						documentFamilyStatus: "historical",
						documentLabel: "Report",
						versionNumber: 1,
						originConversationId: "source-conv",
						originAssistantMessageId: "source-previous-assistant",
						sourceChatFileId: "source-previous-file",
					}),
					createdAt: new Date("2026-05-15T09:00:00.000Z"),
					updatedAt: new Date("2026-05-15T09:00:00.000Z"),
				},
				{
					id: "source-generated-current",
					userId: "user-1",
					conversationId: "source-conv",
					type: "generated_output",
					retrievalClass: "durable",
					name: "Generated report",
					mimeType: "text/plain",
					storagePath: "source-conv/source-generated-current.bin",
					contentText: "Generated report content",
					summary: "Generated report summary",
					metadataJson: JSON.stringify({
						generatedFile: true,
						originalChatFileId: "source-file-1",
						generatedFilename: "report.txt",
						generatedMimeType: "text/plain",
						assistantMessageId: "source-assistant-1",
						documentFamilyId: "source-family-1",
						documentFamilyStatus: "active",
						documentLabel: "Report",
						documentRole: "draft",
						versionNumber: 2,
						supersedesArtifactId: "source-generated-previous",
						originConversationId: "source-conv",
						originAssistantMessageId: "source-assistant-1",
						sourceChatFileId: "source-file-1",
					}),
					createdAt,
					updatedAt: createdAt,
				},
			])
			.run();
		db.insert(schema.artifactChunks)
			.values({
				id: "source-generated-current-chunk-1",
				artifactId: "source-generated-current",
				userId: "user-1",
				conversationId: "source-conv",
				chunkIndex: 0,
				contentText: "Generated report chunk",
				tokenEstimate: 4,
				createdAt,
				updatedAt: createdAt,
			})
			.run();
		db.insert(schema.artifactLinks)
			.values([
				{
					id: "source-generated-supersedes-link",
					userId: "user-1",
					artifactId: "source-generated-current",
					relatedArtifactId: "source-generated-previous",
					conversationId: "source-conv",
					messageId: "source-assistant-1",
					linkType: "supersedes",
					createdAt,
				},
				{
					id: "source-generated-visible-link",
					userId: "user-1",
					artifactId: "source-generated-current",
					conversationId: "source-conv",
					messageId: "source-assistant-1",
					linkType: "attached_to_conversation",
					createdAt,
				},
				{
					id: "source-generated-post-fork-message-link",
					userId: "user-1",
					artifactId: "source-generated-current",
					conversationId: "source-conv",
					messageId: "source-user-later",
					linkType: "attached_to_conversation",
					createdAt: new Date("2026-05-15T10:00:03.100Z"),
				},
				{
					id: "source-generated-post-fork-conversation-link",
					userId: "user-1",
					artifactId: "source-generated-current",
					conversationId: "source-conv",
					messageId: null,
					linkType: "attached_to_conversation",
					createdAt: new Date("2026-05-15T10:00:03.200Z"),
				},
			])
			.run();
		sqlite.close();
		const { createConversationFork } = await import("./conversation-forks");

		const result = await createConversationFork({
			userId: "user-1",
			sourceConversationId: "source-conv",
			sourceMessageId: "source-assistant-1",
		});
		const { forkMessages } = readForkRows(result.conversation.id);
		const copiedAssistantMessageId = forkMessages[1]?.id;
		const forkGeneratedWork = readGeneratedWorkRows(result.conversation.id);
		const copiedChatFileId = forkGeneratedWork.generatedFiles[0]?.id;
		trackStoredChatPath(forkGeneratedWork.generatedFiles[0]?.storagePath);
		const { generatedArtifacts, chunks, links } = readGeneratedArtifacts(
			result.conversation.id,
		);

		expect(generatedArtifacts).toEqual([
			expect.objectContaining({
				userId: "user-1",
				conversationId: result.conversation.id,
				type: "generated_output",
				retrievalClass: "durable",
				name: "Generated report",
				contentText: "Generated report content",
				summary: "Generated report summary",
			}),
		]);
		const copiedArtifact = generatedArtifacts[0];
		expect(copiedArtifact?.id).not.toBe("source-generated-current");
		expect(copiedArtifact?.storagePath).toBeNull();
		const metadata = JSON.parse(String(copiedArtifact?.metadataJson));
		expect(metadata).toMatchObject({
			generatedFile: true,
			originalChatFileId: copiedChatFileId,
			generatedFilename: "report.txt",
			assistantMessageId: copiedAssistantMessageId,
			documentFamilyStatus: "active",
			documentLabel: "Report",
			documentRole: "draft",
			versionNumber: 1,
			originConversationId: result.conversation.id,
			originAssistantMessageId: copiedAssistantMessageId,
			sourceChatFileId: copiedChatFileId,
			forkedFromArtifactId: "source-generated-current",
			forkedFromChatFileId: "source-file-1",
			forkedFromConversationId: "source-conv",
			forkedFromAssistantMessageId: "source-assistant-1",
			forkedFromDocumentFamilyId: "source-family-1",
		});
		expect(metadata.documentFamilyId).toEqual(expect.any(String));
		expect(metadata.documentFamilyId).not.toBe("source-family-1");
		expect(metadata.supersedesArtifactId).toBeUndefined();
		expect(chunks).toEqual([
			expect.objectContaining({
				artifactId: copiedArtifact?.id,
				userId: "user-1",
				conversationId: result.conversation.id,
				chunkIndex: 0,
				contentText: "Generated report chunk",
				tokenEstimate: 4,
			}),
		]);
		expect(links.filter((link) => link.linkType === "supersedes")).toEqual([]);
		expect(links).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					artifactId: copiedArtifact?.id,
					conversationId: result.conversation.id,
					messageId: copiedAssistantMessageId,
					linkType: "attached_to_conversation",
				}),
			]),
		);
		expect(
			links.filter(
				(link) =>
					link.artifactId === copiedArtifact?.id &&
					link.linkType === "attached_to_conversation",
			),
		).toHaveLength(1);
		expect(semanticRefreshQueue).toHaveBeenCalledTimes(1);
		expect(semanticRefreshQueue).toHaveBeenCalledWith(
			expect.objectContaining({
				id: copiedArtifact?.id,
				userId: "user-1",
				conversationId: result.conversation.id,
				type: "generated_output",
				contentText: "Generated report content",
				metadata: expect.objectContaining({
					forkedFromArtifactId: "source-generated-current",
					originConversationId: result.conversation.id,
					originAssistantMessageId: copiedAssistantMessageId,
				}),
			}),
		);
	});

	it("does not queue semantic refresh for generated-output snapshots when the fork rolls back", async () => {
		seedTextConversation();
		writeStoredChatFile("source-conv/source-file-1.txt", "rolled back bytes");
		const { sqlite, db } = openDatabase();
		const createdAt = new Date("2026-05-15T10:00:02.500Z");
		db.insert(schema.users)
			.values({
				id: "user-2",
				email: "other@example.com",
				passwordHash: "hash",
			})
			.run();
		db.insert(schema.chatGeneratedFiles)
			.values({
				id: "source-file-1",
				conversationId: "source-conv",
				assistantMessageId: "source-assistant-1",
				userId: "user-1",
				filename: "report.txt",
				mimeType: "text/plain",
				sizeBytes: "rolled back bytes".length,
				storagePath: "source-conv/source-file-1.txt",
				createdAt,
			})
			.run();
		db.insert(schema.artifacts)
			.values([
				{
					id: "source-generated-current",
					userId: "user-1",
					conversationId: "source-conv",
					type: "generated_output",
					retrievalClass: "durable",
					name: "Generated report",
					mimeType: "text/plain",
					contentText: "Generated report content",
					metadataJson: JSON.stringify({
						originalChatFileId: "source-file-1",
						assistantMessageId: "source-assistant-1",
						documentFamilyId: "source-family-1",
						documentFamilyStatus: "active",
						originConversationId: "source-conv",
						originAssistantMessageId: "source-assistant-1",
					}),
					createdAt,
					updatedAt: createdAt,
				},
				{
					id: "other-user-source-doc",
					userId: "user-2",
					type: "source_document",
					retrievalClass: "durable",
					name: "Other.pdf",
					createdAt,
					updatedAt: createdAt,
				},
			])
			.run();
		db.insert(schema.artifactLinks)
			.values({
				id: "unauthorized-source-message-link",
				userId: "user-1",
				artifactId: "other-user-source-doc",
				conversationId: "source-conv",
				messageId: "source-user-1",
				linkType: "attached_to_conversation",
				createdAt,
			})
			.run();
		sqlite.close();
		const storedPathsBeforeFork = listStoredChatFilePaths();
		const { createConversationFork } = await import("./conversation-forks");

		await expect(
			createConversationFork({
				userId: "user-1",
				sourceConversationId: "source-conv",
				sourceMessageId: "source-assistant-1",
			}),
		).rejects.toMatchObject({
			code: "required_artifact_unauthorized",
			status: 403,
		});

		expect(semanticRefreshQueue).not.toHaveBeenCalled();
		expect(readForkRowsAfterFailure()).toEqual({
			forkConversations: [],
			forkMessages: [],
			generatedFiles: [],
			fileProductionJobs: [],
			generatedArtifacts: [],
		});
		expect(
			listStoredChatFilePaths().filter(
				(path) => !storedPathsBeforeFork.includes(path),
			),
		).toEqual([]);
	});

	it("fails clearly when binary-backed generated-output artifacts have no copied chat file", async () => {
		seedTextConversation();
		const { sqlite, db } = openDatabase();
		const createdAt = new Date("2026-05-15T10:00:02.500Z");
		db.insert(schema.artifacts)
			.values({
				id: "source-generated-binary-only",
				userId: "user-1",
				conversationId: "source-conv",
				type: "generated_output",
				retrievalClass: "durable",
				name: "Binary only generated output",
				mimeType: "application/pdf",
				storagePath: "source-conv/generated-output-only.pdf",
				metadataJson: JSON.stringify({
					assistantMessageId: "source-assistant-1",
					documentFamilyId: "source-binary-family",
					documentFamilyStatus: "active",
					originConversationId: "source-conv",
					originAssistantMessageId: "source-assistant-1",
				}),
				createdAt,
				updatedAt: createdAt,
			})
			.run();
		sqlite.close();
		const { createConversationFork } = await import("./conversation-forks");

		await expect(
			createConversationFork({
				userId: "user-1",
				sourceConversationId: "source-conv",
				sourceMessageId: "source-assistant-1",
			}),
		).rejects.toMatchObject({
			code: "required_generated_work_unavailable",
			status: 409,
		});
		expect(readForkRowsAfterFailure()).toEqual({
			forkConversations: [],
			forkMessages: [],
			generatedFiles: [],
			fileProductionJobs: [],
			generatedArtifacts: [],
		});
	});

	it("fails clearly and cleans staged generated-file copies when required binary storage is missing", async () => {
		seedTextConversation();
		writeStoredChatFile("source-conv/source-file-1.txt", "first copied bytes");
		const { sqlite, db } = openDatabase();
		db.insert(schema.chatGeneratedFiles)
			.values([
				{
					id: "source-file-1",
					conversationId: "source-conv",
					assistantMessageId: "source-assistant-1",
					userId: "user-1",
					filename: "first.txt",
					mimeType: "text/plain",
					sizeBytes: "first copied bytes".length,
					storagePath: "source-conv/source-file-1.txt",
					createdAt: new Date("2026-05-15T10:00:02.100Z"),
				},
				{
					id: "source-file-2",
					conversationId: "source-conv",
					assistantMessageId: "source-assistant-1",
					userId: "user-1",
					filename: "missing.txt",
					mimeType: "text/plain",
					sizeBytes: 12,
					storagePath: "source-conv/missing-file.txt",
					createdAt: new Date("2026-05-15T10:00:02.200Z"),
				},
			])
			.run();
		sqlite.close();
		const storedPathsBeforeFork = listStoredChatFilePaths();
		const { createConversationFork } = await import("./conversation-forks");

		await expect(
			createConversationFork({
				userId: "user-1",
				sourceConversationId: "source-conv",
				sourceMessageId: "source-assistant-1",
			}),
		).rejects.toMatchObject({
			code: "required_generated_work_unavailable",
			status: 409,
		});

		expect(readForkRowsAfterFailure()).toEqual({
			forkConversations: [],
			forkMessages: [],
			generatedFiles: [],
			fileProductionJobs: [],
			generatedArtifacts: [],
		});
		expect(
			listStoredChatFilePaths().filter(
				(path) => !storedPathsBeforeFork.includes(path),
			),
		).toEqual([]);
		expect(readStoredChatFile("source-conv/source-file-1.txt")).toBe("first copied bytes");
	});

	it("fails clearly and rolls back when a visible copied attachment is not owned by the user", async () => {
		seedTextConversation();
		const { sqlite, db } = openDatabase();
		db.insert(schema.users)
			.values({
				id: "user-2",
				email: "other@example.com",
				passwordHash: "hash",
			})
			.run();
		db.insert(schema.artifacts)
			.values([
				{
					id: "valid-source-doc",
					userId: "user-1",
					type: "source_document",
					retrievalClass: "durable",
					name: "Valid.pdf",
					createdAt: new Date(),
					updatedAt: new Date(),
				},
				{
					id: "other-user-source-doc",
					userId: "user-2",
					type: "source_document",
					retrievalClass: "durable",
					name: "Other.pdf",
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			])
			.run();
		db.insert(schema.artifactLinks)
			.values([
				{
					id: "valid-source-message-link",
					userId: "user-1",
					artifactId: "valid-source-doc",
					conversationId: "source-conv",
					messageId: "source-user-1",
					linkType: "attached_to_conversation",
					createdAt: new Date(),
				},
				{
					id: "unauthorized-source-message-link",
					userId: "user-1",
					artifactId: "other-user-source-doc",
					conversationId: "source-conv",
					messageId: "source-user-1",
					linkType: "attached_to_conversation",
					createdAt: new Date(),
				},
			])
			.run();
		sqlite.close();
		const { createConversationFork } = await import("./conversation-forks");

		await expect(
			createConversationFork({
				userId: "user-1",
				sourceConversationId: "source-conv",
				sourceMessageId: "source-assistant-1",
			}),
		).rejects.toMatchObject({
			code: "required_artifact_unauthorized",
			status: 403,
		});
		expect(readAllForkArtifacts()).toEqual({
			forkConversations: [],
			forkMessages: [],
			forkLinks: [],
		});
	});

	it("fails clearly and rolls back when a visible copied attachment artifact is missing", async () => {
		seedTextConversation();
		const { sqlite, db } = openDatabase();
		sqlite.pragma("foreign_keys = OFF");
		db.insert(schema.artifactLinks)
			.values({
				id: "missing-source-message-link",
				userId: "user-1",
				artifactId: "missing-source-doc",
				conversationId: "source-conv",
				messageId: "source-user-1",
				linkType: "attached_to_conversation",
				createdAt: new Date(),
			})
			.run();
		sqlite.pragma("foreign_keys = ON");
		sqlite.close();
		const { createConversationFork } = await import("./conversation-forks");

		await expect(
			createConversationFork({
				userId: "user-1",
				sourceConversationId: "source-conv",
				sourceMessageId: "source-assistant-1",
			}),
		).rejects.toMatchObject({
			code: "required_artifact_unavailable",
			status: 409,
		});
		expect(readAllForkArtifacts()).toEqual({
			forkConversations: [],
			forkMessages: [],
			forkLinks: [],
		});
	});

	it("lists child forks by source assistant message and fork summaries by conversation", async () => {
		seedTextConversation();
		const {
			createConversationFork,
			getConversationForkSummaries,
			listChildForksBySourceMessages,
		} = await import("./conversation-forks");

		const firstFork = await createConversationFork({
			userId: "user-1",
			sourceConversationId: "source-conv",
			sourceMessageId: "source-assistant-1",
		});
		const secondFork = await createConversationFork({
			userId: "user-1",
			sourceConversationId: "source-conv",
			sourceMessageId: "source-assistant-1",
		});

		const childForks = await listChildForksBySourceMessages("user-1", [
			"source-assistant-1",
			"missing-message",
		]);
		expect(childForks).toEqual({
			"source-assistant-1": {
				count: 2,
				forks: [
					expect.objectContaining({
						conversationId: firstFork.conversation.id,
						title: "Source title (fork 1)",
						forkSequence: 1,
					}),
					expect.objectContaining({
						conversationId: secondFork.conversation.id,
						title: "Source title (fork 2)",
						forkSequence: 2,
					}),
				],
			},
		});

		const summaries = await getConversationForkSummaries("user-1", [
			firstFork.conversation.id,
			"source-conv",
		]);
		expect(summaries.get(firstFork.conversation.id)).toMatchObject({
			sourceTitle: "Source title",
			forkSequence: 1,
			sourceConversationId: "source-conv",
			sourceConversationIdAvailable: true,
		});
		expect(summaries.has("source-conv")).toBe(false);
	});

	it("preserves a fork with snapshot origin when the source conversation is deleted", async () => {
		seedTextConversation();
		const {
			createConversationFork,
			getConversationForkOrigin,
			listChildForksBySourceMessages,
		} = await import("./conversation-forks");
		const { deleteConversationWithCleanup } = await import("./cleanup");
		const { getConversation } = await import("./conversations");

		const fork = await createConversationFork({
			userId: "user-1",
			sourceConversationId: "source-conv",
			sourceMessageId: "source-assistant-1",
		});

		await expect(
			deleteConversationWithCleanup("user-1", "source-conv"),
		).resolves.toMatchObject({
			deletedArtifactIds: [],
			preservedArtifactIds: [],
		});

		await expect(
			getConversation("user-1", fork.conversation.id),
		).resolves.toMatchObject({
			id: fork.conversation.id,
			title: "Source title (fork 1)",
		});
		await expect(getConversationForkOrigin(fork.conversation.id)).resolves.toMatchObject({
			sourceConversationId: "source-conv",
			sourceAssistantMessageId: "source-assistant-1",
			sourceConversationIdAvailable: false,
			sourceAssistantMessageIdAvailable: false,
			sourceTitle: "Source title",
		});
		await expect(
			listChildForksBySourceMessages("user-1", ["source-assistant-1"]),
		).resolves.toEqual({});
	});

	it("removes fork lineage when deleting the fork without mutating the source transcript", async () => {
		seedTextConversation();
		const {
			createConversationFork,
			getConversationForkOrigin,
			listChildForksBySourceMessages,
		} = await import("./conversation-forks");
		const { deleteConversationWithCleanup } = await import("./cleanup");
		const { listMessages } = await import("./messages");

		const fork = await createConversationFork({
			userId: "user-1",
			sourceConversationId: "source-conv",
			sourceMessageId: "source-assistant-1",
		});
		const sourceBeforeDelete = await listMessages("source-conv");

		await expect(
			deleteConversationWithCleanup("user-1", fork.conversation.id),
		).resolves.toMatchObject({
			deletedArtifactIds: [],
			preservedArtifactIds: [],
		});

		await expect(getConversationForkOrigin(fork.conversation.id)).resolves.toBeNull();
		await expect(
			listChildForksBySourceMessages("user-1", ["source-assistant-1"]),
		).resolves.toEqual({});
		await expect(listMessages("source-conv")).resolves.toEqual(sourceBeforeDelete);
	});

	it("rejects user, empty, and stopped assistant messages as fork points", async () => {
		seedTextConversation();
		const { sqlite, db } = openDatabase();
		db.insert(schema.messages)
			.values([
				{
					id: "source-empty-assistant",
					conversationId: "source-conv",
					role: "assistant",
					content: "   ",
					createdAt: new Date("2026-05-15T10:00:04.000Z"),
				},
				{
					id: "source-stopped-assistant",
					conversationId: "source-conv",
					role: "assistant",
					content: "Partial stopped answer",
					metadataJson: JSON.stringify({ wasStopped: true }),
					createdAt: new Date("2026-05-15T10:00:05.000Z"),
				},
			])
			.run();
		sqlite.close();
		const { createConversationFork } = await import("./conversation-forks");
		const { listMessages } = await import("./messages");

		await expect(
			createConversationFork({
				userId: "user-1",
				sourceConversationId: "source-conv",
				sourceMessageId: "source-user-1",
			}),
		).rejects.toMatchObject({ code: "invalid_source_message" });
		await expect(
			createConversationFork({
				userId: "user-1",
				sourceConversationId: "source-conv",
				sourceMessageId: "source-empty-assistant",
			}),
		).rejects.toMatchObject({ code: "empty_source_message" });
		await expect(
			createConversationFork({
				userId: "user-1",
				sourceConversationId: "source-conv",
				sourceMessageId: "source-stopped-assistant",
			}),
		).rejects.toMatchObject({ code: "stopped_source_message" });
		expect(readMemoryEvents()).toEqual([]);
		const stoppedMessage = (await listMessages("source-conv")).find(
			(message) => message.id === "source-stopped-assistant",
		);
		expect(stoppedMessage).toMatchObject({ wasStopped: true });
		expect(stoppedMessage?.renderKey).toBeUndefined();
	});
});
