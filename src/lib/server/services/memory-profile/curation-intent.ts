import type { MemoryAction } from "$lib/memory-types";
import type { Tx } from "../jobs/types";
import type { EditedFact } from "./curation";
import type { RepairPlan } from "./dependency-plan";
import { isJsonRecord } from "./internal-json";
import { parseMemoryAction } from "./memory-request";

export interface ActionIntentRecord {
	request: MemoryAction;
	revision?: number;
	/** Local replay of an earlier accepted action, with the original ledger ordering. */
	replayOriginActionId?: string;
	replayOrder?: number;
	/** Local corrected facts already identified by the bounded replay check. */
	replayFactDates?: Array<{ id: string; sourceId: string; textHash: string }>;
	dependencyRepair?: RepairPlan;
	outcome?: "accepted" | "rejected";
	originConversationId?: string;
	before: string;
	sourceIds: string[];
	facts: Array<{ id: string; text: string; sourceId: string }>;
	/**
	 * A Remove's targeted facts and every fact that shared a published row
	 * with one of them when the person asked: what stays left out if the
	 * Remove ends unapplied after its native write (`excludedNativeEvidence`).
	 */
	familyFactIds?: string[];
	/**
	 * A changed resend refused for good: the facts of the chats it carried
	 * that its refusal excludes the way a Remove excludes its facts, recorded
	 * once with the `rejected` outcome (`excludeRefusedSourceEdit`) and read by
	 * `excludedNativeEvidence`. Empty when the edit only added sentences;
	 * absent on an edit refused and put back before this rule, which excludes
	 * nothing later.
	 */
	excludedFactIds?: string[];
	plan?: { forget: string[]; replace: string[]; preserve: string[] };
	removalOnly?: boolean;
	omissionEarlierFingerprint?: string;
	proposal?: Array<{ id: string; text: string }>;
	resultGeneration?: string;
	resultSupport?: string;
	resultPresentation?: string;
	resultOriginSourceIds?: string[];
	resultRows?: Array<{ support: string; presentation: string; timing: string }>;
	previousResultActionId?: string;
	addedSourceId?: string;
	nativeFacts?: EditedFact[];
	/** A possibly submitted, one-time targeted consolidation retry. */
	observationResetFactId?: string;
	rejectionCode?: string;
	rollbackPending?: boolean;
	/**
	 * A per-chat forget step for an approved unlocated removal (migration.ts):
	 * the chat revisions whose native facts it began to edit, those whose
	 * latest edit then passed the final review, and for each edited revision
	 * the facts it had before the edit and the facts the edit was to leave.
	 */
	meaningCheck?: {
		started: string[];
		checked: string[];
		edits?: Array<{
			sourceId: string;
			baseline: Array<{ id: string; text: string; sourceId: string }>;
			proposal: Array<{ id: string; text: string }>;
		}>;
	};
}

function validMeaningCheck(value: unknown) {
	const facts = (list: unknown, owned: boolean) =>
		Array.isArray(list) &&
		list.every(
			(fact) =>
				isJsonRecord(fact) &&
				typeof fact.id === "string" &&
				typeof fact.text === "string" &&
				(!owned || typeof fact.sourceId === "string"),
		);
	return (
		isJsonRecord(value) &&
		[value.started, value.checked].every(
			(ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string"),
		) &&
		(value.edits === undefined ||
			(Array.isArray(value.edits) &&
				value.edits.every(
					(edit) =>
						isJsonRecord(edit) &&
						typeof edit.sourceId === "string" &&
						facts(edit.baseline, true) &&
						facts(edit.proposal, false),
				)))
	);
}

export function parseActionIntent(json: string | null): ActionIntentRecord {
	if (!json) throw Error("memory_action_corrupt");
	const value: unknown = JSON.parse(json);
	if (
		!isJsonRecord(value) ||
		typeof value.before !== "string" ||
		!Array.isArray(value.sourceIds) ||
		value.sourceIds.some((x) => typeof x !== "string") ||
		!Array.isArray(value.facts) ||
		value.facts.some(
			(f) =>
				!isJsonRecord(f) ||
				typeof f.id !== "string" ||
				typeof f.text !== "string" ||
				typeof f.sourceId !== "string",
		) ||
		(value.replayFactDates !== undefined &&
			(!Array.isArray(value.replayFactDates) ||
				value.replayFactDates.some(
					(fact) =>
						!isJsonRecord(fact) ||
						typeof fact.id !== "string" ||
						typeof fact.sourceId !== "string" ||
						typeof fact.textHash !== "string",
				))) ||
		(value.observationResetFactId !== undefined &&
			(typeof value.observationResetFactId !== "string" ||
				!value.observationResetFactId)) ||
		(value.omissionEarlierFingerprint !== undefined &&
			typeof value.omissionEarlierFingerprint !== "string") ||
		(value.familyFactIds !== undefined &&
			(!Array.isArray(value.familyFactIds) ||
				value.familyFactIds.some((id) => typeof id !== "string"))) ||
		(value.excludedFactIds !== undefined &&
			(!Array.isArray(value.excludedFactIds) ||
				value.excludedFactIds.some((id) => typeof id !== "string"))) ||
		(value.meaningCheck !== undefined && !validMeaningCheck(value.meaningCheck))
	)
		throw Error("memory_action_corrupt");
	parseMemoryAction(value.request);
	return value as unknown as ActionIntentRecord;
}

/**
 * A message's sentences and lines, each with its spacing folded and its
 * closing mark dropped, with how many times each occurs.
 */
function sentenceCounts(text: string) {
	const counts = new Map<string, number>();
	for (const line of text.normalize("NFC").split(/\r?\n/u))
		for (const part of line.split(/(?<=[.!?…])\s+/u)) {
			const sentence = part
				.replace(/\s+/gu, " ")
				.replace(/[.!?…]+$/u, "")
				.trim();
			if (sentence) counts.set(sentence, (counts.get(sentence) ?? 0) + 1);
		}
	return counts;
}

/**
 * Whether the person's edit of their message took anything away: a sentence
 * (or line) of the message before, counted, that the message after no longer
 * has word for word. An edit that only added sentences, anywhere, took nothing
 * away; any change inside a sentence, even of one letter, counts as taking it
 * away.
 */
export function sourceEditTookAway(intent: ActionIntentRecord) {
	if (intent.request.kind !== "edit") return true;
	const after = sentenceCounts(intent.request.text);
	for (const [sentence, count] of sentenceCounts(intent.before))
		if ((after.get(sentence) ?? 0) < count) return true;
	return false;
}

/**
 * The facts of the chats a changed resend carried whose text its saved
 * proposal changed, rewritten or invalidated, each with the text and chat it
 * had: what a refused resend's proposal wrote.
 */
export function sourceEditChangedFacts(intent: ActionIntentRecord) {
	const proposed = new Map(
		(intent.proposal ?? []).map(({ id, text }) => [id, text]),
	);
	return [
		...new Map(
			intent.facts
				.filter(
					(fact) =>
						proposed.has(fact.id) && proposed.get(fact.id) !== fact.text,
				)
				.map((fact) => [fact.id, fact]),
		).values(),
	];
}

export type ReplayCheck = {
	actionId: string;
	revision: number;
	actionAt?: number;
	actionOrder?: number;
	replayOrder?: number;
	sources: string[];
	originals: ActionIntentRecord["facts"];
	before: string;
	after: string;
	intent: NonNullable<ActionIntentRecord["plan"]>;
	chatRevision?: boolean;
	assertProvenance?: (tx: Tx) => void;
	/** A per-chat forget step for an approved unlocated removal. */
	meaningCheck?: true;
};
