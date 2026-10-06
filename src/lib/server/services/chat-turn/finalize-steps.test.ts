/**
 * The evidence step against a real (in-memory) database.
 *
 * `persistAssistantEvidence` is the one place a finished turn's evidence and
 * its "project files read" count are composed and written, in one metadata
 * write, and `getMessageEvidenceState` is what the evidence endpoint the live
 * page polls reads back. These tests drive both for real — the project's link
 * table, the normalized sibling, the persisted metadata — so the count the
 * Info popover prints is checked where it is actually made. The same step
 * builds the "Made in this chat" group from the turn's own finished
 * create_artifact / edit_artifact calls; those tests make the items with the
 * real tools, so the metadata the group reads is the metadata the tools write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import type { ToolCallEntry } from "$lib/server/services/messages-types";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

vi.mock("$lib/server/services/tei-reranker", () => ({
	canUseTeiReranker: vi.fn(() => false),
	rerankItems: vi.fn(),
}));

// Binds its query executor to `db` at import, before any test has a database;
// the evidence step never touches drafts.
vi.mock("$lib/server/services/conversation-drafts", () => ({
	clearConversationDraft: vi.fn(),
}));

const { persistAssistantEvidence } = await import("./finalize-steps");
const { createNormalChatTools, createToolCallRecorder } = await import(
	"$lib/server/services/normal-chat-tools"
);
const { getMessageEvidenceState } = await import(
	"$lib/server/services/messages"
);
const { toolReadArtifactIdsMetadata } = await import(
	"$lib/server/services/message-evidence"
);
const { deleteArtifact, readDocumentForAlfy } = await import(
	"$lib/server/services/artifacts"
);
const { runCreateArtifactTool } = await import(
	"$lib/server/services/normal-chat-tools/artifact-tools/create"
);

const USER = "user-1";
const PROJECT = "project-vienna";
const CONVERSATION = "conv-in-project";
const ASSISTANT_MESSAGE = "assistant-1";
/** The uploaded PDF the library shows; the project's link is stored on it. */
const ITINERARY = "artifact-itinerary";
/** Its normalized sibling: where the text lives, and what the tool reads. */
const ITINERARY_NORMALIZED = "artifact-itinerary-normalized";
/** A library document the project does not know. */
const PACKING_LIST = "artifact-packing-list";
const NOW = new Date("2026-09-25T09:00:00.000Z");

function seedProjectConversation() {
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
		.insert(schema.projects)
		.values({
			id: PROJECT,
			userId: USER,
			name: "Vienna trip",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	memory.db
		.insert(schema.conversations)
		.values({
			id: CONVERSATION,
			userId: USER,
			title: "Train times",
			projectId: PROJECT,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	memory.db
		.insert(schema.artifacts)
		.values([
			{
				id: ITINERARY,
				userId: USER,
				type: "source_document",
				retrievalClass: "durable",
				name: "Wien itinerary.pdf",
				mimeType: "application/pdf",
				createdAt: NOW,
				updatedAt: NOW,
			},
			{
				id: ITINERARY_NORMALIZED,
				userId: USER,
				type: "normalized_document",
				retrievalClass: "durable",
				name: "Wien itinerary.pdf",
				mimeType: "text/markdown",
				contentText: "Budapest 07:40, Wien 10:04, coach 24.",
				createdAt: NOW,
				updatedAt: NOW,
			},
			{
				id: PACKING_LIST,
				userId: USER,
				type: "normalized_document",
				retrievalClass: "durable",
				name: "Packing list.md",
				mimeType: "text/markdown",
				contentText: "Passport, rail pass, umbrella.",
				createdAt: NOW,
				updatedAt: NOW,
			},
		])
		.run();
	memory.db
		.insert(schema.artifactLinks)
		.values({
			id: "link-itinerary-derived",
			userId: USER,
			artifactId: ITINERARY_NORMALIZED,
			relatedArtifactId: ITINERARY,
			linkType: "derived_from",
			createdAt: NOW,
		})
		.run();
	memory.db
		.insert(schema.projectKnowledgeLinks)
		.values({
			id: "link-project-itinerary",
			userId: USER,
			projectId: PROJECT,
			artifactId: ITINERARY,
			createdAt: NOW,
		})
		.run();
	memory.db
		.insert(schema.messages)
		.values({
			id: ASSISTANT_MESSAGE,
			conversationId: CONVERSATION,
			messageSequence: 2,
			role: "assistant",
			content: "The train leaves Budapest at 07:40.",
			metadataJson: JSON.stringify({ evidenceStatus: "pending" }),
			createdAt: NOW,
		})
		.run();
}

/** A finished `read_generated_file` call that read these artifacts. */
function readCall(artifactIds: string[]): ToolCallEntry {
	return {
		callId: "call-read-1",
		name: "read_generated_file",
		input: { filename: "Wien itinerary.pdf" },
		status: "done",
		outputSummary: 'Found "Wien itinerary.pdf" (37 chars).',
		sourceType: "tool",
		metadata: {
			ok: true,
			evidenceReady: false,
			found: true,
			source: "document",
			...toolReadArtifactIdsMetadata(artifactIds),
		},
	};
}

function persistEvidence(toolCalls: ToolCallEntry[]) {
	return persistAssistantEvidence({
		turnKind: "stream",
		userId: USER,
		conversationId: CONVERSATION,
		assistantMessageId: ASSISTANT_MESSAGE,
		normalizedMessage: "When does the train leave?",
		assistantResponse: "The train leaves Budapest at 07:40.",
		attachmentIds: [],
		contextDebug: null,
		toolCalls,
	});
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedProjectConversation();
});

afterEach(() => {
	memory.close();
});

describe("persistAssistantEvidence — the project files a turn read", () => {
	it("counts a project file the model read with a tool, and delivers it with its evidence", async () => {
		// Nothing was selected as evidence: the model found the file in the
		// project's list and read it itself — the turn the row used to miss.
		await persistEvidence([readCall([ITINERARY_NORMALIZED])]);

		const state = await getMessageEvidenceState(
			CONVERSATION,
			ASSISTANT_MESSAGE,
		);
		expect(state?.projectFilesRead).toBe(1);
		// The evidence endpoint hands the count to the live page only alongside
		// a non-empty evidence summary. A tool-only read still has one — the
		// read itself is a Tool Outputs row — so the count is never stranded.
		expect(state?.status).toBe("ready");
		expect(
			state?.evidenceSummary?.groups.some(
				(group) => group.sourceType === "tool" && group.items.length > 0,
			),
		).toBe(true);
	});

	it("counts the project file a real read_generated_file call read", async () => {
		// The tool's own lookup, its own record, the evidence step's count: no
		// hand-written metadata anywhere between the read and the number.
		const recorder = createToolCallRecorder();
		const { tools } = createNormalChatTools({
			userId: USER,
			conversationId: CONVERSATION,
			turnId: "turn-1",
			recorder,
		});
		const readFile = (filename: string, toolCallId: string) =>
			tools.read_generated_file.execute(
				{ filename },
				{ toolCallId, messages: [] },
			);

		await readFile("Wien itinerary.pdf", "call-project-file");
		// Read and recorded like any file, but not the project's.
		await readFile("Packing list.md", "call-library-file");
		await readFile("Nowhere.md", "call-miss");

		const entries = recorder.getEntries();
		expect(entries.map((entry) => entry.metadata?.readArtifactIds)).toEqual([
			ITINERARY_NORMALIZED,
			PACKING_LIST,
			undefined,
		]);

		await persistEvidence(entries);

		const state = await getMessageEvidenceState(
			CONVERSATION,
			ASSISTANT_MESSAGE,
		);
		expect(state?.projectFilesRead).toBe(1);
	});

	it("does not credit a tool read of a file outside the conversation's project", async () => {
		await persistEvidence([readCall([PACKING_LIST])]);

		const state = await getMessageEvidenceState(
			CONVERSATION,
			ASSISTANT_MESSAGE,
		);
		expect(state?.status).toBe("ready");
		expect(state?.projectFilesRead).toBeUndefined();
	});
});

// Rulings 6 and 7: what the turn made or changed is evidence of the turn. The
// group is read off the turn's own finished calls — nothing is queried to
// build it — so the rows below come from the real tools' own records.
describe("persistAssistantEvidence — what the turn made", () => {
	async function runTools(
		calls: (
			tools: ReturnType<typeof createNormalChatTools>["tools"],
		) => Promise<void>,
		overrides: { conversationId?: string } = {},
	): Promise<ToolCallEntry[]> {
		const recorder = createToolCallRecorder();
		const { tools } = createNormalChatTools({
			userId: USER,
			conversationId: overrides.conversationId ?? CONVERSATION,
			turnId: "turn-made",
			recorder,
		});
		await calls(tools);
		return recorder.getEntries();
	}

	const create = (
		tools: ReturnType<typeof createNormalChatTools>["tools"],
		title: string,
		toolCallId: string,
	) =>
		tools.create_artifact.execute(
			{ artifactType: "document", title, body: "Book the museum tickets." },
			{ toolCallId, messages: [] },
		);

	async function stored(
		conversationId = CONVERSATION,
		messageId = ASSISTANT_MESSAGE,
	) {
		return getMessageEvidenceState(conversationId, messageId);
	}

	function madeGroup(state: Awaited<ReturnType<typeof stored>>) {
		return state?.evidenceSummary?.groups.find(
			(group) => group.sourceType === "artifact",
		);
	}

	it("lists the Document the turn made, with its kind, as one reference row", async () => {
		let madeId = "";
		const entries = await runTools(async (tools) => {
			const result = (await create(tools, "Weekend plan", "call-create")) as {
				artifactId: string;
			};
			madeId = result.artifactId;
		});

		await persistEvidence(entries);

		const state = await stored();
		expect(state?.status).toBe("ready");
		const group = state?.evidenceSummary?.groups.find(
			(candidate) => candidate.sourceType === "artifact",
		);
		expect(group?.label).toBe("Made in this chat");
		expect(group?.items).toEqual([
			expect.objectContaining({
				id: madeId,
				artifactId: madeId,
				title: "Weekend plan",
				sourceType: "artifact",
				status: "reference",
				metadata: { artifactKind: "document" },
			}),
		]);
		// The Document is not also dressed up as a retrieved document.
		expect(
			state?.evidenceSummary?.groups.some(
				(candidate) => candidate.sourceType === "document",
			),
		).toBe(false);
	});

	it("lists an item once when the turn made it and then changed it", async () => {
		let madeId = "";
		const entries = await runTools(async (tools) => {
			const result = (await create(tools, "Weekend plan", "call-create")) as {
				artifactId: string;
			};
			madeId = result.artifactId;
			const read = await readDocumentForAlfy({
				userId: USER,
				artifactId: madeId,
				conversationId: CONVERSATION,
			});
			const [block] = read?.blocks ?? [];
			await tools.edit_artifact.execute(
				{
					artifactId: madeId,
					patches: [
						{
							op: "replaceBlock",
							blockId: block?.blockId,
							baseHash: block?.hash,
							text: "Book the museum tickets for Saturday.",
						},
					],
				},
				{ toolCallId: "call-edit", messages: [] },
			);
		});
		expect(entries.map((entry) => entry.name)).toEqual([
			"create_artifact",
			"edit_artifact",
		]);
		expect(entries.map((entry) => entry.metadata?.ok)).toEqual([true, true]);

		await persistEvidence(entries);

		expect(madeGroup(await stored())?.items).toHaveLength(1);
		expect(madeGroup(await stored())?.items[0]).toMatchObject({
			artifactId: madeId,
			title: "Weekend plan",
		});
	});

	it("lists nothing for a call that made or changed nothing", async () => {
		const entries = await runTools(async (tools) => {
			await tools.edit_artifact.execute(
				{
					artifactId: "no-such-item",
					patches: [
						{ op: "replaceBlock", blockId: "p1", baseHash: "x", text: "y" },
					],
				},
				{ toolCallId: "call-edit-missing", messages: [] },
			);
		});
		// A Slides item cannot be made while the kind is shelved (ruling 69): the
		// tool's own refusal is what a turn that asked for one would have recorded.
		const slides = await runCreateArtifactTool({
			userId: USER,
			conversationId: CONVERSATION,
			turnId: "turn-made",
			artifactType: "slides",
			title: "Quarterly deck",
			body: "# Slide one",
			language: "en",
			abortSignal: new AbortController().signal,
		});
		entries.push({
			callId: "call-slides",
			name: "create_artifact",
			input: { artifactType: "slides", title: "Quarterly deck" },
			status: "done",
			outputSummary: slides.outputSummary,
			sourceType: "tool",
			metadata: slides.metadata,
		});
		expect(entries.map((entry) => entry.metadata?.ok)).toEqual([false, false]);

		await persistEvidence(entries);

		expect(madeGroup(await stored())).toBeUndefined();
	});

	it("names only kinds that ship, whatever a call's own record says", async () => {
		const succeeded = (artifactKind: string): ToolCallEntry => ({
			callId: `call-${artifactKind}`,
			name: "create_artifact",
			input: { artifactType: artifactKind, title: "Something" },
			status: "done",
			sourceType: "tool",
			metadata: {
				ok: true,
				artifactId: `item-${artifactKind}`,
				artifactKind,
				artifactTitle: "Something",
			},
		});

		await persistEvidence([succeeded("slides"), succeeded("file")]);

		expect(madeGroup(await stored())).toBeUndefined();
	});

	it("never lists a produced file as something the turn made", async () => {
		await persistEvidence([
			{
				callId: "call-file",
				name: "produce_file",
				input: { filename: "Itinerary.pdf" },
				status: "done",
				outputSummary: "Produced Itinerary.pdf",
				sourceType: "tool",
				metadata: { ok: true },
			},
		]);

		const state = await stored();
		expect(madeGroup(state)).toBeUndefined();
		expect(state?.evidenceSummary?.groups.map((g) => g.sourceType)).toEqual([
			"tool",
		]);
	});

	it("keeps the row of an item deleted before the turn finished, which opens into the deleted state a card shows", async () => {
		let madeId = "";
		const entries = await runTools(async (tools) => {
			const result = (await create(tools, "Weekend plan", "call-create")) as {
				artifactId: string;
			};
			madeId = result.artifactId;
		});
		// The reader deletes it from the panel while the turn is still writing.
		const deleted = await deleteArtifact({
			userId: USER,
			artifactId: madeId,
			conversationId: CONVERSATION,
		});
		expect(deleted.ok).toBe(true);

		await persistEvidence(entries);

		// The row is a record of what the turn did, and Regenerate remakes the
		// item under the same id: no read decides, at this moment, that it is gone.
		expect(madeGroup(await stored())?.items).toEqual([
			expect.objectContaining({ artifactId: madeId, title: "Weekend plan" }),
		]);
	});

	it("keeps an incognito turn's rows on its own message and puts nothing on another chat", async () => {
		const INCOGNITO = "conv-incognito";
		const INCOGNITO_MESSAGE = "assistant-incognito";
		const OTHER_MESSAGE = "assistant-other";
		memory.db
			.insert(schema.conversations)
			.values({
				id: INCOGNITO,
				userId: USER,
				title: "Private plan",
				memoryIncognito: true,
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		memory.db
			.insert(schema.messages)
			.values([
				{
					id: INCOGNITO_MESSAGE,
					conversationId: INCOGNITO,
					messageSequence: 2,
					role: "assistant",
					content: "Here is the plan.",
					metadataJson: JSON.stringify({ evidenceStatus: "pending" }),
					createdAt: NOW,
				},
				{
					id: OTHER_MESSAGE,
					conversationId: CONVERSATION,
					messageSequence: 4,
					role: "assistant",
					content: "A different answer.",
					metadataJson: JSON.stringify({ evidenceStatus: "none" }),
					createdAt: NOW,
				},
			])
			.run();
		let madeId = "";
		const entries = await runTools(
			async (tools) => {
				const result = (await create(
					tools,
					"Private plan",
					"call-private",
				)) as {
					artifactId: string;
				};
				madeId = result.artifactId;
			},
			{ conversationId: INCOGNITO },
		);

		await persistAssistantEvidence({
			turnKind: "stream",
			userId: USER,
			conversationId: INCOGNITO,
			assistantMessageId: INCOGNITO_MESSAGE,
			normalizedMessage: "Make a private plan.",
			assistantResponse: "Here is the plan.",
			attachmentIds: [],
			contextDebug: null,
			toolCalls: entries,
		});

		expect(
			madeGroup(await stored(INCOGNITO, INCOGNITO_MESSAGE))?.items,
		).toEqual([expect.objectContaining({ artifactId: madeId })]);
		// The other chat's message, and the first one's, are exactly as they were.
		expect((await stored(CONVERSATION, OTHER_MESSAGE))?.status).toBe("none");
		expect(
			madeGroup(await stored(CONVERSATION, OTHER_MESSAGE)),
		).toBeUndefined();
		expect((await stored())?.status).toBe("pending");
	});
});
