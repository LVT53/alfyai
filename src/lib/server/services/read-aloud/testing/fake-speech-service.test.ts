// @vitest-environment node
import { get } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MP3_FRAME_SECONDS } from "../../../../shared/read-aloud/silent-mp3";
import {
	createFakeSpeechService,
	type FakeSpeechOptions,
	type FakeSpeechService,
} from "./fake-speech-service";

const FRAME_BYTES = 417;
/** The encoder's start delay: the first sentence starts here, not at 0 (README, "Times"). */
const ENCODER_DELAY = 0.025;

let fake: FakeSpeechService;

async function start(options?: FakeSpeechOptions) {
	fake = await createFakeSpeechService(options);
	return fake;
}

beforeEach(async () => {
	await start();
});

afterEach(async () => {
	await fake.close();
});

function sentence(id: string, text: string, paragraphStart = false) {
	return {
		id,
		language: "en",
		voice: { speaker_id: "default_b78b28baf5c31a1d", controls: {} },
		tokens: text.split(" "),
		paragraph_start: paragraphStart,
	};
}

function post(path: string, body: unknown): Promise<Response> {
	return fetch(`${fake.baseUrl}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

async function openSession(sentences: unknown[]): Promise<string> {
	const created = await post("/v1/sessions", { sentences });
	expect(created.status).toBe(201);
	const { session_id } = (await created.json()) as { session_id: string };
	return session_id;
}

type SseData = {
	id: string;
	start: number;
	end: number;
	code: string;
	times: Array<[number, number] | null>;
};
type SseEvent = { event: string; data: SseData };

function parseSse(text: string): SseEvent[] {
	const blocks = text.split("\n\n");
	if (!text.endsWith("\n\n")) blocks.pop();
	return blocks
		.filter((block) => block.trim() !== "")
		.map((block) => {
			const lines = block.split("\n");
			return {
				event: lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "",
				data: JSON.parse(
					lines.find((l) => l.startsWith("data: "))?.slice(6) ?? "{}",
				) as SseData,
			};
		});
}

/** Reads an event stream while it arrives. */
function followEvents(response: Response) {
	const reader = (response.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let text = "";
	let ended = false;
	const finished = (async () => {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
	})()
		.catch(() => undefined)
		.finally(() => {
			ended = true;
		});
	return {
		events: () => parseSse(text),
		hasEnded: () => ended,
		finished,
		cancel: () => reader.cancel().catch(() => undefined),
		async until(predicate: (events: SseEvent[]) => boolean, timeoutMs = 2000) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (predicate(parseSse(text))) return;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			throw new Error(
				`timed out; saw ${JSON.stringify(parseSse(text).map((e) => e.event))}`,
			);
		},
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("fake speech service: a reading", () => {
	it("follows Plan 1's contract for a two-sentence session", async () => {
		const id = await openSession([
			sentence("s0", "Hello there world."),
			sentence("s1", "Second one here."),
		]);
		expect(id).toMatch(/^[0-9a-f]{32}$/);

		const eventsResponse = await fetch(
			`${fake.baseUrl}/v1/sessions/${id}/events`,
		);
		expect(eventsResponse.status).toBe(200);
		expect(eventsResponse.headers.get("content-type")).toContain(
			"text/event-stream",
		);
		const events = parseSse(await eventsResponse.text());
		expect(events.map((e) => e.event)).toEqual([
			"sentence",
			"words",
			"sentence",
			"words",
			"done",
		]);

		const [first, firstWords, second] = events as [
			SseEvent,
			SseEvent,
			SseEvent,
		];
		// The stream's clock holds the encoder's delay: the first sentence starts
		// at about 0.025 s, not at 0.
		expect(first.data.start).toBeCloseTo(ENCODER_DELAY, 3);
		// The 0.30 s gap, rounded up to whole frames: 12 frames, about 0.313 s.
		expect(second.data.start - first.data.end).toBeCloseTo(
			12 * MP3_FRAME_SECONDS,
			2,
		);
		// One entry per token, an even split of the sentence.
		expect(firstWords.data.id).toBe("s0");
		expect(firstWords.data.times).toHaveLength(3);
		expect(firstWords.data.times[0]?.[0]).toBeCloseTo(first.data.start, 3);
		expect(firstWords.data.times[2]?.[1]).toBeCloseTo(first.data.end, 3);

		const audioResponse = await fetch(
			`${fake.baseUrl}/v1/sessions/${id}/audio`,
		);
		expect(audioResponse.status).toBe(200);
		expect(audioResponse.headers.get("content-type")).toBe("audio/mpeg");
		const audio = new Uint8Array(await audioResponse.arrayBuffer());
		// Silent frames, as many as the last end time says.
		expect(audio.length % FRAME_BYTES).toBe(0);
		expect(audio.length / FRAME_BYTES).toBe(
			Math.round((second.data.end - ENCODER_DELAY) / MP3_FRAME_SECONDS),
		);
		expect([...audio.slice(0, 4)]).toEqual([0xff, 0xfb, 0x90, 0xc0]);
	});

	it("keeps the recorded request, the positions and the deleted flag", async () => {
		// Four sentences, so the reading is still running when it is reported to.
		const id = await openSession([
			sentence("s0", "One two three four five."),
			sentence("s1", "Second one here."),
			sentence("s2", "Third one here."),
			sentence("s3", "Fourth one waits."),
		]);
		const [session] = fake.sessions;
		expect(session?.id).toBe(id);
		expect(session?.body.sentences[0]?.voice.speaker_id).toBe(
			"default_b78b28baf5c31a1d",
		);
		await post(`/v1/sessions/${id}/position`, { sentence_id: "s0" });
		expect(session?.positions).toEqual(["s0"]);
		const gone = await fetch(`${fake.baseUrl}/v1/sessions/${id}`, {
			method: "DELETE",
		});
		expect(gone.status).toBe(204);
		expect(session?.deleted).toBe(true);
	});

	it("gives every token a null time when word times are off", async () => {
		await fake.close();
		await start({ wordTimes: "null" });
		const id = await openSession([sentence("s0", "No word times here.")]);
		const events = parseSse(
			await (await fetch(`${fake.baseUrl}/v1/sessions/${id}/events`)).text(),
		);
		expect(events.find((e) => e.event === "words")?.data.times).toEqual([
			null,
			null,
			null,
			null,
		]);
	});

	it("gives a new paragraph a 0.60 s gap", async () => {
		const id = await openSession([
			sentence("s0", "Hello there world."),
			sentence("s1", "A new paragraph begins.", true),
		]);
		const events = parseSse(
			await (await fetch(`${fake.baseUrl}/v1/sessions/${id}/events`)).text(),
		).filter((e) => e.event === "sentence");
		const gap = events[1]?.data.start - events[0]?.data.end;
		expect(gap).toBeCloseTo(23 * MP3_FRAME_SECONDS, 2);
	});

	it("waits firstAudioDelayMs before the first sentence", async () => {
		await fake.close();
		await start({ firstAudioDelayMs: 250 });
		const id = await openSession([sentence("s0", "Hello there world.")]);
		const began = Date.now();
		const events = followEvents(
			await fetch(`${fake.baseUrl}/v1/sessions/${id}/events`),
		);
		await events.until((all) => all.length > 0);
		expect(Date.now() - began).toBeGreaterThanOrEqual(150);
		await events.cancel();
	});
});

describe("fake speech service: one reader of each stream", () => {
	it("answers 409 to a second audio or events reader, even after the first left", async () => {
		const id = await openSession([sentence("s0", "Hello there world.")]);
		await (
			await fetch(`${fake.baseUrl}/v1/sessions/${id}/audio`)
		).arrayBuffer();
		await (await fetch(`${fake.baseUrl}/v1/sessions/${id}/events`)).text();
		for (const kind of ["audio", "events"]) {
			const again = await fetch(`${fake.baseUrl}/v1/sessions/${id}/${kind}`);
			// A reading whose two streams have drained is forgotten at once: take
			// the 404 as done. A reader still being served is a 409.
			expect([404, 409]).toContain(again.status);
		}
	});

	it("answers 409, not 404, to a second reader while the session is still being read", async () => {
		const id = await openSession([
			sentence("s0", "Hello there world."),
			sentence("s1", "Second one here."),
			sentence("s2", "Third one here."),
			sentence("s3", "Fourth one waits."),
		]);
		const first = followEvents(
			await fetch(`${fake.baseUrl}/v1/sessions/${id}/events`),
		);
		await first.until((all) => all.some((e) => e.event === "sentence"));
		const second = await fetch(`${fake.baseUrl}/v1/sessions/${id}/events`);
		expect(second.status).toBe(409);
		expect(await second.json()).toEqual({ error: "reader_taken" });
		await first.cancel();
		// The first reader has left, and a second is still refused.
		await sleep(30);
		const third = await fetch(`${fake.baseUrl}/v1/sessions/${id}/events`);
		expect(third.status).toBe(409);
		const audio = await fetch(`${fake.baseUrl}/v1/sessions/${id}/audio`);
		expect(audio.status).toBe(200);
		await audio.body?.cancel();
		const again = await fetch(`${fake.baseUrl}/v1/sessions/${id}/audio`);
		expect(again.status).toBe(409);
		await again.body?.cancel();
	});

	it("ignores Range and answers 200 from byte 0 with no length", async () => {
		const id = await openSession([sentence("s0", "Hello there world.")]);
		const probe = await fetch(`${fake.baseUrl}/v1/sessions/${id}/audio`, {
			headers: { Range: "bytes=0-1" },
		});
		expect(probe.status).toBe(200);
		expect(probe.headers.get("content-length")).toBeNull();
		expect(probe.headers.get("accept-ranges")).toBeNull();
		const bytes = new Uint8Array(await probe.arrayBuffer());
		expect(bytes.length).toBeGreaterThan(2);
		expect([...bytes.slice(0, 4)]).toEqual([0xff, 0xfb, 0x90, 0xc0]);
	});

	it("answers 404 for a session it does not know", async () => {
		for (const path of ["audio", "events"]) {
			const response = await fetch(
				`${fake.baseUrl}/v1/sessions/${"0".repeat(32)}/${path}`,
			);
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({ error: "not_found" });
		}
		const gone = await fetch(`${fake.baseUrl}/v1/sessions/${"0".repeat(32)}`, {
			method: "DELETE",
		});
		expect(gone.status).toBe(404);
	});
});

describe("fake speech service: position and prefetch", () => {
	it("holds a sentence until a position report lets it through", async () => {
		const id = await openSession([
			sentence("s0", "Hello there world."),
			sentence("s1", "Second one here."),
			sentence("s2", "Third one here."),
			sentence("s3", "Fourth one waits."),
		]);
		const events = followEvents(
			await fetch(`${fake.baseUrl}/v1/sessions/${id}/events`),
		);
		// Sentences 0, 1 and 2 are within position + 2 of the first sentence.
		await events.until(
			(all) => all.filter((e) => e.event === "words").length === 3,
		);
		await sleep(150);
		expect(events.events().filter((e) => e.event === "sentence")).toHaveLength(
			3,
		);
		expect(events.events().some((e) => e.event === "done")).toBe(false);

		// The sentence now playing is s1: sentence 3 is within 2 of it.
		const reported = await post(`/v1/sessions/${id}/position`, {
			sentence_id: "s1",
		});
		expect(reported.status).toBe(204);
		await events.until((all) => all.some((e) => e.event === "done"));
		expect(events.events().filter((e) => e.event === "sentence")).toHaveLength(
			4,
		);
		await events.finished;
	});

	it("answers 422 to a position for an unknown sentence", async () => {
		const id = await openSession([sentence("s0", "Hello there world.")]);
		const response = await post(`/v1/sessions/${id}/position`, {
			sentence_id: "s9",
		});
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({
			error: "invalid",
			field: "sentence_id",
		});
		const notAnObject = await post(`/v1/sessions/${id}/position`, "[]");
		expect(notAnObject.status).toBe(422);
		expect(await notAnObject.json()).toEqual({
			error: "invalid",
			field: "body",
		});
	});

	it("answers 404 to a position for an unknown session", async () => {
		const response = await post(`/v1/sessions/${"0".repeat(32)}/position`, {
			sentence_id: "s0",
		});
		expect(response.status).toBe(404);
	});
});

describe("fake speech service: failures on demand", () => {
	it("fails at the asked sentence with an error event, the last one", async () => {
		await fake.close();
		await start({ failAtSentence: 1 });
		const id = await openSession([
			sentence("s0", "Hello there world."),
			sentence("s1", "This one fails."),
			sentence("s2", "Never reached."),
		]);
		const events = parseSse(
			await (await fetch(`${fake.baseUrl}/v1/sessions/${id}/events`)).text(),
		);
		expect(events.map((e) => e.event)).toEqual(["sentence", "words", "error"]);
		expect(events.at(-1)?.data).toEqual({ id: "s1", code: "synthesis_failed" });
	});

	it("gives a late events reader the buffered error, then forgets the session", async () => {
		await fake.close();
		await start({ failAtSentence: 0 });
		const id = await openSession([sentence("s0", "Fails at once.")]);
		// A late audio reader gets an empty, finished response.
		const audio = await fetch(`${fake.baseUrl}/v1/sessions/${id}/audio`);
		expect(audio.status).toBe(200);
		expect((await audio.arrayBuffer()).byteLength).toBe(0);
		// position and DELETE are accepted while the events are unread.
		expect(
			(await post(`/v1/sessions/${id}/position`, { sentence_id: "s0" })).status,
		).toBe(204);
		const events = parseSse(
			await (await fetch(`${fake.baseUrl}/v1/sessions/${id}/events`)).text(),
		);
		expect(events.map((e) => e.event)).toEqual(["error"]);
		// The events were read to their end: nothing is left to keep.
		await sleep(30);
		const after = await fetch(`${fake.baseUrl}/v1/sessions/${id}/audio`);
		expect(after.status).toBe(404);
	});

	it("cuts both streams at the asked sentence, with no event", async () => {
		await fake.close();
		await start({ cutAtSentence: 1 });
		const id = await openSession([
			sentence("s0", "Hello there world."),
			sentence("s1", "This one is cut."),
		]);
		// The audio's connection is destroyed before its last chunk: the response
		// never completes (what the app's server reads it with sees the same).
		const audioComplete = await new Promise<boolean>((resolve) => {
			get(`${fake.baseUrl}/v1/sessions/${id}/audio`, (res) => {
				res.on("data", () => undefined);
				res.on("error", () => undefined);
				res.on("close", () => resolve(res.complete));
			}).on("error", () => resolve(false));
		});
		expect(audioComplete).toBe(false);
		// The events break the same way: neither a done nor an error.
		const events = followEvents(
			await fetch(`${fake.baseUrl}/v1/sessions/${id}/events`),
		);
		await events.finished;
		const seen = events.events().map((e) => e.event);
		expect(seen).not.toContain("done");
		expect(seen).not.toContain("error");
	});

	it("refuses sessions when asked", async () => {
		await fake.close();
		await start({ refuseSessions: true });
		const response = await post("/v1/sessions", {
			sentences: [sentence("s0", "Hello there.")],
		});
		expect(response.status).toBe(503);
	});

	it("replaces its options as a whole, so an empty set clears a failure", async () => {
		await fake.close();
		await start({ failAtSentence: 0 });
		fake.setOptions({});
		const id = await openSession([sentence("s0", "This one no longer fails.")]);
		const events = parseSse(
			await (await fetch(`${fake.baseUrl}/v1/sessions/${id}/events`)).text(),
		);
		expect(events.at(-1)?.event).toBe("done");
	});
});

describe("fake speech service: DELETE", () => {
	it("ends both streams with neither done nor error, and forgets the session", async () => {
		const id = await openSession([
			sentence("s0", "Hello there world."),
			sentence("s1", "Second one here."),
			sentence("s2", "Third one here."),
			sentence("s3", "Fourth one waits."),
		]);
		const events = followEvents(
			await fetch(`${fake.baseUrl}/v1/sessions/${id}/events`),
		);
		const audio = await fetch(`${fake.baseUrl}/v1/sessions/${id}/audio`);
		await events.until(
			(all) => all.filter((e) => e.event === "words").length === 3,
		);

		const gone = await fetch(`${fake.baseUrl}/v1/sessions/${id}`, {
			method: "DELETE",
		});
		expect(gone.status).toBe(204);
		await events.finished;
		expect(events.events().map((e) => e.event)).not.toContain("done");
		expect(events.events().map((e) => e.event)).not.toContain("error");
		// The audio response ends as a complete one.
		expect((await audio.arrayBuffer()).byteLength).toBeGreaterThan(0);
		expect(fake.sessions[0]?.deleted).toBe(true);

		const again = await fetch(`${fake.baseUrl}/v1/sessions/${id}`, {
			method: "DELETE",
		});
		expect(again.status).toBe(404);
	});
});

describe("fake speech service: what a body may hold", () => {
	it("answers 422 with the path of the first field that fails, never a value", async () => {
		const secret = "SECRET-TEXT-MUST-NOT-COME-BACK";
		const cases: Array<[string, unknown, string]> = [
			["body", [secret], "body"],
			["sentences", { sentences: [] }, "sentences"],
			[
				"tokens",
				{
					sentences: [
						sentence("s0", "fine one"),
						{ ...sentence("s1", "x"), tokens: [] },
					],
				},
				"sentences[1].tokens",
			],
			[
				"tokens over 400 characters",
				{
					sentences: [{ ...sentence("s0", "x"), tokens: [secret.repeat(14)] }],
				},
				"sentences[0].tokens",
			],
			[
				"language",
				{ sentences: [{ ...sentence("s0", secret), language: "de" }] },
				"sentences[0].language",
			],
			[
				"duplicate id",
				{
					sentences: [sentence("s0", "one two"), sentence("s0", "three four")],
				},
				"sentences[1].id",
			],
			[
				"controls with a boolean",
				{
					sentences: [
						{
							...sentence("s0", "one two"),
							voice: { speaker_id: "x", controls: { "room.clean": true } },
						},
					],
				},
				"sentences[0].voice.controls",
			],
			[
				"seed as a float",
				{ sentences: [sentence("s0", "one two")], seed: 1.5 },
				"seed",
			],
			[
				"seed as a boolean",
				{ sentences: [sentence("s0", "one two")], seed: true },
				"seed",
			],
			[
				"seed too large",
				{ sentences: [sentence("s0", "one two")], seed: 2 ** 32 },
				"seed",
			],
		];
		for (const [name, body, field] of cases) {
			const response = await post("/v1/sessions", body);
			expect(response.status, name).toBe(422);
			const text = await response.text();
			expect(JSON.parse(text), name).toEqual({ error: "invalid", field });
			expect(text).not.toContain(secret);
		}
		const notJson = await post("/v1/sessions", "{not json");
		expect(notJson.status).toBe(422);
	});

	it("accepts a seed in range, and controls that are integers or finite floats", async () => {
		const response = await post("/v1/sessions", {
			sentences: [
				{
					...sentence("s0", "one two"),
					voice: {
						speaker_id: "x",
						controls: { "room.clean": 2, "delivery.tempo": 0.5 },
					},
				},
			],
			seed: 4294967295,
		});
		expect(response.status).toBe(201);
	});

	it("answers 413 to a body of more than 4 MiB", async () => {
		const response = await post(
			"/v1/sessions",
			`{"sentences":[],"pad":"${"a".repeat(4 * 1024 * 1024)}"}`,
		);
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "too_large" });
	});
});

describe("fake speech service: the rest", () => {
	it("answers /health with ok, zonos and aligner", async () => {
		const response = await fetch(`${fake.baseUrl}/health`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			zonos: true,
			aligner: true,
		});
	});

	it("answers 404 text/plain to a path that is no route, and 405 to a wrong method", async () => {
		const missing = await fetch(`${fake.baseUrl}/nope`);
		expect(missing.status).toBe(404);
		expect(missing.headers.get("content-type")).toContain("text/plain");
		const wrong = await fetch(`${fake.baseUrl}/v1/sessions`, { method: "GET" });
		expect(wrong.status).toBe(405);
	});
});
