import { describe, expect, it } from "vitest";
import {
	arrangePictureChips,
	markedPictureNumber,
	numberPictures,
	pictureKey,
	reconcilePictureOrder,
} from "./composer-pictures";

const isPicture = (key: string) => key !== "upload:pdf";

describe("pictureKey", () => {
	it("names an upload and a ref apart", () => {
		expect(pictureKey({ kind: "upload", artifactId: "a1" })).toBe("upload:a1");
		expect(pictureKey({ kind: "ref", imageFileId: "f1" })).toBe("ref:f1");
	});
});

describe("numberPictures", () => {
	it("numbers in the order added: a photo, a PDF, then a ref", () => {
		const order = ["upload:photo", "upload:pdf", "ref:f1"];
		const numbers = numberPictures(order, isPicture);
		expect(numbers.get("upload:photo")).toBe(1);
		expect(numbers.has("upload:pdf")).toBe(false);
		expect(numbers.get("ref:f1")).toBe(2);
	});

	it("moves the ref up when the photo is removed", () => {
		const numbers = numberPictures(["upload:pdf", "ref:f1"], isPicture);
		expect(numbers.get("ref:f1")).toBe(1);
	});

	it("numbers nine pictures 1 to 9 with no cap", () => {
		const order = [
			...Array.from({ length: 8 }, (_, i) => `upload:p${i}`),
			"ref:f1",
		];
		const numbers = numberPictures(order, isPicture);
		expect([...numbers.values()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	it("counts a repeated key once", () => {
		const numbers = numberPictures(["ref:f1", "ref:f1"], isPicture);
		expect([...numbers.values()]).toEqual([1]);
	});
});

describe("reconcilePictureOrder", () => {
	it("appends new keys and drops gone ones", () => {
		expect(reconcilePictureOrder(["a", "b"], ["b", "c"])).toEqual(["b", "c"]);
	});

	it("keeps the same array when nothing changed", () => {
		const previous = ["a", "b"];
		expect(reconcilePictureOrder(previous, ["b", "a"])).toBe(previous);
	});
});

describe("arrangePictureChips", () => {
	it("draws a ref added first before a photo added after it", () => {
		const slots = arrangePictureChips(
			["ref:f1", "upload:p1"],
			["upload:p1"],
			["ref:f1"],
		);
		expect(slots).toEqual([
			{ type: "ref", index: 0 },
			{ type: "attachment", index: 0 },
		]);
	});

	it("draws a ref added last after the attachments", () => {
		const slots = arrangePictureChips(
			["upload:p1", "ref:f1"],
			["upload:p1", null],
			["ref:f1"],
		);
		expect(slots).toEqual([
			{ type: "attachment", index: 0 },
			{ type: "attachment", index: 1 },
			{ type: "ref", index: 0 },
		]);
	});
});

describe("markedPictureNumber", () => {
	it("is the number of the attached chip when the marked picture is attached", () => {
		const numbers = numberPictures(["upload:a", "ref:f1"], () => true);
		expect(markedPictureNumber(numbers, "f1")).toBe(2);
	});

	it("is the next number otherwise, the one the server gives the open picture or the added ref", () => {
		const numbers = numberPictures(["upload:a", "ref:f1"], () => true);
		expect(markedPictureNumber(numbers, "f9")).toBe(3);
		expect(markedPictureNumber(new Map(), "f9")).toBe(1);
	});
});
