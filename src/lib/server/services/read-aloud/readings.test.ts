// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MP3_FRAME_SECONDS } from "../../../shared/read-aloud/silent-mp3";
import {
	attachAudio,
	attachEvents,
	closeReading,
	configureReadingsForTests,
	currentReading,
	openReading,
	type Reading,
	reportPosition,
	resetReadingsForTests,
	takeOpenTicket,
} from "./readings";
import { ReadingSuperseded, SpeechUnavailable } from "./speech-client";
import {
	createFakeSpeechService,
	type FakeSpeechOptions,
	type FakeSpeechService,
} from "./testing/fake-speech-service";

const FRAME_BYTES = 417;
const ENCODER_DELAY = 0.025;

let fake: FakeSpeechService;

async function startFake(options?: FakeSpeechOptions) {
	fake = await createFakeSpeechService(options);
	return fake;
}

beforeEach(async () => {
	await startFake();
});

afterEach(async () => {
	resetReadingsForTests();
	await fake.close();
	vi.restoreAllMocks();
});

function sentence(id: string, text: string, paragraphStart = false) {
	return {
		id,
		language: "en" as const,
		voice: { speaker_id: "default_b78b28baf5c31a1d", controls: {} },
		tokens: text.split(" "),
		paragraph_start: paragraphStart,
	};
}

const TWO = [
	sentence("s0", "Hello there world."),
	sentence("s1", "Second one here."),
];
// Four sentences: the fake holds the fourth until a position report lets it
// through, so the reading stays running.
const FOUR = [
	...TWO,
	sentence("s2", "Third one here."),
	sentence("s3", "Fourth one waits."),
];

function open(userId: string, sentences = TWO): Promise<Reading> {
	return openReading({ userId, baseUrl: fake.baseUrl, sentences });
}

async function readAll(
	stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** The service's last word on a good reading: its timeline is complete. */
const DONE = /event: done\ndata: [^\n]*\n\n/;

/**
 * Reads an events stream until `marker` has come, and returns what it said.
 * The browser's stream stays open after the service's last event (a reading
 * replaced from another tab must still hear `replaced`, early review R7), so a
 * test cannot read it to its end.
 */
async function readEventsUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	marker: RegExp,
): Promise<string> {
	const decoder = new TextDecoder();
	let seen = "";
	while (!marker.test(seen)) {
		const { done, value } = await reader.read();
		if (done) throw new Error(`ended before ${marker}: ${seen}`);
		seen += decoder.decode(value, { stream: true });
	}
	return seen;
}

/** What is left of a stream once it has ended. */
async function readRest(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
	const decoder = new TextDecoder();
	let seen = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return seen;
		seen += decoder.decode(value, { stream: true });
	}
}

type SseEvent = {
	event: string;
	data: { id?: string; end?: number; code?: string };
};
function parseSse(raw: string): SseEvent[] {
	return raw
		.split("\n\n")
		.filter((block) => block.startsWith("event: "))
		.map((block) => {
			const lines = block.split("\n");
			return {
				event: (lines[0] ?? "").slice(7),
				data: JSON.parse((lines[1] ?? "data: {}").slice(6)),
			};
		});
}

async function until(condition: () => boolean, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("readings: what a browser hears", () => {
	it("a browser reader hears the session from its first byte", async () => {
		const reading = await open("user-a");
		const eventsReader = attachEvents(reading).getReader();
		const [audio, events] = await Promise.all([
			readAll(attachAudio(reading) as ReadableStream<Uint8Array>),
			readEventsUntil(eventsReader, DONE),
		]);
		await eventsReader.cancel();
		const sentences = parseSse(events).filter((e) => e.event === "sentence");
		const lastEnd = sentences.at(-1)?.data.end as number;
		// Every byte of the fake's silent frames: as many as the last end time says.
		expect(audio.length % FRAME_BYTES).toBe(0);
		expect(audio.length / FRAME_BYTES).toBe(
			Math.round((lastEnd - ENCODER_DELAY) / MP3_FRAME_SECONDS),
		);
		expect([...audio.slice(0, 4)]).toEqual([0xff, 0xfb, 0x90, 0xc0]);
	});

	it("a second reader of the audio hears it from the first byte", async () => {
		const reading = await open("user-a", FOUR);
		const first = attachAudio(reading) as ReadableStream<Uint8Array>;
		const firstReader = first.getReader();
		const firstChunk = await firstReader.read();
		expect(firstChunk.done).toBe(false);

		// Safari probes with a range request, then asks again: both are served
		// from the replay, and the speech service sees no second GET.
		const second = attachAudio(reading) as ReadableStream<Uint8Array>;
		const secondReader = second.getReader();
		const secondChunk = await secondReader.read();
		expect(secondChunk.value).toEqual(firstChunk.value);
		await firstReader.cancel();
		await secondReader.cancel();
	});

	it("replays the timeline to a late events reader", async () => {
		const reading = await open("user-a");
		const first = attachEvents(reading).getReader();
		const live = parseSse(await readEventsUntil(first, DONE));
		expect(live.map((e) => e.event)).toEqual([
			"sentence",
			"words",
			"sentence",
			"words",
			"done",
		]);
		// The reading is still held (the audio has not been read): a late reader
		// gets the whole timeline again, from its first event.
		const second = attachEvents(reading).getReader();
		const late = parseSse(await readEventsUntil(second, DONE));
		expect(late).toEqual(live);
		await first.cancel();
		await second.cancel();
	});

	it("reports the sentence now playing, which releases the next sentences", async () => {
		const reading = await open("user-a", FOUR);
		const events = attachEvents(reading).getReader();
		let seen = "";
		const decoder = new TextDecoder();
		const readUntil = async (marker: string) => {
			while (!seen.includes(marker)) {
				const { done, value } = await events.read();
				if (done) throw new Error(`ended before ${marker}: ${seen}`);
				seen += decoder.decode(value, { stream: true });
			}
		};
		await readUntil('"id":"s2"');
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(seen).not.toContain('"id":"s3"');
		await reportPosition(reading, "s1");
		await readUntil("event: done");
		expect(fake.sessions[0]?.positions).toEqual(["s1"]);
		await events.cancel();
	});

	it("keeps the heartbeat out of the replay and sends it to a waiting reader", async () => {
		configureReadingsForTests({ heartbeatMs: 40 });
		const reading = await open("user-a", FOUR);
		const reader = attachEvents(reading).getReader();
		let seen = "";
		const decoder = new TextDecoder();
		const deadline = Date.now() + 3000;
		while (!seen.includes(": hb\n\n") && Date.now() < deadline) {
			const { done, value } = await reader.read();
			if (done) break;
			seen += decoder.decode(value, { stream: true });
		}
		expect(seen).toContain(": hb\n\n");
		await reader.cancel();
		// A late reader's replay is the timeline alone.
		const late = attachEvents(reading).getReader();
		const first = await late.read();
		expect(decoder.decode(first.value)).not.toContain(": hb");
		await late.cancel();
	});
});

describe("readings: one per person", () => {
	it("opening a second reading for the same person closes the first and tells its readers", async () => {
		const first = await open("user-a", FOUR);
		const firstEvents = attachEvents(first);
		const second = await open("user-a", TWO);

		expect(first.sessionId).not.toBe(second.sessionId);
		const tail = text(await readAll(firstEvents));
		expect(tail.endsWith("event: replaced\ndata: {}\n\n")).toBe(true);
		await until(() => fake.sessions[0]?.deleted === true);
		expect(currentReading("user-a", first.sessionId)).toBeNull();
		expect(currentReading("user-a", second.sessionId)).not.toBeNull();
	});

	it("two people read at once", async () => {
		const a = await open("user-a", FOUR);
		const b = await open("user-b", FOUR);
		expect(currentReading("user-a", a.sessionId)).not.toBeNull();
		expect(currentReading("user-b", b.sessionId)).not.toBeNull();
		// A session id is only the caller's own.
		expect(currentReading("user-a", b.sessionId)).toBeNull();
		await closeReading(a);
		expect(currentReading("user-a", a.sessionId)).toBeNull();
		expect(currentReading("user-b", b.sessionId)).not.toBeNull();
		expect(fake.sessions.map((s) => s.deleted)).toEqual([true, false]);
	});

	it("serves two quick presses one after the other", async () => {
		const [first, second] = await Promise.all([
			open("user-a", FOUR),
			open("user-a", FOUR),
		]);
		expect(currentReading("user-a", first.sessionId)).toBeNull();
		expect(currentReading("user-a", second.sessionId)).not.toBeNull();
		await until(
			() => fake.sessions.length === 2 && fake.sessions[0]?.deleted === true,
		);
	});

	it("keeps the later press when the earlier one finishes opening last", async () => {
		// Two presses: the first took a ticket first, but the later one finished
		// its checks first and opens first. The earlier one must not replace it.
		const early = takeOpenTicket("user-a");
		const late = takeOpenTicket("user-a");
		expect(late).toBeGreaterThan(early);
		const kept = await openReading({
			userId: "user-a",
			baseUrl: fake.baseUrl,
			sentences: FOUR,
			ticket: late,
		});
		await expect(
			openReading({
				userId: "user-a",
				baseUrl: fake.baseUrl,
				sentences: FOUR,
				ticket: early,
			}),
		).rejects.toBeInstanceOf(ReadingSuperseded);
		expect(currentReading("user-a", kept.sessionId)).not.toBeNull();
		// The refused press made no session at all.
		expect(fake.sessions).toHaveLength(1);
		// A press after both replaces the reading as usual.
		const next = await openReading({
			userId: "user-a",
			baseUrl: fake.baseUrl,
			sentences: FOUR,
			ticket: takeOpenTicket("user-a"),
		});
		expect(currentReading("user-a", next.sessionId)).not.toBeNull();
		expect(currentReading("user-a", kept.sessionId)).toBeNull();
		// Tickets are each person's own.
		expect(takeOpenTicket("user-b")).toBe(1);
	});

	it("closing a reading deletes the session and ends its readers", async () => {
		const reading = await open("user-a", FOUR);
		const audio = attachAudio(reading) as ReadableStream<Uint8Array>;
		const events = attachEvents(reading);
		await closeReading(reading);
		expect(fake.sessions[0]?.deleted).toBe(true);
		expect(currentReading("user-a", reading.sessionId)).toBeNull();
		await readAll(audio);
		const ended = text(await readAll(events));
		expect(ended).not.toContain("event: replaced");
		// Closing twice is harmless.
		await closeReading(reading);
	});
});

describe("readings: a reading replaced after the service said done (early review R7)", () => {
	it("tells the events reader of a reading whose synthesis has finished that it was replaced", async () => {
		// Two sentences: the fake makes both at once, so `done` comes before anything
		// is played. The first tab still plays them, so the second tab's press must
		// reach it (decision 8: it ends quietly).
		const first = await open("user-a", TWO);
		const reader = attachEvents(first).getReader();
		await readEventsUntil(reader, DONE);

		const second = await open("user-a", TWO);

		expect(await readRest(reader)).toBe("event: replaced\ndata: {}\n\n");
		expect(currentReading("user-a", first.sessionId)).toBeNull();
		expect(currentReading("user-a", second.sessionId)).not.toBeNull();
	});

	it("keeps sending the heartbeat after done, so the stream is not cut", async () => {
		configureReadingsForTests({ heartbeatMs: 30 });
		const reading = await open("user-a", TWO);
		const reader = attachEvents(reading).getReader();
		await readEventsUntil(reader, DONE);
		await readEventsUntil(reader, /: hb\n\n/);
		await reader.cancel();
	});

	it("keeps a drained reading while its events reader is attached, and closes it when that reader leaves", async () => {
		const reading = await open("user-a", TWO);
		const reader = attachEvents(reading).getReader();
		await readEventsUntil(reader, DONE);
		await readAll(attachAudio(reading) as ReadableStream<Uint8Array>);
		// All of it has been served, and the browser is still playing it: the
		// reading stays, because it is what a replacing press tells.
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(currentReading("user-a", reading.sessionId)).not.toBeNull();

		// The browser closes its stream when the reading ends: nothing is left to serve.
		await reader.cancel();
		await until(
			() => currentReading("user-a", reading.sessionId) === null,
			1000,
		);
	});

	it("does not end a reading as idle while its events reader is attached", async () => {
		configureReadingsForTests({ idleMs: 100 });
		const reading = await open("user-a", FOUR);
		const events = attachEvents(reading).getReader();
		const audio = (
			attachAudio(reading) as ReadableStream<Uint8Array>
		).getReader();
		await audio.read();
		await audio.cancel();
		await new Promise((resolve) => setTimeout(resolve, 350));
		expect(currentReading("user-a", reading.sessionId)).not.toBeNull();

		await events.cancel();
		await until(
			() => currentReading("user-a", reading.sessionId) === null,
			1000,
		);
	});

	it("does not close a drained reading before its events reader has come", async () => {
		// The browser asks for the audio and, a moment later, for the events. On a busy machine
		// the audio can be read to its end before the second request arrives: closing the
		// reading then answered the events request 404, and the page ended its reading with
		// "the voice stopped answering".
		const reading = await open("user-a", TWO);
		await readAll(attachAudio(reading) as ReadableStream<Uint8Array>);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(currentReading("user-a", reading.sessionId)).not.toBeNull();

		// The events reader comes late, hears the whole timeline, and leaves: now it is drained.
		const late = attachEvents(reading).getReader();
		await readEventsUntil(late, DONE);
		await late.cancel();
		await until(
			() => currentReading("user-a", reading.sessionId) === null,
			1000,
		);
	});

	it("a finished reading whose events nobody ever read ends as idle", async () => {
		// A client that never opens the events stream: with no stream to wait for, the idle end
		// closes it.
		configureReadingsForTests({ idleMs: 150 });
		const reading = await open("user-a", TWO);
		await readAll(attachAudio(reading) as ReadableStream<Uint8Array>);
		expect(currentReading("user-a", reading.sessionId)).not.toBeNull();
		await until(
			() => currentReading("user-a", reading.sessionId) === null,
			1000,
		);
	});
});

describe("readings: when readers leave", () => {
	it("ends a reading 30 s after its last browser reader leaves", async () => {
		configureReadingsForTests({ idleMs: 200 });
		const reading = await open("user-a", FOUR);
		const audio = (
			attachAudio(reading) as ReadableStream<Uint8Array>
		).getReader();
		await audio.read();
		await audio.cancel();
		const left = Date.now();
		await until(
			() => currentReading("user-a", reading.sessionId) === null,
			1000,
		);
		expect(Date.now() - left).toBeLessThan(600);
		await until(() => fake.sessions[0]?.deleted === true, 1000);
	});

	it("counts the idle time from creation, when no reader ever comes", async () => {
		configureReadingsForTests({ idleMs: 150 });
		const reading = await open("user-a", FOUR);
		await until(
			() => currentReading("user-a", reading.sessionId) === null,
			1000,
		);
		await until(() => fake.sessions[0]?.deleted === true, 1000);
	});

	it("keeps a reading while a reader is attached, however long it takes", async () => {
		configureReadingsForTests({ idleMs: 100 });
		const reading = await open("user-a", FOUR);
		const audio = (
			attachAudio(reading) as ReadableStream<Uint8Array>
		).getReader();
		await audio.read();
		await new Promise((resolve) => setTimeout(resolve, 350));
		expect(currentReading("user-a", reading.sessionId)).not.toBeNull();
		await audio.cancel();
	});

	it("closes once the audio has ended, a reader has drained it and the events reader has left", async () => {
		const reading = await open("user-a", TWO);
		const events = attachEvents(reading).getReader();
		await readEventsUntil(events, DONE);
		await readAll(attachAudio(reading) as ReadableStream<Uint8Array>);
		await events.cancel();
		await until(
			() => currentReading("user-a", reading.sessionId) === null,
			1000,
		);
	});

	it("does not close for a reader that left early: a probe is not a drain", async () => {
		const reading = await open("user-a", TWO);
		const probe = (
			attachAudio(reading) as ReadableStream<Uint8Array>
		).getReader();
		await probe.read();
		await probe.cancel();
		// The real request comes after the probe, and still hears everything.
		await new Promise((resolve) => setTimeout(resolve, 100));
		const real = attachAudio(reading);
		expect(real).not.toBeNull();
		expect(
			(await readAll(real as ReadableStream<Uint8Array>)).length,
		).toBeGreaterThan(FRAME_BYTES);
	});

	it("stops replaying after its cap", async () => {
		await fake.close();
		// The audio starts after the first reader has attached, so that reader is
		// the one the cap must not take anything from.
		await startFake({ firstAudioDelayMs: 200 });
		configureReadingsForTests({ replayMaxBytes: 10_000 });
		const reading = await open("user-a", FOUR);
		const early = (
			attachAudio(reading) as ReadableStream<Uint8Array>
		).getReader();
		let heard = 0;
		while (heard <= 10_000) {
			const { done, value } = await early.read();
			if (done) break;
			heard += value.length;
		}
		expect(heard).toBeGreaterThan(10_000);
		// Past the cap, with the reading still going, nobody new can start from
		// the first byte.
		expect(currentReading("user-a", reading.sessionId)).not.toBeNull();
		expect(attachAudio(reading)).toBeNull();
		// The reader that was attached keeps its place in the chain.
		const more = await early.read();
		expect(more.done).toBe(false);
		await early.cancel();
	});
});

describe("readings: when the service breaks", () => {
	it("refuses with SpeechUnavailable when the service is down", async () => {
		const baseUrl = fake.baseUrl;
		await fake.close();
		await expect(
			openReading({ userId: "user-a", baseUrl, sentences: TWO }),
		).rejects.toBeInstanceOf(SpeechUnavailable);
		expect(currentReading("user-a", "0".repeat(32))).toBeNull();
		await startFake();
	});

	it("refuses with SpeechUnavailable when the service answers 503", async () => {
		await fake.close();
		await startFake({ refuseSessions: true });
		await expect(open("user-a")).rejects.toBeInstanceOf(SpeechUnavailable);
	});

	it("ends its readers with an error when the service cuts the stream", async () => {
		await fake.close();
		await startFake({ cutAtSentence: 1 });
		const reading = await open("user-a", TWO);
		const audio = attachAudio(reading) as ReadableStream<Uint8Array>;
		await expect(readAll(audio)).rejects.toThrow();
	});

	it("passes an error event on to the readers, and never opens a stream twice", async () => {
		await fake.close();
		await startFake({ failAtSentence: 1 });
		const reading = await open("user-a", TWO);
		const reader = attachEvents(reading).getReader();
		const events = parseSse(
			await readEventsUntil(reader, /event: error\ndata: [^\n]*\n\n/),
		);
		expect(events.at(-1)).toEqual({
			event: "error",
			data: { id: "s1", code: "synthesis_failed" },
		});
		await reader.cancel();
	});
});
