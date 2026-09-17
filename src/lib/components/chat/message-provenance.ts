// The assistant turn's PROVENANCE line (chips redesign, owner-approved
// boards 2026-09-15, InStream.dc.html — "In the footer, above the action
// row").
//
// The composer's chips are destroyed on send, so nothing in the stream said
// what the user had turned on for a turn. This line says it back.
//
// Owner's rule: the line shows only what the USER CHOSE for that turn — never
// what the model decided to do on its own.
//
// The first version of this file derived the line from the turn's tool calls
// ("derive from what is already on the message, persist nothing"). That was
// cheap and it was wrong: a `use_skill` or `research_web` call looks the same
// whether the user asked for it or the model reached for it, so the line
// credited the user with the model's choices — and could NOT show the one
// skill case that is the user's, a skill force-applied from the composer,
// because that is resolved into the system prompt at preflight and never
// called as a tool. Tool calls cannot answer "who chose this", so the choice
// is now written down: a small additive `userIntent` record on the assistant
// message (see $lib/message-user-intent.ts — `metadataJson`, no migration,
// plus the terminal stream frame for the live session).
//
//   * a skill shows when the user applied one to that message from the
//     composer — picked from the plus menu or force-applied with `$name`
//     (request field `pendingSkill`). The label is that skill's display name.
//     A skill the model loaded by itself via `use_skill` does not show.
//   * the web shows when the user forced web search for that message with
//     `/web` (request field `forceWebSearch`). A `research_web` call the model
//     made by itself does not show. The source count beside it still comes
//     from the turn's own evidence summary, when there is one.
//   * Atlas shows when the turn carries an Atlas job card, whose `profile` is
//     the profile that ran. Atlas only ever runs because the user turned it
//     on, so the job card IS the user's choice and needs no record.
//
// A message persisted before the record existed has none, and shows no skill
// or web chip — the safe default; nothing is guessed back out of its tool
// calls. Its Atlas chip still shows.
//
// Pure functions over plain data, per the `activity-presentation.ts`
// boundary rule: nothing Svelte-reactive, nothing that imports `$t`. The
// caller localizes the labels from the returned kinds.
import type { MessageUserIntent } from "$lib/message-user-intent";
import type { AtlasProfile } from "$lib/server/services/atlas/types";
import type { MessageEvidenceSummary } from "$lib/server/services/message-evidence";

/** One entry on the provenance line, in the order the board draws them. */
export type MessageProvenanceEntry =
	| { kind: "skill"; skillName: string }
	| { kind: "web"; sourceCount: number | null }
	| { kind: "atlas"; profile: AtlasProfile };

export type MessageProvenanceInput = {
	role: "user" | "assistant";
	// The user's recorded choices for this turn; absent on a turn where they
	// chose nothing and on every message from before the record existed.
	userIntent?: MessageUserIntent | undefined;
	// Only ever used to COUNT the sources of a web search the user forced —
	// never to decide that the chip shows.
	evidenceSummary?: MessageEvidenceSummary | undefined;
	atlasProfiles?: AtlasProfile[] | undefined;
};

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
 * Atlas. Empty for a user turn and for a turn where the user chose none of
 * the three — whatever the model went on to do by itself.
 */
export function deriveMessageProvenance(
	message: MessageProvenanceInput,
): MessageProvenanceEntry[] {
	if (message.role !== "assistant") return [];

	const entries: MessageProvenanceEntry[] = [];

	// --- skill ------------------------------------------------------------
	const skillName = message.userIntent?.skill?.displayName.trim();
	if (skillName) {
		entries.push({ kind: "skill", skillName });
	}

	// --- web --------------------------------------------------------------
	if (message.userIntent?.webSearch === true) {
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
