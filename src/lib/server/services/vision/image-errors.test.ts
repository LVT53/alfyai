// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	ImageDecodeTimeoutError,
	ImageDecodeUnavailableError,
	ImagePreparationError,
	ImageTooLargeError,
} from "./image-errors";
import { ImagePreparationError as ReExportedFromPrepareImage } from "./prepare-image";

describe("the errors of preparing a picture", () => {
	it("still comes from prepare-image, where callers have always imported it", () => {
		expect(ReExportedFromPrepareImage).toBe(ImagePreparationError);
	});

	it("names a photo that is too large, with its size and the limit", () => {
		const error = new ImageTooLargeError(100_020_001, 100_000_000);

		expect(error).toBeInstanceOf(ImagePreparationError);
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("ImageTooLargeError");
		expect([error.pixels, error.limit]).toEqual([100_020_001, 100_000_000]);
		expect(error.message).toContain("100020001");
		expect(error.message).toContain("100000000");
	});

	it("names a decode that ran out of time, with the time it was given", () => {
		const error = new ImageDecodeTimeoutError(60_000);

		expect(error).toBeInstanceOf(ImagePreparationError);
		expect(error.name).toBe("ImageDecodeTimeoutError");
		expect(error.timeoutMs).toBe(60_000);
		expect(error.message).toContain("60000");
	});

	it("names a decode that could not start, apart from the others of its family", () => {
		const cause = new Error("Resource temporarily unavailable");
		const error = new ImageDecodeUnavailableError(
			"image decode worker could not start: Resource temporarily unavailable",
			{ cause },
		);

		expect(error).toBeInstanceOf(ImagePreparationError);
		expect(error).not.toBeInstanceOf(ImageDecodeTimeoutError);
		expect(error).not.toBeInstanceOf(ImageTooLargeError);
		expect(error.name).toBe("ImageDecodeUnavailableError");
		expect(error.cause).toBe(cause);
	});

	it("keeps the cause it is given, as every error of this family does", () => {
		const cause = new Error("libheif said no");
		const error = new ImagePreparationError("image preparation failed", {
			cause,
		});

		expect(error.name).toBe("ImagePreparationError");
		expect(error.cause).toBe(cause);
	});
});
