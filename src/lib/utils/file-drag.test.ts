import { describe, expect, it } from "vitest";
import { isOsFileDropDataTransfer } from "./file-drag";

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
