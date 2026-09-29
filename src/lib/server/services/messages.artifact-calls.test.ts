// Which artifacts a conversation's own tool calls made or edited (polish
// G2-A). The persisted `tool_calls` of an assistant message are the only place
// that says "this card is about artifact X" — the artifact rows say nothing
// about a card once they are gone — so the deleted state and Regenerate both
// start from what is read here. `artifactCallIdsFromMessages` works on the
// messages a caller already holds (no query: the detail read is pinned to one
// `messages` SELECT); `getStoredCreateArtifactCall` is the one lookup, on real
// migrated SQLite with foreign keys on, since its SQL prefilter and the
// conversation/role filters are the point and the hand-rolled mock in
// messages.test.ts cannot prove either.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import {
	NOW,
	seedConversation,
	seedUser,
} from "$lib/server/services/artifacts/artifacts.test-helpers";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const {
	artifactCallIdsFromMessages,
	getStoredCreateArtifactCall,
	listMessageWindow,
	regenerableArtifactIdsFromMessages,
} = await import("./messages");

const OWNER = "user-owner";
const CONVERSATION = "conv-1";
const OTHER_CONVERSATION = "conv-2";

type Segment = Record<string, unknown>;

function toolCall(
	name: string,
	metadata: Record<string, string | number | boolean | null> | undefined,
	input: Record<string, unknown> = {},
): Segment {
	return {
		type: "tool_call",
		callId: `call-${Math.random()}`,
		name,
		input,
		status: "done",
		...(metadata ? { metadata } : {}),
	};
}

let sequence = 0;
function seedMessage(params: {
	conversationId?: string;
	role?: "user" | "assistant";
	segments?: Segment[] | string | null;
	id?: string;
	metadata?: Record<string, unknown>;
}): string {
	sequence += 1;
	const id = params.id ?? `message-${sequence}`;
	memory.db
		.insert(schema.messages)
		.values({
			id,
			conversationId: params.conversationId ?? CONVERSATION,
			messageSequence: sequence,
			role: params.role ?? "assistant",
			content: "reply",
			metadataJson: params.metadata ? JSON.stringify(params.metadata) : null,
			toolCalls:
				params.segments === undefined || params.segments === null
					? null
					: typeof params.segments === "string"
						? params.segments
						: JSON.stringify(params.segments),
			createdAt: NOW,
		})
		.run();
	return id;
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	sequence = 0;
	seedUser(memory, OWNER);
	seedConversation(memory, { id: CONVERSATION, userId: OWNER });
	seedConversation(memory, { id: OTHER_CONVERSATION, userId: OWNER });
});

describe("artifactCallIdsFromMessages", () => {
	const messageWith = (segments: Segment[] | undefined) =>
		({ thinkingSegments: segments }) as never;

	it("lists the artifacts the successful create and edit calls name, once each, in the order they were made", () => {
		expect(
			artifactCallIdsFromMessages([
				messageWith([
					toolCall("create_artifact", { ok: true, artifactId: "doc-1" }),
					toolCall("web_search", { ok: true }),
				]),
				messageWith([
					toolCall("edit_artifact", { ok: true, artifactId: "doc-1" }),
					toolCall("create_artifact", { ok: true, artifactId: "app-1" }),
				]),
			]),
		).toEqual(["doc-1", "app-1"]);
	});

	it("skips a refused or failed call, a call with no artifact id, and any other tool that names one", () => {
		expect(
			artifactCallIdsFromMessages([
				messageWith([
					toolCall("create_artifact", { ok: false, error: "too large" }),
					toolCall("create_artifact", { ok: true }),
					toolCall("read_artifact", { ok: true, artifactId: "read-only" }),
					toolCall("create_artifact", undefined),
					{
						...toolCall("edit_artifact", { artifactId: "doc-9" }),
						status: "failed",
					},
				]),
				messageWith(undefined),
			]),
		).toEqual([]);
	});
});

// The security review's L2: the delete confirm may promise "You can regenerate
// it from the chat" only for an item the chat can really make again. Two things
// in the loaded messages say so: a successful create call (Regenerate makes it
// again from the model's own arguments) and the link a message keeps to the
// Document it was opened as (the same "Open as document" makes it again).
describe("regenerableArtifactIdsFromMessages", () => {
	const messageWith = (
		segments: Segment[] | undefined,
		documentArtifactId?: string,
	) => ({ thinkingSegments: segments, documentArtifactId }) as never;

	it("lists what the loaded messages can make again: created items and the Document a message was kept as, once each", () => {
		expect(
			regenerableArtifactIdsFromMessages([
				messageWith([
					toolCall("create_artifact", { ok: true, artifactId: "doc-1" }),
					// An edit holds a summary, not the item.
					toolCall("edit_artifact", { ok: true, artifactId: "doc-2" }),
				]),
				messageWith(
					[toolCall("create_artifact", { ok: false, error: "too large" })],
					"kept-1",
				),
				messageWith(undefined, "kept-1"),
				messageWith([
					toolCall("create_artifact", { ok: true, artifactId: "doc-1" }),
					toolCall("create_artifact", { ok: true, artifactId: "app-1" }),
				]),
			]),
		).toEqual(["doc-1", "kept-1", "app-1"]);
	});

	it("says nothing for messages that made nothing", () => {
		expect(
			regenerableArtifactIdsFromMessages([messageWith(undefined)]),
		).toEqual([]);
	});
});

describe("the Document a message was kept as, on a loaded message", () => {
	it("is projected from the message's metadata, and absent when it was never kept", async () => {
		seedMessage({ id: "kept", metadata: { documentArtifactId: "doc-kept" } });
		seedMessage({ id: "plain" });

		const { messages } = await listMessageWindow(CONVERSATION, { limit: 10 });

		expect(
			messages.map((message) => [message.id, message.documentArtifactId]),
		).toEqual([
			["kept", "doc-kept"],
			["plain", undefined],
		]);
	});
});

describe("getStoredCreateArtifactCall", () => {
	it("returns the message and the model's own arguments of the call that made the artifact", async () => {
		const input = {
			artifactType: "document",
			title: "Plan",
			body: "- [ ] Book",
		};
		const messageId = seedMessage({
			segments: [
				toolCall("create_artifact", { ok: true, artifactId: "doc-1" }, input),
			],
		});

		await expect(
			getStoredCreateArtifactCall({
				conversationId: CONVERSATION,
				artifactId: "doc-1",
			}),
		).resolves.toEqual({ messageId, input });
	});

	it("never mistakes an edit for the creation, and never reads another conversation's call", async () => {
		seedMessage({
			segments: [
				toolCall(
					"edit_artifact",
					{ ok: true, artifactId: "doc-1" },
					{ summary: "x" },
				),
			],
		});
		seedMessage({
			conversationId: OTHER_CONVERSATION,
			segments: [
				toolCall(
					"create_artifact",
					{ ok: true, artifactId: "doc-1" },
					{ title: "Elsewhere" },
				),
			],
		});

		await expect(
			getStoredCreateArtifactCall({
				conversationId: CONVERSATION,
				artifactId: "doc-1",
			}),
		).resolves.toBeNull();
	});

	it("answers null for an artifact no call made, and for a call that was refused", async () => {
		seedMessage({
			segments: [
				toolCall(
					"create_artifact",
					{ ok: false, artifactId: "doc-1" },
					{ title: "x" },
				),
			],
		});

		await expect(
			getStoredCreateArtifactCall({
				conversationId: CONVERSATION,
				artifactId: "doc-1",
			}),
		).resolves.toBeNull();
		await expect(
			getStoredCreateArtifactCall({
				conversationId: CONVERSATION,
				artifactId: "nope",
			}),
		).resolves.toBeNull();
	});
});
