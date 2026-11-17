// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/config-store", () => ({
	getReadAloudUrl: vi.fn(() => "http://127.0.0.1:1920"),
}));
vi.mock("$lib/server/services/conversations", () => ({
	getConversation: vi.fn(),
}));
vi.mock("$lib/server/services/messages", () => ({
	getReplyForDocumentKeep: vi.fn(),
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

import { getReadAloudUrl } from "$lib/server/config-store";
import { getConversation } from "$lib/server/services/conversations";
import { getReplyForDocumentKeep } from "$lib/server/services/messages";
import {
	ReadingSuperseded,
	SpeechRefused,
	SpeechUnavailable,
} from "$lib/server/services/read-aloud";
import { resolveReadingVoices } from "$lib/server/services/read-aloud/personal-voices";
import {
	attachAudio,
	attachEvents,
	closeReading,
	currentReading,
	openReading,
	reportPosition,
	takeOpenTicket,
} from "$lib/server/services/read-aloud/readings";
import {
	builtInVoice,
	defaultVoiceFor,
	resolvedVoice,
} from "$lib/server/services/read-aloud/voices";
import { speakWord, type WordKind } from "$lib/shared/read-aloud/spoken-forms";
import { STYLES } from "$lib/shared/read-aloud/voice-knobs";
import { POST } from "./+server";
import { DELETE } from "./[sessionId]/+server";
import { GET as GET_AUDIO } from "./[sessionId]/audio/+server";
import { GET as GET_EVENTS } from "./[sessionId]/events/+server";
import { POST as POST_POSITION } from "./[sessionId]/position/+server";

const mocks = {
	url: getReadAloudUrl as ReturnType<typeof vi.fn>,
	conversation: getConversation as ReturnType<typeof vi.fn>,
	reply: getReplyForDocumentKeep as ReturnType<typeof vi.fn>,
	open: openReading as ReturnType<typeof vi.fn>,
	current: currentReading as ReturnType<typeof vi.fn>,
	audio: attachAudio as ReturnType<typeof vi.fn>,
	events: attachEvents as ReturnType<typeof vi.fn>,
	position: reportPosition as ReturnType<typeof vi.fn>,
	close: closeReading as ReturnType<typeof vi.fn>,
	ticket: takeOpenTicket as ReturnType<typeof vi.fn>,
	voices: resolveReadingVoices as ReturnType<typeof vi.fn>,
};

/** What `resolveReadingVoices` answers for a person who chose these built-in voices. */
function readingWith(choice: { en: string; hu: string }, defaultSpeed = 1) {
	const voiceOf = (key: string) => {
		const voice = builtInVoice(key);
		if (!voice) throw new Error(`no voice ${key}`);
		return resolvedVoice(voice);
	};
	return {
		voices: { en: voiceOf(choice.en), hu: voiceOf(choice.hu) },
		defaultSpeed,
	};
}

const SESSION = "a".repeat(32);

function eventFor(
	body: unknown,
	options: { user?: string | null; sessionId?: string; raw?: string } = {},
) {
	const user = options.user === undefined ? "user-1" : options.user;
	return {
		request: new Request("http://localhost/api/read-aloud/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: options.raw ?? JSON.stringify(body),
		}),
		params: { sessionId: options.sessionId ?? SESSION },
		locals: { user: user ? { id: user, role: "user" } : undefined },
	} as never;
}

function word(
	shown: string,
	kind: WordKind = "prose",
	language: "en" | "hu" = "en",
) {
	return { shown, kind, tokens: speakWord(shown, kind, language) };
}

function body(overrides: Record<string, unknown> = {}) {
	return {
		conversationId: "conv-1",
		messageId: "msg-1",
		sentences: [
			{
				id: "s0",
				language: "en",
				paragraphStart: true,
				words: [word("Hello"), word("there"), word("world.")],
			},
			{
				id: "s1",
				language: "hu",
				paragraphStart: false,
				words: [
					word("Szia", "prose", "hu"),
					word("mindenki", "prose", "hu"),
					word("ma.", "prose", "hu"),
				],
			},
		],
		...overrides,
	};
}

const REPLY = "Hello there world.\n\nSzia mindenki ma.";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.url.mockReturnValue("http://127.0.0.1:1920");
	mocks.conversation.mockResolvedValue({ id: "conv-1", userId: "user-1" });
	mocks.reply.mockResolvedValue({ content: REPLY, documentArtifactId: null });
	mocks.open.mockResolvedValue({ sessionId: SESSION, userId: "user-1" });
	mocks.current.mockReturnValue({ sessionId: SESSION, userId: "user-1" });
	mocks.voices.mockResolvedValue(readingWith({ en: "imogen", hu: "berta" }));
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("POST /api/read-aloud/sessions", () => {
	it("401 without a user", async () => {
		await expect(POST(eventFor(body(), { user: null }))).rejects.toMatchObject({
			status: 401,
		});
		expect(mocks.open).not.toHaveBeenCalled();
	});

	it("404 read_aloud_off when the feature is off", async () => {
		mocks.url.mockReturnValue("");
		const response = await POST(eventFor(body()));
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "read_aloud_off" });
		expect(mocks.conversation).not.toHaveBeenCalled();
	});

	it("400 for a body that is not a reading request", async () => {
		for (const raw of ["{not json", "[]", JSON.stringify({})]) {
			const response = await POST(eventFor(null, { raw }));
			expect(response.status, raw).toBe(400);
			expect(await response.json()).toEqual({ error: "invalid_request" });
		}
	});

	it("400 for a sentence of 401 characters", async () => {
		const tooLong = {
			id: "s0",
			language: "en",
			paragraphStart: true,
			words: [
				{ shown: "x", kind: "prose", tokens: ["a".repeat(80)] },
				{ shown: "x", kind: "prose", tokens: ["b".repeat(80)] },
				{ shown: "x", kind: "prose", tokens: ["c".repeat(80)] },
				{ shown: "x", kind: "prose", tokens: ["d".repeat(80)] },
				{ shown: "x", kind: "prose", tokens: ["e".repeat(80)] },
			],
		};
		// 5 tokens of 80 characters joined by spaces: 404.
		const response = await POST(eventFor(body({ sentences: [tooLong] })));
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_request" });
		expect(mocks.conversation).not.toHaveBeenCalled();
	});

	it("400 for tokens with whitespace, ids that are not s<n>, and ids that repeat", async () => {
		const sentence = (id: string, token = "hello") => ({
			id,
			language: "en",
			paragraphStart: false,
			words: [{ shown: "hello", kind: "prose", tokens: [token] }],
		});
		for (const sentences of [
			[sentence("s0", "two words")],
			[sentence("x0")],
			[sentence("s0"), sentence("s0")],
			[],
		]) {
			const response = await POST(eventFor(body({ sentences })));
			expect(response.status, JSON.stringify(sentences)).toBe(400);
		}
	});

	it("404 for another person's conversation", async () => {
		mocks.conversation.mockResolvedValue(null);
		const response = await POST(eventFor(body()));
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "not_found" });
		expect(mocks.conversation).toHaveBeenCalledWith("user-1", "conv-1");
		expect(mocks.reply).not.toHaveBeenCalled();
	});

	it("404 for a message that is not a reply", async () => {
		mocks.reply.mockResolvedValue(null);
		const response = await POST(eventFor(body()));
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "not_found" });
		expect(mocks.reply).toHaveBeenCalledWith({
			conversationId: "conv-1",
			messageId: "msg-1",
		});
	});

	it("422 not_in_reply, and the log line carries no reply text", async () => {
		const spies = (["log", "info", "warn", "error"] as const).map((level) =>
			vi.spyOn(console, level).mockImplementation(() => undefined),
		);
		const outsider = {
			id: "s0",
			language: "en",
			paragraphStart: true,
			words: [word("Free"), word("speech"), word("please")],
		};
		const response = await POST(eventFor(body({ sentences: [outsider] })));
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({ error: "not_in_reply" });
		expect(mocks.open).not.toHaveBeenCalled();
		const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
		for (const token of ["Free", "speech", "please", "Hello", "world"])
			expect(logged).not.toContain(token);
		expect(logged).toContain("not in its reply");
	});

	it("201 with Imogen for English and Berta with room.clean 2 for Hungarian", async () => {
		const response = await POST(eventFor(body()));
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({
			sessionId: SESSION,
			defaultSpeed: 1,
			charsPerSecond: { en: 15, hu: 15 },
		});
		expect(mocks.open).toHaveBeenCalledTimes(1);
		const args = mocks.open.mock.calls[0]?.[0];
		expect(args.userId).toBe("user-1");
		expect(args.baseUrl).toBe("http://127.0.0.1:1920");
		expect(args.sentences).toEqual([
			{
				id: "s0",
				language: "en",
				voice: { speaker_id: "default_b78b28baf5c31a1d", controls: {} },
				tokens: ["Hello", "there", "world."],
				paragraph_start: true,
			},
			{
				id: "s1",
				language: "hu",
				voice: {
					speaker_id: "default_bf7632822e6b4dc0",
					controls: { "room.clean": 2 },
				},
				tokens: ["Szia", "mindenki", "ma."],
				paragraph_start: false,
			},
		]);
	});

	it("reads each language with the person's chosen voice", async () => {
		mocks.voices.mockResolvedValue(readingWith({ en: "rupert", hu: "imre" }));
		const response = await POST(eventFor(body()));
		expect(response.status).toBe(201);
		expect(mocks.voices).toHaveBeenCalledWith("user-1");
		const sentences = mocks.open.mock.calls[0]?.[0].sentences;
		expect(
			sentences.map((sentence: { voice: unknown }) => sentence.voice),
		).toEqual([
			{ speaker_id: "default_3765f0d1140c05c0", controls: {} },
			{
				speaker_id: "default_fde02d0881bd267d",
				controls: { "room.clean": 2 },
			},
		]);
	});

	it("a personal voice sends its base's speaker and its knobs' controls", async () => {
		const berta = builtInVoice("berta");
		const bedtime = STYLES.find((style) => style.key === "bedtime");
		if (!berta || !bedtime) throw new Error("no berta or bedtime");
		mocks.voices.mockResolvedValue({
			voices: {
				en: resolvedVoice(defaultVoiceFor("en")),
				hu: resolvedVoice(berta, bedtime.knobs),
			},
			defaultSpeed: 1,
		});
		const response = await POST(eventFor(body()));
		expect(response.status).toBe(201);
		const sentences = mocks.open.mock.calls[0]?.[0].sentences;
		expect(sentences[1].voice).toEqual({
			speaker_id: "default_bf7632822e6b4dc0",
			controls: {
				"room.clean": 2,
				"delivery.tempo": -1,
				"texture.deep": 1,
				"mood.arousal": -2.5,
				"delivery.whisper": 0.6,
			},
		});
		// English was not touched, and the two sentences do not share a controls object.
		expect(sentences[0].voice).toEqual({
			speaker_id: "default_b78b28baf5c31a1d",
			controls: {},
		});
	});

	it("answers the person's Default speed and their voices' speaking rates", async () => {
		mocks.voices.mockResolvedValue({
			voices: {
				en: { ...resolvedVoice(defaultVoiceFor("en")), charsPerSecond: 12 },
				hu: { ...resolvedVoice(defaultVoiceFor("hu")), charsPerSecond: 18 },
			},
			defaultSpeed: 1.5,
		});
		const response = await POST(eventFor(body()));
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({
			sessionId: SESSION,
			defaultSpeed: 1.5,
			charsPerSecond: { en: 12, hu: 18 },
		});
	});

	it("looks up the person's voices only for a request it has accepted", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		mocks.reply.mockResolvedValue(null);
		await POST(eventFor(body()));
		mocks.reply.mockResolvedValue({
			content: "Nothing like the request.",
			documentArtifactId: null,
		});
		await POST(eventFor(body()));
		await POST(eventFor(body({ sentences: [] })));
		expect(mocks.voices).not.toHaveBeenCalled();
		// The same request, accepted: now the lookup happens, once.
		mocks.reply.mockResolvedValue({ content: REPLY, documentArtifactId: null });
		await POST(eventFor(body()));
		expect(mocks.voices).toHaveBeenCalledTimes(1);
	});

	it("flattens a word's tokens, the pause marks included", async () => {
		mocks.reply.mockResolvedValue({
			content: "Use `getUserName()` now.",
			documentArtifactId: null,
		});
		const response = await POST(
			eventFor(
				body({
					sentences: [
						{
							id: "s0",
							language: "en",
							paragraphStart: false,
							words: [
								word("Use"),
								{
									shown: "getUserName()",
									kind: "code",
									tokens: ["get", "User", "Name,"],
								},
								word("now."),
							],
						},
					],
				}),
			),
		);
		expect(response.status).toBe(201);
		expect(mocks.open.mock.calls[0]?.[0].sentences[0].tokens).toEqual([
			"Use",
			"get",
			"User",
			"Name,",
			"now.",
		]);
	});

	it("takes its place in line before it reads or checks anything", async () => {
		await POST(eventFor(body()));
		expect(mocks.ticket).toHaveBeenCalledWith("user-1");
		// Before the body, the conversation and the reply: the order of the
		// presses is the order the requests arrived in, not the order they finished.
		const ticketOrder = mocks.ticket.mock.invocationCallOrder[0] as number;
		expect(ticketOrder).toBeLessThan(
			mocks.conversation.mock.invocationCallOrder[0] as number,
		);
		expect(mocks.open.mock.calls[0]?.[0].ticket).toBe(7);
	});

	it("409 superseded when a later press has opened already", async () => {
		mocks.open.mockRejectedValue(new ReadingSuperseded());
		const response = await POST(eventFor(body()));
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "superseded" });
	});

	it("503 voice_unavailable when the service is down", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		mocks.open.mockRejectedValue(new SpeechUnavailable("down"));
		const response = await POST(eventFor(body()));
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "voice_unavailable" });
	});

	it("503 voice_unavailable when the service refuses, logging only its status and field", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		mocks.open.mockRejectedValue(new SpeechRefused(422, "sentences[0].tokens"));
		const response = await POST(eventFor(body()));
		expect(response.status).toBe(503);
		const logged = JSON.stringify(warn.mock.calls);
		expect(logged).toContain("422");
		expect(logged).toContain("sentences[0].tokens");
		expect(logged).not.toContain("Hello");
	});

	it("503 voice_unavailable for any other failure", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		mocks.open.mockRejectedValue(new Error("boom"));
		const response = await POST(eventFor(body()));
		expect(response.status).toBe(503);
	});
});

describe("the {sessionId} routes", () => {
	const routes: Array<[string, (event: never) => Promise<Response>, string]> = [
		["audio", GET_AUDIO as never, "GET"],
		["events", GET_EVENTS as never, "GET"],
		["position", POST_POSITION as never, "POST"],
		["delete", DELETE as never, "DELETE"],
	];

	it("401 without a user", async () => {
		for (const [name, handler] of routes)
			await expect(
				handler(eventFor({ sentenceId: "s1" }, { user: null })),
				name,
			).rejects.toMatchObject({ status: 401 });
	});

	it("404 for another person's session id", async () => {
		mocks.current.mockReturnValue(null);
		for (const [name, handler] of routes) {
			const response = await handler(eventFor({ sentenceId: "s1" }));
			expect(response.status, name).toBe(404);
			expect(await response.json(), name).toEqual({ error: "not_found" });
		}
		expect(mocks.current).toHaveBeenCalledWith("user-1", SESSION);
		expect(mocks.audio).not.toHaveBeenCalled();
		expect(mocks.close).not.toHaveBeenCalled();
	});

	it("the audio route streams audio/mpeg with no-store", async () => {
		mocks.audio.mockReturnValue(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array([0xff, 0xfb, 0x90, 0xc0]));
					controller.close();
				},
			}),
		);
		const response = await GET_AUDIO(eventFor(null) as never);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("audio/mpeg");
		expect(response.headers.get("cache-control")).toBe(
			"no-store, no-transform",
		);
		expect(response.headers.get("x-accel-buffering")).toBe("no");
		expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
			0xff, 0xfb, 0x90, 0xc0,
		]);
	});

	it("409 once the replay is released", async () => {
		mocks.audio.mockReturnValue(null);
		const response = await GET_AUDIO(eventFor(null) as never);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "already_read" });
	});

	it("the events route streams text/event-stream the way the take events do", async () => {
		mocks.events.mockReturnValue(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode("event: done\ndata: {}\n\n"),
					);
					controller.close();
				},
			}),
		);
		const response = await GET_EVENTS(eventFor(null) as never);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		expect(response.headers.get("cache-control")).toBe(
			"no-cache, no-transform",
		);
		expect(response.headers.get("x-accel-buffering")).toBe("no");
		expect(await response.text()).toBe("event: done\ndata: {}\n\n");
	});

	it("position answers 204 and passes the sentence on", async () => {
		const response = await POST_POSITION(
			eventFor({ sentenceId: "s3" }) as never,
		);
		expect(response.status).toBe(204);
		expect(mocks.position).toHaveBeenCalledWith(
			{ sessionId: SESSION, userId: "user-1" },
			"s3",
		);
	});

	it("position answers 400 for a body that is not a sentence id", async () => {
		for (const sent of [{ sentenceId: "x3" }, { sentenceId: 3 }, {}, "[]"]) {
			const response = await POST_POSITION(
				eventFor(sent, typeof sent === "string" ? { raw: sent } : {}) as never,
			);
			expect(response.status, JSON.stringify(sent)).toBe(400);
		}
		expect(mocks.position).not.toHaveBeenCalled();
	});

	it("DELETE answers 204 and closes the reading", async () => {
		const response = await DELETE(eventFor(null) as never);
		expect(response.status).toBe(204);
		expect(mocks.close).toHaveBeenCalledWith({
			sessionId: SESSION,
			userId: "user-1",
		});
	});
});
