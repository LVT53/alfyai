import { describe, expect, it } from "vitest";
import { getAcceptAttribute } from "$lib/shared/file-types";
import {
	isOsFileDropDataTransfer,
	partitionUploadableFiles,
} from "./file-drag";

// The knowledge surface's accept string, read from the one table that also
// feeds the <input accept> attribute — so this test cannot drift from what the
// UI actually offers.
const ACCEPTED_TYPES = getAcceptAttribute("knowledge");
const ONE_MB = 1024 * 1024;
const SIZE_LIMIT = 100 * 1024 * 1024;

function makeFile(name: string, sizeBytes: number): File {
	const file = new File([new Uint8Array(sizeBytes)], name);
	Object.defineProperty(file, "size", { value: sizeBytes });
	return file;
}

describe("isOsFileDropDataTransfer", () => {
	it("accepts browser file drag type markers", () => {
		expect(
			isOsFileDropDataTransfer({
				types: ["Files"],
				files: { length: 0 },
			}),
		).toBe(true);
	});

	it("accepts real file payloads even when the Files type marker is absent", () => {
		expect(
			isOsFileDropDataTransfer({
				types: [],
				files: { length: 1 },
			}),
		).toBe(true);
	});

	it("rejects internal conversation drags even when files are present", () => {
		expect(
			isOsFileDropDataTransfer({
				types: ["application/x-alfyai-conversation", "Files"],
				files: { length: 1 },
			}),
		).toBe(false);
	});

	it("rejects non-file drags", () => {
		expect(
			isOsFileDropDataTransfer({
				types: ["text/plain"],
				files: { length: 0 },
			}),
		).toBe(false);
	});
});

describe("partitionUploadableFiles", () => {
	it("keeps a valid file under the size limit", () => {
		const file = makeFile("report.pdf", ONE_MB);
		const result = partitionUploadableFiles([file], {
			acceptedTypes: ACCEPTED_TYPES,
			maxFileSizeBytes: SIZE_LIMIT,
		});
		expect(result.valid).toHaveLength(1);
		expect(result.valid[0]).toBe(file);
		expect(result.rejectedUnsupportedType).toHaveLength(0);
		expect(result.rejectedTooLarge).toHaveLength(0);
	});

	it("filters out files with an unsupported extension", () => {
		const zip = makeFile("archive.zip", ONE_MB);
		const result = partitionUploadableFiles([zip], {
			acceptedTypes: ACCEPTED_TYPES,
			maxFileSizeBytes: SIZE_LIMIT,
		});
		expect(result.valid).toHaveLength(0);
		expect(result.rejectedUnsupportedType).toHaveLength(1);
		expect(result.rejectedUnsupportedType[0]).toBe(zip);
		expect(result.rejectedTooLarge).toHaveLength(0);
	});

	it("filters out files exceeding the size limit", () => {
		const oversized = makeFile("huge.pdf", SIZE_LIMIT + 1);
		const result = partitionUploadableFiles([oversized], {
			acceptedTypes: ACCEPTED_TYPES,
			maxFileSizeBytes: SIZE_LIMIT,
		});
		expect(result.valid).toHaveLength(0);
		expect(result.rejectedTooLarge).toHaveLength(1);
		expect(result.rejectedTooLarge[0]).toBe(oversized);
		expect(result.rejectedUnsupportedType).toHaveLength(0);
	});

	it("keeps the good files in a mixed batch while partitioning the bad ones", () => {
		const goodPdf = makeFile("good.pdf", ONE_MB);
		const goodTxt = makeFile("notes.txt", 512);
		const badZip = makeFile("archive.zip", ONE_MB);
		const hugePng = makeFile("big.png", SIZE_LIMIT + 1024);
		const result = partitionUploadableFiles(
			[goodPdf, badZip, hugePng, goodTxt],
			{ acceptedTypes: ACCEPTED_TYPES, maxFileSizeBytes: SIZE_LIMIT },
		);
		expect(result.valid).toEqual([goodPdf, goodTxt]);
		expect(result.rejectedUnsupportedType).toEqual([badZip]);
		expect(result.rejectedTooLarge).toEqual([hugePng]);
	});

	it("treats an exact-size file as valid (boundary is inclusive)", () => {
		const atLimit = makeFile("exact.pdf", SIZE_LIMIT);
		const result = partitionUploadableFiles([atLimit], {
			acceptedTypes: ACCEPTED_TYPES,
			maxFileSizeBytes: SIZE_LIMIT,
		});
		expect(result.valid).toEqual([atLimit]);
		expect(result.rejectedTooLarge).toHaveLength(0);
	});

	it("accepts uppercase extensions case-insensitively", () => {
		const file = makeFile("IMAGE.PNG", ONE_MB);
		const result = partitionUploadableFiles([file], {
			acceptedTypes: ACCEPTED_TYPES,
			maxFileSizeBytes: SIZE_LIMIT,
		});
		expect(result.valid).toEqual([file]);
	});

	// `acceptedTypes` is optional now: a caller that has no reason to hold an
	// accept string names its surface instead and gets the same answer.
	it("falls back to the surface's accept list when none is passed", () => {
		const pdf = makeFile("report.pdf", ONE_MB);
		const zip = makeFile("archive.zip", ONE_MB);
		const result = partitionUploadableFiles([pdf, zip], {
			surface: "knowledge",
			maxFileSizeBytes: SIZE_LIMIT,
		});
		expect(result.valid).toEqual([pdf]);
		expect(result.rejectedUnsupportedType).toEqual([zip]);
	});

	it("defaults to the knowledge surface when none is named", () => {
		const python = makeFile("train.py", ONE_MB);
		const explicit = partitionUploadableFiles([python], {
			acceptedTypes: ACCEPTED_TYPES,
			maxFileSizeBytes: SIZE_LIMIT,
		});
		const implicit = partitionUploadableFiles([python], {
			maxFileSizeBytes: SIZE_LIMIT,
		});
		// `.py` is a chat type, not a knowledge one — the knowledge accept string
		// is frozen in this phase (spec open question 2).
		expect(implicit.rejectedUnsupportedType).toEqual(
			explicit.rejectedUnsupportedType,
		);
		expect(implicit.valid).toEqual([]);
	});

	it("offers the wider chat set when the chat surface asks", () => {
		const python = makeFile("train.py", ONE_MB);
		const result = partitionUploadableFiles([python], {
			surface: "chat",
			maxFileSizeBytes: SIZE_LIMIT,
		});
		expect(result.valid).toEqual([python]);
	});
});
