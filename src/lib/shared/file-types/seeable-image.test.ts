import { describe, expect, it } from "vitest";
import { FILE_TYPE_ENTRIES } from "./index";
import { isSeeableImage } from "./seeable-image";

// The registry ids of the images a chat model can be shown. This list is
// pinned on purpose: the rule is "a format the server's image preparation
// decodes", not "an image the registry knows", and a new registry image does
// not become seeable until somebody adds it here AND shows the decoder reads it
// (`vision/prepare-image.test.ts`, "the formats an attachment can be sent as").
const SEEABLE_IDS = ["gif", "heic", "heif", "jpg", "png", "svg", "tif", "webp"];

describe("isSeeableImage", () => {
	it("is exactly the registry images the image preparation decodes", () => {
		const ids = FILE_TYPE_ENTRIES.filter((entry) => entry.category === "image")
			.filter((entry) =>
				isSeeableImage(`file.${entry.extensions[0]}`, entry.mimeTypes[0]),
			)
			.map((entry) => entry.id)
			.sort();

		expect(ids).toEqual(SEEABLE_IDS);
	});

	it.each([
		["photo.png", "image/png"],
		["photo.jpg", "image/jpeg"],
		["PHOTO.JPEG", "image/jpeg"],
		["scan.jfif", null],
		["IMG_0001.HEIC", "image/heic"],
		["portrait.heif", "image/heif"],
		["animation.gif", "image/gif"],
		["web.webp", "image/webp"],
		["scan.tif", "image/tiff"],
		["scan.tiff", "image/tiff"],
		["drawing.svg", "image/svg+xml"],
	])("is true for %s", (name, mimeType) => {
		expect(isSeeableImage(name, mimeType)).toBe(true);
	});

	it("goes by the extension first, as the rest of the app does", () => {
		expect(isSeeableImage("photo.jpg", "application/octet-stream")).toBe(true);
		expect(isSeeableImage("photo.png", "text/plain")).toBe(true);
		// The extension of a document wins over a picture's MIME type.
		expect(isSeeableImage("notes.txt", "image/png")).toBe(false);
	});

	it("is true for an image whose name has no extension, by its type", () => {
		expect(isSeeableImage("photo", "image/png")).toBe(true);
		expect(isSeeableImage("photo", "image/heic")).toBe(true);
		expect(isSeeableImage("photo", "image/jpeg")).toBe(true);
		expect(isSeeableImage("photo", null)).toBe(false);
		expect(isSeeableImage("photo", undefined)).toBe(false);
	});

	it("is false for a BMP: the prebuilt image library has no BMP decoder", () => {
		expect(isSeeableImage("scan.bmp", "image/bmp")).toBe(false);
		expect(isSeeableImage("scan.bmp", null)).toBe(false);
		expect(isSeeableImage("scan", "image/bmp")).toBe(false);
	});

	it("is false for an AVIF, which the upload refuses and so is never an attachment", () => {
		expect(isSeeableImage("photo.avif", "image/avif")).toBe(false);
		expect(isSeeableImage("photo", "image/avif")).toBe(false);
	});

	// An image type the registry does not know used to count (any image/* type
	// was an image). It is not a format the decoder reads, so the gate that
	// lets a picture through without text must not let it through either.
	it.each([
		["favicon.ico", "image/x-icon"],
		["favicon.ico", "image/vnd.microsoft.icon"],
		["layers.psd", "image/vnd.adobe.photoshop"],
		["IMG_0001.CR2", "image/x-canon-cr2"],
		["IMG_0001.dng", "image/x-adobe-dng"],
		["photo.jxl", "image/jxl"],
		["mystery", "image/x-something-new"],
	])("is false for the unknown image type %s (%s)", (name, mimeType) => {
		expect(isSeeableImage(name, mimeType)).toBe(false);
	});

	it.each([
		["report.pdf", "application/pdf"],
		["notes.txt", "text/plain"],
		["data.csv", "text/csv"],
		["archive.zip", "application/zip"],
		["song.mp3", "audio/mpeg"],
	])("is false for %s, which is not an image", (name, mimeType) => {
		expect(isSeeableImage(name, mimeType)).toBe(false);
	});
});
