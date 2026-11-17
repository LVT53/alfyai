// @vitest-environment node
//
// The caption step: the motion idea goes through an LLM the admin configured,
// with ComfyUI's own LTX-2.5 image-to-video instruction as its system message,
// and the caption it writes is what the take renders. Without an endpoint the
// idea is used unchanged: the step is an improvement, never a prerequisite.

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({
	url: "http://127.0.0.1:11434",
	model: "gemma-3-27b",
	apiKey: "",
}));

vi.mock("$lib/server/config-store", () => ({
	isVideoCaptionConfigured: () =>
		config.url.trim() !== "" && config.model.trim() !== "",
	getLtxCaptionUrl: () => config.url,
	getLtxCaptionModel: () => config.model,
	getLtxCaptionApiKey: () => config.apiKey,
}));

import {
	buildVideoPrompt,
	LTX24_I2V_INSTRUCTION,
	VIDEO_CAPTION_HOUSE_RULES,
	VIDEO_CAPTION_MAX_CHARS,
} from "$lib/server/services/video-caption";

beforeEach(() => {
	config.url = "http://127.0.0.1:11434";
	config.model = "gemma-3-27b";
	config.apiKey = "";
});

function jsonResponse(content: unknown): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("the official LTX instruction", () => {
	it("is the vendored ComfyUI LTX24_I2V_SYSTEM_PROMPT, byte for byte", () => {
		// Pinned: the text is ComfyUI's (comfy_extras/nodes_textgen.py), not ours
		// to improve. A change here is a different model instruction, so it needs
		// a deliberate new pin.
		expect(
			createHash("sha256").update(LTX24_I2V_INSTRUCTION).digest("hex"),
		).toBe("fa6f57a977ab952abb66cc91d42ab86ba152c885d8b55c05134559642d28577e");
		expect(
			LTX24_I2V_INSTRUCTION.startsWith("You are given a REFERENCE IMAGE"),
		).toBe(true);
		expect(LTX24_I2V_INSTRUCTION).toContain(
			"If the user wrote in another language, produce the English caption of the same content.",
		);
		expect(LTX24_I2V_INSTRUCTION).toContain("Output ONLY the caption text");
	});
});

describe("buildVideoPrompt", () => {
	it("uses the motion idea unchanged when no caption endpoint is configured", async () => {
		config.url = "";
		const fetchImpl = vi.fn();
		const prompt = await buildVideoPrompt("the tide comes in slowly", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(prompt).toBe("the tide comes in slowly");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("sends the official instruction and the idea to the configured endpoint", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse("  A slow tide fills the frame.  "),
		);
		const prompt = await buildVideoPrompt("the tide comes in slowly", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(prompt).toBe("A slow tide fills the frame.");
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("http://127.0.0.1:11434/v1/chat/completions");
		const body = JSON.parse(String(init.body));
		expect(body.model).toBe("gemma-3-27b");
		expect(body.stream).toBe(false);
		// A reasoning model spends its answer on reasoning and returns no content.
		expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
		expect(body.max_tokens).toBeGreaterThan(0);
		expect(body.messages[0]).toEqual({
			role: "system",
			content: LTX24_I2V_INSTRUCTION,
		});
		// The app's own words follow the vendored instruction, never inside it.
		expect(body.messages[1]).toEqual({
			role: "system",
			content: VIDEO_CAPTION_HOUSE_RULES,
		});
		expect(body.messages[2]).toEqual({
			role: "user",
			content: "User Raw Input Prompt: the tide comes in slowly.",
		});
		expect(body.messages).toHaveLength(3);
	});

	it("tells the caption model it is not shown the still, and keeps the house rules", () => {
		// The vendored instruction expects the reference image beside the request;
		// this endpoint is sent words only, and a model asked to describe a
		// picture it cannot see makes one up, which LTX then follows away from
		// the person's own picture (review C-1).
		expect(VIDEO_CAPTION_HOUSE_RULES).toMatch(/no image is attached/i);
		expect(VIDEO_CAPTION_HOUSE_RULES).toMatch(/never invent/i);
		// docs/plans/ltx-video/feasibility.md: a static camera unless asked (a
		// push-in overshoots into a dark crop), everyone kept in frame (two
		// people: the model crops one out), and no on-screen text.
		expect(VIDEO_CAPTION_HOUSE_RULES).toMatch(/camera stays static/i);
		expect(VIDEO_CAPTION_HOUSE_RULES).toMatch(/in frame/i);
		expect(VIDEO_CAPTION_HOUSE_RULES).toMatch(/on-screen text/i);
		// Ruling 79: what the app writes into a model request is ASCII English.
		expect(VIDEO_CAPTION_HOUSE_RULES).toMatch(/^[\x20-\x7E\n]+$/);
	});

	it("falls back to the idea when the caption speaks of an image it was not shown", async () => {
		for (const answer of [
			"I can't see the reference image, but here is a caption: a cat walks.",
			"Since no image was provided, a medium shot frames a cat as it walks.",
			"Unable to view the image. A cat walks slowly across the room.",
		]) {
			const fetchImpl = vi.fn(async () => jsonResponse(answer));
			expect(
				await buildVideoPrompt("the cat walks to the door", {
					fetchImpl: fetchImpl as unknown as typeof fetch,
				}),
				answer,
			).toBe("the cat walks to the door");
		}
		// A caption that names a picture in the scene is still a caption.
		const fetchImpl = vi.fn(async () =>
			jsonResponse("A framed image hangs on the wall as the cat walks past."),
		);
		expect(
			await buildVideoPrompt("the cat walks", {
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		).toBe("A framed image hangs on the wall as the cat walks past.");
	});

	it("sends the configured key as a bearer token, and nothing when none is set", async () => {
		const plain = vi.fn(async () => jsonResponse("A caption."));
		await buildVideoPrompt("idea", {
			fetchImpl: plain as unknown as typeof fetch,
		});
		const plainHeaders = (
			plain.mock.calls[0] as unknown as [string, RequestInit]
		)[1].headers as Record<string, string>;
		expect(plainHeaders.authorization).toBeUndefined();

		config.apiKey = "secret-key";
		const keyed = vi.fn(async () => jsonResponse("A caption."));
		await buildVideoPrompt("idea", {
			fetchImpl: keyed as unknown as typeof fetch,
		});
		const keyedHeaders = (
			keyed.mock.calls[0] as unknown as [string, RequestInit]
		)[1].headers as Record<string, string>;
		expect(keyedHeaders.authorization).toBe("Bearer secret-key");
	});

	it("falls back to the idea when the endpoint cannot be reached", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		});
		const prompt = await buildVideoPrompt("the tide comes in slowly", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(prompt).toBe("the tide comes in slowly");
	});

	it("falls back to the idea when the endpoint answers an error or no caption", async () => {
		const failing = vi.fn(async () => new Response("nope", { status: 500 }));
		expect(
			await buildVideoPrompt("idea", {
				fetchImpl: failing as unknown as typeof fetch,
			}),
		).toBe("idea");
		const empty = vi.fn(async () => jsonResponse("   "));
		expect(
			await buildVideoPrompt("idea", {
				fetchImpl: empty as unknown as typeof fetch,
			}),
		).toBe("idea");
		const malformed = vi.fn(async () => new Response("{", { status: 200 }));
		expect(
			await buildVideoPrompt("idea", {
				fetchImpl: malformed as unknown as typeof fetch,
			}),
		).toBe("idea");
	});

	it("keeps a runaway caption inside the take's prompt budget", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse("x".repeat(20_000)));
		const prompt = await buildVideoPrompt("idea", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(prompt).toHaveLength(VIDEO_CAPTION_MAX_CHARS);
	});

	it("trims the idea before it is sent", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse("A caption."));
		await buildVideoPrompt("  the tide comes in  ", {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		const body = JSON.parse(
			String(
				(fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body,
			),
		);
		expect(body.messages[2].content).toBe(
			"User Raw Input Prompt: the tide comes in.",
		);
	});
});
