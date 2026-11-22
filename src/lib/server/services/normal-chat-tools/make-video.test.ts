// @vitest-environment node
//
// make_video: the tool's own decisions, short of the engine. It resolves the
// still from the turn's numbered pictures, refuses before queueing anything,
// builds the take request (with the caption when one is configured) and words
// the outcome the model reads. The take itself is the video kind's (slice 4);
// the wait is injected here, so no take is rendered and no row is written.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	TurnPictureIndex,
	TurnPictureSource,
} from "$lib/server/services/images/turn-pictures";
import type { VideoTakeSnapshot } from "./make-video";

const config = vi.hoisted(() => ({ video: true }));
const captionConfig = vi.hoisted(() => ({
	url: "",
	model: "caption-model",
	apiKey: "",
}));
const queued = vi.hoisted(() => ({
	enqueue: vi.fn(),
	cancel: vi.fn(),
	named: vi.fn(),
	loaded: vi.fn(),
	stored: vi.fn(),
	explicit: vi.fn(),
	variant: vi.fn(),
	caption: vi.fn(),
	continuation: vi.fn(),
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(() => ({})),
	isVideoMakingConfigured: () => config.video,
	// The caption step's own configuration, for the test that runs the real
	// caption builder instead of the stub.
	isVideoCaptionConfigured: () =>
		captionConfig.url.trim() !== "" && captionConfig.model.trim() !== "",
	getLtxCaptionUrl: () => captionConfig.url,
	getLtxCaptionModel: () => captionConfig.model,
	getLtxCaptionApiKey: () => captionConfig.apiKey,
}));

vi.mock("$lib/server/services/images/video/video-job", () => ({
	enqueueVideoTake: queued.enqueue,
	cancelVideoTake: queued.cancel,
}));

vi.mock("$lib/server/services/images/requests", () => ({
	sourcesNamed: queued.named,
}));

vi.mock("$lib/server/services/images/inputs", () => ({
	loadPicture: queued.loaded,
	PictureUnreadableError: class PictureUnreadableError extends Error {},
}));

vi.mock("$lib/server/services/images/files", () => ({
	storeImageFile: queued.stored,
	getImageFile: vi.fn(),
}));

vi.mock("$lib/server/services/images/picture-check/policy", () => ({
	isExplicitFilterOnFor: queued.explicit,
	isExplicitVariantAllowedFor: queued.variant,
}));

vi.mock("$lib/server/services/video-caption", () => ({
	buildVideoPrompt: queued.caption,
	buildVideoContinuationPrompt: queued.continuation,
}));

vi.mock("$lib/server/services/chat-turn/active-streams", () => ({
	UserStopReason: class UserStopReason extends Error {},
}));

import { createTurnTakes } from "$lib/server/services/images/turn-takes";
import { makeVideoInputSchema, runMakeVideoTool } from "./make-video";

const userId = "user-1";
const conversationId = "conv-1";
const toolCallId = "call-1";

function still(
	fileId = "file-1",
): Extract<TurnPictureSource, { type: "image_file" }> {
	return {
		type: "image_file",
		fileId,
		name: "Harbour at dawn",
		artifactId: null,
		role: "attached",
	};
}

function indexOf(source = still()): TurnPictureIndex {
	const pictures = [{ number: 1, source }];
	return {
		pictures,
		metadata: null,
		byNumber: (number) => pictures.find((p) => p.number === number) ?? null,
	};
}

function succeeded(over: Partial<VideoTakeSnapshot> = {}): VideoTakeSnapshot {
	return {
		takeId: "take-1",
		status: "succeeded",
		resultFileId: "clip-1",
		artifactId: "video-1",
		errorCode: null,
		retryable: false,
		...over,
	};
}

beforeEach(() => {
	config.video = true;
	captionConfig.url = "";
	queued.enqueue.mockReset();
	queued.cancel.mockReset();
	queued.named.mockReset();
	queued.loaded.mockReset();
	queued.stored.mockReset();
	queued.explicit.mockReset();
	queued.variant.mockReset();
	queued.caption.mockReset();
	queued.continuation.mockReset();

	queued.named.mockResolvedValue({ ok: true, sources: [still()] });
	// The real read echoes the source's own file; a source of another chat is null.
	queued.loaded.mockImplementation(
		async ({ source }: { source: { type: string; fileId?: string } }) => ({
			png: new Uint8Array([1, 2, 3]),
			width: 1280,
			height: 720,
			fileId: source.type === "image_file" ? (source.fileId ?? null) : null,
		}),
	);
	queued.stored.mockResolvedValue({ id: "stored-1" });
	queued.explicit.mockResolvedValue(true);
	queued.variant.mockResolvedValue(false);
	queued.caption.mockImplementation(async (idea: string) => `caption: ${idea}`);
	queued.continuation.mockImplementation(
		async (idea: string, first: string) => `next after "${first}": ${idea}`,
	);
	queued.enqueue.mockResolvedValue({ takeId: "take-1" });
	queued.cancel.mockResolvedValue(true);
});

type RunOptions = {
	input?: Record<string, unknown>;
	requestText?: string;
	wait?: VideoTakeSnapshot;
	signal?: AbortSignal;
	state?: { takeId: string | null };
	turnPictures?: TurnPictureIndex | null;
	turnTakes?: import("$lib/server/services/images/turn-takes").TurnTakes;
	askedForVideo?: () => Promise<boolean | null>;
};

async function run(options: RunOptions = {}) {
	const parsed = makeVideoInputSchema.parse({
		prompt: "the tide comes in slowly",
		picture: "1",
		title: "Harbour at dawn",
		summary: "Made the tide move",
		...options.input,
	});
	const state = options.state ?? { takeId: null };
	const waitForTake = vi.fn(
		async (): Promise<VideoTakeSnapshot> =>
			options.wait ?? succeeded({ takeId: "take-1" }),
	);
	const outcome = await runMakeVideoTool({
		userId,
		conversationId,
		toolCallId,
		input: parsed,
		requestText: options.requestText ?? "animate this picture",
		turnTakes: options.turnTakes ?? createTurnTakes(),
		turnPictures:
			"turnPictures" in options ? (options.turnPictures ?? null) : indexOf(),
		signal: options.signal ?? new AbortController().signal,
		waitForTake,
		state,
		...(options.askedForVideo ? { askedForVideo: options.askedForVideo } : {}),
	});
	return { outcome, state, waitForTake };
}

describe("make_video's input schema", () => {
	it("takes a motion idea, one picture, a title and a summary", () => {
		const parsed = makeVideoInputSchema.parse({
			prompt: "the tide comes in",
			picture: "2",
			title: "Harbour",
			summary: "Made the tide move",
		});
		expect(parsed.picture).toBe("2");
		expect(parsed.durationSeconds).toBe(5);
	});

	it("defaults the length to 5 seconds and allows only 5 or 10", () => {
		const base = { prompt: "the tide comes in", picture: "1" };
		expect(makeVideoInputSchema.parse(base).durationSeconds).toBe(5);
		expect(
			makeVideoInputSchema.parse({ ...base, durationSeconds: 10 })
				.durationSeconds,
		).toBe(10);
		for (const bad of [7, 0, -5, 15, 2.5]) {
			expect(
				makeVideoInputSchema.safeParse({ ...base, durationSeconds: bad })
					.success,
			).toBe(false);
		}
	});

	it("needs a motion idea, and takes no picture when the turn has one to animate", () => {
		expect(
			makeVideoInputSchema.safeParse({ prompt: "the tide comes in" }).success,
		).toBe(true);
		expect(
			makeVideoInputSchema.safeParse({ picture: "1", prompt: "" }).success,
		).toBe(false);
	});
});

describe("make_video's refusals", () => {
	it("refuses a picture the turn does not have, and names what it does offer", async () => {
		queued.named.mockResolvedValue({
			ok: false,
			message: 'make_video has no picture "9".',
		});
		const { outcome } = await run({
			input: { picture: "Cat in Birthday Hat" },
			turnPictures: indexOf({
				...still(),
				artifactId: "image-1",
				name: "Harbour at dawn",
			}),
		});
		expect(outcome.modelPayload).toMatchObject({
			ok: false,
			errorCode: "unknown_picture",
		});
		expect(queued.enqueue).not.toHaveBeenCalled();
		expect(outcome.metadata.videoTakeId).toBeUndefined();
		const message =
			"message" in outcome.modelPayload
				? String(outcome.modelPayload.message)
				: "";
		expect(message).toContain(
			'make_video has no picture "Cat in Birthday Hat"',
		);
		expect(message).toContain("a picture number from this message (1)");
		expect(message).toContain('image-1 is "Harbour at dawn"');
		expect(message).toContain("takeId a make_image call returned");
	});

	it("animates the picture open in the panel when no picture is named and the turn made none", async () => {
		const open = {
			...still("open-file"),
			name: "Beach",
			artifactId: "image-open",
			role: "open" as const,
		};
		const { outcome } = await run({
			input: { picture: undefined },
			turnPictures: indexOf(open),
			// No take of this turn: the empty test database has no image take.
		});
		expect(outcome.modelPayload.ok).toBe(true);
		expect(queued.enqueue.mock.calls[0][0].request.sourceFileId).toBe(
			"open-file",
		);
	});

	it("refuses with how to make a picture when the turn has nothing to animate", async () => {
		const { outcome } = await run({
			input: { picture: undefined },
			turnPictures: null,
		});
		expect(outcome.modelPayload).toMatchObject({
			ok: false,
			errorCode: "unknown_picture",
		});
		const message =
			"message" in outcome.modelPayload
				? String(outcome.modelPayload.message)
				: "";
		expect(message).toContain("no picture to animate yet");
		expect(message).toContain("make one with make_image first");
		expect(queued.enqueue).not.toHaveBeenCalled();
	});

	it("refuses a picture that cannot be read, before any take", async () => {
		const { PictureUnreadableError } = await import(
			"$lib/server/services/images/inputs"
		);
		queued.loaded.mockRejectedValue(new PictureUnreadableError("broken"));
		const { outcome } = await run();
		expect(outcome.modelPayload.ok).toBe(false);
		expect(queued.enqueue).not.toHaveBeenCalled();
	});

	it("refuses an explicit request the person's filter applies to", async () => {
		queued.explicit.mockResolvedValue(true);
		const { outcome } = await run({
			input: { prompt: "a nude woman on the beach" },
		});
		expect(outcome.modelPayload).toMatchObject({
			ok: false,
			errorCode: "explicit_request",
		});
		expect(queued.enqueue).not.toHaveBeenCalled();
	});

	it("lets the same prompt through when the filter does not apply", async () => {
		queued.explicit.mockResolvedValue(false);
		const { outcome } = await run({
			input: { prompt: "a nude woman on the beach" },
		});
		expect(outcome.modelPayload.ok).toBe(true);
		expect(queued.enqueue).toHaveBeenCalledTimes(1);
	});

	it("refuses when no LTX server is configured", async () => {
		config.video = false;
		const { outcome } = await run();
		expect(outcome.modelPayload).toMatchObject({
			ok: false,
			errorCode: "not_configured",
		});
		expect(queued.enqueue).not.toHaveBeenCalled();
	});
});

// A video starts only on a clear request for one (owner, 2026-11-17): the
// person's words are judged once, when make_video is called (video-request.ts),
// and a "no" stops the call before it costs anything, with the model sent to ask.
describe("make_video and a request that was not for a video", () => {
	it("refuses before any still, caption or take when the person did not ask for a video, and sends the model to ask first", async () => {
		const askedForVideo = vi.fn(async () => false);
		const { outcome } = await run({ askedForVideo });

		expect(askedForVideo).toHaveBeenCalledTimes(1);
		expect(outcome.modelPayload).toMatchObject({
			ok: false,
			errorCode: "not_asked_for",
		});
		const message = (outcome.modelPayload as { message: string }).message;
		expect(message).toContain("ask_user");
		expect(message).toMatch(/^[ -~]+$/);
		expect(queued.named).not.toHaveBeenCalled();
		expect(queued.loaded).not.toHaveBeenCalled();
		expect(queued.caption).not.toHaveBeenCalled();
		expect(queued.enqueue).not.toHaveBeenCalled();
	});

	it("starts the take when the person asked for a video", async () => {
		const { outcome } = await run({ askedForVideo: async () => true });
		expect(outcome.modelPayload.ok).toBe(true);
		expect(queued.enqueue).toHaveBeenCalledTimes(1);
	});

	it("starts the take when the check has no answer: the model's own call stands", async () => {
		const { outcome } = await run({ askedForVideo: async () => null });
		expect(outcome.modelPayload.ok).toBe(true);
		expect(queued.enqueue).toHaveBeenCalledTimes(1);
	});

	it("asks nothing for a server with no video model, and refuses as before", async () => {
		config.video = false;
		const askedForVideo = vi.fn(async () => false);
		const { outcome } = await run({ askedForVideo });
		expect(outcome.modelPayload).toMatchObject({ errorCode: "not_configured" });
		expect(askedForVideo).not.toHaveBeenCalled();
	});
});

describe("make_video's take request", () => {
	it("enqueues the still, the length, the words and the caption as LTX reads them", async () => {
		queued.variant.mockResolvedValue(true);
		const { outcome } = await run({
			input: { durationSeconds: 10 },
			wait: succeeded(),
		});
		expect(outcome.modelPayload.ok).toBe(true);
		expect(queued.named).toHaveBeenCalledWith(
			expect.objectContaining({
				names: ["1"],
				turnPictures: expect.anything(),
			}),
		);
		expect(queued.caption).toHaveBeenCalledWith(
			"the tide comes in slowly",
			expect.anything(),
		);
		// One exemption read for the whole take, however many captions it writes.
		expect(queued.variant).toHaveBeenCalledTimes(1);
		expect(queued.enqueue).toHaveBeenCalledWith(
			expect.objectContaining({
				userId,
				conversationId,
				toolCallId,
				artifactId: null,
				origin: "turn",
				retryOf: null,
				request: {
					v: 1,
					prompt: "caption: the tide comes in slowly",
					// Segment 2 goes on from where segment 1 ends (review C-2).
					continuationPrompt:
						'next after "caption: the tide comes in slowly": the tide comes in slowly',
					durationSeconds: 10,
					sourceFileId: "file-1",
					title: "Harbour at dawn",
					summary: "Made the tide move",
					artifactId: null,
					explicitVariant: true,
				},
			}),
		);
	});

	it("writes the standard variant for a person the exemption does not cover", async () => {
		queued.variant.mockResolvedValue(false);
		await run();
		expect(queued.enqueue.mock.calls[0][0].request.explicitVariant).toBe(false);
		expect(queued.caption).toHaveBeenCalledWith(
			"the tide comes in slowly",
			expect.objectContaining({ variant: "standard" }),
		);
	});

	it("sends an exempt person's caption call the alt block", async () => {
		// Through the real builder: the assertion is on the system message that
		// leaves the process, not on the options the tool happened to pass.
		const actual = await vi.importActual<
			typeof import("$lib/server/services/video-caption")
		>("$lib/server/services/video-caption");
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						choices: [{ message: { content: "A slow tide." } }],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		queued.caption.mockImplementation(
			(
				idea: string,
				options: { variant?: "standard" | "alt"; signal?: AbortSignal },
			) =>
				actual.buildVideoPrompt(idea, {
					...options,
					fetchImpl: fetchImpl as unknown as typeof fetch,
				}),
		);
		captionConfig.url = "http://127.0.0.1:11434";
		queued.variant.mockResolvedValue(true);
		await run();
		const [call] = fetchImpl.mock.calls as unknown as [string, RequestInit][];
		const body = JSON.parse(String(call?.[1].body)) as {
			messages: { role: string; content: string }[];
		};
		const system = body.messages.find((message) => message.role === "system");
		expect(system?.content).toContain(actual.VIDEO_CAPTION_ALT_RULES);
		expect(system?.content).not.toContain(actual.VIDEO_CAPTION_HOUSE_RULES);
	});

	it("defaults the take to 5 seconds, which has one segment and one caption", async () => {
		await run();
		expect(queued.enqueue.mock.calls[0][0].request.durationSeconds).toBe(5);
		expect(queued.continuation).not.toHaveBeenCalled();
		expect(queued.enqueue.mock.calls[0][0].request).not.toHaveProperty(
			"continuationPrompt",
		);
	});

	it("titles a clip from a Hungarian message when the model gives no title", async () => {
		// The motion idea is English (the tool's own contract); the title must
		// come from the person's words, as make_image's does, not from that idea.
		const { outcome } = await run({
			input: { title: undefined },
			requestText: "Készíts videót a tengerpartról.",
		});
		expect(queued.enqueue.mock.calls[0][0].request.title).toBe(
			"Készíts videót a tengerpartról",
		);
		expect(queued.enqueue.mock.calls[0][0].request.title).not.toBe(
			"the tide comes in slowly",
		);
		expect(outcome.metadata.videoTitle).toBe("Készíts videót a tengerpartról");
	});

	it("animates an attached photo by storing a still of this chat first", async () => {
		const upload = {
			type: "upload" as const,
			artifactId: "upload-1",
			name: "beach.jpg",
			mimeType: "image/jpeg",
		};
		queued.named.mockResolvedValue({ ok: true, sources: [upload] });
		queued.loaded.mockResolvedValue({
			png: new Uint8Array([1]),
			width: 1000,
			height: 500,
			fileId: null,
		});
		await run();
		expect(queued.stored).toHaveBeenCalledWith(
			expect.objectContaining({ conversationId, role: "input" }),
		);
		expect(queued.enqueue.mock.calls[0][0].request.sourceFileId).toBe(
			"stored-1",
		);
	});
});

describe("make_video's outcome", () => {
	it("reports a landed clip with its take, file, item and title", async () => {
		const { outcome } = await run({ wait: succeeded() });
		expect(outcome.modelPayload).toMatchObject({
			ok: true,
			status: "succeeded",
			takeId: "take-1",
			fileId: "clip-1",
			videoId: "video-1",
			title: "Harbour at dawn",
			summary: "Made the tide move",
		});
		expect(outcome.metadata).toMatchObject({
			ok: true,
			videoStatus: "succeeded",
			videoTakeId: "take-1",
			videoCardId: "take-1",
			videoArtifactId: "video-1",
			videoFileId: "clip-1",
			videoTitle: "Harbour at dawn",
			videoDurationSeconds: 5,
		});
	});

	it("reports a take that outlives the wait as running, not failed", async () => {
		const { outcome } = await run({
			wait: succeeded({
				status: "queued",
				resultFileId: null,
				artifactId: null,
			}),
			input: { durationSeconds: 10 },
		});
		expect(outcome.modelPayload).toMatchObject({
			ok: true,
			status: "running",
			takeId: "take-1",
			title: "Harbour at dawn",
		});
		expect(outcome.metadata).toMatchObject({
			ok: true,
			videoStatus: "running",
			videoCardId: "take-1",
		});
	});

	it("reports a failed take with its code and whether the model may retry", async () => {
		const { outcome } = await run({
			wait: succeeded({
				status: "failed",
				resultFileId: null,
				artifactId: null,
				errorCode: "video_render_failed",
				retryable: true,
			}),
		});
		expect(outcome.modelPayload).toMatchObject({
			ok: false,
			status: "failed",
			takeId: "take-1",
			errorCode: "video_render_failed",
			retryable: true,
		});
		expect(outcome.metadata).toMatchObject({
			ok: false,
			videoError: "video_render_failed",
		});
	});

	it("tells the model an item that could not be written can be retried", async () => {
		const { outcome } = await run({
			wait: succeeded({
				status: "failed",
				resultFileId: null,
				artifactId: null,
				errorCode: "video_artifact_failed",
				retryable: true,
			}),
		});
		expect(outcome.modelPayload).toMatchObject({
			ok: false,
			errorCode: "video_artifact_failed",
			message: "The video could not be saved to its item.",
			retryable: true,
		});
	});

	it("never offers the model a retry of a filtered take", async () => {
		const { outcome } = await run({
			wait: succeeded({
				status: "failed",
				resultFileId: null,
				artifactId: null,
				errorCode: "video_blocked",
				retryable: false,
			}),
		});
		expect(outcome.modelPayload).toMatchObject({
			ok: false,
			errorCode: "video_blocked",
			retryable: false,
		});
	});

	it("stops the take only for the composer's Stop, and says it was stopped", async () => {
		const { UserStopReason } = await import(
			"$lib/server/services/chat-turn/active-streams"
		);
		const controller = new AbortController();
		// The Stop lands while the wait runs, as the stream's abort reaches it.
		const waitForTake = vi.fn(async (): Promise<VideoTakeSnapshot> => {
			controller.abort(new UserStopReason());
			return succeeded({
				status: "cancelled",
				resultFileId: null,
				artifactId: null,
			});
		});
		const parsed = makeVideoInputSchema.parse({
			prompt: "the tide comes in slowly",
			picture: "1",
			title: "Harbour at dawn",
			summary: "Made the tide move",
		});
		const outcome = await runMakeVideoTool({
			userId,
			conversationId,
			toolCallId,
			input: parsed,
			requestText: "animate this picture",
			turnPictures: indexOf(),
			turnTakes: createTurnTakes(),
			signal: controller.signal,
			waitForTake,
			state: { takeId: null },
		});
		expect(queued.cancel).toHaveBeenCalledWith(userId, "take-1", {
			interrupt: false,
		});
		expect(outcome.modelPayload).toMatchObject({
			ok: false,
			errorCode: "video_stopped",
		});
		expect(outcome.metadata.videoStopped).toBe(true);
	});

	it("starts no take when the turn was stopped before the take existed", async () => {
		const { UserStopReason } = await import(
			"$lib/server/services/chat-turn/active-streams"
		);
		const controller = new AbortController();
		controller.abort(new UserStopReason());
		const { outcome } = await run({ signal: controller.signal });
		expect(queued.enqueue).not.toHaveBeenCalled();
		expect(queued.caption).not.toHaveBeenCalled();
		expect(outcome.modelPayload).toMatchObject({
			ok: false,
			errorCode: "video_stopped",
		});
		expect(outcome.metadata.videoStopped).toBe(true);
	});

	it("lets an envelope abort go without cancelling a rendering take", async () => {
		const controller = new AbortController();
		controller.abort(new Error("the tool envelope timed out"));
		await run({
			signal: controller.signal,
			wait: succeeded({
				status: "queued",
				resultFileId: null,
				artifactId: null,
			}),
		});
		expect(queued.cancel).not.toHaveBeenCalled();
	});

	it("keeps the still and the take when a stop lands during the caption", async () => {
		const { UserStopReason } = await import(
			"$lib/server/services/chat-turn/active-streams"
		);
		const controller = new AbortController();
		queued.named.mockResolvedValue({
			ok: true,
			sources: [
				{
					type: "upload" as const,
					artifactId: "upload-1",
					name: "beach.jpg",
					mimeType: "image/jpeg",
				},
			],
		});
		queued.loaded.mockResolvedValue({
			png: new Uint8Array([1]),
			width: 1000,
			height: 500,
			fileId: null,
		});
		queued.caption.mockImplementation(async (idea: string) => {
			controller.abort(new UserStopReason());
			return idea;
		});
		const { outcome, state } = await run({ signal: controller.signal });
		expect(queued.stored).not.toHaveBeenCalled();
		expect(queued.enqueue).not.toHaveBeenCalled();
		expect(state.takeId).toBeNull();
		expect(outcome.modelPayload).toMatchObject({
			ok: false,
			errorCode: "video_stopped",
		});
	});

	it("keeps the take's id on the call so a timeout can say it is still coming", async () => {
		const state = { takeId: null as string | null };
		await run({ state });
		expect(state.takeId).toBe("take-1");
	});

	it("names the card the take draws, which is the take itself", async () => {
		const { outcome } = await run();
		expect(outcome.metadata.videoCardId).toBe("take-1");
	});
});
