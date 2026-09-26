import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "$lib/server/db/schema";
import {
	ARCHIVE_EXCLUDED_DERIVED_DIRECTORIES,
	createAccountDataArchive,
} from "./index";

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

	// Personal instructions are the user's own words about how the assistant
	// should behave, so they are part of the data the user is entitled to take
	// with them — and the archive is the surface that has to prove it, because
	// nothing else shows a user what leaves with them.
	it("includes Personal Instructions in the human-readable archive", async () => {
		await seedArchiveUser();
		db.update(schema.users)
			.set({ personalInstructions: "Always answer in Hungarian." })
			.where(eq(schema.users.id, "user-1"))
			.run();

		const result = await createAccountDataArchive("user-1", {
			password: "correct-password",
			db,
			rootDir: tempDir,
			now: new Date("2026-06-15T08:00:00Z"),
		});

		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;

		const zip = await JSZip.loadAsync(
			Buffer.from(await new Response(result.zipStream).arrayBuffer()),
		);
		const profile = await zip.file("Profile/Profile.html")?.async("string");
		expect(profile).toContain("Personal instructions");
		expect(profile).toContain("Always answer in Hungarian.");
	});

	// Project instructions are the same kind of thing one level down: text the
	// user typed about their own work, which no other part of this archive can
	// reconstruct. Leaving them out would make the export a partial answer to
	// "what of mine does AlfyAI hold?".
	it("includes each project's Instructions in the human-readable archive", async () => {
		await seedArchiveUser();
		await db.insert(schema.projects).values([
			{
				id: "project-1",
				userId: "user-1",
				name: "House tasks",
				instructions: "Always ask before booking anything.",
				createdAt: new Date("2026-02-01T10:00:00Z"),
				updatedAt: new Date("2026-02-02T10:00:00Z"),
			},
			{
				id: "project-2",
				userId: "user-1",
				name: "Vienna trip",
				instructions: "Only suggest trains, never flights.",
				createdAt: new Date("2026-02-03T10:00:00Z"),
				updatedAt: new Date("2026-02-04T10:00:00Z"),
			},
			{
				// A folder with no instructions is still a project the user made,
				// and the page has to say so rather than drop it.
				id: "project-3",
				userId: "user-1",
				name: "Empty folder",
				createdAt: new Date("2026-02-05T10:00:00Z"),
				updatedAt: new Date("2026-02-05T10:00:00Z"),
			},
			{
				id: "project-other",
				userId: "user-2",
				name: "Other user's folder",
				instructions: "DO_NOT_EXPORT_OTHER_PROJECT_INSTRUCTIONS",
				createdAt: new Date("2026-02-06T10:00:00Z"),
				updatedAt: new Date("2026-02-06T10:00:00Z"),
			},
		]);

		const result = await createAccountDataArchive("user-1", {
			password: "correct-password",
			db,
			rootDir: tempDir,
			now: new Date("2026-06-15T08:00:00Z"),
		});

		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;

		const zip = await JSZip.loadAsync(
			Buffer.from(await new Response(result.zipStream).arrayBuffer()),
		);
		const projects = await zip.file("Projects/Projects.html")?.async("string");
		expect(projects).toContain("House tasks");
		expect(projects).toContain("Always ask before booking anything.");
		expect(projects).toContain("Vienna trip");
		expect(projects).toContain("Only suggest trains, never flights.");
		expect(projects).toContain("Empty folder");

		// Reachable from the entry page, or it is a file nobody finds.
		const entry = await zip
			.file("Open AlfyAI Data Archive.html")
			?.async("string");
		expect(entry).toContain('href="Projects/Projects.html"');
		expect(entry).toContain("3 projects");

		const combinedText = await Promise.all(
			Object.keys(zip.files).map(async (name) => {
				const file = zip.file(name);
				if (!file || file.dir) return "";
				return file.async("string").catch(() => "");
			}),
		).then((parts) => parts.join("\n"));
		expect(combinedText).not.toContain(
			"DO_NOT_EXPORT_OTHER_PROJECT_INSTRUCTIONS",
		);
		expect(combinedText).not.toContain("Other user's folder");
	});

	// An instruction the model OFFERED is the one part of the instruction story
	// that lives nowhere else: an offer the user accepted became instruction
	// text (archived above) and a dismissed one became nothing at all — the
	// offer itself is only ever on the assistant message's metadata. So it
	// travels with the reply it was made under, not in an appendix.
	it("carries suggestion rows into the archive with the messages they belong to", async () => {
		await seedArchiveUser();
		db.update(schema.messages)
			.set({
				metadataJson: JSON.stringify({
					diagnostic: true,
					instructionSuggestions: [
						{
							id: "suggestion-1",
							status: "pending",
							text: "Only suggest trains, never flights.",
							scope: { kind: "personal" },
							createdAt: Date.parse("2026-02-01T10:02:00Z"),
						},
					],
				}),
			})
			.where(eq(schema.messages.id, "msg-assistant"))
			.run();

		const result = await createAccountDataArchive("user-1", {
			password: "correct-password",
			db,
			rootDir: tempDir,
			now: new Date("2026-06-15T08:00:00Z"),
		});

		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;

		const zip = await JSZip.loadAsync(
			Buffer.from(await new Response(result.zipStream).arrayBuffer()),
		);
		const chatPath = Object.keys(zip.files).find(
			(name) => name.startsWith("Chats/") && name.endsWith(".html"),
		);
		const chatHtml = await zip.file(chatPath ?? "")?.async("string");

		// Under the reply it was made about, and with the answer the user gave
		// it (or left open): "there was an offer" is not the record, "and it
		// was never answered" is.
		const replyIndex = chatHtml?.indexOf("Use a staged rollout") ?? -1;
		const offerIndex =
			chatHtml?.indexOf("Only suggest trains, never flights.") ?? -1;
		expect(replyIndex).toBeGreaterThan(-1);
		expect(offerIndex).toBeGreaterThan(replyIndex);
		expect(chatHtml).toContain("Pending");
		expect(chatHtml).toContain("Personal");

		// The one field, not the bag it came in: the metadata holds diagnostics
		// and raw tool bookkeeping the archive is deliberately without.
		expect(chatHtml).not.toContain("diagnostic");
	});

	// A project's file list is a statement the user made about their own work —
	// "this document belongs to this project" — so the names travel with the
	// export. The documents themselves are already archived under `Files/`; what
	// this page adds is which project knows which one.
	it("lists each project's linked files by name in the archive", async () => {
		await seedArchiveUser();
		await db.insert(schema.projects).values([
			{
				id: "project-linked",
				userId: "user-1",
				name: "Vienna trip",
				instructions: "Only suggest trains, never flights.",
				createdAt: new Date("2026-02-01T10:00:00Z"),
				updatedAt: new Date("2026-02-02T10:00:00Z"),
			},
			{
				id: "project-empty",
				userId: "user-1",
				name: "House tasks",
				createdAt: new Date("2026-02-03T10:00:00Z"),
				updatedAt: new Date("2026-02-04T10:00:00Z"),
			},
			{
				id: "project-other",
				userId: "user-2",
				name: "Other user's folder",
				createdAt: new Date("2026-02-05T10:00:00Z"),
				updatedAt: new Date("2026-02-06T10:00:00Z"),
			},
		]);
		await db.insert(schema.artifacts).values([
			{
				id: "artifact-project-file",
				userId: "user-1",
				type: "normalized_document",
				name: "Wien itinerary.md",
				contentText: "Museum opens at 10:00.",
				summary: "Trip itinerary",
				createdAt: new Date("2026-02-01T11:00:00Z"),
				updatedAt: new Date("2026-02-01T11:00:00Z"),
			},
			{
				// In the library, in the archive, and in NO project: it must not be
				// listed under either of the user's projects.
				id: "artifact-unlinked",
				userId: "user-1",
				type: "normalized_document",
				name: "Unlinked notes.md",
				contentText: "Nothing links this to a project.",
				createdAt: new Date("2026-02-01T11:30:00Z"),
				updatedAt: new Date("2026-02-01T11:30:00Z"),
			},
			{
				id: "artifact-other-file",
				userId: "user-2",
				type: "normalized_document",
				name: "DO_NOT_EXPORT_OTHER_PROJECT_FILE.md",
				contentText: "Another user's document.",
				createdAt: new Date("2026-02-01T12:00:00Z"),
				updatedAt: new Date("2026-02-01T12:00:00Z"),
			},
		]);
		await db.insert(schema.projectKnowledgeLinks).values([
			{
				id: "link-1",
				userId: "user-1",
				projectId: "project-linked",
				artifactId: "artifact-project-file",
				createdAt: new Date("2026-02-02T10:00:00Z"),
			},
			{
				id: "link-other",
				userId: "user-2",
				projectId: "project-other",
				artifactId: "artifact-other-file",
				createdAt: new Date("2026-02-06T10:00:00Z"),
			},
		]);

		const result = await createAccountDataArchive("user-1", {
			password: "correct-password",
			db,
			rootDir: tempDir,
			now: new Date("2026-06-15T08:00:00Z"),
		});

		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;

		const zip = await JSZip.loadAsync(
			Buffer.from(await new Response(result.zipStream).arrayBuffer()),
		);
		const projects = (await zip
			.file("Projects/Projects.html")
			?.async("string")) as string;
		const linkedSection = projects.slice(projects.indexOf("Vienna trip"));
		expect(linkedSection).toContain("Wien itinerary.md");
		// The project with nothing linked to it is still a project, and the page
		// says so rather than leaving the reader to guess whether files are
		// missing or the export simply does not carry them.
		expect(projects).toContain("House tasks");
		expect(projects).toContain("No files linked to this project.");
		expect(projects).not.toContain("Unlinked notes.md");

		const combinedText = await Promise.all(
			Object.keys(zip.files).map(async (name) => {
				const file = zip.file(name);
				if (!file || file.dir) return "";
				return file.async("string").catch(() => "");
			}),
		).then((parts) => parts.join("\n"));
		expect(combinedText).not.toContain("DO_NOT_EXPORT_OTHER_PROJECT_FILE");
		expect(combinedText).not.toContain("Other user's folder");
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

	it("archives the source file and deliberately not its parse bundle", async () => {
		// A MinerU parse bundle is DERIVED data: every byte of it comes from the
		// source file, which is archived, and its readable text is archived a
		// second time under `Files/Readable/`. Excluding it is a decision, not
		// an omission — the archive is built from database rows and never walks
		// the knowledge tree — and this is the test that holds the decision.
		await seedArchiveUser();
		const bundleDir = join(
			tempDir,
			"data",
			"knowledge",
			"user-1",
			"artifact-upload.parse",
		);
		await mkdir(join(bundleDir, "images"), { recursive: true });
		await writeFile(
			join(bundleDir, "manifest.json"),
			'{"version":1,"markdownSha256":"DO_NOT_EXPORT_BUNDLE"}',
		);
		await writeFile(
			join(bundleDir, "normalized.md"),
			"# DO_NOT_EXPORT_BUNDLE normalized markdown",
		);
		await writeFile(
			join(bundleDir, "structured_content.json"),
			'{"pages":[],"DO_NOT_EXPORT_BUNDLE":true}',
		);
		await writeFile(join(bundleDir, "pages.json"), "[]");
		await writeFile(
			join(bundleDir, "images", "page_1_image_body_1.jpg"),
			"jpeg-bytes",
		);
		// And a half-written upload, the other intentionally excluded directory.
		await mkdir(join(tempDir, "data", "knowledge", "user-1", ".incoming"), {
			recursive: true,
		});
		await writeFile(
			join(tempDir, "data", "knowledge", "user-1", ".incoming", "part.bin"),
			"DO_NOT_EXPORT_BUNDLE partial upload",
		);

		const result = await createAccountDataArchive("user-1", {
			password: "correct-password",
			db,
			rootDir: tempDir,
			now: new Date("2026-06-15T08:00:00Z"),
		});
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;

		const zip = await JSZip.loadAsync(
			Buffer.from(await new Response(result.zipStream).arrayBuffer()),
		);
		const names = Object.keys(zip.files);

		// The SOURCE file is there, byte for byte…
		expect(
			await zip.file("Files/Uploaded/roadmap-notes.txt")?.async("string"),
		).toBe("Original uploaded roadmap file.");
		// …and so is its readable text.
		expect(
			names.some((name) => name.startsWith("Files/Readable/roadmap-notes")),
		).toBe(true);

		for (const excluded of ARCHIVE_EXCLUDED_DERIVED_DIRECTORIES) {
			expect(names.filter((name) => name.includes(excluded))).toEqual([]);
		}
		const combined = await Promise.all(
			names.map((name) => {
				const file = zip.file(name);
				if (!file || file.dir) return "";
				return file.async("string").catch(() => "");
			}),
		).then((parts) => parts.join("\n"));
		expect(combined).not.toContain("DO_NOT_EXPORT_BUNDLE");
	});

	// The artifact family (Feature 2). An artifact's history, its comment threads
	// and an App's stored data are the user's own content — a cost splitter's
	// expenses, a note to themselves on a plan — so they travel with the export as
	// readable pages per artifact, never a table dump (ruling 24). The archive
	// bypasses the ownership scope on purpose, so the `user_id` filter is the only
	// guard between this user and another one: the second user's rows must be
	// absent.
	it("archives each artifact with its version history, comment threads and stored App data, and nothing of another user's", async () => {
		await seedArchiveUser();
		const at = new Date("2026-03-01T09:00:00Z");
		await db.insert(schema.artifacts).values([
			{
				id: "artifact-produced",
				userId: "user-1",
				conversationId: "conv-1",
				type: "generated_output",
				name: "roadmap-summary.md",
				contentText: "Generated roadmap summary text.",
				createdAt: at,
				updatedAt: at,
			},
			{
				id: "artifact-document",
				userId: "user-1",
				conversationId: "conv-1",
				type: "artifact",
				name: "Launch checklist",
				contentText: "- [x] Book the venue\n- [ ] Brief support",
				metadataJson: JSON.stringify({
					artifactType: "document",
					title: "Launch checklist",
				}),
				createdAt: at,
				updatedAt: at,
			},
			{
				id: "artifact-app",
				userId: "user-1",
				conversationId: "conv-1",
				type: "artifact",
				name: "Launch budget",
				contentText: "<!doctype html><title>Budget</title>",
				metadataJson: JSON.stringify({
					artifactType: "app",
					title: "Launch budget",
				}),
				createdAt: at,
				updatedAt: at,
			},
			{
				id: "artifact-other-user",
				userId: "user-2",
				conversationId: "conv-other",
				type: "artifact",
				name: "DO_NOT_EXPORT_OTHER_ARTIFACT",
				contentText: "Another user's document.",
				metadataJson: JSON.stringify({ artifactType: "app", title: "x" }),
				createdAt: at,
				updatedAt: at,
			},
		]);
		await db.insert(schema.artifactVersions).values([
			{
				id: "version-produced-1",
				artifactId: "artifact-produced",
				userId: "user-1",
				versionNumber: 1,
				author: "alfy",
				summary: "Alfy produced the summary",
				body: "Generated roadmap summary text.",
				bodyHash: "h1",
				createdAt: at,
			},
			{
				id: "version-document-1",
				artifactId: "artifact-document",
				userId: "user-1",
				versionNumber: 1,
				author: "alfy",
				summary: "Alfy wrote the first draft",
				body: "- [ ] Book the venue\n- [ ] Brief support",
				bodyHash: "h2",
				createdAt: at,
			},
			{
				id: "version-document-2",
				artifactId: "artifact-document",
				userId: "user-1",
				versionNumber: 2,
				author: "user",
				summary: "Ticked the venue",
				body: "- [x] Book the venue\n- [ ] Brief support",
				bodyHash: "h3",
				createdAt: at,
			},
			{
				id: "version-other",
				artifactId: "artifact-other-user",
				userId: "user-2",
				versionNumber: 1,
				author: "user",
				summary: "DO_NOT_EXPORT_OTHER_VERSION",
				body: "x",
				bodyHash: "h4",
				createdAt: at,
			},
		]);
		await db.insert(schema.artifactComments).values([
			{
				id: "comment-root",
				artifactId: "artifact-document",
				userId: "user-1",
				anchorJson: JSON.stringify({ kind: "node", nodeId: "b1" }),
				author: "user",
				body: "Is the venue confirmed?",
				createdAt: at,
			},
			{
				id: "comment-reply",
				artifactId: "artifact-document",
				userId: "user-1",
				parentId: "comment-root",
				author: "alfy",
				body: "Yes, confirmed on Monday.",
				status: "resolved",
				createdAt: at,
			},
			{
				id: "comment-other",
				artifactId: "artifact-other-user",
				userId: "user-2",
				anchorJson: JSON.stringify({ kind: "node", nodeId: "b1" }),
				author: "user",
				body: "DO_NOT_EXPORT_OTHER_COMMENT",
				createdAt: at,
			},
		]);
		await db.insert(schema.artifactKv).values([
			{
				id: "kv-app",
				artifactId: "artifact-app",
				key: "expenses",
				valueJson: JSON.stringify([{ item: "Venue deposit", eur: 400 }]),
				updatedAt: at,
			},
			{
				id: "kv-produced",
				artifactId: "artifact-produced",
				key: "note",
				valueJson: JSON.stringify("kept with the file"),
				updatedAt: at,
			},
			{
				id: "kv-other",
				artifactId: "artifact-other-user",
				key: "DO_NOT_EXPORT_OTHER_KEY",
				valueJson: JSON.stringify("DO_NOT_EXPORT_OTHER_VALUE"),
				updatedAt: at,
			},
		]);

		const result = await createAccountDataArchive("user-1", {
			password: "correct-password",
			db,
			rootDir: tempDir,
			now: new Date("2026-06-15T08:00:00Z"),
		});
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		const zip = await JSZip.loadAsync(
			Buffer.from(await new Response(result.zipStream).arrayBuffer()),
		);

		// A File (a produced file's artifact): its readable page carries its
		// history and its stored data.
		const produced = (await zip
			.file("Files/Readable/roadmap-summary.md.html")
			?.async("string")) as string;
		expect(produced).toContain("Generated roadmap summary text.");
		expect(produced).toContain("Alfy produced the summary");
		expect(produced).toContain("note");
		expect(produced).toContain("kept with the file");

		// A Document: its body, every version with its own text, and its threads.
		const document = (await zip
			.file("Files/Readable/Launch checklist.html")
			?.async("string")) as string;
		expect(document).toContain("Book the venue");
		expect(document).toContain("v2");
		expect(document).toContain("Ticked the venue");
		expect(document).toContain("v1");
		expect(document).toContain("Alfy wrote the first draft");
		expect(document).toContain("Is the venue confirmed?");
		expect(document).toContain("Yes, confirmed on Monday.");

		// An App: what the user typed into it, readable, scoped to the App.
		const app = (await zip
			.file("Files/Readable/Launch budget.html")
			?.async("string")) as string;
		expect(app).toContain("expenses");
		expect(app).toContain("Venue deposit");

		const combinedText = await Promise.all(
			Object.keys(zip.files).map(async (name) => {
				const file = zip.file(name);
				if (!file || file.dir) return "";
				return file.async("string").catch(() => "");
			}),
		).then((parts) => parts.join("\n"));
		for (const marker of [
			"DO_NOT_EXPORT_OTHER_ARTIFACT",
			"DO_NOT_EXPORT_OTHER_VERSION",
			"DO_NOT_EXPORT_OTHER_COMMENT",
			"DO_NOT_EXPORT_OTHER_KEY",
			"DO_NOT_EXPORT_OTHER_VALUE",
		]) {
			expect(combinedText).not.toContain(marker);
		}
		// The UI never names the family, and neither does the export.
		expect(combinedText).not.toMatch(/\bartifacts?\b/i);
	});

	// A10: the App's own HTML is the one model-authored document in the
	// product — the archive must never become a second place it can run. The
	// version-history renderer already HTML-escapes every version's body
	// (ruling 24's "readable, never a live document"); this test pins that
	// specifically for an App's `<!doctype html>` source, and for the Alfy
	// verification note a regeneration leaves as a comment.
	it("archives an App's own html source as inert, escaped text, and its verification note as a comment", async () => {
		await seedArchiveUser();
		const at = new Date("2026-03-01T09:00:00Z");
		const appHtml =
			'<!doctype html><html><head><script>alert("hi")</script></head><body>Budget</body></html>';
		await db.insert(schema.artifacts).values({
			id: "artifact-app-2",
			userId: "user-1",
			conversationId: "conv-1",
			type: "artifact",
			name: "Trip cost splitter",
			contentText: appHtml,
			metadataJson: JSON.stringify({
				artifactType: "app",
				title: "Trip cost splitter",
				verification: { checked: true, verdict: "uncertain", reason: null },
			}),
			createdAt: at,
			updatedAt: at,
		});
		await db.insert(schema.artifactVersions).values({
			id: "version-app-2",
			artifactId: "artifact-app-2",
			userId: "user-1",
			versionNumber: 1,
			author: "alfy",
			summary: "Alfy wrote the first draft",
			body: appHtml,
			bodyHash: "h5",
			createdAt: at,
		});
		await db.insert(schema.artifactComments).values({
			id: "comment-verify",
			artifactId: "artifact-app-2",
			userId: "user-1",
			author: "alfy",
			anchorJson: JSON.stringify({ kind: "node", nodeId: "app" }),
			body: "Vienna is the capital of Hungary: could not settle without web research.",
			createdAt: at,
		});

		const result = await createAccountDataArchive("user-1", {
			password: "correct-password",
			db,
			rootDir: tempDir,
			now: new Date("2026-06-15T08:00:00Z"),
		});
		expect(result.status).toBe("ok");
		if (result.status !== "ok") return;
		const zip = await JSZip.loadAsync(
			Buffer.from(await new Response(result.zipStream).arrayBuffer()),
		);

		const page = (await zip
			.file("Files/Readable/Trip cost splitter.html")
			?.async("string")) as string;

		// The literal tags never appear unescaped — a browser opening this
		// archive page must not run the app's own <script>.
		expect(page).not.toContain("<script>alert(");
		expect(page).not.toContain("<!doctype html><html>");
		// The escaped text is still there, readable, inside a <pre>.
		expect(page).toContain("&lt;!doctype html&gt;");
		expect(page).toContain("&lt;script&gt;");
		expect(page).toMatch(/<pre>[\s\S]*&lt;!doctype html&gt;[\s\S]*<\/pre>/);

		// The verification note travels as a comment, in plain readable prose.
		expect(page).toContain(
			"Vienna is the capital of Hungary: could not settle without web research.",
		);
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
