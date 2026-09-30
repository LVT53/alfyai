// The listing through the real route, service and database: two users, a
// normal chat and an incognito one. What the mocked route test above cannot
// show is that the route hands the service the scope it was read with — an
// incognito chat's board lists its own work only when the read names that chat,
// and a stranger's board answers exactly as a missing one does.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { boardJson, emptyCanvasBody } from "$lib/shared/artifacts/canvas-body";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const { createArtifact } = await import("$lib/server/services/artifacts");
const { GET } = await import("./+server");

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const NORMAL = "conv-normal";
const INCOGNITO = "conv-incognito";
const STRANGER_CHAT = "conv-stranger";

function event(params: {
	artifactId: string;
	userId: string | null;
	conversationId?: string | null;
}) {
	const query = params.conversationId
		? `?conversationId=${encodeURIComponent(params.conversationId)}`
		: "";
	return {
		params: { id: params.artifactId },
		url: new URL(
			`http://localhost/api/artifacts/${params.artifactId}/chat-blocks${query}`,
		),
		locals: {
			user: params.userId ? { id: params.userId, role: "user" } : undefined,
		},
	} as never;
}

async function board(conversationId: string, userId = OWNER) {
	const created = await createArtifact({
		userId,
		conversationId,
		kind: "canvas",
		title: "Board",
		body: boardJson(emptyCanvasBody()),
		author: "user",
		versionSummary: "Created",
	});
	if (!created.ok) throw new Error(created.reason);
	return created.artifact.id;
}

/** A chat file in the conversation, so a listing that reaches it is a listing that read the right chat. */
function seedFile(conversationId: string, userId: string, name: string) {
	// A produced file is part of the chat once an assistant message owns it.
	const messageId = `message-${name}`;
	memory.db
		.insert(schema.messages)
		.values({
			id: messageId,
			conversationId,
			role: "assistant",
			content: "Here it is.",
			createdAt: NOW,
		})
		.run();
	memory.db
		.insert(schema.chatGeneratedFiles)
		.values({
			id: `file-${name}`,
			conversationId,
			assistantMessageId: messageId,
			userId,
			filename: name,
			mimeType: "application/pdf",
			sizeBytes: 10,
			storagePath: `${conversationId}/${name}`,
			createdAt: NOW,
		})
		.run();
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedUser(memory, STRANGER);
	seedConversation(memory, { id: NORMAL, userId: OWNER });
	seedConversation(memory, {
		id: INCOGNITO,
		userId: OWNER,
		memoryIncognito: true,
	});
	seedConversation(memory, { id: STRANGER_CHAT, userId: STRANGER });
});

afterEach(() => {
	memory.close();
});

describe("GET /api/artifacts/[id]/chat-blocks, against the real scope", () => {
	it("lists a normal chat's files for its owner", async () => {
		const id = await board(NORMAL);
		seedFile(NORMAL, OWNER, "plan.pdf");

		const response = await GET(event({ artifactId: id, userId: OWNER }));

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.ok).toBe(true);
		expect(
			body.files.map((file: { data: { name: string } }) => file.data.name),
		).toEqual(["plan.pdf"]);
	});

	it("answers another user's board exactly as it answers an id that does not exist", async () => {
		const theirs = await board(STRANGER_CHAT, STRANGER);
		seedFile(STRANGER_CHAT, STRANGER, "secret.pdf");

		const foreign = await GET(
			event({
				artifactId: theirs,
				userId: OWNER,
				conversationId: STRANGER_CHAT,
			}),
		);
		const missing = await GET(
			event({
				artifactId: "no-such-board",
				userId: OWNER,
				conversationId: STRANGER_CHAT,
			}),
		);

		expect(foreign.status).toBe(404);
		expect(await foreign.text()).toBe(await missing.text());
	});

	it("lists an incognito chat's own work only when the read names that chat", async () => {
		const id = await board(INCOGNITO);
		seedFile(INCOGNITO, OWNER, "private.pdf");

		const without = await GET(event({ artifactId: id, userId: OWNER }));
		const elsewhere = await GET(
			event({ artifactId: id, userId: OWNER, conversationId: NORMAL }),
		);
		const named = await GET(
			event({ artifactId: id, userId: OWNER, conversationId: INCOGNITO }),
		);

		expect(without.status).toBe(404);
		expect(elsewhere.status).toBe(404);
		expect(named.status).toBe(200);
		const body = await named.json();
		expect(body.files).toHaveLength(1);
	});

	it("lists no file from a chat other than the board's own", async () => {
		const id = await board(NORMAL);
		seedFile(INCOGNITO, OWNER, "private.pdf");

		const response = await GET(event({ artifactId: id, userId: OWNER }));
		const body = await response.json();

		expect(body.files).toEqual([]);
	});
});
