// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
	cancelReadingSession,
	createReadingSession,
	readingAudioUrl,
	readingEventsUrl,
	reportReadingPosition,
} from "./read-aloud";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

const body = {
	conversationId: "c1",
	messageId: "m1",
	sentences: [
		{
			id: "s0",
			language: "en" as const,
			paragraphStart: true,
			words: [
				{ shown: "Hello", kind: "prose" as const, tokens: ["Hello"] },
				{ shown: "there.", kind: "prose" as const, tokens: ["there."] },
			],
		},
	],
};

describe("the read-aloud browser API", () => {
	it("createReadingSession posts the body and returns the start", async () => {
		const start = {
			sessionId: "abc",
			defaultSpeed: 1,
			charsPerSecond: { en: 15, hu: 15 },
		};
		const fetchImpl = vi.fn(async () => json(start, 201));
		await expect(createReadingSession(body, fetchImpl)).resolves.toEqual(start);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("/api/read-aloud/sessions");
		expect(init.method).toBe("POST");
		expect(new Headers(init.headers).get("Content-Type")).toBe(
			"application/json",
		);
		expect(JSON.parse(String(init.body))).toEqual(body);
	});

	it("throws the route's refusal, with its status", async () => {
		const fetchImpl = vi.fn(async () =>
			json({ error: "voice_unavailable" }, 503),
		);
		await expect(createReadingSession(body, fetchImpl)).rejects.toMatchObject({
			status: 503,
			message: "voice_unavailable",
		});
	});

	it("cancels with a DELETE that outlives the page, and ignores what it answers", async () => {
		const fetchImpl = vi.fn(async () => json({ error: "not_found" }, 404));
		cancelReadingSession("a b", fetchImpl);
		await Promise.resolve();
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("/api/read-aloud/sessions/a%20b");
		expect(init).toMatchObject({ method: "DELETE", keepalive: true });
		const failing = vi.fn(async () => {
			throw new TypeError("offline");
		});
		expect(() => cancelReadingSession("x", failing)).not.toThrow();
		await Promise.resolve();
	});

	it("reports the position and ignores a failure", async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
		reportReadingPosition("abc", "s3", fetchImpl);
		await Promise.resolve();
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("/api/read-aloud/sessions/abc/position");
		expect(init.method).toBe("POST");
		expect(JSON.parse(String(init.body))).toEqual({ sentenceId: "s3" });
		const failing = vi.fn(async () => json({ error: "not_found" }, 404));
		expect(() => reportReadingPosition("abc", "s4", failing)).not.toThrow();
		await Promise.resolve();
	});

	it("names the two stream addresses", () => {
		expect(readingAudioUrl("abc")).toBe("/api/read-aloud/sessions/abc/audio");
		expect(readingEventsUrl("abc")).toBe("/api/read-aloud/sessions/abc/events");
	});
});
