import { describe, expect, it } from "vitest";
import {
	isOsFileDropDataTransfer,
	partitionUploadableFiles,
} from "./file-drag";

const ACCEPTED_TYPES =
	".pdf,.doc,.docx,.txt,.md,.json,.csv,.xlsx,.xls,.pptx,.ppt,.html,.htm,.jpg,.jpeg,.jfif,.png,.gif,.bmp,.tiff,.tif,.webp,.svg,.heic,.heif,.avif";
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
});
