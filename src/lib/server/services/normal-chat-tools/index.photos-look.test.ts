import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStepImageQueue } from "../vision/step-images";

// How the registered photos tool hands a look to the turn: the turn's queue and
// the call's own signal go to the tool, and the entry it records says how many
// photos the model was shown (the activity row reads that). What a look does is
// held by photos.test.ts and vision/photo-look.test.ts.

const mocks = vi.hoisted(() => ({ runPhotosTool: vi.fn() }));

vi.mock("./photos", async (importOriginal) => ({
	...(await importOriginal<typeof import("./photos")>()),
	runPhotosTool: mocks.runPhotosTool,
}));
vi.mock("$lib/server/config-store", async () => {
	// The real predicate, so the mock cannot drift from the gate it stands in for.
	const actual = await vi.importActual<
		typeof import("$lib/server/config-store")
	>("$lib/server/config-store");
	return {
		getConfig: vi.fn(() => ({
			parallelApiKey: "",
			model1MaxModelContext: 64_000,
			model2MaxModelContext: 200_000,
		})),
		isImageMakingConfigured: (config: { comfyuiUrl?: string }) =>
			actual.isImageMakingConfigured({ comfyuiUrl: config.comfyuiUrl ?? "" }),
	};
});

import { createNormalChatTools } from "./index";

function outcome(extra: { viewedCount?: number } = {}) {
	return {
		modelPayload: {
			success: true,
			name: "photos" as const,
			sourceType: "tool" as const,
			action: "search" as const,
			message: "Found 10 photos.",
			results: [],
			citations: [],
		},
		candidates: [],
		...extra,
	};
}

function photosToolWith(stepImages?: ReturnType<typeof createStepImageQueue>) {
	return createNormalChatTools({
		userId: "user-1",
		conversationId: "conversation-1",
		turnId: "turn-1",
		modelId: "model1",
		enabledConnectionCapabilities: new Set(["photos"]),
		...(stepImages ? { stepImages } : {}),
	});
}

async function callPhotos(
	tools: ReturnType<typeof createNormalChatTools>["tools"],
	input: Record<string, unknown>,
) {
	const photos = (
		tools as unknown as {
			photos: {
				execute: (i: unknown, o: unknown) => Promise<unknown>;
			};
		}
	).photos;
	return photos.execute(input, { toolCallId: "call-photos", messages: [] });
}

describe("the photos tool and a look", () => {
	beforeEach(() => {
		mocks.runPhotosTool.mockReset();
		mocks.runPhotosTool.mockResolvedValue(outcome());
	});

	it("hands the turn's queue and the call's signal to the tool", async () => {
		const queue = createStepImageQueue();
		const { tools } = photosToolWith(queue);

		await callPhotos(tools, { action: "search", query: "beach", look: true });

		expect(mocks.runPhotosTool).toHaveBeenCalledTimes(1);
		const [userId, input, modelId, conversationId, look] =
			mocks.runPhotosTool.mock.calls[0] ?? [];
		expect(userId).toBe("user-1");
		expect(input).toEqual({ action: "search", query: "beach", look: true });
		expect(modelId).toBe("model1");
		expect(conversationId).toBe("conversation-1");
		expect(look.queue).toBe(queue);
		expect(look.signal).toBeInstanceOf(AbortSignal);
		expect(look.signal.aborted).toBe(false);
	});

	it("gives the tool no queue when the turn has none, and a signal all the same", async () => {
		const { tools } = photosToolWith();

		await callPhotos(tools, { action: "search", query: "beach", look: true });

		const look = mocks.runPhotosTool.mock.calls[0]?.[4];
		expect(look.queue).toBeUndefined();
		expect(look.signal).toBeInstanceOf(AbortSignal);
	});

	it("records how many photos the model was shown", async () => {
		mocks.runPhotosTool.mockResolvedValue(outcome({ viewedCount: 6 }));
		const { tools, getToolCalls } = photosToolWith(createStepImageQueue());

		await callPhotos(tools, { action: "search", query: "beach", look: true });

		expect(getToolCalls()[0]).toMatchObject({
			name: "photos",
			metadata: expect.objectContaining({ ok: true, viewedCount: 6 }),
		});
	});

	it("records a look that showed none as zero, and says nothing when there was no look", async () => {
		const { tools, getToolCalls } = photosToolWith(createStepImageQueue());

		mocks.runPhotosTool.mockResolvedValueOnce(outcome({ viewedCount: 0 }));
		await callPhotos(tools, { action: "search", query: "beach", look: true });
		mocks.runPhotosTool.mockResolvedValueOnce(outcome());
		await callPhotos(tools, { action: "search", query: "beach" });

		const [looked, plain] = getToolCalls();
		expect(looked?.metadata).toMatchObject({ viewedCount: 0 });
		expect(plain?.metadata).not.toHaveProperty("viewedCount");
	});

	it("keeps the look in the input it records, so the activity row can tell", async () => {
		const { tools, getToolCalls } = photosToolWith(createStepImageQueue());

		await callPhotos(tools, { action: "search", query: "beach", look: true });

		expect(getToolCalls()[0]?.input).toEqual({
			action: "search",
			query: "beach",
			look: true,
		});
	});
});
