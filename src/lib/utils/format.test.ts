import { describe, expect, it } from "vitest";
import { formatByteSize, formatRoundedKilobytes } from "./format";

describe("format utilities", () => {
	it("formats byte sizes with stable generated-file precision by default", () => {
		expect(formatByteSize(0)).toBe("0 B");
		expect(formatByteSize(1024)).toBe("1.0 KB");
		expect(formatByteSize(1536)).toBe("1.5 KB");
	});

	it("can trim whole non-byte units for document tables", () => {
		expect(formatByteSize(null, { trimWholeUnits: true })).toBe("0 B");
		expect(formatByteSize(1024, { trimWholeUnits: true })).toBe("1 KB");
		expect(formatByteSize(1536, { trimWholeUnits: true })).toBe("1.5 KB");
	});

	it("formats artifact sizes using rounded KB labels", () => {
		expect(formatRoundedKilobytes(null)).toBe("Unknown size");
		expect(formatRoundedKilobytes(1)).toBe("1 KB");
		expect(formatRoundedKilobytes(1025)).toBe("2 KB");
	});
});
