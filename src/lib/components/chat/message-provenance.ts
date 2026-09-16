// The assistant turn's PROVENANCE line (chips redesign, owner-approved
// boards 2026-09-15, InStream.dc.html — "In the footer, above the action
// row").
//
// Nothing in the stream currently records that a skill ran, that the web was
// searched, or which Atlas profile was used: the composer's chips are
// destroyed on send, and only the tool-activity rail — folded away inside
// the thinking block — remembers. This derives that line back out of what is
// ALREADY on the message.
//
// Owner decision (2): the line is DERIVED from the existing tool-activity
// items and message metadata. No new persisted field, no migration, no new
// wire key. Which means the honest limit of this function is exactly the
// honest limit of the data:
//
//   * a skill shows when the turn made a `use_skill` tool call. A skill the
//     user force-applied from the composer (`$name`) is resolved at preflight
//     into the system prompt and explicitly NOT called as a tool, and is
//     recorded only as an `activity_events` "skill_use" row — which the chat
//     read model never projects onto the message. That turn shows no skill
//     chip rather than a guessed one.
//   * the web shows when a web-search tool call is present, and counts its
//     sources from the turn's own evidence summary when there is one.
//   * Atlas shows when the turn carries an Atlas job card, whose `profile`
//     is the profile that ran.
//
// Pure functions over plain data, per the `activity-presentation.ts`
// boundary rule: nothing Svelte-reactive, nothing that imports `$t`. The
// caller localizes the labels from the returned kinds.
import type { ResponseActivityEntry } from "$lib/response-activity-types";
import type { AtlasProfile } from "$lib/server/services/atlas/types";
import type { MessageEvidenceSummary } from "$lib/server/services/message-evidence";
import type { ThinkingSegment } from "$lib/server/services/messages-types";
import { getToolCallIconType } from "$lib/utils/tool-calls";

/** One entry on the provenance line, in the order the board draws them. */
export type MessageProvenanceEntry =
	| { kind: "skill"; skillName: string | null }
	| { kind: "web"; sourceCount: number | null }
	| { kind: "atlas"; profile: AtlasProfile };

export type MessageProvenanceInput = {
	role: "user" | "assistant";
	thinkingSegments?: ThinkingSegment[] | undefined;
	responseActivity?: ResponseActivityEntry[] | undefined;
	evidenceSummary?: MessageEvidenceSummary | undefined;
	atlasProfiles?: AtlasProfile[] | undefined;
};

/**
 * The skill name a `use_skill` call names, as the model wrote it. The tool
 * takes the skill by id/name in its input; the display name a row shows is
 * the same string, so this prefers the human-facing keys and falls back to
 * the id rather than inventing a title.
 */
function skillNameFromToolInput(input: Record<string, unknown>): string | null {
	for (const key of ["displayName", "display_name", "name", "skill", "id"]) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

function toolCallSegments(
	segments: ThinkingSegment[] | undefined,
): Extract<ThinkingSegment, { type: "tool_call" }>[] {
	return (segments ?? []).filter(
		(segment): segment is Extract<ThinkingSegment, { type: "tool_call" }> =>
			segment.type === "tool_call",
	);
}

/**
 * The number of distinct web sources the turn retrieved, from the evidence
 * summary's own web group. `null` when the turn has no evidence summary (an
 * older message, or one whose evidence is still pending) — the caller then
 * draws the chip with no meta clause rather than "0 sources".
 */
export function webSourceCount(
	evidenceSummary: MessageEvidenceSummary | undefined,
): number | null {
	if (!evidenceSummary) return null;
	const webGroups = evidenceSummary.groups.filter(
		(group) => group.sourceType === "web",
	);
	if (webGroups.length === 0) return null;
	const total = webGroups.reduce((sum, group) => sum + group.items.length, 0);
	return total > 0 ? total : null;
}

/**
 * The provenance entries for one message, in the board's order: skill, web,
 * Atlas. Empty for a user turn, for a turn that used none of the three, and
 * for anything it cannot honestly name.
 */
export function deriveMessageProvenance(
	message: MessageProvenanceInput,
): MessageProvenanceEntry[] {
	if (message.role !== "assistant") return [];

	const entries: MessageProvenanceEntry[] = [];
	const toolCalls = toolCallSegments(message.thinkingSegments);
	const activityToolNames = (message.responseActivity ?? [])
		.map((entry) => entry.toolName)
		.filter((name): name is string => Boolean(name?.trim()));

	// --- skill ------------------------------------------------------------
	const skillCall = toolCalls.find(
		(call) => getToolCallIconType(call.name) === "use-skill",
	);
	const skillFromActivity = activityToolNames.some(
		(name) => getToolCallIconType(name) === "use-skill",
	);
	if (skillCall) {
		entries.push({
			kind: "skill",
			skillName: skillNameFromToolInput(skillCall.input ?? {}),
		});
	} else if (skillFromActivity) {
		entries.push({ kind: "skill", skillName: null });
	}

	// --- web --------------------------------------------------------------
	const searchedWeb =
		toolCalls.some((call) => getToolCallIconType(call.name) === "web-search") ||
		activityToolNames.some(
			(name) => getToolCallIconType(name) === "web-search",
		) ||
		Boolean(message.evidenceSummary?.structuredWebSearch);
	if (searchedWeb) {
		entries.push({
			kind: "web",
			sourceCount: webSourceCount(message.evidenceSummary),
		});
	}

	// --- Atlas ------------------------------------------------------------
	// One chip per DISTINCT profile: a turn with two jobs on the same profile
	// says "Atlas · In-Depth" once, not twice.
	const seenProfiles = new Set<AtlasProfile>();
	for (const profile of message.atlasProfiles ?? []) {
		if (seenProfiles.has(profile)) continue;
		seenProfiles.add(profile);
		entries.push({ kind: "atlas", profile });
	}

	return entries;
}
