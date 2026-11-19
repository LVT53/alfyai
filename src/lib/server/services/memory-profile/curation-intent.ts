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
	rejectionCode?: string;
	rollbackPending?: boolean;
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
		(value.omissionEarlierFingerprint !== undefined &&
			typeof value.omissionEarlierFingerprint !== "string")
	)
		throw Error("memory_action_corrupt");
	parseMemoryAction(value.request);
	return value as unknown as ActionIntentRecord;
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
};
