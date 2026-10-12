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

// F20 (ruling 77): "Open as document" titled the Document with the first 120
// characters of a one-paragraph reply, cut mid-word ("... kiváló k"), in a
// two-line header, and the composer placeholder repeated it in three lines. A
// title ends at a sentence or a word, near 60 characters.
describe("the title a kept reply gets", () => {
	// One press per message is idempotent (it hands back the Document it made), so
	// every text is kept from a message of its own.
	let nextSequence = 100;
	async function titleOf(content: string): Promise<string> {
		nextSequence += 1;
		const id = `reply-${nextSequence}`;
		memory.db
			.insert(schema.messages)
			.values({
				id,
				conversationId: CONVERSATION,
				messageSequence: nextSequence,
				role: "assistant",
				content,
				createdAt: NOW,
			})
			.run();
		const result = await keepMessageAsDocument({
			userId: OWNER,
			conversationId: CONVERSATION,
			conversationTitle: "Vienna trip",
			messageId: id,
		});
		if (!result.ok) throw new Error("not kept");
		return result.title;
	}

	const CAFE_REPLY =
		"Szubjektív, de ha egyet kellene mondani, a Café Central (Herrengasse 14) a legjobb: lenyűgöző neogótikus terem, kiváló kávé és sütemények, és történelmileg is ez volt a város szellemi központja. Ha inkább a csendesebb, eredeti bécsi hangulatot keresed, a Café Sperl vagy a Café Hawelka a jobb választás.";

	it("cuts the audit's one-paragraph reply at a word, near 60 characters, with an ellipsis", async () => {
		const title = await titleOf(CAFE_REPLY);

		expect(title).toBe(
			"Szubjektív, de ha egyet kellene mondani, a Café Central…",
		);
		expect(title.length).toBeLessThanOrEqual(61);
	});

	it("takes a first sentence that ends within reach whole, without its period", async () => {
		expect(
			await titleOf(
				"A bécsi hétvége három fő programja a Belvedere, a Hofburg és a Prater. A többi opcionális.",
			),
		).toBe(
			"A bécsi hétvége három fő programja a Belvedere, a Hofburg és a Prater",
		);
		expect(
			await titleOf(
				"Melyik kávéház a legjobb Bécsben? Szerintem a Café Central, de a Sperl is szép.",
			),
		).toBe("Melyik kávéház a legjobb Bécsben?");
	});

	it("leaves a short title as it was", async () => {
		expect(await titleOf("Weekend plan for Vienna")).toBe(
			"Weekend plan for Vienna",
		);
		expect(await titleOf("# Weekend plan\n\n- [ ] Book tickets")).toBe(
			"Weekend plan",
		);
	});

	it("does not take a sentence that is only a word or two as the title: 'Szia!' is not what the reply is about", async () => {
		const title = await titleOf(
			"Szia! Itt a terved a hétvégére: reggel a Belvedere, délben a Naschmarkt, este a Prater óriáskereke.",
		);
		expect(title.startsWith("Szia! Itt a terved")).toBe(true);
	});

	it("never ends inside a word, whatever the text, and never leaves a bracket open", async () => {
		const words = [
			"hatalmas",
			"neogótikus",
			"kávéház",
			"történelmileg",
			"szellemi",
			"központ",
			"(Herrengasse",
			"14)",
			"lenyűgöző",
		];
		for (let start = 0; start < words.length; start += 1) {
			const text = Array.from(
				{ length: 30 },
				(_, index) => words[(start + index) % words.length],
			).join(" ");
			const title = await titleOf(text);
			const body = title.replace(/…$/, "");
			expect(text.startsWith(body), body).toBe(true);
			expect(
				text[body.length] === undefined || text[body.length] === " ",
				`ends mid-word: ${body}`,
			).toBe(true);
			expect(body.split("(").length, body).toBeLessThanOrEqual(
				body.split(")").length,
			);
			expect(body.length).toBeLessThanOrEqual(61);
		}
	});

	it("cuts a first word that is longer than a title at 60 characters and says so", async () => {
		const title = await titleOf(`https://example.com/${"a".repeat(200)}`);
		expect(title).toBe(
			`${`https://example.com/${"a".repeat(200)}`.slice(0, 60)}…`,
		);
	});

	it("falls back to the conversation's title when the reply has no text of its own", async () => {
		expect(await titleOf("#")).toBe("Vienna trip");
	});
});
