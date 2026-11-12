// The opened tool-call body's plain-language account, as STRUCTURED PARTS.
//
// A person who presses a tool row should read what happened, on what, and what
// came back — not a dump of the call's arguments. This module turns the row's
// existing data (`ToolActivityItem`) into the four parts that account needs:
// which action it was, the thing it named, how it ended, and the raw detail
// that belongs behind the closed "Details" disclosure.
//
// It never composes a sentence and imports no `$t`: the row's own label is the
// action, and the component puts the parts into the reader's language. That
// keeps the module pure, unit-testable, and free of a second vocabulary beside
// the labels the row already shows.
import type {
	ToolActivityBody,
	ToolActivityStatus,
} from "$lib/utils/tool-activity";
import type { ToolCallIconType } from "$lib/utils/tool-calls";

/**
 * How long a target may be before it is clipped. The summary is a sentence to
 * read, not the call's argument: a long query must wrap or stop, never widen
 * the row.
 */
export const TOOL_SUMMARY_TARGET_MAX = 120;

/** The kind of action, used to choose the outcome wording. */
export type ToolSummaryActionKey =
	| "search"
	| "image-search"
	| "read"
	| "skill"
	| "run"
	| "route"
	| "memory"
	| "create"
	/** A named tool whose icon type is the fallback: the row's own label is enough. */
	| "other"
	/** A tool the map does not know: the generic sentence, with no target. */
	| "generic";

/** How the call ended, as a clause the component words. */
export type ToolSummaryOutcome =
	| { kind: "found"; count: number }
	| { kind: "read" }
	| { kind: "done" }
	| { kind: "running" }
	| { kind: "failed" }
	| { kind: "unreachable" }
	| { kind: "skipped" };

/** The raw arguments and result, shown only inside the closed Details disclosure. */
export type ToolCallSummaryDetail = {
	args: { key: string; value: string }[];
	result: string | null;
};

export type ToolCallSummary = {
	actionKey: ToolSummaryActionKey;
	target: string | null;
	outcome: ToolSummaryOutcome;
	detail: ToolCallSummaryDetail | null;
};

export type ToolCallSummaryInput = {
	iconType: ToolCallIconType;
	status: ToolActivityStatus;
	/** The row's own human label (its verb), reused rather than replaced. */
	label: string;
	/** The identifying thing the row names, if any. */
	target?: string | null;
	/** How many results the call returned, when the row counts them. */
	count?: number | null;
	/** The expanded body, for the raw arguments/result behind Details. */
	body?: ToolActivityBody | null;
	/** The translated generic tool label ("Tool"), so an unknown tool is told apart from a named one. */
	genericLabel?: string;
};

const ACTION_BY_ICON: Record<ToolCallIconType, ToolSummaryActionKey> = {
	"web-search": "search",
	"image-search": "image-search",
	"fetch-url": "read",
	"use-skill": "skill",
	"run-python": "run",
	"map-route": "route",
	memory: "memory",
	artifact: "create",
	"file-production": "create",
	ask: "generic",
	calendar: "other",
	contacts: "other",
	email: "other",
	files: "other",
	location: "other",
	media: "other",
	photos: "other",
	repos: "other",
	tasks: "other",
	generic: "generic",
};

/**
 * Clips a target to a readable length at a word boundary and trims it. A value
 * that reads as nothing is no target at all (`null`), so the component leaves
 * the clause out rather than printing an empty pair of quotes.
 */
export function clipToolTarget(raw: string | null | undefined): string | null {
	const text = (raw ?? "").replace(/\s+/g, " ").trim();
	if (!text) return null;
	if (text.length <= TOOL_SUMMARY_TARGET_MAX) return text;
	const cut = text.slice(0, TOOL_SUMMARY_TARGET_MAX - 1);
	const lastSpace = cut.lastIndexOf(" ");
	// A single unbroken token keeps its start rather than collapsing to nothing.
	const body =
		lastSpace > TOOL_SUMMARY_TARGET_MAX / 2 ? cut.slice(0, lastSpace) : cut;
	const trimmed = body.replace(/[\s,;:.!?\-–—]+$/, "");
	return `${trimmed}…`;
}

function isNamedTool(input: ToolCallSummaryInput): boolean {
	if (input.iconType !== "generic") return true;
	const generic = input.genericLabel?.trim();
	const label = input.label.trim();
	return generic !== undefined && generic.length > 0 && label !== generic;
}

function actionKeyFor(input: ToolCallSummaryInput): ToolSummaryActionKey {
	if (!isNamedTool(input)) return "generic";
	if (input.iconType === "generic") return "other";
	return ACTION_BY_ICON[input.iconType];
}

function outcomeFor(
	input: ToolCallSummaryInput,
	actionKey: ToolSummaryActionKey,
): ToolSummaryOutcome {
	if (input.status === "running") return { kind: "running" };
	if (input.status === "skipped" || input.status === "closed") {
		return { kind: "skipped" };
	}
	if (input.status === "failed") {
		// A page or a search the app could not reach is what the person needs
		// to hear; anything else simply did not finish.
		return actionKey === "read" ||
			actionKey === "search" ||
			actionKey === "image-search"
			? { kind: "unreachable" }
			: { kind: "failed" };
	}
	if (actionKey === "read") return { kind: "read" };
	if (
		(actionKey === "search" || actionKey === "image-search") &&
		typeof input.count === "number" &&
		input.count > 0
	) {
		return { kind: "found", count: input.count };
	}
	return { kind: "done" };
}

function detailFor(
	body: ToolActivityBody | null | undefined,
): ToolCallSummaryDetail | null {
	if (!body) return null;
	if (body.kind === "generic") {
		if (body.args.length === 0 && !body.result) return null;
		return { args: body.args, result: body.result };
	}
	if (body.kind === "error") {
		return { args: [], result: body.reason };
	}
	return null;
}

/**
 * The four parts of one call's account. The row's label stays the component's
 * to print; this says which kind of action it was, what it named, how it ended,
 * and what raw material sits behind Details.
 */
export function describeToolCall(input: ToolCallSummaryInput): ToolCallSummary {
	const actionKey = actionKeyFor(input);
	// An unknown tool names nothing we can vouch for: its arguments are the
	// model's, and they belong behind Details.
	const target = actionKey === "generic" ? null : clipToolTarget(input.target);
	return {
		actionKey,
		target,
		outcome: outcomeFor(input, actionKey),
		detail: detailFor(input.body),
	};
}
