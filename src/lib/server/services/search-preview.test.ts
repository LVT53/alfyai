import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { fetchPublisherThumbnail } from "./image-search";

const source = "https://www.example.com/image.jpg?version=1";

describe("publisher image previews", () => {
	it("returns a resized raster from the exact result over a credential-free guarded fetch", async () => {
		const original = await sharp({
			create: { width: 1000, height: 400, channels: 3, background: "red" },
		})
			.jpeg()
			.toBuffer();
		const fetch = vi.fn().mockResolvedValue(
			new Response(new Uint8Array(original), {
				headers: { "content-type": "image/jpeg" },
			}),
		);
		const result = await fetchPublisherThumbnail(source, { fetch });
		expect(fetch).toHaveBeenCalledExactlyOnceWith(
			source,
			expect.objectContaining({
				redirect: "manual",
				headers: { accept: expect.any(String) },
			}),
		);
		expect(result?.contentType).toBe("image/webp");
		expect(await sharp(result?.bytes).metadata()).toMatchObject({
			width: 500,
			height: 200,
			format: "webp",
		});
	});

	it("refuses a private destination before fetch and a mislabeled SVG before rendering", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(
				new Response(
					'<svg xmlns="http://www.w3.org/2000/svg" width="3" height="3"/>',
					{ headers: { "content-type": "image/jpeg" } },
				),
			);
		expect(
			await fetchPublisherThumbnail("https://127.0.0.1/a", { fetch }),
		).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
		expect(await fetchPublisherThumbnail(source, { fetch })).toBeNull();
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
