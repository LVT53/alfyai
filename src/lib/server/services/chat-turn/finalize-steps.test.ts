/**
 * The evidence step against a real (in-memory) database.
 *
 * `persistAssistantEvidence` is the one place a finished turn's evidence and
 * its "project files read" count are composed and written, in one metadata
 * write, and `getMessageEvidenceState` is what the evidence endpoint the live
 * page polls reads back. These tests drive both for real — the project's link
 * table, the normalized sibling, the persisted metadata — so the count the
 * Info popover prints is checked where it is actually made.
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
const { getMessageEvidenceState } = await import(
	"$lib/server/services/messages"
);
const { toolReadArtifactIdsMetadata } = await import(
	"$lib/server/services/message-evidence"
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
