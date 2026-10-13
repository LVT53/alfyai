import { describe, expect, it, vi } from "vitest";
import {
	collectReportImageUrls,
	EMPTY_REPORT_IMAGES,
	MAX_REPORT_IMAGE_BYTES,
	MAX_REPORT_IMAGES,
	MAX_REPORT_IMAGES_TOTAL_BYTES,
	resolveReportImages,
} from "./report-images";
import type { GeneratedDocumentSource } from "./source-schema";

// A real 1x1 PNG, so the loader's content sniffing has something to accept.
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHD1f6QAAAABJRU5ErkJggg==",
	"base64",
);

function image(url: string) {
	return {
		type: "image" as const,
		source: { kind: "https" as const, url },
		altText: `Picture of ${url}`,
	};
}

function documentOf(
	blocks: GeneratedDocumentSource["blocks"],
): GeneratedDocumentSource {
	return {
		version: 1,
		template: "alfyai_standard_report",
		title: "Report",
		blocks,
	} as GeneratedDocumentSource;
}

function pngResponse(bytes: Buffer = PNG): Response {
	return new Response(bytes, {
		status: 200,
		headers: { "content-type": "image/png" },
	});
}

describe("collectReportImageUrls", () => {
	it("lists the https pictures once each, in the order the report shows them", () => {
		const urls = collectReportImageUrls(
			documentOf([
				image("https://example.com/a.png"),
				{ type: "paragraph", text: "Words." },
				image("https://example.com/b.png"),
				image("https://example.com/a.png"),
			]),
		);
		expect(urls).toEqual([
			"https://example.com/a.png",
			"https://example.com/b.png",
		]);
	});

	it("leaves out the pictures that carry their own bytes or point at stored files", () => {
		const urls = collectReportImageUrls(
			documentOf([
				{
					type: "image",
					source: { kind: "data", mimeType: "image/png", data: "AAAA" },
					altText: "Inline",
				},
				{
					type: "image",
					source: { kind: "artifact", artifactId: "a-1" },
					altText: "Stored",
				},
				{
					type: "image",
					source: { kind: "generated_file", fileId: "f-1" },
					altText: "Produced",
				},
			] as GeneratedDocumentSource["blocks"]),
		);
		expect(urls).toEqual([]);
	});

	it("stops at the number of pictures a report is allowed to inline", () => {
		const urls = collectReportImageUrls(
			documentOf(
				Array.from({ length: MAX_REPORT_IMAGES + 5 }, (_, i) =>
					image(`https://example.com/${i}.png`),
				),
			),
		);
		expect(urls).toHaveLength(MAX_REPORT_IMAGES);
		expect(urls[0]).toBe("https://example.com/0.png");
	});
});

// ADR-0068: a report previewed in the app is held to `img-src data:`, like every
// other preview, and a report opened outside the app should not call every host
// it shows a picture from. So its pictures are inlined at render time, through
// the same guarded fetch as the PDF's, and a picture that cannot be inlined is a
// placeholder, never a remote address.
describe("resolveReportImages", () => {
	const source = documentOf([image("https://example.com/a.png")]);

	it("returns nothing for a report without a remote picture, and asks for nothing", async () => {
		const fetchImpl = vi.fn();
		const images = await resolveReportImages(
			documentOf([{ type: "paragraph", text: "Words." }]),
			{ fetchImpl },
		);
		expect(images).toBe(EMPTY_REPORT_IMAGES);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("turns each picture into a data: URI of its own bytes and type", async () => {
		const fetchImpl = vi.fn().mockImplementation(async () => pngResponse());
		const images = await resolveReportImages(source, { fetchImpl });

		expect(images.get("https://example.com/a.png")).toBe(
			`data:image/png;base64,${PNG.toString("base64")}`,
		);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("asks for a picture once, however many times the report shows it", async () => {
		const fetchImpl = vi.fn().mockImplementation(async () => pngResponse());
		await resolveReportImages(
			documentOf([
				image("https://example.com/a.png"),
				image("https://example.com/a.png"),
			]),
			{ fetchImpl },
		);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it.each([
		["a missing picture", () => new Response("no", { status: 404 })],
		[
			"something that is not a picture",
			() =>
				new Response("<html></html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		],
		[
			"a picture over the size one picture may add",
			() =>
				pngResponse(Buffer.concat([PNG, Buffer.alloc(MAX_REPORT_IMAGE_BYTES)])),
		],
	])("leaves %s out, so the report draws its placeholder", async (_name, respond) => {
		const fetchImpl = vi.fn().mockImplementation(async () => respond());
		const images = await resolveReportImages(source, { fetchImpl });
		expect(images.size).toBe(0);
	});

	it("leaves a picture out when the request fails, and does not throw", async () => {
		const fetchImpl = vi
			.fn()
			.mockRejectedValue(new Error("connect ECONNREFUSED"));
		await expect(resolveReportImages(source, { fetchImpl })).resolves.toEqual(
			new Map(),
		);
	});

	it("never asks for an address inside the network: the guarded loader refuses it before the fetch", async () => {
		const fetchImpl = vi.fn().mockImplementation(async () => pngResponse());
		const images = await resolveReportImages(
			documentOf([
				image("https://10.0.0.5/a.png"),
				image("https://127.0.0.1/b.png"),
				image("https://localhost/c.png"),
			]),
			{ fetchImpl },
		);
		expect(images.size).toBe(0);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("keeps the pictures it did get when another fails", async () => {
		const fetchImpl = vi
			.fn()
			.mockImplementation(async (url: URL) =>
				String(url).endsWith("bad.png")
					? new Response("no", { status: 500 })
					: pngResponse(),
			);
		const images = await resolveReportImages(
			documentOf([
				image("https://example.com/good.png"),
				image("https://example.com/bad.png"),
			]),
			{ fetchImpl },
		);
		expect([...images.keys()]).toEqual(["https://example.com/good.png"]);
	});

	it("stops adding pictures once the report's total is reached", async () => {
		// Each picture is just under the cap for one, so the total runs out first.
		const big = Buffer.concat([
			PNG,
			Buffer.alloc(MAX_REPORT_IMAGE_BYTES - PNG.length - 16),
		]);
		const fetchImpl = vi.fn().mockImplementation(async () => pngResponse(big));
		const urls = Array.from(
			{ length: MAX_REPORT_IMAGES },
			(_, i) => `https://example.com/${i}.png`,
		);

		const images = await resolveReportImages(documentOf(urls.map(image)), {
			fetchImpl,
		});

		expect(images.size).toBeGreaterThan(0);
		expect(images.size).toBeLessThan(MAX_REPORT_IMAGES);
		const inlined = [...images.values()].reduce(
			(sum, uri) => sum + Buffer.from(uri.split(",")[1], "base64").length,
			0,
		);
		expect(inlined).toBeLessThanOrEqual(MAX_REPORT_IMAGES_TOTAL_BYTES);
	});

	it("asks for a few pictures at a time, not all at once", async () => {
		let inFlight = 0;
		let peak = 0;
		const fetchImpl = vi.fn().mockImplementation(async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			inFlight -= 1;
			return pngResponse();
		});
		await resolveReportImages(
			documentOf(
				Array.from({ length: MAX_REPORT_IMAGES }, (_, i) =>
					image(`https://example.com/${i}.png`),
				),
			),
			{ fetchImpl },
		);
		expect(peak).toBeGreaterThan(1);
		expect(peak).toBeLessThanOrEqual(4);
	});
});
