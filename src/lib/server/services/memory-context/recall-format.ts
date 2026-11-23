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

/**
 * Opens the recalled rows, once, when any row says when it was last said:
 * what the times mean, so a lasting fact is used as true however long ago it
 * was said (the owner's choice after the age probe's run 2). Recall reserves
 * its tokens like the project heading's.
 */
export const RECALL_TIMES_NOTE =
	"The time after each entry is when the person last mentioned it, not when it happened. Facts that do not change, such as dates, names and health conditions, stay true however long ago they were said: use them without questioning them or mentioning their age. Use the times only to choose between entries that disagree.";

/**
 * Opens the rows, after `RECALL_TIMES_NOTE`, when a row is Earlier or carries
 * earlier states (part 2): such a row is past unless the person says
 * otherwise. Recall reserves its tokens like the times note's.
 */
export const RECALL_EARLIER_NOTE =
	"An entry marked earlier was true when it was said but may have ended or changed since: treat it as past unless the person says it still holds, and bring it up only when the conversation is about it.";

const DAY_MS = 86_400_000;

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

/** The row's line, then one line per earlier state under it (the tool's). */
function recalledLines(item: AdmittedMemoryEvidence, now: Date): string[] {
	const parts = [
		...(item.timeState === "earlier" ? ["earlier"] : []),
		...(item.kind ? [item.kind] : []),
		...[lastSaid(item.lastMentionedAt, now)].filter(
			(said): said is string => said !== null,
		),
	];
	return [
		parts.length ? `- ${item.text} (${parts.join(", ")})` : `- ${item.text}`,
		...(item.earlierStates ?? []).map((state) => {
			const said = lastSaid(state.saidAt, now);
			return said
				? `  - earlier: ${state.text} (${said})`
				: `  - earlier: ${state.text}`;
		}),
	];
}

/**
 * What a recalled row's lines cost, exactly as `formatRecalledMemory` writes
 * them on the same clock. Recall budgets each row at this, because the memory
 * section always goes into the prompt whole.
 */
export function recallLineTokens(
	item: AdmittedMemoryEvidence,
	now: Date,
): number {
	return estimateTokenCount(recalledLines(item, now).join("\n"));
}

const EARLIER_STATE_START = /\s+(?=\(\d{4}-\d{2}-\d{2} \d{2}:\d{2}: )/;
const EARLIER_STATE = /^\((\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}): ([\s\S]+)\)$/;

/**
 * The earlier states Hindsight appends to an observation, `(YYYY-MM-DD HH:MM:
 * older fact)`, newest first, read from what `nativeText` holds after the
 * published `text`. Anything else after the text is not read as a state.
 */
export function parseEarlierStates(
	nativeText: string,
	text: string,
): Array<{ text: string; saidAt: string | null }> {
	if (!nativeText.startsWith(text)) return [];
	const rest = nativeText.slice(text.length).trim();
	if (!rest) return [];
	const states: Array<{ text: string; saidAt: string | null }> = [];
	for (const chunk of rest.split(EARLIER_STATE_START)) {
		const match = EARLIER_STATE.exec(chunk.trim());
		if (!match) return [];
		const at = Date.parse(`${match[1]}T${match[2]}:00Z`);
		states.push({
			text: match[3].trim(),
			saidAt: Number.isNaN(at) ? null : new Date(at).toISOString(),
		});
	}
	return states;
}

/**
 * One line per entry, each with its kind once labelled and when it was last
 * said, an Earlier entry marked so and the tool's earlier states under their
 * entry: the person's entries first, then the project's under
 * `RECALL_PROJECT_HEADING`, each group in input order, after
 * `RECALL_TIMES_NOTE` when any entry has a time and `RECALL_EARLIER_NOTE` when
 * any is Earlier or carries a state. `now` is the turn's one clock, so a
 * rebuild writes the same text.
 */
export function formatRecalledMemory(
	items: readonly AdmittedMemoryEvidence[],
	now: Date,
): string {
	const personal: string[] = [];
	const project: string[] = [];
	for (const item of items)
		(item.ref.scope.kind === "project" ? project : personal).push(
			...recalledLines(item, now),
		);
	const timed = items.some(
		(item) =>
			lastSaid(item.lastMentionedAt, now) !== null ||
			(item.earlierStates ?? []).some(
				(state) => lastSaid(state.saidAt, now) !== null,
			),
	);
	const earlier = items.some(
		(item) => item.timeState === "earlier" || item.earlierStates?.length,
	);
	return [
		...(timed ? [RECALL_TIMES_NOTE] : []),
		...(earlier ? [RECALL_EARLIER_NOTE] : []),
		...personal,
		...(project.length ? [RECALL_PROJECT_HEADING, ...project] : []),
	].join("\n");
}
