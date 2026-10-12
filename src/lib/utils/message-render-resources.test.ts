import { describe, expect, it } from "vitest";
import type { ThinkingSegment } from "$lib/server/services/messages-types";
import {
	messageRenderResourcesFromKey,
	messageRenderResourcesKey,
} from "./message-render-resources";

// What a reply may show of the web without a click is what its own tool calls
// returned (docs/plans/exfil-channels). The chat derives that from the message's
// segments, and must hand the renderer the same object while nothing in the tool
// calls has changed: the segment array is replaced by a refreshed copy of the
// message, and a redraw of every block must follow a real change only.

const THUMB =
	"https://imgs.search.brave.com/Zq3s9x/rs:fit:500:0:0:0/g:ce/aHR0cHM6Ly9leGFtcGxlLmNvbS9jYXQuanBn";

function toolCall(
	name: string,
	candidates: Array<{ url?: string | null; metadata?: Record<string, string> }>,
	extra: Partial<Extract<ThinkingSegment, { type: "tool_call" }>> = {},
): ThinkingSegment {
	return {
		type: "tool_call",
		name,
		input: {},
		status: "done",
		candidates: candidates.map((candidate, index) => ({
			id: `c${index}`,
			title: `Result ${index}`,
			sourceType: "web" as const,
			...candidate,
		})),
		...extra,
	};
}

const cats = () =>
	toolCall("image_search", [
		{ url: "https://example.com/cat.jpg", metadata: { thumbnail: THUMB } },
		{ url: "https://www.pets.example.org/dog.jpg" },
	]);

describe("messageRenderResourcesKey / messageRenderResourcesFromKey", () => {
	it("is empty, and gives no resources, when no tool returned anything", () => {
		for (const segments of [
			undefined,
			[],
			[{ type: "text" as const, content: "https://example.com/a.png" }],
			[toolCall("calendar", [{ url: null }])],
			// A call's input is the model's own words and never counts.
			[toolCall("fetch_url", [], { input: { url: "https://secret.test/x" } })],
			// A call still running has returned nothing yet.
			[toolCall("image_search", [], { status: "running" })],
		]) {
			expect(messageRenderResourcesKey(segments)).toBe("");
		}
		expect(messageRenderResourcesFromKey("")).toBeUndefined();
	});

	it("carries the pictures image_search returned and the hosts every tool returned", () => {
		const key = messageRenderResourcesKey([
			cats(),
			toolCall("research_web", [{ url: "https://docs.example.net/guide" }]),
		]);
		const resources = messageRenderResourcesFromKey(key);

		expect(resources?.toolImages).toEqual([
			{ url: "https://example.com/cat.jpg", thumbnail: THUMB },
			{ url: "https://www.pets.example.org/dog.jpg", thumbnail: null },
		]);
		expect([...(resources?.toolSourceHosts ?? [])].sort()).toEqual([
			"docs.example.net",
			"example.com",
			"pets.example.org",
		]);
	});

	it("is the same key for the same content, whichever array and order it comes in", () => {
		const key = messageRenderResourcesKey([cats()]);
		// A refreshed copy of the message: new objects, same content.
		expect(messageRenderResourcesKey([cats()])).toBe(key);
		expect(messageRenderResourcesKey([...[cats()]])).toBe(key);
		// A text segment or a call that returned nothing is not a change.
		expect(
			messageRenderResourcesKey([
				{ type: "text", content: "thinking" },
				cats(),
				toolCall("run_python", []),
			]),
		).toBe(key);
		// The same hosts in another order are the same hosts.
		expect(
			messageRenderResourcesKey([
				toolCall("research_web", [
					{ url: "https://b.example/1" },
					{ url: "https://a.example/2" },
				]),
			]),
		).toBe(
			messageRenderResourcesKey([
				toolCall("research_web", [
					{ url: "https://a.example/2" },
					{ url: "https://b.example/1" },
				]),
			]),
		);
	});

	it("changes when a tool returns something new", () => {
		const before = messageRenderResourcesKey([cats()]);
		expect(
			messageRenderResourcesKey([
				cats(),
				toolCall("image_search", [{ url: "https://example.com/owl.jpg" }]),
			]),
		).not.toBe(before);
		expect(
			messageRenderResourcesKey([
				cats(),
				toolCall("research_web", [{ url: "https://new.example.net/p" }]),
			]),
		).not.toBe(before);
	});
});
