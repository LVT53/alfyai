import { describe, expect, it } from "vitest";
import type { ResponseActivityEntry } from "$lib/response-activity-types";
import type { MessageEvidenceSummary } from "$lib/server/services/message-evidence";
import type { ThinkingSegment } from "$lib/server/services/messages-types";
import { deriveMessageProvenance, webSourceCount } from "./message-provenance";

// The assistant turn's provenance line is DERIVED (owner decision 2) from
// what the message already carries — no new persisted field. These tests pin
// both halves of that bargain: what it can name, and what it refuses to
// guess at.

function toolCall(
	name: string,
	input: Record<string, unknown> = {},
): ThinkingSegment {
	return { type: "tool_call", name, input, status: "done" };
}

function evidence(webItems: number): MessageEvidenceSummary {
	return {
		structuredWebSearch: true,
		groups: [
			{
				sourceType: "web",
				label: "Web",
				reranked: false,
				items: Array.from({ length: webItems }, (_, index) => ({
					id: `src-${index}`,
				})) as MessageEvidenceSummary["groups"][number]["items"],
			},
		],
	};
}

describe("deriveMessageProvenance", () => {
	it("says nothing about a user turn", () => {
		expect(
			deriveMessageProvenance({
				role: "user",
				thinkingSegments: [toolCall("research_web")],
			}),
		).toEqual([]);
	});

	// "It disappears entirely on a turn that used nothing" — the board's own
	// requirement, and the reason a long thread of plain answers does not grow
	// a repeating band of chrome.
	it("says nothing about a turn that used none of the three", () => {
		expect(
			deriveMessageProvenance({
				role: "assistant",
				thinkingSegments: [
					{ type: "text", content: "thinking out loud" },
					toolCall("memory_context"),
				],
			}),
		).toEqual([]);
	});

	it("names the skill a use_skill call names", () => {
		expect(
			deriveMessageProvenance({
				role: "assistant",
				thinkingSegments: [
					toolCall("use_skill", { displayName: "Invoice reply" }),
				],
			}),
		).toEqual([{ kind: "skill", skillName: "Invoice reply" }]);
	});

	it("falls back through the keys a use_skill call might use", () => {
		expect(
			deriveMessageProvenance({
				role: "assistant",
				thinkingSegments: [toolCall("use_skill", { id: "skill-42" })],
			}),
		).toEqual([{ kind: "skill", skillName: "skill-42" }]);
	});

	it("still shows a skill chip when the call names nothing at all", () => {
		expect(
			deriveMessageProvenance({
				role: "assistant",
				thinkingSegments: [toolCall("use_skill")],
			}),
		).toEqual([{ kind: "skill", skillName: null }]);
	});

	it("recognises a skill from the live activity rail too", () => {
		const activity: ResponseActivityEntry[] = [
			{ id: "tool-1", kind: "tool", status: "done", toolName: "use_skill" },
		];
		expect(
			deriveMessageProvenance({
				role: "assistant",
				responseActivity: activity,
			}),
		).toEqual([{ kind: "skill", skillName: null }]);
	});

	it("counts the web sources the turn actually retrieved", () => {
		expect(
			deriveMessageProvenance({
				role: "assistant",
				thinkingSegments: [toolCall("research_web")],
				evidenceSummary: evidence(7),
			}),
		).toEqual([{ kind: "web", sourceCount: 7 }]);
	});

	// "0 sources" would be a claim the turn cannot back; no meta is honest.
	it("leaves the source count out when there is no evidence to count", () => {
		expect(
			deriveMessageProvenance({
				role: "assistant",
				thinkingSegments: [toolCall("web_search_preview")],
			}),
		).toEqual([{ kind: "web", sourceCount: null }]);
	});

	it("names the Atlas profile that ran", () => {
		expect(
			deriveMessageProvenance({
				role: "assistant",
				atlasProfiles: ["in-depth"],
			}),
		).toEqual([{ kind: "atlas", profile: "in-depth" }]);
	});

	it("says one Atlas profile once, however many jobs shared it", () => {
		expect(
			deriveMessageProvenance({
				role: "assistant",
				atlasProfiles: ["overview", "overview", "exhaustive"],
			}),
		).toEqual([
			{ kind: "atlas", profile: "overview" },
			{ kind: "atlas", profile: "exhaustive" },
		]);
	});

	it("draws skill, web and Atlas in the board's order", () => {
		expect(
			deriveMessageProvenance({
				role: "assistant",
				atlasProfiles: ["in-depth"],
				thinkingSegments: [
					toolCall("research_web"),
					toolCall("use_skill", { name: "Invoice reply" }),
				],
				evidenceSummary: evidence(3),
			}).map((entry) => entry.kind),
		).toEqual(["skill", "web", "atlas"]);
	});

	// The honest limit of "derive it, persist nothing": a skill the user
	// force-applied from the composer is resolved into the system prompt at
	// preflight and explicitly NOT called as a tool, so the turn carries no
	// trace of it. Showing no chip beats showing a guessed one.
	it("shows no skill chip for a turn that only force-applied one", () => {
		expect(
			deriveMessageProvenance({
				role: "assistant",
				thinkingSegments: [{ type: "text", content: "Here is the draft." }],
			}),
		).toEqual([]);
	});
});

describe("webSourceCount", () => {
	it("is null without an evidence summary", () => {
		expect(webSourceCount(undefined)).toBeNull();
	});

	it("is null when the summary has no web group", () => {
		expect(
			webSourceCount({
				structuredWebSearch: false,
				groups: [
					{
						sourceType: "document",
						label: "Documents",
						reranked: false,
						items: [],
					},
				] as MessageEvidenceSummary["groups"],
			}),
		).toBeNull();
	});

	it("totals every web group's items", () => {
		expect(webSourceCount(evidence(4))).toBe(4);
	});

	it("is null rather than zero for an empty web group", () => {
		expect(webSourceCount(evidence(0))).toBeNull();
	});
});
