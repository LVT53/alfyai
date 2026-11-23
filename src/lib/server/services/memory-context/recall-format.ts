import type { AdmittedMemoryEvidence } from "$lib/memory-types";
import { estimateTokenCount } from "$lib/utils/tokens";

/**
 * How recalled native Memory reaches the model, for both callers: the
 * per-turn section (`chat-turn/context-selection.ts`) and the
 * `memory_context` tool (`persona.ts`). Model-facing, so ASCII English with
 * no language name and no reply instruction (ruling 79).
 */

/** The line that opens a project chat's own entries, after the person's. */
export const RECALL_PROJECT_HEADING = "Remembered for this project:";

const DAY_MS = 86_400_000;
// The leading "- " and the longest age, " (said less than a day ago)", cost
// 9 tokens together; every other age costs less.
const RECALL_LINE_EXTRA_TOKENS = 9;

/**
 * The most a recalled row's formatted line can cost. Recall budgets each row
 * at this, because the memory section always goes into the prompt whole.
 */
export function recallLineTokens(text: string): number {
	return estimateTokenCount(text) + RECALL_LINE_EXTRA_TOKENS;
}

function lastSaid(lastMentionedAt: string | null, now: Date): string | null {
	if (lastMentionedAt === null) return null;
	const at = Date.parse(lastMentionedAt);
	if (Number.isNaN(at)) return null;
	// Whole days elapsed; a date after `now` counts as today.
	const days = Math.max(0, Math.floor((now.getTime() - at) / DAY_MS));
	if (days === 0) return "said less than a day ago";
	if (days === 1) return "said 1 day ago";
	if (days < 14) return `said ${days} days ago`;
	if (days < 60) return `said ${Math.floor(days / 7)} weeks ago`;
	if (days < 730) return `said ${Math.floor(days / 30)} months ago`;
	return `said ${Math.floor(days / 365)} years ago`;
}

function recalledLine(item: AdmittedMemoryEvidence, now: Date): string {
	const said = lastSaid(item.lastMentionedAt, now);
	return said ? `- ${item.text} (${said})` : `- ${item.text}`;
}

/**
 * One line per entry, each with when it was last said: the person's entries
 * first, then the project's under `RECALL_PROJECT_HEADING`, each group in
 * input order. `now` is the turn's one clock, so a rebuild writes the same
 * text.
 */
export function formatRecalledMemory(
	items: readonly AdmittedMemoryEvidence[],
	now: Date,
): string {
	const personal: string[] = [];
	const project: string[] = [];
	for (const item of items)
		(item.ref.scope.kind === "project" ? project : personal).push(
			recalledLine(item, now),
		);
	return [
		...personal,
		...(project.length ? [RECALL_PROJECT_HEADING, ...project] : []),
	].join("\n");
}
