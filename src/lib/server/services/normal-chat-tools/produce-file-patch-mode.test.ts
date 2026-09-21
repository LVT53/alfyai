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

describe("every other patch-carrying request is unchanged", () => {
	it("resolves a model-authored program's patch into program.sourceCode", async () => {
		seedPreviousVersion(PREVIOUS_MARKDOWN);

		const body = await callProduceFile({
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

		// `xlsx` is not an inline-text type, so nothing about this path moved:
		// the program is still what runs.
		expect(body.sourceMode).toBe("program");
		expect(body.inlineText).toBeUndefined();
		expect(body.program).toEqual(
			expect.objectContaining({ filename: "quarterly-summary.xlsx" }),
		);
	});

	it("leaves a PDF patch on the document_source path", async () => {
		seedPreviousVersion(PREVIOUS_MARKDOWN);

		const body = await callProduceFile({
			requestTitle: TITLE,
			outputType: "pdf",
			markdown: PREVIOUS_MARKDOWN,
			patches: [{ oldText: "North", newText: "South" }],
		});

		expect(body.sourceMode).toBe("document_source");
		expect(body.inlineText).toBeUndefined();
	});

	it("writes a text patch through a program when the model authored one", async () => {
		// An explicit `program` for a `.md` output is the model saying it wants
		// code to run. The inline path is for the requests where the SERVER
		// picks the writer, so this one keeps its container.
		seedPreviousVersion(PREVIOUS_MARKDOWN);

		const body = await callProduceFile({
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

		expect(body.sourceMode).toBe("program");
		expect(body.inlineText).toBeUndefined();
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
			markdown: PREVIOUS_MARKDOWN,
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
				markdown: PREVIOUS_MARKDOWN,
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
				markdown: PREVIOUS_MARKDOWN,
				patches: [{ oldText: "North", newText: "South" }],
			},
			{ toolCallId: "tool-call-1", messages: [] },
		)) as { status: string; errorCode: string | null };

		expect(result.status).toBe("failed");
		expect(result.errorCode).toBe("no_previous_version_for_patches");
		expect(submitIntakeMock).not.toHaveBeenCalled();
	});
});
