import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { buildVisionPrepareStep, createStepImageQueue } from "./step-images";
import {
	buildCurrentUserMessage,
	STRIPPED_IMAGE_NOTE,
	stripImageParts,
	type TurnImage,
} from "./turn-images";

// Pictures a tool asked the model to see ride in the step after its result: the
// AI SDK turns a tool result into text, so the pixels go in a user message that
// follows it (vision/AGENTS.md). These tests drive the step function the way the
// SDK does and read what it would send.

function thumb(name: string, base64 = "QUJD"): TurnImage {
	return {
		artifactId: `immich:${name}`,
		name,
		image: {
			base64,
			mediaType: "image/jpeg",
			width: 32,
			height: 24,
			estimatedTokens: 1,
		},
	};
}

const LABEL =
	"Thumbnails from the photos tool, in result order: 1 = a.jpg, 2 = b.jpg";

/** The conversation as step 1 sees it: the question, the call, its result. */
function afterPhotosResult(): ModelMessage[] {
	return [
		{ role: "user", content: "Which of my beach photos is sharpest?" },
		{
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "call-1",
					toolName: "photos",
					input: { action: "search", query: "beach", look: true },
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "call-1",
					toolName: "photos",
					output: { type: "json", value: { success: true } },
				},
			],
		},
	];
}

type StepOptions = Parameters<ReturnType<typeof buildVisionPrepareStep>>[0];

/** What the SDK hands a prepareStep: only `messages` is read by this one. */
function stepOptions(messages: ModelMessage[], stepNumber = 1): StepOptions {
	return {
		messages,
		stepNumber,
		steps: [],
		model: {} as StepOptions["model"],
		experimental_context: undefined,
	};
}

describe("createStepImageQueue", () => {
	it("hands entries back in the order they were pushed, once", () => {
		const queue = createStepImageQueue();
		queue.push({ label: "first", images: [thumb("a.jpg")] });
		queue.push({ label: "second", images: [thumb("b.jpg")] });

		expect(queue.drain().map((entry) => entry.label)).toEqual([
			"first",
			"second",
		]);
		expect(queue.drain()).toEqual([]);
	});

	it("is empty when nothing was pushed", () => {
		expect(createStepImageQueue().drain()).toEqual([]);
	});

	it("keeps the entries of one queue apart from another's", () => {
		const one = createStepImageQueue();
		const two = createStepImageQueue();
		one.push({ label: "only in one", images: [thumb("a.jpg")] });

		expect(two.drain()).toEqual([]);
		expect(one.drain()).toHaveLength(1);
	});
});

describe("buildVisionPrepareStep", () => {
	it("appends one user message after the tool result: the label, then each picture", async () => {
		const queue = createStepImageQueue();
		queue.push({
			label: LABEL,
			images: [thumb("a.jpg", "QUFB"), thumb("b.jpg", "QkJC")],
		});
		const step = buildVisionPrepareStep({ queue, providerCanSee: true });
		const messages = afterPhotosResult();

		const result = await step(stepOptions(messages));

		expect(result?.messages).toHaveLength(messages.length + 1);
		expect(result?.messages?.slice(0, messages.length)).toEqual(messages);
		expect(result?.messages?.at(-1)).toEqual({
			role: "user",
			content: [
				{ type: "text", text: LABEL },
				{ type: "image", image: "QUFB", mediaType: "image/jpeg" },
				{ type: "image", image: "QkJC", mediaType: "image/jpeg" },
			],
		});
	});

	it("builds the picture parts the way the current message does, so one guard recognises both", async () => {
		const queue = createStepImageQueue();
		const images = [thumb("a.jpg"), thumb("b.jpg")];
		queue.push({ label: LABEL, images });
		const step = buildVisionPrepareStep({ queue, providerCanSee: true });

		const appended = (await step(stepOptions(afterPhotosResult())))?.messages;

		expect(appended?.at(-1)).toEqual(buildCurrentUserMessage(LABEL, images));
		// Task 4's guard turns a message built this way into text: the shape is
		// the one it knows.
		const guarded = stripImageParts(appended ?? []);
		expect(JSON.stringify(guarded.at(-1))).not.toContain('"type":"image"');
		expect(JSON.stringify(guarded.at(-1))).toContain(STRIPPED_IMAGE_NOTE);
	});

	it("appends one message per drained entry, in the order they were queued", async () => {
		const queue = createStepImageQueue();
		queue.push({ label: "first look", images: [thumb("a.jpg")] });
		queue.push({ label: "second look", images: [thumb("b.jpg")] });
		const step = buildVisionPrepareStep({ queue, providerCanSee: true });
		const messages = afterPhotosResult();

		const appended = (await step(stepOptions(messages)))?.messages?.slice(
			messages.length,
		);

		expect(appended).toHaveLength(2);
		expect(
			appended?.map((message) =>
				Array.isArray(message.content) && message.content[0]?.type === "text"
					? message.content[0].text
					: null,
			),
		).toEqual(["first look", "second look"]);
	});

	it("sends no picture to an attempt on a model that cannot see: the label, then the note", async () => {
		const queue = createStepImageQueue();
		queue.push({
			label: LABEL,
			images: [thumb("a.jpg", "SECRETBYTES"), thumb("b.jpg", "MORESECRET")],
		});
		const step = buildVisionPrepareStep({ queue, providerCanSee: false });

		const result = await step(stepOptions(afterPhotosResult()));

		expect(result?.messages?.at(-1)).toEqual({
			role: "user",
			content: [
				{ type: "text", text: LABEL },
				{ type: "text", text: STRIPPED_IMAGE_NOTE },
			],
		});
		const wire = JSON.stringify(result);
		expect(wire).not.toContain('"type":"image"');
		expect(wire).not.toContain("SECRETBYTES");
		expect(wire).not.toContain("MORESECRET");
	});

	it("changes nothing when the queue is empty", async () => {
		const queue = createStepImageQueue();
		const step = buildVisionPrepareStep({ queue, providerCanSee: true });

		expect(await step(stepOptions(afterPhotosResult(), 0))).toBeUndefined();
	});

	it("hands an entry over once: the step after it adds nothing", async () => {
		const queue = createStepImageQueue();
		queue.push({ label: LABEL, images: [thumb("a.jpg")] });
		const step = buildVisionPrepareStep({ queue, providerCanSee: true });

		expect(
			(await step(stepOptions(afterPhotosResult())))?.messages,
		).toBeDefined();
		expect(await step(stepOptions(afterPhotosResult(), 2))).toBeUndefined();
	});

	it("picks up what a tool queues between two steps", async () => {
		const queue = createStepImageQueue();
		const step = buildVisionPrepareStep({ queue, providerCanSee: true });
		expect(await step(stepOptions(afterPhotosResult(), 0))).toBeUndefined();

		queue.push({ label: LABEL, images: [thumb("a.jpg")] });

		expect(
			(await step(stepOptions(afterPhotosResult(), 1)))?.messages,
		).toHaveLength(4);
	});

	it("does not change the list it was given", async () => {
		const queue = createStepImageQueue();
		queue.push({ label: LABEL, images: [thumb("a.jpg")] });
		const step = buildVisionPrepareStep({ queue, providerCanSee: true });
		const messages = afterPhotosResult();
		const before = structuredClone(messages);

		await step(stepOptions(messages));

		expect(messages).toEqual(before);
	});

	it("leaves everything but the messages to the other steps: it names no tool choice, model or system text", async () => {
		const queue = createStepImageQueue();
		queue.push({ label: LABEL, images: [thumb("a.jpg")] });
		const step = buildVisionPrepareStep({ queue, providerCanSee: true });

		const result = await step(stepOptions(afterPhotosResult()));

		expect(Object.keys(result ?? {})).toEqual(["messages"]);
	});
});
