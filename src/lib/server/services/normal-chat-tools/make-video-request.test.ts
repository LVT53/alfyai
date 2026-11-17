// make_video asks whether the person asked for a video (video-request.ts) from
// their own message, once per call, and not on a turn that carries on a reply
// that already asked them: their answer to the card is what that turn goes on.
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
	run: vi.fn(),
	asked: vi.fn(),
}));

vi.mock("$lib/server/config-store", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/server/config-store")>();
	return {
		...actual,
		getConfig: () => ({
			...actual.getConfig(),
			comfyuiLtxUrl: "http://ltx.example",
		}),
	};
});

vi.mock("./make-video", async (importOriginal) => ({
	...(await importOriginal<typeof import("./make-video")>()),
	runMakeVideoTool: hoisted.run,
}));

vi.mock("./video-request", () => ({ askedForVideo: hoisted.asked }));

import { createNormalChatTools } from "./index";

type RunParams = { askedForVideo?: () => Promise<boolean | null> };

beforeEach(() => {
	hoisted.run.mockReset();
	hoisted.asked.mockReset();
	hoisted.asked.mockResolvedValue(false);
	hoisted.run.mockImplementation(async (params: RunParams) => {
		await params.askedForVideo?.();
		return {
			modelPayload: { ok: false, errorCode: "not_asked_for", message: "m" },
			metadata: { ok: false },
		};
	});
});

async function callMakeVideo(extra: Record<string, unknown> = {}) {
	const { tools } = createNormalChatTools({
		userId: "user-1",
		conversationId: "conv-1",
		turnId: "turn-1",
		requestText: "Could the sea move a little?",
		...extra,
	});
	const makeVideo = (
		tools as unknown as Record<
			string,
			{ execute: (input: unknown, options: unknown) => Promise<unknown> }
		>
	).make_video;
	expect(makeVideo).toBeDefined();
	await makeVideo.execute(
		{ prompt: "the waves roll in" },
		{ toolCallId: "call-1", messages: [] },
	);
	return hoisted.run.mock.lastCall?.[0] as RunParams;
}

describe("make_video and whether the person asked for a video", () => {
	it("asks from the person's own message, once, when make_video is called", async () => {
		const params = await callMakeVideo();

		expect(typeof params.askedForVideo).toBe("function");
		expect(hoisted.asked).toHaveBeenCalledTimes(1);
		expect(hoisted.asked).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				conversationId: "conv-1",
				requestText: "Could the sea move a little?",
			}),
		);
	});

	it("asks nothing on a turn that carries on a reply that already asked the person", async () => {
		const params = await callMakeVideo({
			resumeProvenance: { userTexts: [], priorResults: [] },
		});

		expect(params.askedForVideo).toBeUndefined();
		expect(hoisted.asked).not.toHaveBeenCalled();
	});
});
