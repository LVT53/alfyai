import { describe, expect, it } from "vitest";
import { resolveThoughtStepAnchorSpan } from "./thought-step-anchor";

// P3c (ADR-0056) — this is a client-safe duplicate of the server's
// resolveThoughtStepAnchorSpan (src/lib/server/services/chat-turn/
// thought-steps.ts). Same contract, same tests in spirit: an anchor that
// does not resolve to a real, in-bounds, non-empty span returns `null`,
// never clamps, never throws.
describe("resolveThoughtStepAnchorSpan", () => {
	const text = "First I read the request, then I weighed two options.";

	it("resolves a valid in-bounds span to its exact substring", () => {
		expect(resolveThoughtStepAnchorSpan({ start: 0, end: 5 }, text)).toBe(
			"First",
		);
	});

	it("resolves a span touching the exact end of the text", () => {
		const end = text.length;
		expect(resolveThoughtStepAnchorSpan({ start: end - 8, end }, text)).toBe(
			"options.",
		);
	});

	it("returns null for a null or undefined anchor", () => {
		expect(resolveThoughtStepAnchorSpan(null, text)).toBeNull();
		expect(resolveThoughtStepAnchorSpan(undefined, text)).toBeNull();
	});

	it("returns null when end does not exceed start", () => {
		expect(resolveThoughtStepAnchorSpan({ start: 5, end: 5 }, text)).toBeNull();
		expect(resolveThoughtStepAnchorSpan({ start: 8, end: 5 }, text)).toBeNull();
	});

	it("returns null for a negative start", () => {
		expect(
			resolveThoughtStepAnchorSpan({ start: -1, end: 5 }, text),
		).toBeNull();
	});

	it("returns null when end exceeds the text length — never clamps", () => {
		expect(
			resolveThoughtStepAnchorSpan({ start: 0, end: text.length + 1 }, text),
		).toBeNull();
	});

	it("returns null for non-integer bounds", () => {
		expect(
			resolveThoughtStepAnchorSpan({ start: 0.5, end: 5 }, text),
		).toBeNull();
		expect(
			resolveThoughtStepAnchorSpan({ start: 0, end: 5.5 }, text),
		).toBeNull();
	});

	it("returns null against an empty thinking text", () => {
		expect(resolveThoughtStepAnchorSpan({ start: 0, end: 1 }, "")).toBeNull();
	});
});
