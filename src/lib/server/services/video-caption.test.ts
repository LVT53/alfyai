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

import type { LtxVideoVariant } from "$lib/server/services/images/comfyui/ltx-spec";
import {
	buildVideoContinuationPrompt,
	buildVideoPrompt,
	LTX24_I2V_INSTRUCTION,
	VIDEO_CAPTION_ALT_RULES,
	VIDEO_CAPTION_HOUSE_RULES,
	VIDEO_CAPTION_MAX_CHARS,
	VIDEO_CAPTION_TEXT_RULES,
	videoContinuationNote,
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

/** The one system message a builder sends, through the endpoint stub. */
async function captureSystemMessage(
	options: {
		variant?: LtxVideoVariant;
		fromText?: boolean;
		first?: string;
	} = {},
): Promise<string> {
	const fetchImpl = vi.fn(async () => jsonResponse("A caption."));
	const buildOptions = {
		fetchImpl: fetchImpl as unknown as typeof fetch,
		...(options.variant ? { variant: options.variant } : {}),
		...(options.fromText !== undefined ? { fromText: options.fromText } : {}),
	};
	if (options.first) {
		await buildVideoContinuationPrompt("idea", options.first, buildOptions);
	} else {
		await buildVideoPrompt("idea", buildOptions);
	}
	const body = JSON.parse(
		String(
			(fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body,
		),
	) as { messages: { role: string; content: string }[] };
	const system = body.messages.find((message) => message.role === "system");
	expect(system, "one system message").toBeDefined();
	return system?.content ?? "";
}

describe("the caption request's instruction blocks", () => {
	it("keeps the vendored instruction first in both variants", async () => {
		for (const variant of ["standard", "alt"] as const) {
			const sent = await captureSystemMessage({ variant });
			expect(sent.startsWith(LTX24_I2V_INSTRUCTION)).toBe(true);
		}
	});

	it("sends the alt rules instead of the house rules", async () => {
		const sent = await captureSystemMessage({ variant: "alt" });
		expect(sent).toContain(VIDEO_CAPTION_ALT_RULES);
		// Replaced, never appended: neither block goes beside the other.
		expect(sent).not.toContain(VIDEO_CAPTION_HOUSE_RULES);
		expect(sent).not.toContain("No image is attached to this request");
	});

	it("does not keep a frame-preservation rule for a text take", async () => {
		const sent = await captureSystemMessage({ variant: "alt", fromText: true });
		// The vendored instruction stays first and byte for byte; the app's own
		// block follows it, and that block is what this test reads.
		expect(sent.startsWith(LTX24_I2V_INSTRUCTION)).toBe(true);
		const rules = sent.slice(LTX24_I2V_INSTRUCTION.length).replace(/^\n\n/, "");
		expect(rules).toBe(VIDEO_CAPTION_TEXT_RULES);
		// The rule that only a take starting on a still can obey.
		expect(rules).not.toMatch(/stays? in frame/i);
		expect(rules).not.toContain(
			"Everyone and everything in the first frame stays in frame.",
		);
		// The correction the vendored instruction needs for a take with no
		// still: no reference image, the scene from the request alone. It may
		// not deny a frame outright: a continuation's opening frame is the
		// previous segment's last frame.
		expect(rules).not.toMatch(/no first frame/i);
		expect(rules).toContain(
			"No reference image is attached: the request alone supplies the scene, so establish its subject, setting and light from the person's words yourself.",
		);
		expect(rules).toContain(
			"Inventing that detail is right here, unlike a picture take whose frame already fixes it.",
		);
		// The rest of the alt block's structure is still there.
		expect(rules).toMatch(/single continuous take/i);
		expect(rules).toMatch(/camera stays static/i);
		expect(rules).toMatch(/on-screen text/i);
		expect(rules).toMatch(/five seconds of action/i);
		expect(rules).toMatch(/do not add people, objects or events/i);
		expect(rules).toMatch(/leave out nothing it did name/i);
	});

	it("keeps the first-frame rules for a picture take", async () => {
		const sent = await captureSystemMessage({ variant: "alt" });
		// Read the app's block, not the vendored instruction that also names
		// the first frame: this test proves the picture block still carries it.
		const rules = sent.slice(LTX24_I2V_INSTRUCTION.length).replace(/^\n\n/, "");
		expect(rules).toBe(VIDEO_CAPTION_ALT_RULES);
		expect(rules).toContain(
			"Everyone and everything in the first frame stays in frame.",
		);
		const explicit = await captureSystemMessage({
			variant: "alt",
			fromText: false,
		});
		expect(
			explicit.slice(LTX24_I2V_INSTRUCTION.length).replace(/^\n\n/, ""),
		).toBe(VIDEO_CAPTION_ALT_RULES);
	});

	it("leaves the house rules' own image sentence in place", () => {
		expect(VIDEO_CAPTION_HOUSE_RULES).toContain(
			"No image is attached to this request: you are not shown the reference image.",
		);
		expect(VIDEO_CAPTION_HOUSE_RULES).toContain(
			"Everyone and everything in the first frame stays in frame.",
		);
	});

	it("replaces the alt block for a text take, never sending both", async () => {
		const sent = await captureSystemMessage({ variant: "alt", fromText: true });
		expect(sent).not.toContain(VIDEO_CAPTION_ALT_RULES);
		expect(sent).not.toContain(VIDEO_CAPTION_HOUSE_RULES);
	});

	it("keeps the house rules when a text take asks for the first variant", async () => {
		const sent = await captureSystemMessage({
			variant: "standard",
			fromText: true,
		});
		expect(sent).toContain(VIDEO_CAPTION_HOUSE_RULES);
		expect(sent).not.toContain(VIDEO_CAPTION_ALT_RULES);
	});

	it("writes the text-take block as our own, scene-establishing ASCII English", () => {
		expect(VIDEO_CAPTION_TEXT_RULES).toMatch(/^[\x20-\x7E\n]+$/);
		// The frame-preservation rule is gone; the no-image correction is not.
		expect(VIDEO_CAPTION_TEXT_RULES).not.toMatch(/stays? in frame/i);
		expect(VIDEO_CAPTION_TEXT_RULES).not.toContain(
			"Everyone and everything in the first frame stays in frame.",
		);
		// The correction says what the vendored instruction assumes and a text
		// take does not have, then where the scene comes from instead. It does
		// not claim a frame cannot exist: a continuation opens on one.
		expect(VIDEO_CAPTION_TEXT_RULES).not.toMatch(/no first frame/i);
		expect(VIDEO_CAPTION_TEXT_RULES).toContain(
			"No reference image is attached: the request alone supplies the scene, so establish its subject, setting and light from the person's words yourself.",
		);
		expect(VIDEO_CAPTION_TEXT_RULES).toContain(
			"Inventing that detail is right here, unlike a picture take whose frame already fixes it.",
		);
		// The alt block's requirements are kept.
		expect(VIDEO_CAPTION_TEXT_RULES).toContain(
			"A single continuous take, no cuts.",
		);
		expect(VIDEO_CAPTION_TEXT_RULES).toContain(
			"The camera stays static, as on a tripod, unless the user asks for a camera move; it never pushes in or crops.",
		);
		expect(VIDEO_CAPTION_TEXT_RULES).toContain(
			"No on-screen text, titles, captions or logos.",
		);
		expect(VIDEO_CAPTION_TEXT_RULES).toContain(
			"The caption covers five seconds of action.",
		);
		expect(VIDEO_CAPTION_TEXT_RULES).toMatch(
			/describe the subject, clothing, action and state exactly as the request names them/i,
		);
		expect(VIDEO_CAPTION_TEXT_RULES).toMatch(
			/do not add people, objects or events the request did not name/,
		);
		expect(VIDEO_CAPTION_TEXT_RULES).toMatch(/leave out nothing it did name/);
		// The scene is established from the request alone.
		expect(VIDEO_CAPTION_TEXT_RULES).toMatch(
			/the request alone supplies the scene/i,
		);
		expect(VIDEO_CAPTION_TEXT_RULES).toMatch(
			/establish its subject, setting and light from the person's words/i,
		);
	});

	it("defaults to the house rules", async () => {
		const sent = await captureSystemMessage({});
		expect(sent).toContain(VIDEO_CAPTION_HOUSE_RULES);
		expect(sent).not.toContain(VIDEO_CAPTION_ALT_RULES);
	});

	it("puts the continuation note last, after the alt rules", async () => {
		const first =
			"Initially a grey cat walks across a rug toward a closed door.";
		const sent = await captureSystemMessage({ variant: "alt", first });
		expect(sent).toBe(
			[
				LTX24_I2V_INSTRUCTION,
				VIDEO_CAPTION_ALT_RULES,
				videoContinuationNote(first),
			].join("\n\n"),
		);
	});

	it("keeps the renderability rules verbatim and leaves out the house rules' image sentence", () => {
		// Our own block, ASCII English like everything the app writes into a
		// model request (ruling 79), and no third-party text.
		expect(VIDEO_CAPTION_ALT_RULES).toMatch(/^[\x20-\x7E\n]+$/);
		// The house rules' image sentence is absent from this block.
		expect(VIDEO_CAPTION_ALT_RULES).not.toMatch(/no image is attached/i);
		expect(VIDEO_CAPTION_ALT_RULES).not.toMatch(/never invent/i);
		// The renderability rules that still apply are kept word for word.
		expect(VIDEO_CAPTION_ALT_RULES).toContain(
			"The camera stays static, as on a tripod, unless the user asks for a camera move; it never pushes in or crops.",
		);
		expect(VIDEO_CAPTION_ALT_RULES).toContain(
			"Everyone and everything in the first frame stays in frame.",
		);
		expect(VIDEO_CAPTION_ALT_RULES).toContain(
			"No on-screen text, titles, captions or logos.",
		);
		expect(VIDEO_CAPTION_ALT_RULES).toContain(
			"The caption covers five seconds of action.",
		);
		expect(VIDEO_CAPTION_ALT_RULES).toMatch(/single continuous take/i);
		// The faithful-expansion sentences the block carries.
		expect(VIDEO_CAPTION_ALT_RULES).toMatch(
			/do not add people, objects or events/i,
		);
		expect(VIDEO_CAPTION_ALT_RULES).toMatch(/leave out nothing it did name/i);
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
		// One system message: the vendored instruction first and unchanged, the
		// app's own words after it, never inside it.
		expect(body.messages).toEqual([
			{
				role: "system",
				content: `${LTX24_I2V_INSTRUCTION}\n\n${VIDEO_CAPTION_HOUSE_RULES}`,
			},
			{
				role: "user",
				content: "User Raw Input Prompt: the tide comes in slowly.",
			},
		]);
	});

	it("gets its caption from an endpoint that refuses a system message anywhere but first", async () => {
		// Qwen's chat template answers 400 "System message must be at the
		// beginning." (measured on the box on 2026-11-17, when the house rules
		// went in a second system message and every caption fell back to the
		// person's words). This fake keeps that rule, for both builders.
		const strictTemplate = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as {
				messages: { role: string }[];
			};
			const misplaced = body.messages.some(
				(message, index) => message.role === "system" && index > 0,
			);
			return misplaced
				? new Response(
						JSON.stringify({
							error: { message: "System message must be at the beginning." },
						}),
						{ status: 400 },
					)
				: jsonResponse("A slow tide fills the frame.");
		});
		const fetchImpl = strictTemplate as unknown as typeof fetch;
		expect(await buildVideoPrompt("the tide comes in", { fetchImpl })).toBe(
			"A slow tide fills the frame.",
		);
		expect(
			await buildVideoContinuationPrompt(
				"the tide comes in",
				"Initially the tide comes in.",
				{ fetchImpl },
			),
		).toBe("A slow tide fills the frame.");
		expect(strictTemplate).toHaveBeenCalledTimes(2);
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
		expect(body.messages.at(-1)).toEqual({
			role: "user",
			content: "User Raw Input Prompt: the tide comes in.",
		});
	});
});

describe("buildVideoContinuationPrompt: a 10 s clip's second five seconds", () => {
	const first = "Initially a grey cat walks across a rug toward a closed door.";

	it("asks what happens next, from where the first five seconds end", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse("The cat reaches the door and paws at its edge."),
		);
		const caption = await buildVideoContinuationPrompt(
			"the cat walks to the door",
			first,
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
		);
		expect(caption).toBe("The cat reaches the door and paws at its edge.");
		const body = JSON.parse(
			String(
				(fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body,
			),
		);
		expect(body.messages).toEqual([
			{
				role: "system",
				content: [
					LTX24_I2V_INSTRUCTION,
					VIDEO_CAPTION_HOUSE_RULES,
					videoContinuationNote(first),
				].join("\n\n"),
			},
			{
				role: "user",
				content: "User Raw Input Prompt: the cat walks to the door.",
			},
		]);
		const note = videoContinuationNote(first);
		expect(note).toContain(first);
		// Segment 2 starts on segment 1's last frame: its caption goes on from
		// there (review C-2: the same caption replayed the action from its start
		// and spoke its dialogue twice).
		expect(note).toMatch(/second five seconds/i);
		expect(note).toMatch(/do not start the action over/i);
		expect(note).toMatch(/do not repeat any dialogue/i);
		expect(note.replace(first, "")).toMatch(/^[\x20-\x7E\n]+$/);
	});

	it("gives a text take's continuation the text-take block, note last", async () => {
		const sent = await captureSystemMessage({
			variant: "alt",
			fromText: true,
			first,
		});
		expect(sent).not.toContain(VIDEO_CAPTION_ALT_RULES);
		const note = videoContinuationNote(first);
		expect(sent).toBe(
			[LTX24_I2V_INSTRUCTION, VIDEO_CAPTION_TEXT_RULES, note].join("\n\n"),
		);
		// The frame-preservation rule stays out; the no-image correction stays
		// in. The note still names segment 2's own opening frame, and the block
		// no longer denies that a frame exists.
		expect(sent).not.toMatch(/stays? in frame/i);
		expect(sent).not.toMatch(/no first frame/i);
		expect(sent).toContain(
			"No reference image is attached: the request alone supplies the scene",
		);
	});

	it("has none without a caption endpoint, or when the endpoint gives nothing usable", async () => {
		config.url = "";
		const unused = vi.fn();
		expect(
			await buildVideoContinuationPrompt("idea", first, {
				fetchImpl: unused as unknown as typeof fetch,
			}),
		).toBeNull();
		expect(unused).not.toHaveBeenCalled();

		config.url = "http://127.0.0.1:11434";
		for (const answer of [
			new Response("nope", { status: 500 }),
			jsonResponse("   "),
			jsonResponse("I cannot see the image, so here is a guess."),
		]) {
			const fetchImpl = vi.fn(async () => answer);
			expect(
				await buildVideoContinuationPrompt("idea", first, {
					fetchImpl: fetchImpl as unknown as typeof fetch,
				}),
			).toBeNull();
		}
		const down = vi.fn(async () => {
			throw new TypeError("fetch failed");
		});
		expect(
			await buildVideoContinuationPrompt("idea", first, {
				fetchImpl: down as unknown as typeof fetch,
			}),
		).toBeNull();
	});
});
