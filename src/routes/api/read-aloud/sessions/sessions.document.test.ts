// @vitest-environment node
// The session route reading a Document: the real artifacts service on a fully migrated
// in-memory database, so the refusals below are the panel's own access rules
// (`readScopedArtifactRow`) and the version's own stored text, not a mock's answer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import {
	seedConversation,
	seedUser,
} from "$lib/server/services/artifacts/artifacts.test-helpers";
import { speakWord, type WordKind } from "$lib/shared/read-aloud/spoken-forms";

let memory: InMemoryDatabase;

vi.mock("$lib/server/db", () => ({
	get db() {
		return memory.db;
	},
}));
vi.mock("$lib/server/config-store", () => ({
	getReadAloudUrl: vi.fn(() => "http://127.0.0.1:1920"),
}));
vi.mock("$lib/server/services/read-aloud/readings", () => ({
	openReading: vi.fn(),
	currentReading: vi.fn(),
	attachAudio: vi.fn(),
	attachEvents: vi.fn(),
	reportPosition: vi.fn(),
	closeReading: vi.fn(),
	takeOpenTicket: vi.fn(() => 7),
}));
vi.mock("$lib/server/services/read-aloud/personal-voices", () => ({
	resolveReadingVoices: vi.fn(),
}));

const { createDocumentArtifact, updateArtifactBody } = await import(
	"$lib/server/services/artifacts"
);
const { openReading } = await import(
	"$lib/server/services/read-aloud/readings"
);
const { resolveReadingVoices } = await import(
	"$lib/server/services/read-aloud/personal-voices"
);
const { builtInVoice, resolvedVoice } = await import(
	"$lib/server/services/read-aloud/voices"
);
const { POST } = await import("./+server");

const OWNER = "user-owner";
const STRANGER = "user-stranger";
const CHAT = "conv-owner";
const INCOGNITO = "conv-incognito";
const SESSION = "b".repeat(32);

const open = openReading as ReturnType<typeof vi.fn>;
const voices = resolveReadingVoices as ReturnType<typeof vi.fn>;

function word(shown: string, kind: WordKind = "prose") {
	return { shown, kind, tokens: speakWord(shown, kind, "en") };
}

function sentence(id: string, words: string[], paragraphStart = true) {
	return {
		id,
		language: "en",
		paragraphStart,
		words: words.map((shown) => word(shown)),
	};
}

function post(body: unknown, user = OWNER) {
	return POST({
		request: new Request("http://localhost/api/read-aloud/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		params: {},
		locals: { user: { id: user, role: "user" } },
	} as never);
}

async function seedDocument(markdown: string, conversationId = CHAT) {
	const record = await createDocumentArtifact({
		userId: OWNER,
		conversationId,
		title: "Weekend plan",
		markdown,
		author: "user",
		summary: "Seeded for the read-aloud route",
	});
	return record.id;
}

const PLAN =
	"# Weekend plan\n\nBook the hotel by Friday.\n\nPack the warm coats.";

/** The words the panel would send for PLAN: the heading, then the two paragraphs. */
const PLAN_SENTENCES = [
	sentence("s0", ["Weekend", "plan."]),
	sentence("s1", ["Book", "the", "hotel", "by", "Friday."]),
	sentence("s2", ["Pack", "the", "warm", "coats."]),
];

beforeEach(() => {
	vi.clearAllMocks();
	memory = createInMemoryDatabase();
	seedUser(memory, OWNER);
	seedUser(memory, STRANGER);
	seedConversation(memory, { id: CHAT, userId: OWNER });
	seedConversation(memory, {
		id: INCOGNITO,
		userId: OWNER,
		memoryIncognito: true,
	});
	open.mockResolvedValue({ sessionId: SESSION, userId: OWNER });
	const voiceOf = (key: string) => {
		const voice = builtInVoice(key);
		if (!voice) throw new Error(`no voice ${key}`);
		return resolvedVoice(voice);
	};
	voices.mockResolvedValue({
		voices: { en: voiceOf("imogen"), hu: voiceOf("berta") },
		defaultSpeed: 1.25,
	});
});

afterEach(() => {
	memory.close();
	vi.restoreAllMocks();
});

describe("POST /api/read-aloud/sessions for a Document", () => {
	it("201 for the version the panel shows, read with the person's voices", async () => {
		const artifactId = await seedDocument(PLAN);
		const response = await post({
			document: { artifactId, version: 1 },
			conversationId: CHAT,
			sentences: PLAN_SENTENCES,
		});
		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			sessionId: SESSION,
			defaultSpeed: 1.25,
		});
		expect(open).toHaveBeenCalledTimes(1);
		const args = open.mock.calls[0]?.[0];
		expect(args.userId).toBe(OWNER);
		expect(args.ticket).toBe(7);
		expect(
			args.sentences.map((s: { tokens: string[] }) => s.tokens.join(" ")),
		).toEqual([
			"Weekend plan.",
			"Book the hotel by Friday.",
			"Pack the warm coats.",
		]);
	});

	it("201 without the panel's chat for a Document of an ordinary chat", async () => {
		const artifactId = await seedDocument(PLAN);
		const response = await post({
			document: { artifactId, version: 1 },
			sentences: PLAN_SENTENCES,
		});
		expect(response.status).toBe(201);
	});

	it("404 for another person's Document, and the speech service is never asked", async () => {
		const artifactId = await seedDocument(PLAN);
		const response = await post(
			{
				document: { artifactId, version: 1 },
				conversationId: CHAT,
				sentences: PLAN_SENTENCES,
			},
			STRANGER,
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "not_found" });
		expect(open).not.toHaveBeenCalled();
	});

	it("404 for an incognito chat's Document unless that chat is the panel's", async () => {
		const artifactId = await seedDocument(PLAN, INCOGNITO);
		const outside = await post({
			document: { artifactId, version: 1 },
			conversationId: CHAT,
			sentences: PLAN_SENTENCES,
		});
		expect(outside.status).toBe(404);
		const inside = await post({
			document: { artifactId, version: 1 },
			conversationId: INCOGNITO,
			sentences: PLAN_SENTENCES,
		});
		expect(inside.status).toBe(201);
	});

	it("404 for a version the Document does not have", async () => {
		const artifactId = await seedDocument(PLAN);
		const response = await post({
			document: { artifactId, version: 2 },
			sentences: PLAN_SENTENCES,
		});
		expect(response.status).toBe(404);
		expect(open).not.toHaveBeenCalled();
	});

	it("422 not_in_document for made-up words, and the log line carries none of them", async () => {
		const spies = (["log", "info", "warn", "error"] as const).map((level) =>
			vi.spyOn(console, level).mockImplementation(() => undefined),
		);
		const artifactId = await seedDocument(PLAN);
		const response = await post({
			document: { artifactId, version: 1 },
			sentences: [
				sentence("s0", ["Weekend", "plan."]),
				sentence("s1", ["Transfer", "all", "the", "money."]),
			],
		});
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({ error: "not_in_document" });
		expect(open).not.toHaveBeenCalled();
		const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
		for (const token of ["Transfer", "money", "Weekend", "hotel"])
			expect(logged).not.toContain(token);
		expect(logged).toContain("not in its document");
	});

	it("checks the words against the version named, not the newest: a newer version's words are refused for the older one", async () => {
		const artifactId = await seedDocument(PLAN);
		const updated = await updateArtifactBody({
			userId: OWNER,
			artifactId,
			body: "# Weekend plan\n\nBook the cabin by Thursday.",
			author: "alfy",
			summary: "Alfy changed the plan",
		});
		if (!updated.ok) throw new Error(updated.reason);
		const newer = [
			sentence("s0", ["Weekend", "plan."]),
			sentence("s1", ["Book", "the", "cabin", "by", "Thursday."]),
		];

		const old = await post({
			document: { artifactId, version: 1 },
			sentences: newer,
		});
		expect(old.status).toBe(422);
		const current = await post({
			document: { artifactId, version: 2 },
			sentences: newer,
		});
		expect(current.status).toBe(201);
	});
});
