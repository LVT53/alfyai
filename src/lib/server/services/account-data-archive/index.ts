import { readFile } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { and, asc, eq } from "drizzle-orm";
import JSZip from "jszip";
import { type DatabaseInstance, db as defaultDb } from "$lib/server/db";
import {
	analyticsConversations,
	artifacts,
	chatGeneratedFiles,
	conversations,
	conversationTaskStates,
	importJobs,
	memoryEvents,
	messages,
	usageEvents,
	userSkillDefinitions,
	users,
} from "$lib/server/db/schema";
import { verifyPassword } from "$lib/server/services/auth";
import { parseJsonRecord } from "$lib/server/utils/json";
import { escapeHtml, renderArchiveEntryPage, renderArchivePage } from "./html";

export type AccountDataArchiveResult =
	| {
			status: "ok";
			filename: string;
			zipStream: ReadableStream<Uint8Array>;
	  }
	| { status: "not_found" }
	| { status: "incorrect_password" };

export type AccountDataArchiveInput = {
	password: string;
	db?: DatabaseInstance;
	rootDir?: string;
	now?: Date;
};

type ArchiveDb = DatabaseInstance;

const ENTRY_FILE = "Open AlfyAI Data Archive.html";
const EXCLUSION_NOTES = [
	"Passwords, password hashes, active logins, sessions, cookies, service assertions, and API keys are not included.",
	"Private server settings, provider secrets, storage paths, server logs, local process logs, hidden prompt context, assistant thinking traces, raw tool JSON, provider payloads, retry/debug fields, diagnostics, embeddings, and embedding hashes are not included.",
	"Outside AI provider logs that are outside AlfyAI control are not included.",
	"Raw ChatGPT import ZIP files, parser internals, summarizer state, and raw database dumps are not included.",
];

export async function createAccountDataArchive(
	userId: string,
	input: AccountDataArchiveInput,
): Promise<AccountDataArchiveResult> {
	const database = input.db ?? defaultDb;
	const rootDir = input.rootDir ?? process.cwd();
	const now = input.now ?? new Date();

	const [user] = await database
		.select()
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!user) return { status: "not_found" };

	const valid = await verifyPassword(input.password, user.passwordHash);
	if (!valid) return { status: "incorrect_password" };

	const zip = new JSZip();
	zip.file(ENTRY_FILE, "");
	const archive = new ArchiveBuilder(zip);
	const filename = `AlfyAI Data Archive ${formatDateForFilename(now)}.zip`;

	const [
		conversationRows,
		messageRows,
		artifactRows,
		generatedFileRows,
		taskStateRows,
		memoryEventRows,
		skillRows,
		importJobRows,
		usageRows,
		analyticsConversationRows,
	] = await Promise.all([
		listConversations(database, userId),
		listMessages(database, userId),
		listArtifacts(database, userId),
		listGeneratedFiles(database, userId),
		listTaskStates(database, userId),
		listMemoryEvents(database, userId),
		listUserSkills(database, userId),
		listImportJobs(database, userId),
		listUsageEvents(database, userId),
		listAnalyticsConversations(database, userId),
	]);

	const uploadedArtifacts = artifactRows.filter(
		(row) => row.type === "source_document",
	);
	const readableArtifacts = artifactRows.filter(
		(row) =>
			row.contentText &&
			(row.type === "source_document" ||
				row.type === "normalized_document" ||
				row.type === "generated_output"),
	);
	const skillNoteArtifacts = artifactRows.filter(
		(row) => row.type === "skill_note",
	);

	await addProfileSection(archive, { user, rootDir });
	await addFilesSection(archive, {
		rootDir,
		uploadedArtifacts,
		readableArtifacts,
		generatedFiles: generatedFileRows,
	});
	addChatsSection(archive, {
		conversations: conversationRows,
		messages: messageRows,
		importJobs: importJobRows,
		generatedFiles: generatedFileRows,
	});
	addMemorySection(archive, {
		tasks: taskStateRows,
		events: memoryEventRows,
	});
	addSkillsSection(archive, {
		skills: skillRows,
		notes: skillNoteArtifacts,
	});
	addUsageSection(archive, {
		usageRows,
		analyticsConversationRows,
	});
	addExclusionsPage(archive);
	addEntryPage(archive, {
		now,
		userDisplayName: user.name ?? user.email,
		conversationCount: conversationRows.length,
		uploadedFileCount: uploadedArtifacts.length,
		generatedFileCount: generatedFileRows.length,
		memoryCount: taskStateRows.length + memoryEventRows.length,
		skillCount: skillRows.length,
		noteCount: skillNoteArtifacts.length,
		usageEventCount: usageRows.length,
	});

	const nodeStream = zip.generateNodeStream({
		type: "nodebuffer",
		compression: "DEFLATE",
		compressionOptions: { level: 6 },
	});
	nodeStream.on("error", (error) => {
		console.error("[ACCOUNT_DATA_ARCHIVE] Stream error:", error);
	});
	const zipStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
	return { status: "ok", filename, zipStream };
}

class ArchiveBuilder {
	private readonly usedNames = new Map<string, number>();

	constructor(private readonly zip: JSZip) {}

	addHtml(path: string, html: string): string {
		const uniquePath = this.uniquePath(path);
		this.zip.file(uniquePath, html);
		return uniquePath;
	}

	addBinary(path: string, content: Buffer | Uint8Array | string): string {
		const uniquePath = this.uniquePath(path);
		this.zip.file(uniquePath, content);
		return uniquePath;
	}

	private uniquePath(path: string): string {
		const cleanPath = path
			.split("/")
			.map((segment) => sanitizePathSegment(segment))
			.join("/");
		const count = this.usedNames.get(cleanPath) ?? 0;
		this.usedNames.set(cleanPath, count + 1);
		if (count === 0) return cleanPath;

		const dot = cleanPath.lastIndexOf(".");
		if (dot <= cleanPath.lastIndexOf("/")) {
			return `${cleanPath} ${count + 1}`;
		}
		return `${cleanPath.slice(0, dot)} ${count + 1}${cleanPath.slice(dot)}`;
	}
}

async function addProfileSection(
	archive: ArchiveBuilder,
	params: {
		user: typeof users.$inferSelect;
		rootDir: string;
	},
) {
	let avatarMarkup = "";
	if (params.user.profilePicture) {
		const avatar = await readRequiredFile(
			params.rootDir,
			`data/avatars/${params.user.id}.webp`,
			"profile avatar",
		);
		archive.addBinary("Profile/avatar.webp", avatar);
		avatarMarkup = `<p><img class="avatar" src="avatar.webp" alt="Profile avatar"></p>`;
	}

	const profileRows = [
		["Display name", params.user.name ?? ""],
		["Email", params.user.email],
		["Role", params.user.role],
		["Preferred model", params.user.preferredModel],
		["Model preference mode", params.user.modelPreferenceMode ?? "Default"],
		["Theme", params.user.theme],
		["Title language", params.user.titleLanguage],
		["UI language", params.user.uiLanguage],
		["Translation enabled", params.user.translationEnabled ? "Yes" : "No"],
		[
			"Sidebar projects expanded",
			params.user.sidebarProjectsExpanded ? "Yes" : "No",
		],
		["Sidebar chats expanded", params.user.sidebarChatsExpanded ? "Yes" : "No"],
		["Created", formatDateTime(params.user.createdAt)],
		["Updated", formatDateTime(params.user.updatedAt)],
	];

	archive.addHtml(
		"Profile/Profile.html",
		renderArchivePage({
			title: "Profile",
			subtitle: "Account facts and preferences included in this archive.",
			body: `${avatarMarkup}${renderTable(profileRows)}`,
		}),
	);
}

async function addFilesSection(
	archive: ArchiveBuilder,
	params: {
		rootDir: string;
		uploadedArtifacts: Array<typeof artifacts.$inferSelect>;
		readableArtifacts: Array<typeof artifacts.$inferSelect>;
		generatedFiles: Array<typeof chatGeneratedFiles.$inferSelect>;
	},
) {
	for (const artifact of params.uploadedArtifacts) {
		if (!artifact.storagePath) {
			throw new Error(`Uploaded file ${artifact.name} has no storage path`);
		}
		const content = await readRequiredFile(
			params.rootDir,
			artifact.storagePath,
			`uploaded file ${artifact.name}`,
		);
		archive.addBinary(
			`Files/Uploaded/${displayFileName(artifact.name, artifact.extension)}`,
			content,
		);
	}

	for (const file of params.generatedFiles) {
		const content = await readRequiredFile(
			params.rootDir,
			`data/chat-files/${file.storagePath}`,
			`generated file ${file.filename}`,
		);
		archive.addBinary(`Files/Generated/${file.filename}`, content);
	}

	for (const artifact of params.readableArtifacts) {
		const filename = `${displayFileName(artifact.name, artifact.extension)}.html`;
		archive.addHtml(
			`Files/Readable/${filename}`,
			renderArchivePage({
				title: artifact.name,
				subtitle: readableArtifactSubtitle(artifact),
				body: `<pre>${escapeHtml(artifact.contentText ?? "")}</pre>`,
			}),
		);
	}
}

function addChatsSection(
	archive: ArchiveBuilder,
	params: {
		conversations: Array<typeof conversations.$inferSelect>;
		messages: Array<
			typeof messages.$inferSelect & { conversationUserId: string }
		>;
		importJobs: Array<typeof importJobs.$inferSelect>;
		generatedFiles: Array<typeof chatGeneratedFiles.$inferSelect>;
	},
) {
	const messagesByConversation = groupBy(
		params.messages,
		(row) => row.conversationId,
	);
	const generatedByConversation = groupBy(
		params.generatedFiles,
		(row) => row.conversationId,
	);
	const importSummary =
		params.importJobs.length > 0
			? `ChatGPT import jobs found for this account: ${params.importJobs
					.map(
						(job) =>
							`${job.status} (${job.processedConversations}/${job.totalConversations}) on ${formatDateTime(job.createdAt)}`,
					)
					.join("; ")}.`
			: "";

	const chatLinks: Array<[string, string]> = [];
	for (const conversation of params.conversations) {
		const chatMessages = messagesByConversation.get(conversation.id) ?? [];
		const chatFiles = generatedByConversation.get(conversation.id) ?? [];
		const pagePath = `Chats/${conversation.title || "Untitled Chat"}.html`;
		const writtenPath = archive.addHtml(
			pagePath,
			renderChatPage({
				conversation,
				messages: chatMessages,
				generatedFiles: chatFiles,
				importSummary,
			}),
		);
		chatLinks.push([conversation.title, writtenPath]);
	}

	archive.addHtml(
		"Chats/Chats.html",
		renderArchivePage({
			title: "Chats",
			body: chatLinks.length
				? `<ul>${chatLinks
						.map(
							([title, path]) =>
								`<li><a href="${escapeHtml(relativeLink("Chats/Chats.html", path))}">${escapeHtml(title)}</a></li>`,
						)
						.join("")}</ul>`
				: `<p class="empty">No chats were found for this account.</p>`,
		}),
	);
}

function renderChatPage(params: {
	conversation: typeof conversations.$inferSelect;
	messages: Array<
		typeof messages.$inferSelect & { conversationUserId: string }
	>;
	generatedFiles: Array<typeof chatGeneratedFiles.$inferSelect>;
	importSummary: string;
}): string {
	const visibleMessages = params.messages.filter(
		(message) => message.role === "user" || message.role === "assistant",
	);
	const hasImportedMessages = visibleMessages.some((message) =>
		Boolean(message.importSource),
	);
	const fileLinks = params.generatedFiles.length
		? `<section><h2>Files used in this chat</h2><ul>${params.generatedFiles
				.map(
					(file) =>
						`<li><a href="../Files/Generated/${escapeHtml(sanitizePathSegment(file.filename))}">${escapeHtml(file.filename)}</a></li>`,
				)
				.join("")}</ul></section>`
		: "";
	const provenance =
		hasImportedMessages || params.importSummary
			? `<section><h2>Import provenance</h2><p>${hasImportedMessages ? "Imported from ChatGPT." : ""} ${escapeHtml(params.importSummary)}</p></section>`
			: "";

	const body = [
		`<section><h2>Conversation facts</h2>${renderTable([
			["Title", params.conversation.title],
			["Created", formatDateTime(params.conversation.createdAt)],
			["Updated", formatDateTime(params.conversation.updatedAt)],
			["Status", params.conversation.status],
		])}</section>`,
		fileLinks,
		provenance,
		`<section><h2>Transcript</h2>${
			visibleMessages.length
				? visibleMessages
						.map(
							(message) =>
								`<article class="message ${message.role}"><h3>${escapeHtml(capitalize(message.role))}</h3><p class="meta">${escapeHtml(formatDateTime(message.createdAt))}</p><pre>${escapeHtml(message.content)}</pre></article>`,
						)
						.join("")
				: `<p class="empty">No user or assistant messages were found in this conversation.</p>`
		}</section>`,
	].join("");

	return renderArchivePage({
		title: params.conversation.title,
		subtitle:
			"Readable chat transcript with user messages and assistant responses only.",
		body,
	});
}

function addMemorySection(
	archive: ArchiveBuilder,
	params: {
		tasks: Array<typeof conversationTaskStates.$inferSelect>;
		events: Array<typeof memoryEvents.$inferSelect>;
	},
) {
	const sections = [
		renderTaskStates(params.tasks),
		renderMemoryEvents(params.events),
	].join("");
	archive.addHtml(
		"Memory/Memory.html",
		renderArchivePage({
			title: "Memory",
			subtitle: "Readable app-controlled memory and continuity records.",
			body: sections || `<p class="empty">No memory records were found.</p>`,
		}),
	);

	for (const task of params.tasks) {
		archive.addHtml(
			`Memory/Details/${task.objective || task.taskId}.html`,
			renderArchivePage({
				title: task.objective || "Memory Detail",
				body: renderTable([
					["Status", task.status],
					["Created", formatDateTime(task.createdAt)],
					["Updated", formatDateTime(task.updatedAt)],
					["Decisions", formatJsonList(task.decisionsJson)],
					["Next steps", formatJsonList(task.nextStepsJson)],
					["Open questions", formatJsonList(task.openQuestionsJson)],
					["Facts to preserve", formatJsonList(task.factsToPreserveJson)],
				]),
			}),
		);
	}
}

function addSkillsSection(
	archive: ArchiveBuilder,
	params: {
		skills: Array<typeof userSkillDefinitions.$inferSelect>;
		notes: Array<typeof artifacts.$inferSelect>;
	},
) {
	for (const skill of params.skills) {
		archive.addHtml(
			`Skills/${skill.displayName || skill.id}.html`,
			renderArchivePage({
				title: skill.displayName,
				subtitle: "User-created Skill definition.",
				body: renderTable([
					["Description", skill.description],
					["Instructions", skill.instructions],
					["Enabled", skill.enabled ? "Yes" : "No"],
					["Duration policy", skill.durationPolicy],
					["Question policy", skill.questionPolicy],
					["Notes policy", skill.notesPolicy],
					["Source scope", skill.sourceScope],
					["Version", skill.version],
					["Created", formatDateTime(skill.createdAt)],
					["Updated", formatDateTime(skill.updatedAt)],
				]),
			}),
		);
	}

	for (const note of params.notes) {
		archive.addHtml(
			`Skills/Notes/${note.name || note.id}.html`,
			renderArchivePage({
				title: note.name,
				subtitle: "Skill Note.",
				body: `<pre>${escapeHtml(note.contentText ?? note.summary ?? "")}</pre>`,
			}),
		);
	}

	const skillLinks = params.skills
		.map(
			(skill) =>
				`<li><a href="${escapeHtml(sanitizePathSegment(skill.displayName || skill.id))}.html">${escapeHtml(skill.displayName)}</a></li>`,
		)
		.join("");
	const noteLinks = params.notes
		.map(
			(note) =>
				`<li><a href="Notes/${escapeHtml(sanitizePathSegment(note.name || note.id))}.html">${escapeHtml(note.name)}</a></li>`,
		)
		.join("");
	archive.addHtml(
		"Skills/Skills.html",
		renderArchivePage({
			title: "Skills and Notes",
			body: `<section><h2>User Skills</h2>${skillLinks ? `<ul>${skillLinks}</ul>` : `<p class="empty">No user Skills were found.</p>`}</section><section><h2>Skill Notes</h2>${noteLinks ? `<ul>${noteLinks}</ul>` : `<p class="empty">No Skill Notes were found.</p>`}</section>`,
		}),
	);
}

function addUsageSection(
	archive: ArchiveBuilder,
	params: {
		usageRows: Array<typeof usageEvents.$inferSelect>;
		analyticsConversationRows: Array<
			typeof analyticsConversations.$inferSelect
		>;
	},
) {
	const summary = summarizeUsage(params.usageRows);
	const monthlyRows = Array.from(summary.months.entries()).map(
		([month, value]) => [
			month,
			value.messages,
			value.tokens,
			formatUsdMicros(value.costUsdMicros),
		],
	);
	const modelRows = Array.from(summary.models.entries()).map(
		([model, value]) => [
			model,
			value.messages,
			value.tokens,
			formatUsdMicros(value.costUsdMicros),
		],
	);
	const conversationMonths = summarizeAnalyticsConversations(
		params.analyticsConversationRows,
	);

	archive.addHtml(
		"Usage/Usage Summary.html",
		renderArchivePage({
			title: "Usage Summary",
			subtitle: "Personal usage summaries, not raw analytics event payloads.",
			body: [
				`<section><h2>Totals</h2>${renderTable([
					["Messages with usage", summary.messages],
					["Total tokens", summary.tokens],
					["Estimated cost", formatUsdMicros(summary.costUsdMicros)],
				])}</section>`,
				`<section><h2>By month</h2>${monthlyRows.length ? renderTable(monthlyRows) : `<p class="empty">No usage rows were found.</p>`}</section>`,
				`<section><h2>By model</h2>${modelRows.length ? renderTable(modelRows) : `<p class="empty">No usage rows were found.</p>`}</section>`,
				`<section><h2>Conversation summaries</h2>${
					conversationMonths.length
						? renderTable(conversationMonths)
						: `<p class="empty">No conversation analytics summaries were found.</p>`
				}</section>`,
			].join(""),
		}),
	);
}

function addExclusionsPage(archive: ArchiveBuilder) {
	archive.addHtml(
		"What is not included.html",
		renderArchivePage({
			title: "What is not included",
			body: `<ul>${EXCLUSION_NOTES.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>`,
		}),
	);
}

function addEntryPage(
	archive: ArchiveBuilder,
	params: {
		now: Date;
		userDisplayName: string;
		conversationCount: number;
		uploadedFileCount: number;
		generatedFileCount: number;
		memoryCount: number;
		skillCount: number;
		noteCount: number;
		usageEventCount: number;
	},
) {
	const nav = [
		{
			id: "profile",
			title: "Profile",
			subtitle: "Your account details and selected preferences.",
			open: true,
			body: `<div class="profile-grid">
				<a class="field" href="Profile/Profile.html">
					<div class="field-label">Profile page</div>
					<div class="field-value">Open profile and preferences</div>
				</a>
				<div class="field">
					<div class="field-label">Prepared for</div>
					<div class="field-value">${escapeHtml(params.userDisplayName)}</div>
				</div>
				<div class="field">
					<div class="field-label">Format</div>
					<div class="field-value">Human-readable ZIP</div>
				</div>
			</div>`,
		},
		{
			id: "chats",
			title: "Chats",
			subtitle:
				"Readable transcripts with user messages and assistant replies.",
			body: `<div class="chat-list">
				<a class="chat-row" href="Chats/Chats.html">
					<div>
						<p class="chat-title">Chat transcripts</p>
						<p class="chat-preview">Open the chat index and individual conversation pages.</p>
					</div>
					<div class="chat-meta">${escapeHtml(params.conversationCount)} conversations</div>
				</a>
			</div>`,
		},
		{
			id: "files",
			title: "Files",
			subtitle:
				"Uploaded files and generated files, with readable previews when available.",
			body: `<div class="file-grid">
				<a class="file-tile" href="Files/Uploaded">
					<div class="file-kind">Uploaded</div>
					<div class="file-name">${escapeHtml(params.uploadedFileCount)} original files</div>
					<div class="file-meta">Knowledge Base originals</div>
				</a>
				<a class="file-tile" href="Files/Generated">
					<div class="file-kind">Generated</div>
					<div class="file-name">${escapeHtml(params.generatedFileCount)} generated files</div>
					<div class="file-meta">Files created from chats</div>
				</a>
				<a class="file-tile" href="Files/Readable">
					<div class="file-kind">Readable</div>
					<div class="file-name">Readable previews</div>
					<div class="file-meta">Existing extracted text only</div>
				</a>
			</div>`,
		},
		{
			id: "memory",
			title: "Memory",
			subtitle:
				"App-controlled memory and continuity records in readable language.",
			body: `<div class="memory-grid">
				<a class="memory-item" href="Memory/Memory.html">
					<div class="memory-source">Memory records</div>
					<div class="memory-text">${escapeHtml(params.memoryCount)} remembered items and continuity records</div>
					<div class="memory-meta">Detailed pages are linked from the memory index.</div>
				</a>
				<a class="memory-item" href="Skills/Skills.html">
					<div class="memory-source">Skills and notes</div>
					<div class="memory-text">${escapeHtml(params.skillCount)} user Skills and ${escapeHtml(params.noteCount)} Skill Notes</div>
					<div class="memory-meta">User-created Skill material only.</div>
				</a>
			</div>`,
		},
		{
			id: "usage",
			title: "Usage",
			subtitle:
				"Simple personal usage summaries instead of raw analytics events.",
			body: `<div class="analytics-layout">
				<table aria-label="Usage summary">
					<tbody>
						<tr><th>Usage rows summarized</th><td>${escapeHtml(params.usageEventCount)}</td></tr>
						<tr><th>Summary page</th><td><a href="Usage/Usage Summary.html">Usage/Usage Summary.html</a></td></tr>
					</tbody>
				</table>
			</div>`,
		},
		{
			id: "excluded",
			title: "Not included",
			subtitle: "A short list of data that is not part of this archive.",
			body: `<div class="notice">${EXCLUSION_NOTES.map(escapeHtml).join(" ")}</div><p><a href="What is not included.html">Open the full exclusion notes</a></p>`,
		},
	];
	archive.addHtml(
		ENTRY_FILE,
		renderArchiveEntryPage({
			title: "Account Data Archive",
			heroCopy:
				"A readable copy of the AlfyAI data stored for this account when the archive was created. Use the sections below to review your profile, chats, files, memory, skills, and usage.",
			preparedFor: params.userDisplayName,
			created: formatDateTime(params.now),
			metrics: [
				{ value: params.conversationCount, label: "Chats" },
				{
					value: params.uploadedFileCount + params.generatedFileCount,
					label: "Original files",
				},
				{ value: params.memoryCount, label: "Memory records" },
				{ value: params.usageEventCount, label: "Usage rows" },
			],
			sections: nav,
		}),
	);
}

async function listConversations(database: ArchiveDb, userId: string) {
	return database
		.select()
		.from(conversations)
		.where(eq(conversations.userId, userId))
		.orderBy(asc(conversations.createdAt));
}

async function listMessages(database: ArchiveDb, userId: string) {
	return database
		.select({
			id: messages.id,
			conversationId: messages.conversationId,
			messageSequence: messages.messageSequence,
			role: messages.role,
			content: messages.content,
			thinking: messages.thinking,
			toolCalls: messages.toolCalls,
			metadataJson: messages.metadataJson,
			importSource: messages.importSource,
			createdAt: messages.createdAt,
			conversationUserId: conversations.userId,
		})
		.from(messages)
		.innerJoin(conversations, eq(messages.conversationId, conversations.id))
		.where(eq(conversations.userId, userId))
		.orderBy(
			asc(messages.conversationId),
			asc(messages.messageSequence),
			asc(messages.createdAt),
		);
}

async function listArtifacts(database: ArchiveDb, userId: string) {
	return database
		.select()
		.from(artifacts)
		.where(eq(artifacts.userId, userId))
		.orderBy(asc(artifacts.createdAt));
}

async function listGeneratedFiles(database: ArchiveDb, userId: string) {
	return database
		.select()
		.from(chatGeneratedFiles)
		.where(eq(chatGeneratedFiles.userId, userId))
		.orderBy(asc(chatGeneratedFiles.createdAt));
}

async function listTaskStates(database: ArchiveDb, userId: string) {
	return database
		.select()
		.from(conversationTaskStates)
		.where(eq(conversationTaskStates.userId, userId))
		.orderBy(asc(conversationTaskStates.createdAt));
}

async function listMemoryEvents(database: ArchiveDb, userId: string) {
	return database
		.select()
		.from(memoryEvents)
		.where(eq(memoryEvents.userId, userId))
		.orderBy(asc(memoryEvents.observedAt));
}

async function listUserSkills(database: ArchiveDb, userId: string) {
	return database
		.select()
		.from(userSkillDefinitions)
		.where(
			and(
				eq(userSkillDefinitions.userId, userId),
				eq(userSkillDefinitions.ownership, "user"),
				eq(userSkillDefinitions.skillKind, "user_skill"),
			),
		)
		.orderBy(asc(userSkillDefinitions.createdAt));
}

async function listImportJobs(database: ArchiveDb, userId: string) {
	return database
		.select()
		.from(importJobs)
		.where(eq(importJobs.userId, userId))
		.orderBy(asc(importJobs.createdAt));
}

async function listUsageEvents(database: ArchiveDb, userId: string) {
	return database
		.select()
		.from(usageEvents)
		.where(eq(usageEvents.userId, userId))
		.orderBy(asc(usageEvents.billingMonth), asc(usageEvents.createdAt));
}

async function listAnalyticsConversations(database: ArchiveDb, userId: string) {
	return database
		.select()
		.from(analyticsConversations)
		.where(eq(analyticsConversations.userId, userId))
		.orderBy(asc(analyticsConversations.billingMonth));
}

async function readRequiredFile(
	rootDir: string,
	storagePath: string,
	description: string,
): Promise<Buffer> {
	const root = resolve(rootDir);
	const fullPath = resolve(root, storagePath);
	if (fullPath !== root && !fullPath.startsWith(`${root}${sep}`)) {
		throw new Error(`Refusing to archive unsafe ${description}`);
	}
	try {
		return await readFile(fullPath);
	} catch (error) {
		throw new Error(`Failed to read ${description}`, { cause: error });
	}
}

function renderTaskStates(
	rows: Array<typeof conversationTaskStates.$inferSelect>,
) {
	if (rows.length === 0) return "";
	return `<section><h2>Continuity</h2>${renderTable(
		rows.map((row) => [
			row.objective,
			row.status,
			formatJsonList(row.decisionsJson),
			formatJsonList(row.nextStepsJson),
			formatDateTime(row.updatedAt),
		]),
	)}</section>`;
}

function renderMemoryEvents(rows: Array<typeof memoryEvents.$inferSelect>) {
	if (rows.length === 0) return "";
	return `<section><h2>Memory events</h2>${renderTable(
		rows.map((row) => [
			row.domain,
			row.eventType,
			memoryEventSummary(row),
			formatDateTime(row.observedAt),
		]),
	)}</section>`;
}

function memoryEventSummary(row: typeof memoryEvents.$inferSelect): string {
	const payload = parseJsonRecord(row.payloadJson);
	if (typeof payload?.summary === "string") return payload.summary;
	if (typeof payload?.content === "string") return payload.content;
	if (typeof payload?.text === "string") return payload.text;
	return row.subjectId ?? row.relatedId ?? "";
}

function summarizeUsage(rows: Array<typeof usageEvents.$inferSelect>) {
	const summary = {
		messages: 0,
		tokens: 0,
		costUsdMicros: 0,
		months: new Map<
			string,
			{ messages: number; tokens: number; costUsdMicros: number }
		>(),
		models: new Map<
			string,
			{ messages: number; tokens: number; costUsdMicros: number }
		>(),
	};

	for (const row of rows) {
		summary.messages += 1;
		summary.tokens += row.totalTokens;
		summary.costUsdMicros += row.costUsdMicros;

		const month = getUsageBucket(summary.months, row.billingMonth);
		month.messages += 1;
		month.tokens += row.totalTokens;
		month.costUsdMicros += row.costUsdMicros;

		const modelName =
			row.modelDisplayName ?? row.providerDisplayName ?? "Unknown model";
		const model = getUsageBucket(summary.models, modelName);
		model.messages += 1;
		model.tokens += row.totalTokens;
		model.costUsdMicros += row.costUsdMicros;
	}

	return summary;
}

function getUsageBucket(
	map: Map<string, { messages: number; tokens: number; costUsdMicros: number }>,
	key: string,
) {
	const existing = map.get(key);
	if (existing) return existing;
	const created = { messages: 0, tokens: 0, costUsdMicros: 0 };
	map.set(key, created);
	return created;
}

function summarizeAnalyticsConversations(
	rows: Array<typeof analyticsConversations.$inferSelect>,
) {
	const months = new Map<string, number>();
	for (const row of rows) {
		months.set(row.billingMonth, (months.get(row.billingMonth) ?? 0) + 1);
	}
	return Array.from(months.entries()).map(([month, count]) => [
		month,
		`${count} conversation${count === 1 ? "" : "s"}`,
	]);
}

function renderTable(rows: Array<Array<unknown>>): string {
	if (rows.length === 0) return `<p class="empty">No rows.</p>`;
	return `<table><tbody>${rows
		.map(
			(row) =>
				`<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`,
		)
		.join("")}</tbody></table>`;
}

function formatJsonList(value: string | null): string {
	if (!value) return "";
	try {
		const parsed = JSON.parse(value);
		if (Array.isArray(parsed)) {
			return parsed.map((item) => String(item)).join("; ");
		}
		return String(parsed);
	} catch {
		return value;
	}
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
	const grouped = new Map<string, T[]>();
	for (const row of rows) {
		const value = key(row);
		const group = grouped.get(value) ?? [];
		group.push(row);
		grouped.set(value, group);
	}
	return grouped;
}

function formatDateForFilename(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function formatDateTime(value: Date | number | null): string {
	if (!value) return "";
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function formatUsdMicros(value: number): string {
	return `$${(value / 1_000_000).toFixed(6)}`;
}

function displayFileName(name: string, extension: string | null): string {
	if (extname(name) || !extension) return basename(name);
	return `${basename(name)}.${extension}`;
}

function readableArtifactSubtitle(
	artifact: typeof artifacts.$inferSelect,
): string {
	switch (artifact.type) {
		case "source_document":
			return "Readable text already stored for an uploaded file.";
		case "normalized_document":
			return "Readable normalized document text already stored by AlfyAI.";
		case "generated_output":
			return "Readable generated file content already stored by AlfyAI.";
		default:
			return "Readable stored content.";
	}
}

function sanitizePathSegment(value: string): string {
	const safe = Array.from(basename(String(value || "Untitled")))
		.map((char) =>
			char.charCodeAt(0) < 32 || '<>:"\\|?*'.includes(char) ? "-" : char,
		)
		.join("")
		.replaceAll(/\s+/g, " ")
		.trim();
	return safe || "Untitled";
}

function relativeLink(_from: string, to: string): string {
	return to.startsWith("Chats/") ? to.slice("Chats/".length) : to;
}

function capitalize(value: string): string {
	return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}
