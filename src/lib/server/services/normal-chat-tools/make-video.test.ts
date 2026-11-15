// @vitest-environment node
//
// make_video: the tool's own decisions, short of the engine. It resolves the
// still from the turn's numbered pictures, refuses before queueing anything,
// builds the take request (with the caption when one is configured) and words
// the outcome the model reads. The take itself is the video kind's (slice 4);
// the wait is injected here, so no take is rendered and no row is written.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnPictureIndex } from "$lib/server/services/images/turn-pictures";
import type { VideoTakeSnapshot } from "./make-video";

const config = vi.hoisted(() => ({ video: true }));
const queued = vi.hoisted(() => ({
	enqueue: vi.fn(),
	cancel: vi.fn(),
	named: vi.fn(),
	loaded: vi.fn(),
	stored: vi.fn(),
	explicit: vi.fn(),
	caption: vi.fn(),
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(() => ({})),
	isVideoMakingConfigured: () => config.video,
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
}));

vi.mock("$lib/server/services/images/picture-check/policy", () => ({
	isExplicitFilterOnFor: queued.explicit,
}));

vi.mock("$lib/server/services/video-caption", () => ({
	buildVideoPrompt: queued.caption,
}));

vi.mock("$lib/server/services/chat-turn/active-streams", () => ({
	UserStopReason: class UserStopReason extends Error {},
}));

import { makeVideoInputSchema, runMakeVideoTool } from "./make-video";

const userId = "user-1";
const conversationId = "conv-1";
const toolCallId = "call-1";

function still(fileId = "file-1") {
	return {
		type: "image_file" as const,
		fileId,
		name: "Harbour at dawn",
		artifactId: null,
		role: "attached" as const,
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
	queued.enqueue.mockReset();
	queued.cancel.mockReset();
	queued.named.mockReset();
	queued.loaded.mockReset();
	queued.stored.mockReset();
	queued.explicit.mockReset();
	queued.caption.mockReset();

	queued.named.mockResolvedValue({ ok: true, sources: [still()] });
	queued.loaded.mockResolvedValue({
		png: new Uint8Array([1, 2, 3]),
		width: 1280,
		height: 720,
		fileId: "file-1",
	});
	queued.stored.mockResolvedValue({ id: "stored-1" });
	queued.explicit.mockResolvedValue(true);
	queued.caption.mockImplementation(async (idea: string) => `caption: ${idea}`);
	queued.enqueue.mockResolvedValue({ takeId: "take-1" });
	queued.cancel.mockResolvedValue(true);
});

type RunOptions = {
	input?: Record<string, unknown>;
	wait?: VideoTakeSnapshot;
	signal?: AbortSignal;
	state?: { takeId: string | null };
	turnPictures?: TurnPictureIndex | null;
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
		turnPictures:
			"turnPictures" in options ? (options.turnPictures ?? null) : indexOf(),
		signal: options.signal ?? new AbortController().signal,
		waitForTake,
		state,
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

	it("needs a picture and a motion idea", () => {
		expect(
			makeVideoInputSchema.safeParse({ prompt: "the tide comes in" }).success,
		).toBe(false);
		expect(
			makeVideoInputSchema.safeParse({ picture: "1", prompt: "" }).success,
		).toBe(false);
	});
});

describe("make_video's refusals", () => {
	it("refuses a picture the turn does not have, before any take", async () => {
		queued.named.mockResolvedValue({
			ok: false,
			message: 'make_video has no picture "9".',
		});
		const { outcome } = await run({ input: { picture: "9" } });
		expect(outcome.modelPayload).toMatchObject({
			ok: false,
			errorCode: "unknown_picture",
		});
		expect(queued.enqueue).not.toHaveBeenCalled();
		expect(outcome.metadata.videoTakeId).toBeUndefined();
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

describe("make_video's take request", () => {
	it("enqueues the still, the length, the words and the caption as LTX reads them", async () => {
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
					durationSeconds: 10,
					sourceFileId: "file-1",
					title: "Harbour at dawn",
					summary: "Made the tide move",
					artifactId: null,
				},
			}),
		);
	});

	it("defaults the take to 5 seconds", async () => {
		await run();
		expect(queued.enqueue.mock.calls[0][0].request.durationSeconds).toBe(5);
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
			turnPictures: indexOf(),
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
