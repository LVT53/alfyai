import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
	callShortLocalControlModel: vi.fn(),
}));

vi.mock("$lib/server/services/chat-turn/short-local-text", () => ({
	callShortLocalControlModel: calls.callShortLocalControlModel,
}));

import {
	askedForVideo,
	buildVideoRequestMessage,
	parseVideoRequestVerdict,
	VIDEO_REQUEST_SYSTEM_PROMPT,
} from "./video-request";

beforeEach(() => {
	calls.callShortLocalControlModel.mockReset();
});

describe("whether the person asked for a video", () => {
	it("reads the verdict in the forms the model writes it, and nothing else", () => {
		expect(parseVideoRequestVerdict('{"video": true}')).toBe(true);
		expect(parseVideoRequestVerdict('{"video":false}')).toBe(false);
		expect(parseVideoRequestVerdict('```json\n{"video": true}\n```')).toBe(
			true,
		);
		expect(parseVideoRequestVerdict("maybe")).toBeNull();
		expect(parseVideoRequestVerdict('{"video": "yes"}')).toBeNull();
		expect(parseVideoRequestVerdict("")).toBeNull();
	});

	it("asks one short machine-read question about the person's own words, in English", async () => {
		calls.callShortLocalControlModel.mockResolvedValue({
			text: '{"video": false}',
		});

		const verdict = await askedForVideo({
			userId: "user-1",
			conversationId: "conv-1",
			requestText: "Mozoghatna egy kicsit a tenger?",
		});

		expect(verdict).toBe(false);
		const sent = calls.callShortLocalControlModel.mock.lastCall?.[0];
		expect(sent).toMatchObject({
			userId: "user-1",
			conversationId: "conv-1",
			systemPrompt: VIDEO_REQUEST_SYSTEM_PROMPT,
			temperature: 0,
			thinkingMode: "off",
		});
		expect(sent.timeoutMs).toBeGreaterThan(0);
		// The person's words travel as material to judge; everything around them
		// is ASCII English that names no language (ruling 79).
		expect(sent.message).toContain("Mozoghatna egy kicsit a tenger?");
		const scaffold = sent.message.replace(
			"Mozoghatna egy kicsit a tenger?",
			"",
		);
		for (const text of [scaffold, VIDEO_REQUEST_SYSTEM_PROMPT]) {
			expect(text).toMatch(/^[\n -~]+$/);
			expect(text).not.toMatch(
				/\b(?:English|Hungarian|Magyar|languages?|repl(?:y|ies)|respon(?:d|ds|se|ses))\b/i,
			);
		}
	});

	it("says a request for a video, a clip or an animation is one, and a wish that something would move is not", () => {
		expect(VIDEO_REQUEST_SYSTEM_PROMPT).toMatch(/video, a clip/);
		expect(VIDEO_REQUEST_SYSTEM_PROMPT).toMatch(/animat/);
		expect(VIDEO_REQUEST_SYSTEM_PROMPT).toMatch(
			/wish that something .* would move/,
		);
		expect(
			buildVideoRequestMessage("Turn this picture into a video."),
		).toContain("Turn this picture into a video.");
	});

	it("has no answer when there are no words to judge, a call that fails, or an answer it cannot read", async () => {
		expect(
			await askedForVideo({
				userId: "user-1",
				conversationId: "conv-1",
				requestText: "  ",
			}),
		).toBeNull();
		expect(calls.callShortLocalControlModel).not.toHaveBeenCalled();

		calls.callShortLocalControlModel.mockRejectedValueOnce(new Error("down"));
		calls.callShortLocalControlModel.mockResolvedValueOnce(null);
		calls.callShortLocalControlModel.mockResolvedValueOnce({ text: "sure" });
		for (let i = 0; i < 3; i += 1) {
			expect(
				await askedForVideo({
					userId: "user-1",
					conversationId: "conv-1",
					requestText: "Animate this picture.",
				}),
			).toBeNull();
		}
	});
});
