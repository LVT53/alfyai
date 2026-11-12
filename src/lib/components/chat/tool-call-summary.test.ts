import { describe, expect, it } from "vitest";
import {
	clipToolTarget,
	describeToolCall,
	TOOL_SUMMARY_TARGET_MAX,
} from "./tool-call-summary";

describe("describeToolCall", () => {
	it("says a search found twelve results", () => {
		const summary = describeToolCall({
			iconType: "web-search",
			status: "done",
			label: "Searched",
			target: "cork weather",
			count: 12,
			body: { kind: "sources", sources: [], citedCount: 0 },
		});

		expect(summary).toEqual({
			actionKey: "search",
			target: "cork weather",
			outcome: { kind: "found", count: 12 },
			detail: null,
		});
	});

	it("says a failed read could not reach the page", () => {
		const summary = describeToolCall({
			iconType: "fetch-url",
			status: "failed",
			label: "Read",
			target: "weather.metoffice.gov.uk",
			body: { kind: "error", reason: "request timed out after 20 s" },
		});

		expect(summary.actionKey).toBe("read");
		expect(summary.target).toBe("weather.metoffice.gov.uk");
		expect(summary.outcome).toEqual({ kind: "unreachable" });
		// The raw reason is what the closed Details disclosure carries.
		expect(summary.detail).toEqual({
			args: [],
			result: "request timed out after 20 s",
		});
	});

	it("carries a refused picture's reason for the account, not only for Details", () => {
		// The make_image row's body is an `error` whose reason is already written
		// for the person (a localized imageReasonKey), so the summary must hand it
		// back as the detail a failed outcome shows.
		const reason =
			"H3 cannot make transparent pictures. Switch the Admin “Picture model” to Qwen.";
		const summary = describeToolCall({
			iconType: "artifact",
			status: "failed",
			label: "Picture not made",
			target: "Sunset over Cork",
			body: { kind: "error", reason },
		});

		expect(summary.actionKey).toBe("create");
		expect(summary.target).toBe("Sunset over Cork");
		expect(summary.outcome).toEqual({ kind: "failed" });
		expect(summary.detail).toEqual({ args: [], result: reason });
	});

	it("says a call that is still running is still working", () => {
		const summary = describeToolCall({
			iconType: "web-search",
			status: "running",
			label: "Searching",
			target: "cork weather",
			count: null,
			body: { kind: "sources", sources: [], citedCount: 0 },
		});

		expect(summary.outcome).toEqual({ kind: "running" });
	});

	it("leaves the target out when there is nothing readable to name", () => {
		const summary = describeToolCall({
			iconType: "web-search",
			status: "done",
			label: "Searched",
			target: "   ",
			count: 0,
			body: null,
		});

		expect(summary.target).toBeNull();
		expect(summary.outcome).toEqual({ kind: "done" });
	});

	it("falls back to a plain sentence for a tool it does not know", () => {
		const summary = describeToolCall({
			iconType: "generic",
			status: "done",
			label: "Tool",
			target: "value",
			genericLabel: "Tool",
			body: {
				kind: "generic",
				args: [{ key: "thing", value: "value" }],
				result: "it worked",
			},
		});

		expect(summary.actionKey).toBe("generic");
		expect(summary.target).toBeNull();
		expect(summary.outcome).toEqual({ kind: "done" });
		expect(summary.detail).toEqual({
			args: [{ key: "thing", value: "value" }],
			result: "it worked",
		});
	});

	it("keeps the row's own label for a named tool that uses the generic icon", () => {
		const summary = describeToolCall({
			iconType: "generic",
			status: "done",
			label: "Read",
			target: "Trip plan",
			genericLabel: "Tool",
			body: { kind: "generic", args: [], result: null },
		});

		expect(summary.actionKey).toBe("other");
		expect(summary.target).toBe("Trip plan");
	});

	it("clips a very long target at a word boundary", () => {
		const long = Array.from({ length: 60 }, (_, index) => `word${index}`).join(
			" ",
		);
		const summary = describeToolCall({
			iconType: "web-search",
			status: "done",
			label: "Searched",
			target: long,
			count: 3,
		});

		expect(summary.target).not.toBeNull();
		expect(summary.target?.length).toBeLessThanOrEqual(TOOL_SUMMARY_TARGET_MAX);
		expect(summary.target?.endsWith("…")).toBe(true);
		// The last word before the ellipsis is whole, never a cut in the middle.
		expect(summary.target).toMatch(/^\S+( \S+)*…$/);
		expect(summary.target).not.toContain(long);
	});
});

describe("clipToolTarget", () => {
	it("collapses whitespace and keeps a short target as it is", () => {
		expect(clipToolTarget("  cork \n weather  ")).toBe("cork weather");
	});

	it("returns null for a target that reads as nothing", () => {
		expect(clipToolTarget("   ")).toBeNull();
		expect(clipToolTarget(null)).toBeNull();
		expect(clipToolTarget(undefined)).toBeNull();
	});
});
