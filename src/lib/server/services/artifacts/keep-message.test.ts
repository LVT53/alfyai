// "Open as document", one press per message at a time (the security review's
// L5). The route's test covers the two-presses-at-once outcome through the real
// route; this pins what only the service can: a press that FAILS must not leave
// its message wedged for the next one.
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import { NOW, seedConversation, seedUser } from "./artifacts.test-helpers";
import { ARTIFACT_BODY_MAX_BYTES } from "./limits";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const { keepMessageAsDocument } = await import("./index");

const OWNER = "user-owner";
const CONVERSATION = "conv-1";
const MESSAGE = "assistant-1";

function setMessageText(content: string) {
	memory.db
		.update(schema.messages)
		.set({ content })
		.where(eq(schema.messages.id, MESSAGE))
		.run();
}

const press = () =>
	keepMessageAsDocument({
		userId: OWNER,
		conversationId: CONVERSATION,
		conversationTitle: "Vienna trip",
		messageId: MESSAGE,
	});

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedConversation(memory, { id: CONVERSATION, userId: OWNER });
	memory.db
		.insert(schema.messages)
		.values({
			id: MESSAGE,
			conversationId: CONVERSATION,
			messageSequence: 1,
			role: "assistant",
			content: "A plan for Saturday.",
			createdAt: NOW,
		})
		.run();
});

afterEach(() => {
	memory.close();
});

describe("keepMessageAsDocument", () => {
	it("hands a press that arrives meanwhile the Document the first one is making, and says it made nothing", async () => {
		const [first, second] = await Promise.all([press(), press()]);

		expect(first).toMatchObject({ ok: true, created: true });
		expect(second).toMatchObject({
			ok: true,
			created: false,
			artifactId: first.ok ? first.artifactId : undefined,
		});
		expect(memory.db.select().from(schema.artifacts).all()).toHaveLength(1);
	});

	it("does not leave the message wedged when a press fails: the next one works", async () => {
		// Too long to keep: the creation is refused and the press throws.
		setMessageText("x".repeat(ARTIFACT_BODY_MAX_BYTES + 1));
		await expect(press()).rejects.toThrow();
		expect(memory.db.select().from(schema.artifacts).all()).toEqual([]);

		setMessageText("A plan for Saturday.");
		await expect(press()).resolves.toMatchObject({ ok: true, created: true });
	});

	it("answers not_found for a reply with no text, and for a message that is not there", async () => {
		setMessageText("   ");
		await expect(press()).resolves.toEqual({ ok: false, reason: "not_found" });
		await expect(
			keepMessageAsDocument({
				userId: OWNER,
				conversationId: CONVERSATION,
				conversationTitle: "Vienna trip",
				messageId: "no-such-message",
			}),
		).resolves.toEqual({ ok: false, reason: "not_found" });
	});
});
