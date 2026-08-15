import { describe, expect, it } from "vitest";
import {
	citationPresent,
	correctToolSelected,
	fileProduced,
	imagesEmbedded,
	summarizeHitRate,
} from "./tool-guidance-scoring";

describe("correctToolSelected", () => {
	it("returns true when the expected tool was called (right tool)", () => {
		const toolCalls = [{ toolName: "research_web" }];
		expect(correctToolSelected(toolCalls, "research_web")).toBe(true);
	});

	it("returns false when a different tool was called instead (wrong tool)", () => {
		const toolCalls = [{ toolName: "image_search" }];
		expect(correctToolSelected(toolCalls, "research_web")).toBe(false);
	});

	it("returns false when no tool was called but one was expected", () => {
		expect(correctToolSelected([], "produce_file")).toBe(false);
	});

	it("returns false when none was expected but a tool was called (none-expected-but-called)", () => {
		const toolCalls = [{ toolName: "memory_context" }];
		expect(correctToolSelected(toolCalls, "none")).toBe(false);
	});

	it("returns true when none was expected and no tool was called", () => {
		expect(correctToolSelected([], "none")).toBe(true);
	});

	it("returns true when the expected tool was called alongside other tools", () => {
		const toolCalls = [
			{ toolName: "memory_context" },
			{ toolName: "research_web" },
		];
		expect(correctToolSelected(toolCalls, "research_web")).toBe(true);
	});

	it("treats duplicate calls to the same tool as a single selection", () => {
		const toolCalls = [{ toolName: "fetch_url" }, { toolName: "fetch_url" }];
		expect(correctToolSelected(toolCalls, "fetch_url")).toBe(true);
	});
});

describe("citationPresent", () => {
	it("returns true (hit) when a markdown link with a URL is present", () => {
		const text =
			"According to [the source](https://example.com/article), X is true.";
		expect(citationPresent(text)).toBe(true);
	});

	it("returns true (hit) when a bare http(s) URL is present without markdown", () => {
		const text = "See https://example.com/article for details.";
		expect(citationPresent(text)).toBe(true);
	});

	it("returns false (miss) when there is no URL or link in the text", () => {
		const text = "Here is a plain-language answer with no sources cited.";
		expect(citationPresent(text)).toBe(false);
	});

	it("returns false (miss) for an empty string", () => {
		expect(citationPresent("")).toBe(false);
	});
});

describe("imagesEmbedded", () => {
	it("returns true (hit) when a markdown image tag with a URL is present", () => {
		const text =
			"Here you go: ![a sunset beach](https://example.com/beach.jpg)";
		expect(imagesEmbedded(text)).toBe(true);
	});

	it("returns false (miss) when only a markdown LINK (not an image) is present", () => {
		const text =
			"Here is [a link to the photo](https://example.com/beach.jpg), not embedded.";
		expect(imagesEmbedded(text)).toBe(false);
	});

	it("returns false (miss) when there is no image markdown at all", () => {
		const text = "I found some great photos of the beach for you.";
		expect(imagesEmbedded(text)).toBe(false);
	});
});

describe("fileProduced", () => {
	it("returns true (hit) when produce_file is among the tool calls", () => {
		const toolCalls = [{ toolName: "produce_file" }];
		expect(fileProduced(toolCalls)).toBe(true);
	});

	it("returns true (hit) when produce_file is called alongside other tools", () => {
		const toolCalls = [
			{ toolName: "research_web" },
			{ toolName: "produce_file" },
		];
		expect(fileProduced(toolCalls)).toBe(true);
	});

	it("returns false (miss) when produce_file is not among the tool calls", () => {
		const toolCalls = [{ toolName: "image_search" }];
		expect(fileProduced(toolCalls)).toBe(false);
	});

	it("returns false (miss) when toolCalls is empty", () => {
		expect(fileProduced([])).toBe(false);
	});
});

describe("summarizeHitRate", () => {
	it("computes hits/applicable/hitRate over boolean flags, ignoring null/undefined", () => {
		const result = summarizeHitRate([true, false, true, null, undefined, true]);
		expect(result).toEqual({ hits: 3, applicable: 4, hitRate: 0.75 });
	});

	it("returns hitRate: null (not 0) when there are no applicable flags", () => {
		const result = summarizeHitRate([null, undefined, null]);
		expect(result).toEqual({ hits: 0, applicable: 0, hitRate: null });
	});

	it("returns hitRate: 0 when every applicable flag is false", () => {
		const result = summarizeHitRate([false, false]);
		expect(result).toEqual({ hits: 0, applicable: 2, hitRate: 0 });
	});

	it("returns hitRate: 1 when every applicable flag is true", () => {
		const result = summarizeHitRate([true, true, true]);
		expect(result).toEqual({ hits: 3, applicable: 3, hitRate: 1 });
	});

	it("handles an empty array as zero applicable, zero hits, null rate", () => {
		expect(summarizeHitRate([])).toEqual({
			hits: 0,
			applicable: 0,
			hitRate: null,
		});
	});
});
