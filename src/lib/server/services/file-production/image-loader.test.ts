import { describe, expect, it, vi } from "vitest";
import { loadGeneratedDocumentImage } from "./image-loader";

const ONE_BY_ONE_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const ONE_BY_ONE_PNG = Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64");

describe("generated document image loader", () => {
	it("accepts size-limited PNG data image sources", async () => {
		const result = await loadGeneratedDocumentImage(
			{
				kind: "data",
				mimeType: "image/png",
				data: `data:image/png;base64,${ONE_BY_ONE_PNG_BASE64}`,
			},
			{ maxImageBytes: 1024 },
		);

		expect(result).toMatchObject({
			ok: true,
			image: {
				mimeType: "image/png",
				bytes: ONE_BY_ONE_PNG,
			},
		});
	});

	it("rejects unsafe URL schemes and private hosts before fetching", async () => {
		const fetchImpl = vi.fn();

		await expect(
			loadGeneratedDocumentImage(
				{ kind: "https", url: "http://example.com/image.png" },
				{ fetchImpl },
			),
		).resolves.toMatchObject({ ok: false, code: "image_limit_exceeded" });
		await expect(
			loadGeneratedDocumentImage(
				{ kind: "https", url: "https://127.0.0.1/image.png" },
				{ fetchImpl },
			),
		).resolves.toMatchObject({ ok: false, code: "image_limit_exceeded" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("revalidates redirect targets and rejects non-image responses", async () => {
		const redirectFetch = vi.fn(async () => {
			return new Response(null, {
				status: 302,
				headers: { location: "https://localhost/private.png" },
			});
		});
		await expect(
			loadGeneratedDocumentImage(
				{ kind: "https", url: "https://cdn.example.com/image.png" },
				{ fetchImpl: redirectFetch },
			),
		).resolves.toMatchObject({ ok: false, code: "image_limit_exceeded" });

		const htmlFetch = vi.fn(async () => {
			return new Response("<html></html>", {
				headers: { "content-type": "text/html" },
			});
		});
		await expect(
			loadGeneratedDocumentImage(
				{ kind: "https", url: "https://cdn.example.com/image.png" },
				{ fetchImpl: htmlFetch },
			),
		).resolves.toMatchObject({ ok: false, code: "image_limit_exceeded" });
	});

	it("rejects oversized images before returning bytes", async () => {
		await expect(
			loadGeneratedDocumentImage(
				{ kind: "data", mimeType: "image/png", data: ONE_BY_ONE_PNG_BASE64 },
				{ maxImageBytes: 8 },
			),
		).resolves.toMatchObject({
			ok: false,
			code: "image_limit_exceeded",
		});
	});
});
