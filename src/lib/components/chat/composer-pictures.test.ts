import { describe, expect, it } from "vitest";
import type { KnowledgeDocumentItem } from "$lib/server/services/knowledge/types";
import type { ImageMark } from "$lib/shared/artifacts/image-body";
import { attachmentChipFailure } from "./composer-chip-presentation";
import {
	arrangePictureChips,
	attachmentPictureOptions,
	libraryPictureAttachment,
	markedPictureNumber,
	marksAfterUndo,
	numberPictures,
	pictureChipNames,
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
		const marks: ImageMark[] = [];
		expect(markedPictureNumber(numbers, { imageFileId: "f1", marks })).toBe(2);
		expect(markedPictureNumber(numbers, { uploadArtifactId: "a", marks })).toBe(
			1,
		);
	});

	it("is the next number otherwise, the one the server gives the open picture or the added ref", () => {
		const numbers = numberPictures(["upload:a", "ref:f1"], () => true);
		const marked = { imageFileId: "f9", marks: [] };
		expect(markedPictureNumber(numbers, marked)).toBe(3);
		expect(markedPictureNumber(new Map(), marked)).toBe(1);
	});
});

describe("pictureChipNames", () => {
	const when = (at: number) => `at ${at}`;

	it("tells two pictures of one item apart: the older carries when it was made, the newest keeps the name", () => {
		const names = pictureChipNames(
			[
				{ imageFileId: "new", name: "Sunset gradient", at: 200 },
				{ imageFileId: "old", name: "Sunset gradient", at: 100 },
				{ imageFileId: "rug", name: "Red rug", at: 50 },
			],
			when,
		);
		expect(names.get("new")).toBe("Sunset gradient");
		expect(names.get("old")).toBe("Sunset gradient · at 100");
		expect(names.get("rug")).toBe("Red rug");
	});

	it("leaves a name alone when it cannot say when the picture was made", () => {
		const names = pictureChipNames(
			[
				{ imageFileId: "a", name: "Sunset gradient" },
				{ imageFileId: "b", name: "Sunset gradient", at: 100 },
			],
			when,
		);
		expect(names.get("a")).toBe("Sunset gradient");
		expect(names.get("b")).toBe("Sunset gradient");
	});
});

describe("libraryPictureAttachment", () => {
	const photo = {
		id: "p1",
		type: "source_document",
		displayArtifactId: "p1",
		promptArtifactId: null,
		familyArtifactIds: ["p1"],
		name: "room.png",
		mimeType: "image/png",
		sizeBytes: 10,
		conversationId: null,
		summary: null,
		normalizedAvailable: false,
		updatedAt: 2,
		createdAt: 1,
	} as KnowledgeDocumentItem;

	it("never waits on a text-free photo: a model that sees sends it, one that cannot says why", () => {
		const attachment = libraryPictureAttachment(photo);
		expect(
			attachmentChipFailure(undefined, attachment, {
				selectedModelSupportsImages: true,
			}),
		).toEqual({ kind: "none" });
		expect(
			attachmentChipFailure(undefined, attachment, {
				selectedModelSupportsImages: false,
			}),
		).toEqual({ kind: "readiness", reason: "no_usable_text" });
	});

	it("is ready when the photo has text to read", () => {
		const attachment = libraryPictureAttachment({
			...photo,
			promptArtifactId: "p1-text",
		});
		expect(attachment.promptReady).toBe(true);
		expect(attachment.readinessErrorCode).toBeUndefined();
	});
});

describe("marksAfterUndo", () => {
	const marks = [{ letter: "A" as const, x: 0.1, y: 0.1, w: 0.4, h: 0.5 }];
	const onSofa = {
		uploadArtifactId: "sofa",
		marks,
		artifactId: "sofa",
		name: "sofa.png",
		version: null,
	};
	const onRoom = { ...onSofa, uploadArtifactId: "room", artifactId: "room" };

	it("takes the marks back to the photo they came from", () => {
		expect(marksAfterUndo(onRoom, onRoom, onSofa)).toBe(onSofa);
	});

	it("still undoes after more boxes were drawn on the photo they moved to", () => {
		const onRoomAgain = {
			...onRoom,
			marks: [...marks, { ...marks[0], letter: "B" as const }],
		};
		expect(marksAfterUndo(onRoomAgain, onRoom, onSofa)).toBe(onSofa);
	});

	it("does nothing once the moved marks are gone: sent, cleared or another chat", () => {
		expect(marksAfterUndo(null, onRoom, onSofa)).toBeNull();
	});

	it("leaves marks drawn since on yet another photo", () => {
		const onDesk = { ...onSofa, uploadArtifactId: "desk", artifactId: "desk" };
		expect(marksAfterUndo(onDesk, onRoom, onSofa)).toBe(onDesk);
	});
});

describe("attachmentPictureOptions", () => {
	const held = {
		uploadArtifactId: "photo-1",
		marks: [{ letter: "A" as const, x: 0.1, y: 0.1, w: 0.4, h: 0.5 }],
		artifactId: "photo-1",
		name: "room.jpg",
		version: null,
	};
	const blind = { selectedModelSupportsImages: false };

	it("lets the marked photo through for a model that cannot see", () => {
		expect(
			attachmentPictureOptions("photo-1", held, false, blind)
				.selectedModelSupportsImages,
		).toBe(true);
	});

	it("leaves every other attachment to the model", () => {
		expect(attachmentPictureOptions("other", held, false, blind)).toBe(blind);
		expect(attachmentPictureOptions("photo-1", null, false, blind)).toBe(blind);
	});

	it("keeps Atlas's text-only gate: a report makes no picture", () => {
		expect(attachmentPictureOptions("photo-1", held, true, blind)).toBe(blind);
	});
});
