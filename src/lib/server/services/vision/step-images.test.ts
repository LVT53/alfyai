import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
	buildVisionPrepareStep,
	createStepImageQueue,
	STEP_IMAGE_TURN_BUDGET,
} from "./step-images";
import {
	buildStepImagesMessage,
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

// A turn may show the model so many pictures, however many looks it asks for
// and however many are asked for in one step: the queue of the turn keeps the
// count, and a look takes at most what is left.
describe("the turn's budget of pictures", () => {
	it("is eight", () => {
		expect(STEP_IMAGE_TURN_BUDGET).toBe(8);
		expect(createStepImageQueue().room()).toBe(8);
	});

	it("gives a look what it asks for, up to what is left", () => {
		const queue = createStepImageQueue();

		expect(queue.reserve(3)).toBe(3);
		expect(queue.room()).toBe(5);
		expect(queue.reserve(8)).toBe(5);
		expect(queue.room()).toBe(0);
		expect(queue.reserve(1)).toBe(0);
	});

	it("shares it between looks that ask in the same moment", () => {
		const queue = createStepImageQueue();

		// Two calls of one step both ask before either has downloaded anything.
		const first = queue.reserve(8);
		const second = queue.reserve(8);

		expect([first, second]).toEqual([8, 0]);
	});

	it("takes back what a look did not queue", () => {
		const queue = createStepImageQueue();
		queue.reserve(8);

		queue.release(5);

		expect(queue.room()).toBe(5);
		expect(queue.reserve(8)).toBe(5);
	});

	it("never holds more than the budget, nor less than none", () => {
		const queue = createStepImageQueue();

		queue.release(100);
		expect(queue.room()).toBe(8);
		expect(queue.reserve(100)).toBe(8);
		expect(queue.reserve(-4)).toBe(0);
		expect(queue.reserve(Number.NaN)).toBe(0);
		queue.release(-2);
		expect(queue.room()).toBe(0);
	});

	it("counts whole pictures", () => {
		const queue = createStepImageQueue();

		expect(queue.reserve(2.9)).toBe(2);
		expect(queue.room()).toBe(6);
	});

	it("is spent for the turn: handing the pictures over does not give it back", () => {
		const queue = createStepImageQueue();
		queue.reserve(8);
		queue.push({ label: LABEL, images: [thumb("a.jpg")] });

		queue.drain();

		expect(queue.room()).toBe(0);
	});

	it("is the turn's own: another turn has its eight", () => {
		const one = createStepImageQueue();
		const two = createStepImageQueue();
		one.reserve(8);

		expect(two.room()).toBe(8);
	});

	it("can be made for a smaller budget", () => {
		const queue = createStepImageQueue({ budget: 3 });

		expect(queue.reserve(8)).toBe(3);
		expect(queue.room()).toBe(0);
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

	it("keeps a step's thumbnails under their own label, without picture numbers", async () => {
		const queue = createStepImageQueue();
		queue.push({
			label: LABEL,
			images: [thumb("a.jpg", "QUFB"), thumb("b.jpg", "QkJC")],
		});
		const step = buildVisionPrepareStep({ queue, providerCanSee: true });

		const appended = (await step(stepOptions(afterPhotosResult())))?.messages;

		expect(appended?.at(-1)?.content).toEqual([
			{ type: "text", text: LABEL },
			{ type: "image", image: "QUFB", mediaType: "image/jpeg" },
			{ type: "image", image: "QkJC", mediaType: "image/jpeg" },
		]);
	});

	it("builds the picture parts the way the current message does, so one guard recognises both", async () => {
		const queue = createStepImageQueue();
		const images = [thumb("a.jpg"), thumb("b.jpg")];
		queue.push({ label: LABEL, images });
		const step = buildVisionPrepareStep({ queue, providerCanSee: true });

		const appended = (await step(stepOptions(afterPhotosResult())))?.messages;

		expect(appended?.at(-1)).toEqual(buildStepImagesMessage(LABEL, images));
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

	// A person who keeps connector data local has pictures cleared for a model on
	// their own box (`localOnly`). The step is built for each attempt, and an
	// attempt can be somewhere else than the model the clearance was given for
	// (a failover to a cloud model that is ticked as seeing): that attempt is sent
	// neither the pictures nor the names of the photos.
	describe("an entry cleared for a model on the person's own box only", () => {
		const NAMED =
			"Thumbnails from the photos tool, in result order: 1 = SECRET-beach.jpg, 3 = SECRET-dunes.jpg";
		const NAMELESS = "Thumbnails from the photos tool, in result order: 1, 3";

		function localOnlyEntry() {
			return {
				label: NAMED,
				labelWithoutNames: NAMELESS,
				localOnly: true as const,
				images: [
					thumb("SECRET-beach.jpg", "SECRETBYTES-1"),
					thumb("SECRET-dunes.jpg", "SECRETBYTES-3"),
				],
			};
		}

		async function appended(params: {
			entry?: ReturnType<typeof localOnlyEntry> | Record<string, unknown>;
			providerCanSee: boolean;
			providerIsLocal?: boolean;
		}) {
			const queue = createStepImageQueue();
			queue.push((params.entry ?? localOnlyEntry()) as never);
			const step = buildVisionPrepareStep({
				queue,
				providerCanSee: params.providerCanSee,
				...(params.providerIsLocal === undefined
					? {}
					: { providerIsLocal: params.providerIsLocal }),
			});
			const result = await step(stepOptions(afterPhotosResult()));
			return result?.messages?.at(-1);
		}

		it("shows the pictures and the names to an attempt on the box that can see", async () => {
			const message = await appended({
				providerCanSee: true,
				providerIsLocal: true,
			});

			expect(message).toEqual({
				role: "user",
				content: [
					{ type: "text", text: NAMED },
					{ type: "image", image: "SECRETBYTES-1", mediaType: "image/jpeg" },
					{ type: "image", image: "SECRETBYTES-3", mediaType: "image/jpeg" },
				],
			});
		});

		it("sends an attempt on another host that can see no picture and no name: a label without names, then the note", async () => {
			const message = await appended({
				providerCanSee: true,
				providerIsLocal: false,
			});

			expect(message).toEqual({
				role: "user",
				content: [
					{ type: "text", text: NAMELESS },
					{ type: "text", text: STRIPPED_IMAGE_NOTE },
				],
			});
			const wire = JSON.stringify(message);
			expect(wire).not.toContain("SECRET");
			expect(wire).not.toContain('"type":"image"');
		});

		it("takes an attempt whose place is not said for one that is not on the box", async () => {
			const message = await appended({ providerCanSee: true });

			expect(message).toEqual({
				role: "user",
				content: [
					{ type: "text", text: NAMELESS },
					{ type: "text", text: STRIPPED_IMAGE_NOTE },
				],
			});
		});

		it("sends an attempt on another host that cannot see the same: a label without names, then the note", async () => {
			const message = await appended({
				providerCanSee: false,
				providerIsLocal: false,
			});

			expect(JSON.stringify(message)).not.toContain("SECRET");
			expect(message).toMatchObject({
				content: [
					{ type: "text", text: NAMELESS },
					{ type: "text", text: STRIPPED_IMAGE_NOTE },
				],
			});
		});

		it("names the photos to an attempt on the box that cannot see: the names stay on the box", async () => {
			const message = await appended({
				providerCanSee: false,
				providerIsLocal: true,
			});

			expect(message).toEqual({
				role: "user",
				content: [
					{ type: "text", text: NAMED },
					{ type: "text", text: STRIPPED_IMAGE_NOTE },
				],
			});
		});

		it("never falls back to the names when the entry has no label without them", async () => {
			const message = await appended({
				entry: { ...localOnlyEntry(), labelWithoutNames: undefined },
				providerCanSee: true,
				providerIsLocal: false,
			});

			const wire = JSON.stringify(message);
			expect(wire).not.toContain("SECRET");
			expect(wire).not.toContain('"type":"image"');
			expect(wire).toContain(STRIPPED_IMAGE_NOTE);
		});

		it("does not hold back an entry the person did not ask to keep local", async () => {
			const message = await appended({
				entry: {
					label: NAMED,
					images: [thumb("SECRET-beach.jpg", "SECRETBYTES-1")],
				},
				providerCanSee: true,
				providerIsLocal: false,
			});

			expect(message).toEqual({
				role: "user",
				content: [
					{ type: "text", text: NAMED },
					{ type: "image", image: "SECRETBYTES-1", mediaType: "image/jpeg" },
				],
			});
		});

		it("holds back only the entries that were cleared for the box, when a step has both", async () => {
			const queue = createStepImageQueue();
			queue.push(localOnlyEntry());
			queue.push({
				label: "open look",
				images: [thumb("open.jpg", "OPENBYTES")],
			});
			const step = buildVisionPrepareStep({
				queue,
				providerCanSee: true,
				providerIsLocal: false,
			});
			const messages = afterPhotosResult();

			const added = (await step(stepOptions(messages)))?.messages?.slice(
				messages.length,
			);

			expect(JSON.stringify(added?.[0])).not.toContain("SECRET");
			expect(JSON.stringify(added?.[0])).toContain(STRIPPED_IMAGE_NOTE);
			expect(JSON.stringify(added?.[1])).toContain("OPENBYTES");
		});

		it("takes the entry out of the queue all the same: nothing is kept for a later attempt", async () => {
			const queue = createStepImageQueue();
			queue.push(localOnlyEntry());
			const step = buildVisionPrepareStep({
				queue,
				providerCanSee: true,
				providerIsLocal: false,
			});

			await step(stepOptions(afterPhotosResult()));

			expect(queue.drain()).toEqual([]);
		});
	});
});
