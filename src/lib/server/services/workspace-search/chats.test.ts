import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import * as schema from "$lib/server/db/schema";
import {
	searchTerms,
	typedSearchWords,
} from "$lib/shared/workspace-search-text";
import { seedUser } from "../artifacts/artifacts.test-helpers";

// Chat search on a real, fully migrated database: the SQL decides which chats
// hold every word, so only a real SQLite can prove it.
let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));

const { searchChats } = await import("./chats");
const { searchWorkspace } = await import("./index");

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const BASE = new Date("2026-09-25T10:00:00.000Z");
const PAGE = { offset: 0, limit: 20 };

function words(text: string) {
	return { terms: searchTerms(text), words: typedSearchWords(text) };
}

interface ChatSeed {
	id: string;
	userId?: string;
	title?: string;
	projectId?: string | null;
	/** Message texts, oldest first. */
	messages?: string[];
	updatedAt?: Date;
}

function addChat(seed: ChatSeed): void {
	const updatedAt = seed.updatedAt ?? BASE;
	memory.db
		.insert(schema.conversations)
		.values({
			id: seed.id,
			userId: seed.userId ?? OWNER,
			title: seed.title ?? seed.id,
			projectId: seed.projectId ?? null,
			createdAt: BASE,
			updatedAt,
		})
		.run();
	const texts = seed.messages ?? ["hello"];
	for (let start = 0; start < texts.length; start += 200) {
		memory.db
			.insert(schema.messages)
			.values(
				texts.slice(start, start + 200).map((content, offset) => ({
					id: `${seed.id}-m${start + offset}`,
					conversationId: seed.id,
					role: (start + offset) % 2 === 0 ? "user" : "assistant",
					content,
					createdAt: new Date(BASE.getTime() + (start + offset) * 1000),
				})),
			)
			.run();
	}
}

function addProject(id: string, userId: string, name: string): void {
	memory.db
		.insert(schema.projects)
		.values({ id, userId, name, createdAt: BASE, updatedAt: BASE })
		.run();
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedUser(memory, STRANGER);
});

afterEach(() => {
	memory.close();
});

describe("searchChats", () => {
	it("finds a chat by its title with words in any order", async () => {
		addChat({ id: "c1", title: "Plan for the kitchen" });
		addChat({ id: "c2", title: "Garden notes" });
		const { results, total } = await searchChats(
			OWNER,
			words("kitchen plan"),
			PAGE,
		);
		expect(results.map((row) => row.id)).toEqual(["c1"]);
		expect(total).toBe(1);
		expect(results[0].match).toEqual({
			type: "title",
			snippet: null,
			messageId: null,
			messageRole: null,
		});
		expect(results[0].href).toBe("/chat/c1");
	});

	it("finds an accented capital in a message body", async () => {
		addChat({
			id: "c1",
			title: "Gépek",
			messages: ["Árvíztűrő tükörfúrógép kell"],
		});
		const { results } = await searchChats(OWNER, words("árvíz"), PAGE);
		expect(results.map((row) => row.id)).toEqual(["c1"]);
		expect(results[0].match.type).toBe("body");
		expect(results[0].match.snippet).toContain("Árvíztűrő");
		expect(results[0].match.messageId).toBe("c1-m0");
		expect(results[0].match.messageRole).toBe("user");
		expect(results[0].href).toBe("/chat/c1?focus_message=c1-m0");
	});

	it("finds a message typed without accents, through the index", async () => {
		addChat({
			id: "c1",
			title: "Gépek",
			messages: ["Árvíztűrő tükörfúrógép kell"],
		});
		const { results } = await searchChats(OWNER, words("arviz"), PAGE);
		expect(results.map((row) => row.id)).toEqual(["c1"]);
		expect(results[0].match.type).toBe("body");
		expect(results[0].match.messageId).toBe("c1-m0");
		expect(results[0].match.snippet).toContain("Árvíztűrő");
	});

	it("finds a word whose accented letters are in mixed case in a message", async () => {
		// Stage A's spellings (typed, Capitalised, UPPER) miss "áRVÍZ": LIKE
		// folds the case of ASCII letters only.
		addChat({ id: "c1", title: "Gépek", messages: ["a gép neve áRVÍZTŰRŐ"] });
		const { results } = await searchChats(OWNER, words("árvíz"), PAGE);
		expect(results.map((row) => row.id)).toEqual(["c1"]);
	});

	it("cuts a snippet around a word found only by folding, deep in a long message", async () => {
		const long = `${"lorem ipsum ".repeat(700)}the Árvíztűrő machine ${"dolor sit ".repeat(300)}`;
		addChat({ id: "c1", title: "Notes", messages: [long] });
		const { results } = await searchChats(OWNER, words("arvizturo"), PAGE);
		expect(results[0].match.snippet).toContain("Árvíztűrő");
		expect(results[0].match.snippet?.length).toBeLessThanOrEqual(162);
	});

	it("finds a short word and a long word in different messages", async () => {
		addChat({
			id: "c1",
			title: "Talk",
			messages: ["the AI said so", "about the kitchen"],
		});
		addChat({ id: "c2", title: "Other", messages: ["about the kitchen"] });
		const both = await searchChats(OWNER, words("ai kitchen"), PAGE);
		expect(both.results.map((row) => row.id)).toEqual(["c1"]);
		const neither = await searchChats(OWNER, words("ai garden"), PAGE);
		expect(neither.results).toEqual([]);
	});

	it("takes query syntax literally", async () => {
		addChat({ id: "c1", title: "One", messages: ['say o"neil now'] });
		addChat({ id: "c2", title: "Two", messages: ["call near(x) here"] });
		addChat({
			id: "c3",
			title: "Three",
			messages: ["the a*b product, foo:bar key"],
		});
		addChat({ id: "c4", title: "Four", messages: ["NOT this one"] });
		const found = async (query: string) =>
			(await searchChats(OWNER, words(query), PAGE)).results.map(
				(row) => row.id,
			);
		expect(await found('o"neil')).toEqual(["c1"]);
		expect(await found("near(x)")).toEqual(["c2"]);
		expect(await found("a*b")).toEqual(["c3"]);
		expect(await found("foo:bar")).toEqual(["c3"]);
		expect(await found("not")).toEqual(["c4"]);
	});

	it("never finds another person's message through the index", async () => {
		addChat({ id: "mine", title: "Mine", messages: ["Árvíztűrő gép"] });
		addChat({
			id: "theirs",
			userId: STRANGER,
			title: "Theirs",
			messages: ["Árvíztűrő gép"],
		});
		const { results, total } = await searchChats(OWNER, words("arviz"), PAGE);
		expect(results.map((row) => row.id)).toEqual(["mine"]);
		expect(total).toBe(1);
	});

	it("finds a word in the title and another in a message", async () => {
		addChat({
			id: "c1",
			title: "Thesis",
			messages: ["dovetail joints"],
		});
		const { results } = await searchChats(
			OWNER,
			words("thesis dovetail"),
			PAGE,
		);
		expect(results.map((row) => row.id)).toEqual(["c1"]);
		expect(results[0].match.type).toBe("body");
		expect(results[0].match.snippet).toContain("dovetail");
	});

	it("finds an accented title typed without accents, in any case", async () => {
		addChat({ id: "c1", title: "Árvíztűrő tükörfúrógép", messages: ["x"] });
		for (const typed of ["arviz", "ÁRVÍZ", "tukorfurogep arviz", "ÁrVíZ"]) {
			const { results } = await searchChats(OWNER, words(typed), PAGE);
			expect(
				results.map((row) => row.id),
				typed,
			).toEqual(["c1"]);
			expect(results[0].match.type, typed).toBe("title");
		}
	});

	it("finds a chat by its project's name and reports it as a project match", async () => {
		addProject("p1", OWNER, "Kitchen renovation");
		addChat({ id: "c1", title: "Quotes", projectId: "p1", messages: ["x"] });
		const { results } = await searchChats(OWNER, words("renovation"), PAGE);
		expect(results.map((row) => row.id)).toEqual(["c1"]);
		expect(results[0].match.type).toBe("project");
		expect(results[0].projectName).toBe("Kitchen renovation");
	});

	it("does not find a chat that lacks one of the words", async () => {
		addChat({ id: "c1", title: "Plan for the kitchen", messages: ["x"] });
		const { results, total } = await searchChats(
			OWNER,
			words("kitchen budget"),
			PAGE,
		);
		expect(results).toEqual([]);
		expect(total).toBe(0);
	});

	it("ranks a title match above a newer match in a message", async () => {
		addChat({
			id: "old-title",
			title: "Dovetail joints",
			messages: ["x"],
			updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		});
		addChat({
			id: "new-body",
			title: "Workshop",
			messages: ["dovetail again"],
			updatedAt: new Date("2026-06-01T00:00:00.000Z"),
		});
		addChat({
			id: "newer-body",
			title: "Shed",
			messages: ["a dovetail saw"],
			updatedAt: new Date("2026-07-01T00:00:00.000Z"),
		});
		const { results } = await searchChats(OWNER, words("dovetail"), PAGE);
		expect(results.map((row) => row.id)).toEqual([
			"old-title",
			"newer-body",
			"new-body",
		]);
	});

	it("keeps the best matches when a full cap of newer chats only mention the words", async () => {
		// The chats the person means are old; 405 newer ones merely say the words
		// in a message. The cap must keep the strongest matches, not the newest.
		addChat({
			id: "by-title",
			title: "Python notes",
			messages: ["x"],
			updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		});
		addProject("p-python", OWNER, "Python course");
		addChat({
			id: "by-project",
			title: "Notes",
			projectId: "p-python",
			messages: ["x"],
			updatedAt: new Date("2026-01-02T00:00:00.000Z"),
		});
		for (let index = 0; index < 405; index++) {
			addChat({
				id: `mention-${index}`,
				messages: ["my python notes"],
				updatedAt: new Date(BASE.getTime() + index * 60_000),
			});
		}
		const { results, total } = await searchChats(
			OWNER,
			words("python notes"),
			PAGE,
		);
		expect(results.slice(0, 2).map((row) => [row.id, row.match.type])).toEqual([
			["by-title", "title"],
			["by-project", "project"],
		]);
		expect(total).toBe(100);
	});

	it("reports the newest message that holds the word", async () => {
		addChat({
			id: "c1",
			title: "Workshop",
			messages: ["first dovetail", "nothing here", "second dovetail", "last"],
		});
		const { results } = await searchChats(OWNER, words("dovetail"), PAGE);
		expect(results[0].match.messageId).toBe("c1-m2");
		expect(results[0].match.snippet).toBe("second dovetail");
	});

	it("cuts a long message down to a snippet around the match", async () => {
		const long = `${"lorem ipsum ".repeat(2000)}needle in a haystack ${"dolor sit ".repeat(2000)}`;
		addChat({ id: "c1", title: "Long", messages: [long] });
		const { results } = await searchChats(OWNER, words("needle"), PAGE);
		const snippet = results[0].match.snippet ?? "";
		expect(snippet).toContain("needle");
		expect(snippet.length).toBeLessThanOrEqual(162);
	});

	it("counts chats, not messages", async () => {
		for (const id of ["big1", "big2", "big3"]) {
			addChat({ id, messages: Array.from({ length: 300 }, () => "hello") });
		}
		for (let index = 0; index < 40; index++) addChat({ id: `small${index}` });
		const first = await searchChats(OWNER, words("hello"), PAGE);
		expect(first.total).toBe(43);
		expect(first.results).toHaveLength(20);
		expect(first.hasMore).toBe(true);
		const second = await searchChats(OWNER, words("hello"), {
			offset: 20,
			limit: 20,
		});
		expect(second.results).toHaveLength(20);
		expect(second.hasMore).toBe(true);
		const third = await searchChats(OWNER, words("hello"), {
			offset: 40,
			limit: 20,
		});
		expect(third.results).toHaveLength(3);
		expect(third.hasMore).toBe(false);
		const ids = [first, second, third].flatMap((page) =>
			page.results.map((row) => row.id),
		);
		expect(new Set(ids).size).toBe(43);
	});

	it("stops counting at the cap", async () => {
		for (let index = 0; index < 150; index++) addChat({ id: `chat${index}` });
		const { total, results, hasMore } = await searchChats(
			OWNER,
			words("hello"),
			PAGE,
		);
		expect(total).toBe(100);
		expect(results).toHaveLength(20);
		expect(hasMore).toBe(true);
	});

	it("never returns another person's chat", async () => {
		addChat({
			id: "theirs",
			userId: STRANGER,
			title: "Secret kitchen",
			messages: ["secret kitchen plans"],
		});
		const { results, total } = await searchChats(OWNER, words("secret"), PAGE);
		expect(results).toEqual([]);
		expect(total).toBe(0);
	});

	it("never matches a project name that belongs to someone else", async () => {
		addProject("p-theirs", STRANGER, "Secret kitchen");
		addChat({
			id: "c1",
			title: "Quotes",
			projectId: "p-theirs",
			messages: ["x"],
		});
		const { results } = await searchChats(OWNER, words("secret"), PAGE);
		expect(results).toEqual([]);
	});

	it("skips a chat that has no messages, as the sidebar does", async () => {
		memory.db
			.insert(schema.conversations)
			.values({
				id: "empty",
				userId: OWNER,
				title: "Kitchen plan",
				createdAt: BASE,
				updatedAt: BASE,
			})
			.run();
		const { results } = await searchChats(OWNER, words("kitchen"), PAGE);
		expect(results).toEqual([]);
	});

	it("takes the characters of a query as text when it matches a message", async () => {
		addChat({
			id: "literal",
			title: "Rates",
			messages: ["a%b rise", "x_y", "star*star", "q[b]c", "w?z", "back\\slash"],
		});
		addChat({
			id: "other",
			title: "Noise",
			messages: ["axb rise", "xzy", "starXstar", "qbc", "wuz", "backXslash"],
		});
		for (const typed of [
			"a%b",
			"x_y",
			"star*star",
			"q[b]c",
			"w?z",
			"back\\slash",
		]) {
			const { results } = await searchChats(OWNER, words(typed), PAGE);
			expect(
				results.map((row) => row.id),
				typed,
			).toEqual(["literal"]);
		}
	});

	it("takes the characters of a query as text when it matches a title", async () => {
		for (const [id, title] of [
			["star", "a*b"],
			["xx", "axxb"],
			["bracket", "q[b]c"],
			["plain", "qbc"],
			["question", "w?z"],
			["letter", "wuz"],
			["percent", "a%b"],
			["underscore", "x_y"],
			["any", "xzy"],
		]) {
			addChat({ id, title, messages: ["z"] });
		}
		for (const [typed, expected] of [
			["a*b", ["star"]],
			["q[b]c", ["bracket"]],
			["w?z", ["question"]],
			["a%b", ["percent"]],
			["x_y", ["underscore"]],
		] as const) {
			const { results } = await searchChats(OWNER, words(typed), PAGE);
			expect(
				results.map((row) => row.id),
				typed,
			).toEqual(expected);
		}
	});

	it("treats a query of punctuation as no query", async () => {
		addChat({ id: "c1", title: "Kitchen plan" });
		const response = await searchWorkspace(OWNER, { query: "!!" });
		expect(response.mode).toBe("default");
		expect(response.conversations.map((row) => row.id)).toEqual(["c1"]);
		expect(response.conversations[0].match.type).toBe("recent");
		const single = await searchWorkspace(OWNER, { query: "a" });
		expect(single.mode).toBe("default");
	});

	it("answers a chats scope from a cursor, with the next cursor while more remain", async () => {
		for (let index = 0; index < 45; index++) addChat({ id: `chat${index}` });
		const first = await searchWorkspace(OWNER, {
			query: "hello",
			scope: "chats",
		});
		expect(first.scope).toBe("chats");
		expect(first.conversations).toHaveLength(20);
		expect(first.totals.chats).toBe(45);
		expect(first.nextCursor).toBe("o:20");
		const second = await searchWorkspace(OWNER, {
			query: "hello",
			scope: "chats",
			cursor: first.nextCursor,
		});
		expect(second.conversations).toHaveLength(20);
		expect(second.nextCursor).toBe("o:40");
		const third = await searchWorkspace(OWNER, {
			query: "hello",
			scope: "chats",
			cursor: second.nextCursor,
		});
		expect(third.conversations).toHaveLength(5);
		expect(third.nextCursor).toBeNull();
		const unreadable = await searchWorkspace(OWNER, {
			query: "hello",
			scope: "chats",
			cursor: "garbage",
		});
		expect(unreadable.conversations).toHaveLength(20);
		const all = await searchWorkspace(OWNER, { query: "hello" });
		expect(all.scope).toBe("all");
		expect(all.conversations).toHaveLength(3);
		expect(all.totals.chats).toBe(45);
		expect(all.nextCursor).toBeNull();
		expect(all.memories).toEqual([]);
		expect(all.memorySearchable).toBe(false);
	});
});
