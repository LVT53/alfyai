import { describe, expect, it } from "vitest";

import { compactModelPayload } from "./shared";

describe("compactModelPayload", () => {
	it("drops undefined, null, empty string, empty array and empty object values", () => {
		expect(
			compactModelPayload({
				a: undefined,
				b: null,
				c: "",
				d: [],
				e: {},
				f: "kept",
				g: 0,
				h: false,
			}),
		).toEqual({ f: "kept", g: 0, h: false });
	});

	it("never drops the protected envelope keys even when empty/falsy", () => {
		expect(
			compactModelPayload({
				success: false,
				name: "",
				action: "",
				message: "",
				mode: "",
				sourceType: "",
			}),
		).toEqual({
			success: false,
			name: "",
			action: "",
			message: "",
			mode: "",
			sourceType: "",
		});
	});

	it("recurses exactly one level into a nested plain object", () => {
		expect(
			compactModelPayload({
				answerBrief: { sourceCount: 2, evidenceCount: 0, note: "" },
			}),
		).toEqual({ answerBrief: { sourceCount: 2, evidenceCount: 0 } });
	});

	it("drops a nested object entirely once compaction leaves it empty", () => {
		expect(
			compactModelPayload({
				answerBrief: { note: "", other: null },
				kept: "value",
			}),
		).toEqual({ kept: "value" });
	});

	it("does not descend a second level (a grandchild object is left as-is)", () => {
		const payload = compactModelPayload({
			outer: { inner: { note: "", value: 1 } },
		});
		expect(payload).toEqual({ outer: { inner: { note: "", value: 1 } } });
	});

	it("leaves array items untouched (arrays are not recursed into)", () => {
		const payload = compactModelPayload({
			items: [{ note: "", value: 1 }, { value: 2 }],
		});
		expect(payload).toEqual({
			items: [{ note: "", value: 1 }, { value: 2 }],
		});
	});

	it("passes non-record payloads through unchanged", () => {
		expect(compactModelPayload("a string" as unknown)).toBe("a string");
		expect(compactModelPayload(null as unknown)).toBe(null);
		expect(compactModelPayload([1, 2, 3] as unknown)).toEqual([1, 2, 3]);
	});

	it("is idempotent — compacting an already-compacted payload changes nothing", () => {
		const once = compactModelPayload({
			success: true,
			name: "research_web",
			answerBrief: { sourceCount: 1, note: "" },
			empty: [],
		});
		const twice = compactModelPayload(once);
		expect(twice).toEqual(once);
	});
});
