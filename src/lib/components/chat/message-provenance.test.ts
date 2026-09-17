import { describe, expect, it } from "vitest";
import type { ResponseActivityEntry } from "$lib/response-activity-types";
import type { MessageEvidenceSummary } from "$lib/server/services/message-evidence";
import type {
	ChatMessage,
	ThinkingSegment,
} from "$lib/server/services/messages-types";
import {
	deriveMessageProvenance,
	type MessageProvenanceInput,
	webSourceCount,
} from "./message-provenance";

// Owner's rule: the provenance line shows only what the USER chose for the
// turn — the `userIntent` record persisted with the assistant message — and
// never what the model did by itself. These tests pin both halves: what the
// record names, and that a turn's tool calls, however loud, name nothing.

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

// A whole assistant message, the way MessageBubble holds one — tool calls,
// live activity and all. `deriveMessageProvenance` takes a narrower input,
// so handing it the full message proves the model's own activity is not
// merely unread by the caller but ignored by the function.
function assistantMessage(
	extra: Partial<ChatMessage> = {},
): MessageProvenanceInput {
	const message: ChatMessage = {
		id: "assistant-1",
		role: "assistant",
		content: "Done.",
		timestamp: 1,
		...extra,
	};
	return message;
}

describe("deriveMessageProvenance", () => {
	it("says nothing about a user turn", () => {
		expect(
			deriveMessageProvenance({
				role: "user",
				userIntent: {
					skill: { id: "skill-1", displayName: "Invoice reply" },
					webSearch: true,
				},
			}),
		).toEqual([]);
	});

	// "It disappears entirely on a turn that used nothing" — the board's own
	// requirement, and the reason a long thread of plain answers does not grow
	// a repeating band of chrome.
	it("says nothing about a turn where the user chose none of the three", () => {
		expect(
			deriveMessageProvenance(
				assistantMessage({
					thinkingSegments: [
						{ type: "text", content: "thinking out loud" },
						toolCall("memory_context"),
					],
				}),
			),
		).toEqual([]);
	});

	it("names the skill the user applied from the composer", () => {
		expect(
			deriveMessageProvenance({
				role: "assistant",
				userIntent: {
					skill: { id: "skill-1", displayName: "Invoice reply" },
				},
			}),
		).toEqual([{ kind: "skill", skillName: "Invoice reply" }]);
	});

	// A `$`-forced skill is resolved into the system prompt at preflight and
	// never called as a tool — the turn carries no `use_skill` at all. It is
	// exactly the case the record exists for.
	it("shows a force-applied skill although the turn made no use_skill call", () => {
		expect(
			deriveMessageProvenance(
				assistantMessage({
					thinkingSegments: [{ type: "text", content: "Here is the draft." }],
					userIntent: {
						skill: { id: "skill-1", displayName: "Invoice reply" },
					},
				}),
			),
		).toEqual([{ kind: "skill", skillName: "Invoice reply" }]);
	});

	it("shows no skill chip for a skill the model loaded by itself", () => {
		expect(
			deriveMessageProvenance(
				assistantMessage({
					thinkingSegments: [
						toolCall("use_skill", { displayName: "Invoice reply" }),
					],
				}),
			),
		).toEqual([]);
	});

	it("ignores a model-loaded skill on the live activity rail too", () => {
		const activity: ResponseActivityEntry[] = [
			{ id: "tool-1", kind: "tool", status: "done", toolName: "use_skill" },
		];
		expect(
			deriveMessageProvenance(assistantMessage({ responseActivity: activity })),
		).toEqual([]);
	});

	// The user's pick is what shows — not whatever other skill the model went
	// on to load in the same turn.
	it("labels the chip with the user's skill, not one the model also loaded", () => {
		expect(
			deriveMessageProvenance(
				assistantMessage({
					thinkingSegments: [
						toolCall("use_skill", { displayName: "Contract review" }),
					],
					userIntent: {
						skill: { id: "skill-1", displayName: "Invoice reply" },
					},
				}),
			),
		).toEqual([{ kind: "skill", skillName: "Invoice reply" }]);
	});

	it("shows the web chip when the user forced web search", () => {
		expect(
			deriveMessageProvenance({
				role: "assistant",
				userIntent: { webSearch: true },
			}),
		).toEqual([{ kind: "web", sourceCount: null }]);
	});

	it("shows no web chip for a search the model ran by itself", () => {
		expect(
			deriveMessageProvenance(
				assistantMessage({
					thinkingSegments: [
						toolCall("research_web"),
						toolCall("web_search_preview"),
					],
					responseActivity: [
						{
							id: "tool-1",
							kind: "tool",
							status: "done",
							toolName: "research_web",
						},
					],
					evidenceSummary: evidence(7),
				}),
			),
		).toEqual([]);
	});

	it("counts the web sources a forced search actually retrieved", () => {
		expect(
			deriveMessageProvenance({
				role: "assistant",
				userIntent: { webSearch: true },
				evidenceSummary: evidence(7),
			}),
		).toEqual([{ kind: "web", sourceCount: 7 }]);
	});

	// "0 sources" would be a claim the turn cannot back; no meta is honest.
	it("leaves the source count out when there is no evidence to count", () => {
		expect(
			deriveMessageProvenance({
				role: "assistant",
				userIntent: { webSearch: true },
				evidenceSummary: evidence(0),
			}),
		).toEqual([{ kind: "web", sourceCount: null }]);
	});

	// A message persisted before the record existed has no `userIntent`.
	// Nothing is guessed back out of its tool calls: no skill chip, no web
	// chip. Atlas is not part of the record and still shows.
	it("shows only Atlas on a legacy message that has no record", () => {
		expect(
			deriveMessageProvenance({
				...assistantMessage({
					thinkingSegments: [
						toolCall("use_skill", { displayName: "Invoice reply" }),
						toolCall("research_web"),
					],
					evidenceSummary: evidence(3),
				}),
				atlasProfiles: ["overview"],
			}),
		).toEqual([{ kind: "atlas", profile: "overview" }]);
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
				userIntent: {
					webSearch: true,
					skill: { id: "skill-1", displayName: "Invoice reply" },
				},
				evidenceSummary: evidence(3),
			}).map((entry) => entry.kind),
		).toEqual(["skill", "web", "atlas"]);
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
