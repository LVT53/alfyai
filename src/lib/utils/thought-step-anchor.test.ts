import { describe, expect, it } from "vitest";
import {
	resolveThoughtStepAnchorSpan,
	resolveThoughtStepDisplayContext,
} from "./thought-step-anchor";

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

// The step rail's per-step reveal expands the raw anchored span out to its
// own sentence so it no longer begins/ends mid-sentence, while keeping the
// exact anchored span as the highlighted core. Same rejection contract as
// resolveThoughtStepAnchorSpan (eligibility must not change).
describe("resolveThoughtStepDisplayContext", () => {
	const text =
		"First I read the request carefully. Then I weighed two different options before continuing.";
	const anchorText = "weighed two different options";
	const start = text.indexOf(anchorText);
	const end = start + anchorText.length;

	it("keeps the anchored span exact and completes its sentence around it", () => {
		const ctx = resolveThoughtStepDisplayContext({ start, end }, text);
		expect(ctx).not.toBeNull();
		if (!ctx) throw new Error("expected a context");
		expect(ctx.span).toBe(anchorText);
		// Same-sentence lead-in and tail are pulled in...
		expect(ctx.before).toBe("Then I ");
		expect(ctx.after).toBe(" before continuing.");
		// ...but the previous sentence is not.
		expect(`${ctx.before}${ctx.span}${ctx.after}`).toBe(
			"Then I weighed two different options before continuing.",
		);
		expect(`${ctx.before}${ctx.span}${ctx.after}`).not.toContain(
			"First I read the request",
		);
	});

	it("adds no context when the span already sits on sentence boundaries", () => {
		// The whole second sentence, exactly.
		const s = text.indexOf("Then");
		const e = text.length;
		const ctx = resolveThoughtStepDisplayContext({ start: s, end: e }, text);
		expect(ctx).not.toBeNull();
		if (!ctx) throw new Error("expected a context");
		expect(ctx.before).toBe("");
		expect(ctx.after).toBe("");
	});

	it("returns null on exactly the anchors the raw resolver rejects", () => {
		expect(resolveThoughtStepDisplayContext(null, text)).toBeNull();
		expect(
			resolveThoughtStepDisplayContext({ start: 5, end: 5 }, text),
		).toBeNull();
		expect(
			resolveThoughtStepDisplayContext(
				{ start: 0, end: text.length + 1 },
				text,
			),
		).toBeNull();
	});
});
