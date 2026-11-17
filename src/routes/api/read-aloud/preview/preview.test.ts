// @vitest-environment node
// POST /api/read-aloud/preview (Plan 3, Task 5) against the fake speech
// service, with only the user (on the event) and `getReadAloudUrl` mocked.
// Made-up people and the samples only.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Importing the read-aloud index must not open a database.
vi.mock("$lib/server/db", () => ({ db: {} }));
vi.mock("$lib/server/config-store", () => ({ getReadAloudUrl: vi.fn() }));

import { getReadAloudUrl } from "$lib/server/config-store";
import { readMp3 } from "$lib/server/services/read-aloud/mp3-join";
import {
	createFakeSpeechService,
	type FakeSpeechService,
} from "$lib/server/services/read-aloud/testing/fake-speech-service";
import { STYLES, ZERO_KNOBS } from "$lib/shared/read-aloud/voice-knobs";
import { VOICE_SAMPLES } from "$lib/shared/read-aloud/voice-samples";
import { POST } from "./+server";

const feature = getReadAloudUrl as ReturnType<typeof vi.fn>;
let fake: FakeSpeechService;

beforeEach(async () => {
	fake = await createFakeSpeechService();
	feature.mockReturnValue(fake.baseUrl);
});

afterEach(async () => {
	await fake.close();
	vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs = 2000) {
	for (let waited = 0; !condition(); waited += 10) {
		if (waited >= timeoutMs) throw new Error("timed out");
		await sleep(10);
	}
}

function eventFor(
	body: unknown,
	options: { user?: string | null; raw?: string } = {},
) {
	const user = options.user === undefined ? "user-a" : options.user;
	return {
		request: new Request("http://localhost/api/read-aloud/preview", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: options.raw ?? JSON.stringify(body),
		}),
		params: {},
		locals: { user: user ? { id: user, role: "user" } : undefined },
	} as never;
}

const request = (extra: Record<string, unknown> = {}) => ({
	base: "imogen",
	knobs: { ...ZERO_KNOBS },
	...extra,
});

function bedtime() {
	const style = STYLES.find((candidate) => candidate.key === "bedtime");
	if (!style) throw new Error("no bedtime style");
	return { ...style.knobs };
}

/** A service that answers every call with this status and body. */
async function serviceAnswering(status: number, body: unknown) {
	const server: Server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(body));
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((done) => server.close(() => done())),
	};
}

describe("POST /api/read-aloud/preview", () => {
	it("401 without a user; 404 read_aloud_off when the feature is off", async () => {
		await expect(
			POST(eventFor(request(), { user: null })),
		).rejects.toMatchObject({
			status: 401,
		});
		feature.mockReturnValue("");
		const response = await POST(eventFor(request()));
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "read_aloud_off" });
		expect(fake.previews).toEqual([]);
	});

	it("400 for a body that is not a preview request, and unknown_voice for a base that is not a built-in voice", async () => {
		const invalid: Array<[string, unknown]> = [
			["no knobs", { base: "imogen" }],
			["no base", { knobs: ZERO_KNOBS }],
			["a knob out of range", request({ knobs: { ...ZERO_KNOBS, pace: 3 } })],
			["a sixth knob", request({ knobs: { ...ZERO_KNOBS, gender: 1 } })],
			["words that are not a string", request({ text: 5 })],
			["more than 2000 characters", request({ text: "a".repeat(2001) })],
			["a list", []],
		];
		for (const [label, body] of invalid) {
			const response = await POST(eventFor(body));
			expect(response.status, label).toBe(400);
			expect(await response.json(), label).toEqual({
				error: "invalid_request",
			});
		}
		const notJson = await POST(eventFor(null, { raw: "{not json" }));
		expect(notJson.status).toBe(400);

		const unknown = await POST(eventFor(request({ base: "nobody" })));
		expect(unknown.status).toBe(400);
		expect(await unknown.json()).toEqual({ error: "unknown_voice" });
		expect(fake.previews).toEqual([]);
	});

	it("answers the joined MP3 with Content-Length, no-store and the sentences' times", async () => {
		const response = await POST(eventFor(request()));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("audio/mpeg");
		expect(response.headers.get("cache-control")).toBe("no-store");
		const bytes = new Uint8Array(await response.arrayBuffer());
		expect(response.headers.get("content-length")).toBe(String(bytes.length));
		const times = JSON.parse(
			response.headers.get("x-read-aloud-sentences") ?? "null",
		) as Array<[number, number]>;
		expect(times).toHaveLength(2);
		const [first, second] = times;
		expect(first?.[0]).toBe(0);
		// The second sentence starts after the first and the 0.30 s gap, and the clip ends with it.
		expect((second?.[0] ?? 0) - (first?.[1] ?? 0)).toBeCloseTo(0.313, 2);
		expect(readMp3(bytes).seconds).toBeCloseTo(second?.[1] ?? -1, 2);
		// It spoke the English sample, in the base's voice.
		expect(fake.previews.map((made) => made.text).sort()).toEqual(
			[...VOICE_SAMPLES.en].sort(),
		);
		expect(fake.previews[0]?.voice).toEqual({
			speaker_id: "default_b78b28baf5c31a1d",
			controls: {},
		});
	});

	it("previews the base's own language, with the knobs' controls on the base's", async () => {
		const response = await POST(
			eventFor(request({ base: "berta", knobs: bedtime() })),
		);
		expect(response.status).toBe(200);
		expect(fake.previews.map((made) => made.text).sort()).toEqual(
			[...VOICE_SAMPLES.hu].sort(),
		);
		for (const made of fake.previews) {
			expect(made.language).toBe("hu");
			expect(made.voice).toEqual({
				speaker_id: "default_bf7632822e6b4dc0",
				controls: {
					"room.clean": 2,
					"delivery.tempo": -1,
					"texture.deep": 1,
					"mood.arousal": -2.5,
					"delivery.whisper": 0.6,
				},
			});
		}
	});

	it("reads the person's words instead of the sample", async () => {
		const response = await POST(
			eventFor(request({ text: "  Hello there, this is mine.  " })),
		);
		expect(response.status).toBe(200);
		expect(fake.previews.map((made) => made.text)).toEqual([
			"Hello there, this is mine.",
		]);
		const times = JSON.parse(
			response.headers.get("x-read-aloud-sentences") ?? "null",
		) as Array<[number, number]>;
		expect(times).toHaveLength(1);
	});

	it("400 for words with nothing to say", async () => {
		for (const text of ["", "   ", "→ ★ …", "a".repeat(301)]) {
			const response = await POST(eventFor(request({ text })));
			expect(response.status, JSON.stringify(text.slice(0, 10))).toBe(400);
			expect(await response.json()).toEqual({ error: "invalid_request" });
		}
		expect(fake.previews).toEqual([]);
	});

	it("409 superseded for a preview a later one overtook", async () => {
		fake.setOptions({ previewDelayMs: 250 });
		const first = POST(eventFor(request({ text: "The first one." })));
		await until(() => fake.previews.length === 1);
		const second = POST(eventFor(request({ text: "The second one." })));
		const overtaken = await first;
		expect(overtaken.status).toBe(409);
		expect(await overtaken.json()).toEqual({ error: "superseded" });
		expect((await second).status).toBe(200);
		// Another person's preview was never in the way.
		fake.setOptions({ previewDelayMs: 150 });
		const [a, b] = await Promise.all([
			POST(eventFor(request({ text: "From A." }), { user: "user-a" })),
			POST(eventFor(request({ text: "From B." }), { user: "user-b" })),
		]);
		expect([a.status, b.status]).toEqual([200, 200]);
	});

	it("503 voice_unavailable when the service fails, and the log line carries no text", async () => {
		const spies = (["log", "info", "warn", "error"] as const).map((level) =>
			vi.spyOn(console, level).mockImplementation(() => undefined),
		);
		const secret = "My secret sentence to hear.";
		fake.setOptions({ failPreview: "unavailable" });
		const down = await POST(eventFor(request({ text: secret })));
		expect(down.status).toBe(503);
		expect(await down.json()).toEqual({ error: "voice_unavailable" });
		fake.setOptions({ failPreview: "failed" });
		expect((await POST(eventFor(request({ text: secret })))).status).toBe(503);
		// A service nobody listens at.
		feature.mockReturnValue("http://127.0.0.1:1");
		expect((await POST(eventFor(request({ text: secret })))).status).toBe(503);

		const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
		for (const word of [
			"secret",
			"sentence",
			...VOICE_SAMPLES.en.flatMap((s) =>
				s.split(" ").filter((w) => w.length > 4),
			),
		])
			expect(logged).not.toContain(word);
	});

	it("422 nothing_to_say when the service finds nothing speakable, logging only its status and field", async () => {
		const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const refusing = await serviceAnswering(422, {
			error: "invalid",
			field: "text",
		});
		try {
			feature.mockReturnValue(refusing.url);
			const response = await POST(eventFor(request({ text: "Hello there." })));
			expect(response.status).toBe(422);
			expect(await response.json()).toEqual({ error: "nothing_to_say" });
		} finally {
			await refusing.close();
		}
		expect(JSON.stringify(spy.mock.calls)).not.toContain("Hello there");
	});

	it("503 voice_unavailable for any other refusal of the service, logging its status and field", async () => {
		const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const refusing = await serviceAnswering(422, {
			error: "invalid",
			field: "voice.speaker_id",
		});
		try {
			feature.mockReturnValue(refusing.url);
			const response = await POST(eventFor(request({ text: "Hello there." })));
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({ error: "voice_unavailable" });
		} finally {
			await refusing.close();
		}
		const logged = JSON.stringify(spy.mock.calls);
		expect(logged).toContain("voice.speaker_id");
		expect(logged).not.toContain("Hello there");
	});

	it("503 voice_unavailable when the clip is not an MP3 the service writes", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const server: Server = createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				res.writeHead(200, { "content-type": "audio/mpeg" });
				res.end(Buffer.alloc(900, 7));
			});
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		try {
			feature.mockReturnValue(
				`http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			);
			const response = await POST(eventFor(request()));
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({ error: "voice_unavailable" });
		} finally {
			await new Promise<void>((done) => server.close(() => done()));
		}
	});
});
