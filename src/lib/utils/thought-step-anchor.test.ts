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
// own sentence (`before`/`span`/`after`, highlighted as ONE unit by the
// caller) and one further sentence of un-highlighted context on each side
// (`leadIn`/`tailOut`). Same rejection contract as
// resolveThoughtStepAnchorSpan (eligibility must not change).
describe("resolveThoughtStepDisplayContext", () => {
	const text =
		"First I read the request carefully. Then I weighed two different options before continuing. After that I drafted an answer.";
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
		// ...and together with the span they form the whole sentence the
		// caller highlights as one unit — never a mid-sentence slice.
		expect(`${ctx.before}${ctx.span}${ctx.after}`).toBe(
			"Then I weighed two different options before continuing.",
		);
	});

	it("adds exactly one further sentence of un-highlighted context on each side", () => {
		const ctx = resolveThoughtStepDisplayContext({ start, end }, text);
		if (!ctx) throw new Error("expected a context");
		expect(ctx.leadIn).toBe("First I read the request carefully. ");
		expect(ctx.tailOut).toBe(" After that I drafted an answer.");
	});

	it("never crosses a line break for the surrounding context (the paragraph is the edge)", () => {
		const paragraphs =
			"An earlier paragraph ends here.\nThen I weighed two different options before continuing.\nA later paragraph starts here.";
		const s = paragraphs.indexOf(anchorText);
		const ctx = resolveThoughtStepDisplayContext(
			{ start: s, end: s + anchorText.length },
			paragraphs,
		);
		if (!ctx) throw new Error("expected a context");
		expect(ctx.leadIn).toBe("");
		expect(ctx.tailOut).toBe("");
		expect(`${ctx.before}${ctx.span}${ctx.after}`).toBe(
			"Then I weighed two different options before continuing.",
		);
	});

	it("adds no same-sentence context when the span already sits on sentence boundaries", () => {
		// The whole second sentence, exactly.
		const s = text.indexOf("Then");
		const e = text.indexOf("continuing.") + "continuing.".length;
		const ctx = resolveThoughtStepDisplayContext({ start: s, end: e }, text);
		expect(ctx).not.toBeNull();
		if (!ctx) throw new Error("expected a context");
		expect(ctx.before).toBe("");
		expect(ctx.after).toBe("");
		// The one-sentence surround is still offered on both sides.
		expect(ctx.leadIn).toBe("First I read the request carefully. ");
		expect(ctx.tailOut).toBe(" After that I drafted an answer.");
	});

	it("offers no context at all when the anchor already spans the whole text", () => {
		const ctx = resolveThoughtStepDisplayContext(
			{ start: 0, end: text.length },
			text,
		);
		if (!ctx) throw new Error("expected a context");
		expect(ctx.leadIn).toBe("");
		expect(ctx.before).toBe("");
		expect(ctx.after).toBe("");
		expect(ctx.tailOut).toBe("");
		expect(ctx.span).toBe(text);
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
