import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	prewarmDocumentPreview,
	resetDocumentPreviewPrewarmCache,
} from "./document-preview-prewarm";

describe("prewarmDocumentPreview", () => {
	beforeEach(() => {
		resetDocumentPreviewPrewarmCache();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("delays preview fetches until intent remains long enough", async () => {
		vi.useFakeTimers();
		const fetcher = vi.fn().mockResolvedValue(new Response("ok"));

		const started = prewarmDocumentPreview(
			{ displayArtifactId: "artifact-1", sizeBytes: 1024 },
			{ fetcher },
		);

		expect(fetcher).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(119);
		expect(fetcher).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);

		await expect(started).resolves.toBe(true);
		expect(fetcher).toHaveBeenCalledWith("/api/knowledge/artifact-1/preview", {
			credentials: "same-origin",
		});
	});

	it("dedupes in-flight and recent preview URLs", async () => {
		vi.useFakeTimers();
		let resolveFetch: (() => void) | undefined;
		const fetcher = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					resolveFetch = () => resolve(new Response("ok"));
				}),
		);
		let currentTime = 1000;
		const target = {
			previewUrl: "/api/chat/files/file-1/preview",
			sizeBytes: 512,
		};

		const first = prewarmDocumentPreview(target, {
			fetcher,
			now: () => currentTime,
			prewarmDelayMs: 0,
		});
		const duplicate = await prewarmDocumentPreview(target, {
			fetcher,
			now: () => currentTime,
			prewarmDelayMs: 0,
		});

		vi.advanceTimersByTime(0);
		resolveFetch?.();
		await expect(first).resolves.toBe(true);
		expect(duplicate).toBe(false);

		currentTime += 100;
		const recent = await prewarmDocumentPreview(target, {
			fetcher,
			now: () => currentTime,
			prewarmDelayMs: 0,
		});

		expect(recent).toBe(false);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("skips oversized previews", async () => {
		const fetcher = vi.fn();

		const started = await prewarmDocumentPreview(
			{ previewUrl: "/api/chat/files/huge/preview", sizeBytes: 2048 },
			{ fetcher, maxBytes: 1024 },
		);

		expect(started).toBe(false);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("swallows fetch errors because prewarm is best-effort", async () => {
		const fetcher = vi.fn().mockRejectedValue(new Error("network failed"));

		await expect(
			prewarmDocumentPreview(
				{ previewUrl: "/api/chat/files/file-1/preview", sizeBytes: 512 },
				{ fetcher, prewarmDelayMs: 0 },
			),
		).resolves.toBe(true);
	});

	it("consumes a small preview response body when prewarming starts", async () => {
		const response = new Response("warm", {
			headers: { "content-length": "4" },
		});
		const arrayBuffer = vi.spyOn(response, "arrayBuffer");
		const fetcher = vi.fn().mockResolvedValue(response);

		await expect(
			prewarmDocumentPreview(
				{ previewUrl: "/api/chat/files/file-1/preview", sizeBytes: 512 },
				{ fetcher, prewarmDelayMs: 0 },
			),
		).resolves.toBe(true);

		expect(arrayBuffer).toHaveBeenCalledTimes(1);
	});

	it("skips new preview intent while the global queue is saturated", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response("ok"));

		const first = prewarmDocumentPreview(
			{ previewUrl: "/api/chat/files/file-1/preview", sizeBytes: 512 },
			{ fetcher, prewarmDelayMs: 0 },
		);
		const second = prewarmDocumentPreview(
			{ previewUrl: "/api/chat/files/file-2/preview", sizeBytes: 512 },
			{ fetcher, prewarmDelayMs: 0 },
		);
		const third = await prewarmDocumentPreview(
			{ previewUrl: "/api/chat/files/file-3/preview", sizeBytes: 512 },
			{ fetcher, prewarmDelayMs: 0 },
		);

		await expect(first).resolves.toBe(true);
		await expect(second).resolves.toBe(true);
		expect(third).toBe(false);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});
