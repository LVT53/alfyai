import type { ModelMessage } from "ai";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPublisherThumbnail } from "../image-search";
import { buildVisionPrepareStep, createStepImageQueue } from "./step-images";
import { queueWebImagePreviews } from "./web-image-look";

vi.mock("../image-search", () => ({ fetchPublisherThumbnail: vi.fn() }));
const image = {
	id: "image-search:one",
	url: "https://public.example/pic",
	thumbnail: "https://public.example/pic",
};
const signal = new AbortController().signal;

describe("inspecting a selected web image", () => {
	beforeEach(() => vi.mocked(fetchPublisherThumbnail).mockReset());
	it("fetches no publisher for a text-only attempt or exhausted budget", async () => {
		const queue = createStepImageQueue({ budget: 0 });
		queue.visionAttempt = { canSee: false };
		expect(
			await queueWebImagePreviews({ queue, signal, candidates: [image] }),
		).toEqual({ queuedIds: [], reason: "text_only" });
		queue.visionAttempt = { canSee: true };
		expect(
			await queueWebImagePreviews({ queue, signal, candidates: [image] }),
		).toEqual({ queuedIds: [], reason: "budget" });
		expect(fetchPublisherThumbnail).not.toHaveBeenCalled();
	});
	it("queues prepared JPEG pixels labeled by result ID, and a text-only retry gets words only", async () => {
		const original = await sharp({
			create: { width: 32, height: 24, channels: 3, background: "red" },
		})
			.png()
			.toBuffer();
		vi.mocked(fetchPublisherThumbnail).mockResolvedValue({
			bytes: original,
			contentType: "image/png",
		});
		for (const providerCanSee of [true, false]) {
			const queue = createStepImageQueue();
			queue.visionAttempt = { canSee: true };
			expect(
				await queueWebImagePreviews({ queue, signal, candidates: [image] }),
			).toEqual({ queuedIds: [image.id] });
			const build = buildVisionPrepareStep({ queue, providerCanSee });
			const result = await build({
				messages: [] as ModelMessage[],
				model: {} as Parameters<typeof build>[0]["model"],
				steps: [],
				stepNumber: 1,
				experimental_context: undefined,
			});
			const message = result?.messages?.[0];
			expect(message?.content).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "text",
						text: expect.stringContaining(image.id),
					}),
				]),
			);
			if (providerCanSee)
				expect(message?.content).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							type: "image",
							mediaType: "image/jpeg",
							image: expect.stringMatching(/^\/9j\//),
						}),
					]),
				);
			else expect(JSON.stringify(message)).not.toContain('"type":"image"');
		}
	});
	it("leaves the replacement attempt's queue empty when a publisher completes after failover", async () => {
		const queue = createStepImageQueue({ budget: 1 });
		queue.visionAttempt = { canSee: true };
		const bytes = await sharp({
			create: { width: 2, height: 2, channels: 3, background: "red" },
		})
			.png()
			.toBuffer();
		vi.mocked(fetchPublisherThumbnail).mockImplementation(async () => {
			queue.visionAttempt = { canSee: true };
			return { bytes, contentType: "image/png" };
		});
		expect(
			await queueWebImagePreviews({ queue, signal, candidates: [image] }),
		).toEqual({ queuedIds: [], reason: "unavailable" });
		expect(queue.room()).toBe(1);
		expect(queue.drain()).toEqual([]);
	});

	it("rejects an altered candidate and releases a reserved slot when an in-flight operation was canceled", async () => {
		const queue = createStepImageQueue({ budget: 1 });
		queue.visionAttempt = { canSee: true };
		expect(
			(
				await queueWebImagePreviews({
					queue,
					signal,
					candidates: [{ ...image, thumbnail: `${image.url}?unlisted` }],
				})
			).queuedIds,
		).toEqual([]);
		expect(fetchPublisherThumbnail).not.toHaveBeenCalled();
		const controller = new AbortController();
		vi.mocked(fetchPublisherThumbnail).mockImplementation(async () => {
			controller.abort();
			return null;
		});
		expect(
			(
				await queueWebImagePreviews({
					queue,
					signal: controller.signal,
					candidates: [image],
				})
			).queuedIds,
		).toEqual([]);
		expect(queue.room()).toBe(1);
		expect(queue.drain()).toEqual([]);
	});
});
