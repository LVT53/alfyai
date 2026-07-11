import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "$lib/server/db/schema";
import { createAccountDataArchive } from "./index";

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

let tempDir: string;
let sqlite: Database.Database;
let db: TestDb;

async function seedArchiveUser() {
	const passwordHash = await bcrypt.hash("correct-password", 4);
	await db.insert(schema.users).values({
		id: "user-1",
		email: "user@example.com",
		passwordHash,
		name: "Archive User",
		role: "user",
		preferredModel: "model1",
		theme: "light",
		titleLanguage: "en",
		uiLanguage: "en",
		profilePicture: "avatar",
		createdAt: new Date("2026-01-01T10:00:00Z"),
		updatedAt: new Date("2026-01-02T10:00:00Z"),
	});
	await db.insert(schema.users).values({
		id: "user-2",
		email: "other@example.com",
		passwordHash,
		name: "Other User",
	});

	await mkdir(join(tempDir, "data", "avatars"), { recursive: true });
	await writeFile(join(tempDir, "data", "avatars", "user-1.webp"), "avatar");

	await db.insert(schema.conversations).values([
		{
			id: "conv-1",
			userId: "user-1",
			title: "Quarterly Roadmap Planning",
			createdAt: new Date("2026-02-01T10:00:00Z"),
			updatedAt: new Date("2026-02-02T10:00:00Z"),
		},
		{
			id: "conv-other",
			userId: "user-2",
			title: "Other Conversation",
		},
	]);
	await db.insert(schema.messages).values([
		{
			id: "msg-user",
			conversationId: "conv-1",
			messageSequence: 1,
			role: "user",
			content: "Plan the Q3 launch.",
			createdAt: new Date("2026-02-01T10:01:00Z"),
		},
		{
			id: "msg-assistant",
			conversationId: "conv-1",
			messageSequence: 2,
			role: "assistant",
			content: "Use a staged rollout with customer interviews.",
			thinking: "hidden chain of thought",
			toolCalls: '{"private":true}',
			metadataJson: '{"diagnostic":true}',
			importSource: "chatgpt",
			createdAt: new Date("2026-02-01T10:02:00Z"),
		},
		{
			id: "msg-system",
			conversationId: "conv-1",
			messageSequence: 3,
			role: "system",
			content: "Hidden system context.",
			createdAt: new Date("2026-02-01T10:03:00Z"),
		},
	]);
	await db.insert(schema.importJobs).values({
		id: "import-1",
		userId: "user-1",
		status: "completed",
		totalConversations: 1,
		processedConversations: 1,
		createdAt: new Date("2026-02-01T09:00:00Z"),
		updatedAt: new Date("2026-02-01T09:05:00Z"),
	});

	await mkdir(join(tempDir, "data", "knowledge", "user-1"), {
		recursive: true,
	});
	await writeFile(
		join(tempDir, "data", "knowledge", "user-1", "roadmap-notes.txt"),
		"Original uploaded roadmap file.",
	);
	await db.insert(schema.artifacts).values([
		{
			id: "artifact-upload",
			userId: "user-1",
			type: "source_document",
			name: "roadmap-notes.txt",
			mimeType: "text/plain",
			extension: "txt",
			sizeBytes: 31,
			storagePath: "data/knowledge/user-1/roadmap-notes.txt",
			contentText: "Readable uploaded notes.",
			summary: "Roadmap upload",
			createdAt: new Date("2026-02-01T11:00:00Z"),
			updatedAt: new Date("2026-02-01T11:00:00Z"),
		},
		{
			id: "artifact-note",
			userId: "user-1",
			type: "skill_note",
			name: "Decision Log",
			contentText: "Decision: stage the launch.",
			summary: "Launch decision",
			createdAt: new Date("2026-02-01T12:00:00Z"),
			updatedAt: new Date("2026-02-01T12:00:00Z"),
		},
		{
			id: "artifact-other",
			userId: "user-2",
			type: "source_document",
			name: "other.txt",
			contentText: "Other user content.",
		},
	]);

	await mkdir(join(tempDir, "data", "chat-files", "conv-1"), {
		recursive: true,
	});
	await writeFile(
		join(tempDir, "data", "chat-files", "conv-1", "file-1.md"),
		"# Roadmap summary\n",
	);
	await db.insert(schema.chatGeneratedFiles).values({
		id: "file-1",
		conversationId: "conv-1",
		assistantMessageId: "msg-assistant",
		userId: "user-1",
		filename: "roadmap-summary.md",
		mimeType: "text/markdown",
		sizeBytes: 18,
		storagePath: "conv-1/file-1.md",
		createdAt: new Date("2026-02-01T10:04:00Z"),
	});

	await db.insert(schema.conversationTaskStates).values({
		taskId: "task-1",
		userId: "user-1",
		conversationId: "conv-1",
		status: "active",
		objective: "Prepare Q3 launch plan",
		decisionsJson: '["Run customer interviews"]',
		nextStepsJson: '["Draft rollout checklist"]',
		createdAt: new Date("2026-02-01T12:10:00Z"),
		updatedAt: new Date("2026-02-01T12:10:00Z"),
	});
	await db.insert(schema.memoryEvents).values({
		id: "memory-event-1",
		eventKey: "memory-event-1",
		userId: "user-1",
		conversationId: "conv-1",
		domain: "task",
		eventType: "decision_recorded",
		subjectId: "task-1",
		observedAt: new Date("2026-02-01T12:15:00Z"),
		payloadJson: '{"summary":"Customer interviews are required."}',
		createdAt: new Date("2026-02-01T12:15:00Z"),
	});

	await db.insert(schema.userSkillDefinitions).values({
		id: "skill-1",
		userId: "user-1",
		ownership: "user",
		skillKind: "user_skill",
		displayName: "Meeting Notes",
		description: "Capture meeting decisions.",
		instructions: "Write concise action notes.",
		notesPolicy: "create_private_notes",
		createdAt: new Date("2026-02-01T13:00:00Z"),
		updatedAt: new Date("2026-02-01T13:00:00Z"),
	});

	await db.insert(schema.analyticsConversations).values({
		id: "analytics-conv-1",
		conversationId: "conv-1",
		userId: "user-1",
		title: "Quarterly Roadmap Planning",
		source: "live",
		billingMonth: "2026-02",
		conversationCreatedAt: new Date("2026-02-01T10:00:00Z"),
	});
	await db.insert(schema.usageEvents).values({
		id: "usage-1",
		userId: "user-1",
		conversationId: "conv-1",
		messageId: "msg-assistant",
		modelId: "model1",
		modelDisplayName: "Alfy Default",
		providerDisplayName: "Local",
		promptTokens: 100,
		completionTokens: 40,
		totalTokens: 140,
		billingMonth: "2026-02",
		costUsdMicros: 12345,
	});
}

async function seedAtlasArchiveOutput() {
	await writeFile(
		join(tempDir, "data", "chat-files", "conv-1", "atlas-report.html"),
		"<h1>Atlas market report</h1>",
	);
	await db.insert(schema.chatGeneratedFiles).values({
		id: "atlas-file-html",
		conversationId: "conv-1",
		assistantMessageId: "msg-assistant",
		userId: "user-1",
		filename: "atlas-market-report.html",
		mimeType: "text/html",
		sizeBytes: 28,
		storagePath: "conv-1/atlas-report.html",
		createdAt: new Date("2026-02-01T10:05:00Z"),
	});
	await db.insert(schema.atlasJobs).values({
		id: "atlas-job-1",
		userId: "user-1",
		conversationId: "conv-1",
		assistantMessageId: "msg-assistant",
		action: "create",
		profile: "overview",
		normalizedQueryHash: "hash-atlas",
		clientAtlasTurnId: "client-atlas-1",
		idempotencyKey:
			"atlas:v1:user-1:conv-1:create:root:overview:hash-atlas:client-atlas-1",
		title: "Atlas market report",
		status: "succeeded",
		stage: "complete",
		htmlChatGeneratedFileId: "atlas-file-html",
		completedAt: new Date("2026-02-01T10:06:00Z"),
		createdAt: new Date("2026-02-01T10:05:00Z"),
		updatedAt: new Date("2026-02-01T10:06:00Z"),
	});
	await db.insert(schema.atlasRoundCheckpoints).values({
		id: "atlas-checkpoint-1",
		jobId: "atlas-job-1",
		roundNumber: 1,
		stage: "synthesize",
		checkpointJson: '{"raw":"DO_NOT_EXPORT_ATLAS_CHECKPOINT"}',
		curatedSourcePoolJson: '[{"raw":"DO_NOT_EXPORT_ATLAS_SOURCE_POOL"}]',
		compressedFindingsJson: '{"raw":"DO_NOT_EXPORT_ATLAS_FINDINGS"}',
		qualityDiagnosticsJson: '{"raw":"DO_NOT_EXPORT_ATLAS_DIAGNOSTICS"}',
		createdAt: new Date("2026-02-01T10:05:30Z"),
		updatedAt: new Date("2026-02-01T10:05:30Z"),
	});
}

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "alfyai-archive-test-"));
	sqlite = new Database(join(tempDir, "test.db"));
	sqlite.pragma("foreign_keys = ON");
	db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
});

afterEach(async () => {
	sqlite.close();
	await rm(tempDir, { recursive: true, force: true });
});

describe("createAccountDataArchive", () => {
	it("creates a human-readable archive for the signed-in user only", async () => {
		await seedArchiveUser();

		const result = await createAccountDataArchive("user-1", {
			password: "correct-password",
			db,
			rootDir: tempDir,
			now: new Date("2026-06-15T08:00:00Z"),
		});

		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		expect(result.filename).toBe("AlfyAI Data Archive 2026-06-15.zip");

		const zipBytes = Buffer.from(
			await new Response(result.zipStream).arrayBuffer(),
		);
		const zip = await JSZip.loadAsync(zipBytes);
		expect(Object.keys(zip.files)[0]).toBe("Open AlfyAI Data Archive.html");
		expect(zip.file("Open AlfyAI Data Archive.html")).toBeTruthy();
		expect(zip.file("Profile/Profile.html")).toBeTruthy();
		expect(zip.file("Profile/avatar.webp")).toBeTruthy();

		const entry = await zip
			.file("Open AlfyAI Data Archive.html")
			?.async("string");
		expect(entry).toContain("Account Data Archive");
		expect(entry).toContain("--surface-page: #fafaf8");
		expect(entry).toContain("--surface-overlay: #f7f6f2");
		expect(entry).toContain("--accent: #c15f3c");
		expect(entry).toContain("--gold: #c8a882");
		expect(entry).toContain('class="logo-box"');
		expect(entry).toContain('<nav class="nav" aria-label="Archive sections">');
		expect(entry).toMatch(
			/<nav class="nav" aria-label="Archive sections">\s*<a href="#profile">/,
		);
		expect(entry).toContain('id="profile" class="section" open');
		expect(entry).toContain('id="chats" class="section">');
		expect(entry).not.toContain('id="chats" class="section" open');
		expect(entry).not.toContain('id="files" class="section" open');
		expect(entry).not.toContain("Account archive");
		expect(entry).not.toContain("Contains personal data");
		expect(entry).not.toContain("Overview");

		const chatPath = Object.keys(zip.files).find(
			(name) => name.startsWith("Chats/") && name.endsWith(".html"),
		);
		expect(chatPath).toBeTruthy();
		const chatHtml = await zip.file(chatPath ?? "")?.async("string");
		expect(chatHtml).toContain("Plan the Q3 launch.");
		expect(chatHtml).toContain("Use a staged rollout");
		expect(chatHtml).toContain("Imported from ChatGPT");
		expect(chatHtml).toContain("roadmap-summary.md");
		expect(chatHtml).not.toContain("hidden chain of thought");
		expect(chatHtml).not.toContain("toolCalls");
		expect(chatHtml).not.toContain("Hidden system context");

		expect(zip.file("Files/Uploaded/roadmap-notes.txt")).toBeTruthy();
		expect(zip.file("Files/Generated/roadmap-summary.md")).toBeTruthy();
		const readableUpload = await zip
			.file("Files/Readable/roadmap-notes.txt.html")
			?.async("string");
		expect(readableUpload).toContain("Readable uploaded notes.");

		const memoryIndex = await zip.file("Memory/Memory.html")?.async("string");
		expect(memoryIndex).toContain("Prepare Q3 launch plan");
		expect(memoryIndex).toContain("Customer interviews are required");
		expect(memoryIndex).not.toContain("embedding");

		const skillPage = await zip
			.file("Skills/Meeting Notes.html")
			?.async("string");
		expect(skillPage).toContain("Write concise action notes.");
		const notePage = await zip
			.file("Skills/Notes/Decision Log.html")
			?.async("string");
		expect(notePage).toContain("Decision: stage the launch.");

		const usage = await zip.file("Usage/Usage Summary.html")?.async("string");
		expect(usage).toContain("140");
		expect(usage).toContain("$0.012345");
		expect(usage).not.toContain("usage-1");
		expect(usage).not.toContain("msg-assistant");

		const combinedText = await Promise.all(
			Object.keys(zip.files)
				.filter((name) => name.endsWith(".html"))
				.map(async (name) => zip.file(name)?.async("string") ?? ""),
		).then((parts) => parts.join("\n"));
		expect(combinedText).not.toContain("Other user content.");
		expect(combinedText).not.toContain("passwordHash");
	});

	it("returns incorrect_password when confirmation fails", async () => {
		await seedArchiveUser();

		const result = await createAccountDataArchive("user-1", {
			password: "wrong-password",
			db,
			rootDir: tempDir,
			now: new Date("2026-06-15T08:00:00Z"),
		});

		expect(result).toEqual({ status: "incorrect_password" });
	});

	it("exports produced Atlas files as generated files without raw checkpoints", async () => {
		await seedArchiveUser();
		await seedAtlasArchiveOutput();

		const result = await createAccountDataArchive("user-1", {
			password: "correct-password",
			db,
			rootDir: tempDir,
			now: new Date("2026-06-15T08:00:00Z"),
		});

		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;

		const zipBytes = Buffer.from(
			await new Response(result.zipStream).arrayBuffer(),
		);
		const zip = await JSZip.loadAsync(zipBytes);
		expect(zip.file("Files/Generated/atlas-market-report.html")).toBeTruthy();
		const atlasFile = await zip
			.file("Files/Generated/atlas-market-report.html")
			?.async("string");
		expect(atlasFile).toContain("Atlas market report");

		const combinedText = await Promise.all(
			Object.keys(zip.files).map(async (name) => {
				const file = zip.file(name);
				if (!file || file.dir) return "";
				return file.async("string").catch(() => "");
			}),
		).then((parts) => parts.join("\n"));
		expect(combinedText).toContain("atlas-market-report.html");
		expect(combinedText).not.toContain("DO_NOT_EXPORT_ATLAS_CHECKPOINT");
		expect(combinedText).not.toContain("DO_NOT_EXPORT_ATLAS_SOURCE_POOL");
		expect(combinedText).not.toContain("DO_NOT_EXPORT_ATLAS_FINDINGS");
		expect(combinedText).not.toContain("DO_NOT_EXPORT_ATLAS_DIAGNOSTICS");
	});

	it("fails the whole archive when an in-scope original file cannot be read", async () => {
		await seedArchiveUser();
		await rm(join(tempDir, "data", "knowledge", "user-1", "roadmap-notes.txt"));

		await expect(
			createAccountDataArchive("user-1", {
				password: "correct-password",
				db,
				rootDir: tempDir,
				now: new Date("2026-06-15T08:00:00Z"),
			}),
		).rejects.toThrow(/failed to read uploaded file roadmap-notes\.txt/i);
	});
});
