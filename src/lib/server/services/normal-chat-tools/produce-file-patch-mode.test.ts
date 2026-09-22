/**
 * Which production mode a PATCH-carrying produce_file call ends up in.
 *
 * Phase 6 D8 gave plain-text outputs an `inline_text` mode that writes the
 * model's bytes directly, no Docker container and no generated `write_text`
 * one-liner. `normalizeProduceFileInput` could not use it for a patch, because
 * the patched bytes do not exist until the tool adapter has fetched the
 * previous version of the file — so every patched `.md` still started a
 * container to write text the app already had in memory.
 *
 * These tests pin the adapter's half of that decision, in both directions:
 * an all-plain-text patch becomes `inline_text` carrying the patched content,
 * and everything else — a real program, a document source, a binary output —
 * stays exactly where it was.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import type { FileProductionJob } from "$lib/server/services/file-production/types";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

vi.mock("$lib/server/services/file-production", async () => {
	const { waitForFileProductionJobVerdict } = await import(
		"$lib/server/services/file-production/job-wait"
	);
	return {
		submitFileProductionIntake: vi.fn(),
		getConversationFileProductionJob: vi.fn(),
		waitForFileProductionJobVerdict,
	};
});

vi.mock("$lib/server/services/analytics", () => ({
	recordParallelUsage: vi.fn(),
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(() => ({})),
}));

vi.mock("$lib/server/services/skills/prompt-context", () => ({
	resolveSkillInstructionsForUse: vi.fn(),
	SKILLS_AVAILABLE_HEADING: "## Skills available",
}));

const { getConversationFileProductionJob, submitFileProductionIntake } =
	await import("$lib/server/services/file-production");
const { createNormalChatTools } = await import("./index");

const submitIntakeMock = vi.mocked(submitFileProductionIntake);
const getJobMock = vi.mocked(getConversationFileProductionJob);

const USER = "user-1";
const CONVERSATION = "conversation-1";
const NOW = new Date("2026-09-20T10:00:00.000Z");
const TITLE = "Quarterly summary";

const PREVIOUS_MARKDOWN = [
	"# Quarterly summary",
	"",
	"Revenue grew 12% quarter over quarter, driven by the two enterprise",
	"renewals that closed in March, and the migration backlog is now under",
	"fifty tickets.",
	"",
	"| Region | Revenue |",
	"|---|---|",
	"| North | 24.25 |",
].join("\n");

function job(overrides: Partial<FileProductionJob> = {}): FileProductionJob {
	return {
		id: "job-1",
		conversationId: CONVERSATION,
		assistantMessageId: null,
		title: TITLE,
		status: "queued",
		createdAt: 1,
		updatedAt: 1,
		files: [],
		warnings: [],
		dismissed: false,
		error: null,
		// Required on the DTO since the follow-up that exposed the job's
		// source mode to the client. Omitting it made this factory the one
		// `tsc --noEmit` error outside the two known component-test files.
		sourceMode: null,
		...overrides,
	};
}

/** Mirrors `read-generated-file.ts`'s own constant. */
const CHAT_FILES_DIR = join(process.cwd(), "data", "chat-files");
const diskFiles: string[] = [];

/**
 * `getPreviousGeneratedFileContent` finds the most recent `generated_output`
 * artifact of this conversation whose text contains the request title, so the
 * seeded row has to carry the title the call will use.
 */
function seedPreviousVersion(
	contentText: string,
	metadata?: Record<string, unknown>,
): void {
	memory.db
		.insert(schema.artifacts)
		.values({
			id: randomUUID(),
			userId: USER,
			conversationId: CONVERSATION,
			type: "generated_output",
			retrievalClass: "durable",
			name: "quarterly-summary.md",
			mimeType: "text/markdown",
			contentText,
			metadataJson: metadata ? JSON.stringify(metadata) : null,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

/** A stored generated file: bytes on disk plus its `chat_generated_files` row. */
async function seedChatFileOnDisk(params: {
	filename: string;
	content: string;
	createdAt?: Date;
	conversationId?: string;
	userId?: string;
}): Promise<string> {
	const chatFileId = randomUUID();
	const conversationId = params.conversationId ?? CONVERSATION;
	const extension = params.filename.split(".").pop() ?? "bin";
	const storagePath = join(conversationId, `${chatFileId}.${extension}`);
	const absolute = join(CHAT_FILES_DIR, storagePath);
	await mkdir(dirname(absolute), { recursive: true });
	await writeFile(absolute, params.content, "utf8");
	diskFiles.push(absolute);

	memory.db
		.insert(schema.chatGeneratedFiles)
		.values({
			id: chatFileId,
			userId: params.userId ?? USER,
			conversationId,
			filename: params.filename,
			mimeType: "text/markdown",
			storagePath,
			sizeBytes: Buffer.byteLength(params.content),
			createdAt: params.createdAt ?? NOW,
		})
		.run();
	return chatFileId;
}

async function callProduceFile(
	input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const { tools } = createNormalChatTools({
		userId: USER,
		conversationId: CONVERSATION,
		turnId: "turn-1",
		fileProductionVerdictPollIntervalMs: 1,
	});
	await tools.produce_file.execute(input, {
		toolCallId: "tool-call-1",
		messages: [],
	});
	expect(submitIntakeMock).toHaveBeenCalledTimes(1);
	return submitIntakeMock.mock.calls[0][0].body as Record<string, unknown>;
}

/** The refusal payload of a call that never reaches intake. */
async function refuseProduceFile(
	input: Record<string, unknown>,
): Promise<{ status: string; errorCode: string | null; message: string }> {
	const { tools } = createNormalChatTools({
		userId: USER,
		conversationId: CONVERSATION,
		turnId: "turn-1",
	});
	const result = (await tools.produce_file.execute(input, {
		toolCallId: "tool-call-1",
		messages: [],
	})) as { status: string; errorCode: string | null; message: string };
	expect(submitIntakeMock).not.toHaveBeenCalled();
	return result;
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	memory.db
		.insert(schema.users)
		.values({
			id: USER,
			email: `${USER}@example.com`,
			passwordHash: "hash",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	memory.db
		.insert(schema.conversations)
		.values({
			id: CONVERSATION,
			userId: USER,
			title: TITLE,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();

	submitIntakeMock.mockReset();
	submitIntakeMock.mockResolvedValue({
		ok: true,
		status: 202,
		reused: false,
		job: job(),
	});
	// These tests are about the request the adapter SUBMITS, so the in-turn
	// verdict wait is given a terminal job on the first poll rather than being
	// left to time out.
	getJobMock.mockReset();
	getJobMock.mockResolvedValue(job({ status: "succeeded" }));
});

afterEach(async () => {
	while (diskFiles.length > 0) {
		await rm(diskFiles.pop() as string, { force: true });
	}
});

/**
 * What a REAL `generated_output` artifact's text looks like: the memory
 * wrapper `chat-files.buildGeneratedFileMemoryContent` writes, whose last
 * section is `buildGeneratedFileExtractedContentSection(text)` — and that
 * section runs the file through `previewText`, which collapses every run of
 * whitespace to one space and truncates at 6000 characters.
 *
 * Every other test in this file seeds the raw markdown directly, so none of
 * them sees what the patch resolver actually reads in production.
 */
function wrapAsMemoryText(fileText: string): string {
	const preview = fileText.replace(/\s+/g, " ").trim();
	return [
		"Generated file: quarterly-summary.md",
		"File type: text/markdown",
		"Chat file id: chat-file-1",
		`Generated in conversation: ${CONVERSATION}`,
		"Generated file version: v1",
		"",
		"Assistant response context:",
		"Here is the quarterly summary you asked for.",
		"",
		"Extracted file content:",
		preview,
	].join("\n");
}

describe("the base a patch is applied to", () => {
	it("is the file on disk, not the whitespace-collapsed memory preview", async () => {
		const chatFileId = randomUUID();
		const storagePath = join(CONVERSATION, `${chatFileId}.md`);
		const absolute = join(CHAT_FILES_DIR, storagePath);
		await mkdir(dirname(absolute), { recursive: true });
		await writeFile(absolute, PREVIOUS_MARKDOWN, "utf8");
		diskFiles.push(absolute);

		memory.db
			.insert(schema.chatGeneratedFiles)
			.values({
				id: chatFileId,
				userId: USER,
				conversationId: CONVERSATION,
				filename: "quarterly-summary.md",
				mimeType: "text/markdown",
				storagePath,
				sizeBytes: Buffer.byteLength(PREVIOUS_MARKDOWN),
				createdAt: NOW,
			})
			.run();
		seedPreviousVersion(wrapAsMemoryText(PREVIOUS_MARKDOWN), {
			generatedFile: true,
			originalChatFileId: chatFileId,
			generatedFilename: "quarterly-summary.md",
		});

		const body = await callProduceFile({
			requestTitle: TITLE,
			filename: "quarterly-summary.md",
			// A single-line excerpt, which is what a model sends most often and
			// the only kind that could still MATCH a base whose newlines are gone.
			patches: [{ oldText: "| North | 24.25 |", newText: "| South | 25.75 |" }],
		});

		const inlineText = body.inlineText as { content: string };
		// Before the fix this was the whole document on one line, because the
		// base came from the memory wrapper's `previewText` section.
		expect(inlineText.content).toBe(
			PREVIOUS_MARKDOWN.replace("| North | 24.25 |", "| South | 25.75 |"),
		);
	});

	// The patch base used to be its own resolver: scan this conversation's
	// `generated_output` artifacts, take the first whose BODY contains the
	// request title. It could only ever see artifacts — and the memory sync
	// that mints them is deferred until the assistant message is assigned, so
	// a file produced a moment earlier in the SAME turn had none. Patching it
	// was refused with `no_previous_version_for_patches`, for a file the user
	// could already see in the chat.
	it("is the file produced earlier in this same turn, before any artifact exists", async () => {
		await seedChatFileOnDisk({
			filename: "quarterly-summary.md",
			content: PREVIOUS_MARKDOWN,
		});

		const body = await callProduceFile({
			requestTitle: TITLE,
			filename: "quarterly-summary.md",
			patches: [{ oldText: "| North | 24.25 |", newText: "| South | 25.75 |" }],
		});

		const inlineText = body.inlineText as { content: string };
		expect(inlineText.content).toBe(
			PREVIOUS_MARKDOWN.replace("| North | 24.25 |", "| South | 25.75 |"),
		);
	});

	// And the second patch of the same file: v2 is on disk with no artifact
	// yet, v1 has one. The artifact scan could only find v1, so a patch whose
	// `oldText` came from v2 either failed to match or silently reverted the
	// first edit.
	it("is the newest version, not the one that happens to have an artifact", async () => {
		const version2 = PREVIOUS_MARKDOWN.replace(
			"| North | 24.25 |",
			"| South | 25.75 |",
		);
		const v1 = await seedChatFileOnDisk({
			filename: "quarterly-summary.md",
			content: PREVIOUS_MARKDOWN,
			createdAt: new Date("2026-09-20T10:00:00.000Z"),
		});
		seedPreviousVersion(wrapAsMemoryText(PREVIOUS_MARKDOWN), {
			generatedFile: true,
			originalChatFileId: v1,
			generatedFilename: "quarterly-summary.md",
			versionNumber: 1,
		});
		await seedChatFileOnDisk({
			filename: "quarterly-summary.md",
			content: version2,
			createdAt: new Date("2026-09-20T10:01:00.000Z"),
		});

		const body = await callProduceFile({
			requestTitle: TITLE,
			filename: "quarterly-summary.md",
			patches: [{ oldText: "| South | 25.75 |", newText: "| East | 31.00 |" }],
		});

		const inlineText = body.inlineText as { content: string };
		expect(inlineText.content).toBe(
			version2.replace("| South | 25.75 |", "| East | 31.00 |"),
		);
		// The first edit survives; the stale v1 was never the base.
		expect(inlineText.content).not.toContain("| North | 24.25 |");
	});
});

/**
 * THE LIVE FAILURE. The model produced `release-notes.md`, was asked to change
 * line 3 with a patch, and sent the patch with no filename — it had never been
 * told the name mattered, and its own history did not carry one. The app then
 * derived a FRESH name from that turn's request title
 * ("release-notes-for-small-app-release.md"), looked for a previous version
 * under THAT name, found nothing and answered `no_previous_version_for_patches`
 * for a file the user could see in the chat. The model gave up on patching and
 * regenerated the whole document.
 *
 * A name the app has just invented can only miss. What the request does carry
 * is a title and, sometimes, an output type; the file it means is one of THIS
 * conversation's own outputs.
 */
describe("which file a patch that names none is about", () => {
	const RELEASE_NOTES = [
		"# Release notes",
		"",
		"Line one introduces the release.",
		"Line two lists the headline change.",
		"Line three is the one the user wants changed.",
		"Line four thanks the contributors.",
	].join("\n");

	const CHANGELOG = [
		"# Changelog",
		"",
		"Line four is here too, which is why a patch has to say which file it",
		"means: the same excerpt matches in both of this conversation's outputs.",
		"Nothing else in this file is interesting.",
	].join("\n");

	it("is the conversation's only generated file, whatever the title would have named", async () => {
		await seedChatFileOnDisk({
			filename: "release-notes.md",
			content: RELEASE_NOTES,
		});

		const body = await callProduceFile({
			// The title of THIS turn, which would derive
			// `release-notes-for-small-app-release.txt` — a file that does not exist.
			requestTitle: "Release notes for small app release",
			patches: [
				{
					oldText: "Line three is the one the user wants changed.",
					newText: "Line three now says what the user asked for.",
				},
			],
		});

		const inlineText = body.inlineText as {
			content: string;
			files: Array<{ filename: string; outputType: string }>;
		};
		expect(inlineText.content).toBe(
			RELEASE_NOTES.replace(
				"Line three is the one the user wants changed.",
				"Line three now says what the user asked for.",
			),
		);
		// The patched file is the NEXT VERSION of the file it patched: same name,
		// same type — never `release-notes-for-small-app-release.txt` beside it.
		expect(inlineText.files).toEqual([
			{ filename: "release-notes.md", outputType: "md" },
		]);
		expect(body.requestedOutputs).toEqual([{ type: "md" }]);
	});

	it("is the file whose own name answers to the request title", async () => {
		await seedChatFileOnDisk({
			filename: "changelog.md",
			content: "# Changelog\n\nNothing to see here.",
			createdAt: new Date("2026-09-20T10:02:00.000Z"),
		});
		await seedChatFileOnDisk({
			filename: "release-notes.md",
			content: RELEASE_NOTES,
			createdAt: new Date("2026-09-20T10:00:00.000Z"),
		});

		const body = await callProduceFile({
			requestTitle: "Release notes for small app release",
			outputType: "md",
			patches: [{ oldText: "Line four", newText: "The last line" }],
		});

		// Two candidates of the same type, but only one answers to this title —
		// and it is the OLDER of the two, so "newest file" alone is not the rule.
		const inlineText = body.inlineText as {
			content: string;
			files: Array<{ filename: string }>;
		};
		expect(inlineText.files).toEqual([
			{ filename: "release-notes.md", outputType: "md" },
		]);
		expect(inlineText.content).toContain("The last line thanks");
	});

	it("refuses with the names when two files could be meant", async () => {
		await seedChatFileOnDisk({
			filename: "release-notes.md",
			content: RELEASE_NOTES,
			createdAt: new Date("2026-09-20T10:00:00.000Z"),
		});
		await seedChatFileOnDisk({
			filename: "changelog.md",
			content: CHANGELOG,
			createdAt: new Date("2026-09-20T10:02:00.000Z"),
		});

		const result = await refuseProduceFile({
			requestTitle: "Small app",
			outputType: "md",
			patches: [{ oldText: "Line four", newText: "The last line" }],
		});

		expect(result.status).toBe("failed");
		expect(result.errorCode).toBe("no_previous_version_for_patches");
		// Guessing here would edit the wrong document and report success. The
		// names are the way out: the model can only say which with `filename`.
		expect(result.message).toContain("release-notes.md");
		expect(result.message).toContain("changelog.md");
		expect(result.message).toContain("filename");
	});

	it("is the one the model names, when it names one", async () => {
		await seedChatFileOnDisk({
			filename: "release-notes.md",
			content: RELEASE_NOTES,
			createdAt: new Date("2026-09-20T10:00:00.000Z"),
		});
		await seedChatFileOnDisk({
			filename: "changelog.md",
			content: CHANGELOG,
			createdAt: new Date("2026-09-20T10:02:00.000Z"),
		});

		const body = await callProduceFile({
			requestTitle: "Small app",
			filename: "changelog.md",
			patches: [{ oldText: "Line four", newText: "The last line" }],
		});

		const inlineText = body.inlineText as {
			content: string;
			files: Array<{ filename: string; outputType: string }>;
		};
		expect(inlineText.files).toEqual([
			{ filename: "changelog.md", outputType: "md" },
		]);
		expect(inlineText.content).toContain("The last line is here too,");
		// The file the model did NOT name is untouched by this request.
		expect(inlineText.content).not.toContain("Release notes");
	});

	it("keeps the original filename when the patched file becomes v2", async () => {
		await seedChatFileOnDisk({
			filename: "release-notes.md",
			content: RELEASE_NOTES,
			createdAt: new Date("2026-09-20T10:00:00.000Z"),
		});

		const body = await callProduceFile({
			requestTitle: "Release notes",
			patches: [{ oldText: "Line two", newText: "Line 2" }],
		});
		const patched = (body.inlineText as { content: string }).content;

		// Intake is mocked, so stand in for the production job: the file it would
		// write is the one the request names, under the same name.
		const files = (body.inlineText as { files: Array<{ filename: string }> })
			.files;
		expect(files).toEqual([{ filename: "release-notes.md", outputType: "md" }]);
		await seedChatFileOnDisk({
			filename: files[0].filename,
			content: patched,
			createdAt: new Date("2026-09-20T10:05:00.000Z"),
		});

		// …and the model reading it back by that one name gets the NEW version.
		const { tools } = createNormalChatTools({
			userId: USER,
			conversationId: CONVERSATION,
			turnId: "turn-2",
		});
		const read = (await tools.read_generated_file.execute(
			{ filename: "release-notes.md" },
			{ toolCallId: "tool-call-read", messages: [] },
		)) as {
			found: boolean;
			filename: string | null;
			content: string;
			versionNumber: number | string | null;
		};

		expect(read.found).toBe(true);
		expect(read.filename).toBe("release-notes.md");
		expect(read.content).toContain("Line 2 lists the headline change.");
		expect(read.content).not.toContain("Line two lists");
		// The patched file is on disk and its artifact link is not minted yet,
		// so the tool says "latest" rather than a number. It used to count the
		// same-named files of THIS conversation and answer 2 — right here, and
		// a stale 1 whenever the earlier version of the family lived in another
		// conversation, which the sync then contradicted seconds later.
		expect(read.versionNumber).toBe("latest");
	});
});

describe("a patch whose outputs are all plain text", () => {
	it("is written inline instead of in a container", async () => {
		seedPreviousVersion(PREVIOUS_MARKDOWN);

		const body = await callProduceFile({
			requestTitle: TITLE,
			filename: "quarterly-summary.md",
			patches: [{ oldText: "| North | 24.25 |", newText: "| South | 25.75 |" }],
		});

		expect(body.sourceMode).toBe("inline_text");
		expect(body.program).toBeUndefined();
		// The bytes are the patched file, verbatim — not a Python program that
		// would reproduce them.
		const inlineText = body.inlineText as {
			content: string;
			files: Array<{ filename: string; outputType: string }>;
		};
		expect(inlineText.content).toBe(
			PREVIOUS_MARKDOWN.replace("| North | 24.25 |", "| South | 25.75 |"),
		);
		expect(inlineText.content).not.toContain("North");
		expect(inlineText.files).toEqual([
			{ filename: "quarterly-summary.md", outputType: "md" },
		]);
		// Patches are the adapter's business; intake never sees them.
		expect(body.patches).toBeUndefined();
	});

	it("names the file exactly as the whole-content path would", async () => {
		// The point of re-normalising rather than hand-building the request: for
		// the same declared shape, a patched file and the same file sent whole
		// cannot end up named differently, which would silently fork the
		// artifact the next patch is then resolved against.
		seedPreviousVersion(PREVIOUS_MARKDOWN);
		const shape = { requestTitle: TITLE, filename: "quarterly-summary.md" };

		const patched = await callProduceFile({
			...shape,
			patches: [{ oldText: "North", newText: "South" }],
		});
		submitIntakeMock.mockClear();
		const whole = await callProduceFile({
			...shape,
			markdown: PREVIOUS_MARKDOWN.replace("North", "South"),
		});

		expect(patched.sourceMode).toBe("inline_text");
		expect(whole.sourceMode).toBe("inline_text");
		expect(patched.inlineText).toEqual(whole.inlineText);
		expect(patched.requestedOutputs).toEqual(whole.requestedOutputs);
	});

	it("defaults a typeless patch to txt, exactly as before", async () => {
		// A patch-only call names no format, so the type ladder falls back to
		// `txt` — the same fallback `resolveTextFilename` has always applied on
		// the program path. Moving the request to inline_text did not change
		// which file it addresses.
		seedPreviousVersion(PREVIOUS_MARKDOWN);

		const body = await callProduceFile({
			requestTitle: TITLE,
			patches: [{ oldText: "North", newText: "South" }],
		});

		expect(body.sourceMode).toBe("inline_text");
		expect(body.requestedOutputs).toEqual([{ type: "txt" }]);
		expect((body.inlineText as { files: unknown }).files).toEqual([
			{ filename: "quarterly-summary.txt", outputType: "txt" },
		]);
	});

	it("still refuses a patch with no previous version to apply it to", async () => {
		const { tools } = createNormalChatTools({
			userId: USER,
			conversationId: CONVERSATION,
			turnId: "turn-1",
		});
		const result = (await tools.produce_file.execute(
			{
				requestTitle: TITLE,
				filename: "quarterly-summary.md",
				patches: [{ oldText: "North", newText: "South" }],
			},
			{ toolCallId: "tool-call-1", messages: [] },
		)) as { status: string; errorCode: string | null };

		expect(result.status).toBe("failed");
		expect(result.errorCode).toBe("no_previous_version_for_patches");
		expect(submitIntakeMock).not.toHaveBeenCalled();
	});

	it("still refuses a patch whose oldText is not in the previous version", async () => {
		seedPreviousVersion(PREVIOUS_MARKDOWN);

		const { tools } = createNormalChatTools({
			userId: USER,
			conversationId: CONVERSATION,
			turnId: "turn-1",
		});
		const result = (await tools.produce_file.execute(
			{
				requestTitle: TITLE,
				filename: "quarterly-summary.md",
				patches: [{ oldText: "nothing like this exists", newText: "x" }],
			},
			{ toolCallId: "tool-call-1", messages: [] },
		)) as { status: string; errorCode: string | null };

		expect(result.status).toBe("failed");
		expect(result.errorCode).toBe("patch_failed");
		expect(submitIntakeMock).not.toHaveBeenCalled();
	});
});

/**
 * A request may bring patches, or it may bring the whole new version — never
 * both.
 *
 * These calls used to be accepted, and whichever half the branch order
 * happened to reach was the one that ran: an explicit `sourceMode` took the
 * content and threw the patches away, a model-authored `program` ran its own
 * code with the patch folded in or not at all. Either way a request the model
 * meant as "change these two lines" could ship a file built from something
 * else and report success. The two claims contradict each other, so the call
 * is refused and the model told to pick one.
 */
describe("a patch-carrying request that also brings its own content", () => {
	async function refusal(
		input: Record<string, unknown>,
	): Promise<{ status: string; errorCode: string | null; message?: string }> {
		const { tools } = createNormalChatTools({
			userId: USER,
			conversationId: CONVERSATION,
			turnId: "turn-1",
		});
		return (await tools.produce_file.execute(input, {
			toolCallId: "tool-call-1",
			messages: [],
		})) as { status: string; errorCode: string | null; message?: string };
	}

	it("refuses a model-authored program sent with patches", async () => {
		seedPreviousVersion(PREVIOUS_MARKDOWN);

		const result = await refusal({
			requestTitle: TITLE,
			outputType: "xlsx",
			sourceMode: "program",
			program: {
				language: "python",
				sourceCode: "print('original')",
				filename: "quarterly-summary.xlsx",
			},
			patches: [{ oldText: "North", newText: "South" }],
		});

		expect(result.status).toBe("failed");
		expect(result.errorCode).toBe("invalid_tool_input");
		expect(result.message).toContain("not both");
		expect(submitIntakeMock).not.toHaveBeenCalled();
	});

	it("refuses markdown sent with patches", async () => {
		seedPreviousVersion(PREVIOUS_MARKDOWN);

		const result = await refusal({
			requestTitle: TITLE,
			outputType: "pdf",
			markdown: PREVIOUS_MARKDOWN,
			patches: [{ oldText: "North", newText: "South" }],
		});

		expect(result.status).toBe("failed");
		expect(result.errorCode).toBe("invalid_tool_input");
		expect(result.message).toContain("not both");
		expect(submitIntakeMock).not.toHaveBeenCalled();
	});

	it("refuses a model-authored text program sent with patches", async () => {
		seedPreviousVersion(PREVIOUS_MARKDOWN);

		const result = await refusal({
			requestTitle: TITLE,
			outputType: "md",
			sourceMode: "program",
			program: {
				language: "python",
				sourceCode: "print('original')",
				filename: "quarterly-summary.md",
			},
			patches: [{ oldText: "North", newText: "South" }],
		});

		expect(result.status).toBe("failed");
		expect(result.errorCode).toBe("invalid_tool_input");
		expect(result.message).toContain("not both");
		expect(submitIntakeMock).not.toHaveBeenCalled();
	});
});

/**
 * The document half of the same promise.
 *
 * `produce_file`'s description tells the model that patches change an existing
 * file "to change an existing file … send `patches`", for every format. On the
 * document_source path they were stripped one line before intake, so a PDF
 * request reported success and shipped the file WITHOUT the edit.
 */
describe("a patch whose outputs are a document", () => {
	/** Every text block a `documentSource` envelope carries, flattened. */
	function documentText(body: Record<string, unknown>): string {
		return JSON.stringify(
			(body.documentSource as { blocks?: unknown })?.blocks ?? [],
		);
	}

	it("produces the document from the PATCHED markdown", async () => {
		seedPreviousVersion(PREVIOUS_MARKDOWN);

		const body = await callProduceFile({
			requestTitle: TITLE,
			outputType: "pdf",
			patches: [{ oldText: "| North | 24.25 |", newText: "| South | 25.75 |" }],
		});

		expect(body.sourceMode).toBe("document_source");
		expect(body.patches).toBeUndefined();
		const text = documentText(body);
		expect(text).toContain("South");
		expect(text).toContain("25.75");
		expect(text).not.toContain("North");
		expect(text).not.toContain("24.25");
	});

	it("builds the document even when the model sends patches alone", async () => {
		// No `markdown`: the previous version IS the content, and the request
		// names a document output. This used to write the patched TEXT into a
		// file called `.pdf`.
		seedPreviousVersion(PREVIOUS_MARKDOWN);

		const body = await callProduceFile({
			requestTitle: TITLE,
			outputType: "pdf",
			patches: [{ oldText: "North", newText: "South" }],
		});

		expect(body.sourceMode).toBe("document_source");
		expect(body.program).toBeUndefined();
		expect(documentText(body)).toContain("South");
	});

	it("refuses when the previous document holds a block its text cannot carry", async () => {
		// The base a patch applies to is the Markdown `read_generated_file`
		// showed the model, and a chart does not survive a round trip through
		// it. Rebuilding the document from that text would ship a report with
		// the chart gone, so the call is refused instead.
		seedPreviousVersion(PREVIOUS_MARKDOWN, {
			generatedFile: true,
			generatedDocumentSource: {
				version: 1,
				template: "alfyai_standard_report",
				title: TITLE,
				blocks: [
					{ type: "paragraph", text: "Revenue grew 12% quarter over quarter." },
					{
						type: "chart",
						chartType: "bar",
						title: "Revenue by region",
						caption: "Quarterly revenue.",
						units: "EUR",
						altText: "Revenue by region.",
						xKey: "label",
						yKey: "value",
						data: [{ label: "North", value: 24.25 }],
					},
				],
			},
		});

		const { tools } = createNormalChatTools({
			userId: USER,
			conversationId: CONVERSATION,
			turnId: "turn-1",
		});
		const result = (await tools.produce_file.execute(
			{
				requestTitle: TITLE,
				outputType: "pdf",
				patches: [{ oldText: "North", newText: "South" }],
			},
			{ toolCallId: "tool-call-1", messages: [] },
		)) as { status: string; errorCode: string | null; message?: string };

		expect(result.status).toBe("failed");
		expect(result.errorCode).toBe("patch_not_applicable");
		expect(result.message).toContain("chart");
		// Never a success on an unpatched document.
		expect(submitIntakeMock).not.toHaveBeenCalled();
	});

	it("still refuses a document patch whose oldText does not match", async () => {
		seedPreviousVersion(PREVIOUS_MARKDOWN);

		const { tools } = createNormalChatTools({
			userId: USER,
			conversationId: CONVERSATION,
			turnId: "turn-1",
		});
		const result = (await tools.produce_file.execute(
			{
				requestTitle: TITLE,
				outputType: "pdf",
				patches: [{ oldText: "nothing like this exists", newText: "x" }],
			},
			{ toolCallId: "tool-call-1", messages: [] },
		)) as { status: string; errorCode: string | null };

		expect(result.status).toBe("failed");
		expect(result.errorCode).toBe("patch_failed");
		expect(submitIntakeMock).not.toHaveBeenCalled();
	});

	it("refuses a document patch with no previous version at all", async () => {
		const { tools } = createNormalChatTools({
			userId: USER,
			conversationId: CONVERSATION,
			turnId: "turn-1",
		});
		const result = (await tools.produce_file.execute(
			{
				requestTitle: TITLE,
				outputType: "pdf",
				patches: [{ oldText: "North", newText: "South" }],
			},
			{ toolCallId: "tool-call-1", messages: [] },
		)) as { status: string; errorCode: string | null };

		expect(result.status).toBe("failed");
		expect(result.errorCode).toBe("no_previous_version_for_patches");
		expect(submitIntakeMock).not.toHaveBeenCalled();
	});
});

/**
 * THE LIVE FAILURE. The model's first patch call was
 * `{filename:"alpha-notes.md", sourceMode:"document_source", patches:[…]}` —
 * no content of its own, because a patch's content IS the base file plus the
 * edit. `normalizeProduceFileInput` ran its explicit-mode branches first and
 * refused with `documentSource or content is required when sourceMode is
 * document_source`, so the model abandoned patching and rewrote the whole
 * file.
 *
 * A request that carries patches and nothing of its own is a PATCH request
 * whatever `sourceMode` says: the mode follows from the base file and the
 * requested outputs, which is what the patch path already decides.
 */
describe("a patch request whose sourceMode names a mode it brought no content for", () => {
	const ALPHA_NOTES = [
		"# Alpha notes",
		"",
		"Line one introduces the alpha.",
		"Line two lists the headline change.",
		"Line three is the one the user wants changed.",
		"Line four thanks the testers.",
	].join("\n");

	it.each([
		"document_source",
		"program",
	] as const)("is produced as the next version of the base file with sourceMode %o", async (sourceMode) => {
		await seedChatFileOnDisk({
			filename: "alpha-notes.md",
			content: ALPHA_NOTES,
		});

		const body = await callProduceFile({
			requestTitle: "Alpha notes",
			filename: "alpha-notes.md",
			sourceMode,
			patches: [
				{
					oldText: "Line three is the one the user wants changed.",
					newText: "Line three now says what the user asked for.",
				},
			],
		});

		// The base is a Markdown file, so the mode the SERVER picks is
		// inline_text — no container, no report renderer — whatever mode the
		// model named for the content it did not send.
		expect(body.sourceMode).toBe("inline_text");
		expect(body.program).toBeUndefined();
		const inlineText = body.inlineText as {
			content: string;
			files: Array<{ filename: string; outputType: string }>;
		};
		expect(inlineText.content).toBe(
			ALPHA_NOTES.replace(
				"Line three is the one the user wants changed.",
				"Line three now says what the user asked for.",
			),
		);
		expect(inlineText.files).toEqual([
			{ filename: "alpha-notes.md", outputType: "md" },
		]);
	});

	it("still goes down the document path when the outputs are a document", async () => {
		// Same shape, but the request asks for a PDF: the patched Markdown is
		// rebuilt into a document source, exactly as a patch with no sourceMode
		// already was.
		seedPreviousVersion(PREVIOUS_MARKDOWN);

		const body = await callProduceFile({
			requestTitle: TITLE,
			outputType: "pdf",
			sourceMode: "document_source",
			patches: [{ oldText: "| North | 24.25 |", newText: "| South | 25.75 |" }],
		});

		expect(body.sourceMode).toBe("document_source");
		expect(body.program).toBeUndefined();
		const blocks = JSON.stringify(
			(body.documentSource as { blocks?: unknown })?.blocks ?? [],
		);
		expect(blocks).toContain("25.75");
		expect(blocks).not.toContain("24.25");
	});

	it("still refuses when there is no base to patch", async () => {
		// Ignoring the named mode must not turn a patch with no previous version
		// into something else: it is the same honest refusal as before.
		const result = await refuseProduceFile({
			requestTitle: "Alpha notes",
			filename: "alpha-notes.md",
			sourceMode: "document_source",
			patches: [{ oldText: "Line three", newText: "Line 3" }],
		});

		expect(result.status).toBe("failed");
		expect(result.errorCode).toBe("no_previous_version_for_patches");
	});
});

/**
 * The other half of the owner's ruling on cross-conversation families.
 *
 * A generated file's family and version number already span conversations, so
 * a patch aimed at the release notes from a fresh conversation was aimed at a
 * file `produce_file` could not reach: it answered
 * `no_previous_version_for_patches` for a document the app itself had just
 * called v2. An explicitly NAMED file may now come from an earlier
 * conversation; an inferred one may not.
 */
describe("patching a file made in an earlier conversation", () => {
	const EARLIER_CONVERSATION = "conversation-earlier";

	function seedOtherConversation(id = EARLIER_CONVERSATION, userId = USER) {
		memory.db
			.insert(schema.conversations)
			.values({
				id,
				userId,
				title: "Earlier",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
	}

	it("uses the named file from elsewhere as the base", async () => {
		seedOtherConversation();
		await seedChatFileOnDisk({
			filename: "quarterly-summary.md",
			content: PREVIOUS_MARKDOWN,
			conversationId: EARLIER_CONVERSATION,
		});

		const body = await callProduceFile({
			requestTitle: TITLE,
			filename: "quarterly-summary.md",
			patches: [{ oldText: "| North | 24.25 |", newText: "| South | 25.75 |" }],
		});

		// Patched from the earlier version, and written into THIS conversation
		// under the SAME filename — the next version of that family, not a fork.
		expect(body.conversationId).toBe(CONVERSATION);
		expect(body.sourceMode).toBe("inline_text");
		expect(body.inlineText).toMatchObject({
			files: [{ filename: "quarterly-summary.md", outputType: "md" }],
		});
		const content = (body.inlineText as { content: string }).content;
		expect(content).toContain("| South | 25.75 |");
		expect(content).not.toContain("| North | 24.25 |");
	});

	it("prefers this conversation's copy over the earlier one", async () => {
		seedOtherConversation();
		await seedChatFileOnDisk({
			filename: "quarterly-summary.md",
			content: PREVIOUS_MARKDOWN,
			conversationId: EARLIER_CONVERSATION,
		});
		await seedChatFileOnDisk({
			filename: "quarterly-summary.md",
			content: PREVIOUS_MARKDOWN.replace(
				"| North | 24.25 |",
				"| East | 11.00 |",
			),
			createdAt: new Date("2026-09-21T10:00:00.000Z"),
		});

		const body = await callProduceFile({
			requestTitle: TITLE,
			filename: "quarterly-summary.md",
			patches: [{ oldText: "| East | 11.00 |", newText: "| West | 12.00 |" }],
		});

		const content = (body.inlineText as { content: string }).content;
		expect(content).toContain("| West | 12.00 |");
	});

	it("does not guess across conversations without a filename", async () => {
		// Title-only resolution stays scoped to THIS conversation: reaching into
		// another one on a guess would let "update the summary" rewrite a
		// document the user has not mentioned here at all.
		seedOtherConversation();
		await seedChatFileOnDisk({
			filename: "quarterly-summary.md",
			content: PREVIOUS_MARKDOWN,
			conversationId: EARLIER_CONVERSATION,
		});

		const result = await refuseProduceFile({
			requestTitle: TITLE,
			patches: [{ oldText: "| North | 24.25 |", newText: "| South | 25.75 |" }],
		});

		expect(result.status).toBe("failed");
		expect(result.errorCode).toBe("no_previous_version_for_patches");
	});

	it("never patches another user's file of the same name", async () => {
		memory.db
			.insert(schema.users)
			.values({
				id: "user-2",
				email: "user-2@example.com",
				passwordHash: "hash",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		seedOtherConversation("conversation-foreign", "user-2");
		await seedChatFileOnDisk({
			filename: "quarterly-summary.md",
			content: PREVIOUS_MARKDOWN,
			conversationId: "conversation-foreign",
			userId: "user-2",
		});

		const result = await refuseProduceFile({
			requestTitle: TITLE,
			filename: "quarterly-summary.md",
			patches: [{ oldText: "| North | 24.25 |", newText: "| South | 25.75 |" }],
		});

		expect(result.status).toBe("failed");
		expect(result.errorCode).toBe("no_previous_version_for_patches");
	});
});
