// Pure scoring functions for the G0 tool-guidance A/B evaluation harness
// (scripts/evaluate-tool-guidance-ab.ts).
//
// Everything in this module is a pure function with no I/O: no file access,
// no network calls, no environment reads, no model calls. That is
// intentional — these are the unit-tested primitives the harness composes
// with real `generateText` calls (which are NOT unit-tested here; only the
// harness's live/staging run exercises them). Mirrors the
// scripts/skill-eval-scoring.ts convention for the sibling skill-pack A/B
// harness.
//
// NOTE on what these signals mean under a definition-only, single-step
// harness (see the header comment in evaluate-tool-guidance-ab.ts):
// `correctToolSelected` and `fileProduced` read `toolCalls`, which the model
// populates in the SAME step it decides to call a tool — these are reliable
// signals even though no tool actually executes. `citationPresent` and
// `imagesEmbedded` read the model's final `text`, which in a single-step run
// is typically empty once the model has emitted a tool call (there is no
// tool RESULT fed back for it to cite or embed against). Those two signals
// are still real, reusable, deterministic primitives — worth having and
// testing — but expect them to rarely hit in a G0/G1 single-step report;
// document that plainly in the report rather than treating a near-zero rate
// as a defect.

// ExpectedTool is defined once in the corpus module and imported here (type-only,
// no runtime coupling) so the two eval modules don't duplicate-export the type.
import type { ExpectedTool } from "./eval/tool-guidance-fixtures";

/**
 * Minimal shape the scoring functions need from an AI SDK tool-call part
 * (`result.toolCalls` from `generateText`). Decoupled from the SDK's own
 * `TypedToolCall` type so this module has zero dependency on "ai" and stays
 * trivially unit-testable with synthetic objects.
 */
export type ToolCallLike = { toolName: string };

/**
 * Did the model select the expected tool for this turn?
 *
 * - `expectedTool === "none"`: correct only when NO tool was called at all.
 * - otherwise: correct when the expected tool appears among the calls made,
 *   regardless of whether other tools were also called alongside it (the
 *   model choosing to call an expected tool plus something extra is still a
 *   "selected the right tool" outcome for this signal — over-calling is a
 *   different, not-yet-scored concern).
 */
export function correctToolSelected(
	toolCalls: ToolCallLike[],
	expectedTool: ExpectedTool,
): boolean {
	const calledNames = new Set(toolCalls.map((call) => call.toolName));
	if (expectedTool === "none") {
		return calledNames.size === 0;
	}
	return calledNames.has(expectedTool);
}

// Markdown link `[text](url)` or a bare http(s) URL — either counts as a
// citation marker. SOURCE_LINKING_GUARD (normal-chat-context.ts) asks for
// markdown links specifically and forbids bare source markers like `【S5】`,
// but a bare URL is still a citation-shaped signal worth counting here; the
// distinction between "well-formed markdown link" and "bare URL" is not this
// function's job.
const MARKDOWN_LINK_RE = /\[[^\]]+\]\(https?:\/\/[^\s)]+\)/;
const BARE_URL_RE = /https?:\/\/[^\s)]+/;

/** Does the output text contain a URL/citation marker (web-backed claim)? */
export function citationPresent(text: string): boolean {
	return MARKDOWN_LINK_RE.test(text) || BARE_URL_RE.test(text);
}

// Markdown image syntax `![alt](url)` specifically — IMAGE_SEARCH_GUARD
// requires this exact form to make image_search results visible to the
// user. A plain markdown LINK (no leading `!`) does not count.
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(https?:\/\/[^\s)]+\)/;

/** Does the output text embed at least one markdown image tag? */
export function imagesEmbedded(text: string): boolean {
	return MARKDOWN_IMAGE_RE.test(text);
}

/** Was `produce_file` among the tool calls made this turn? */
export function fileProduced(toolCalls: ToolCallLike[]): boolean {
	return toolCalls.some((call) => call.toolName === "produce_file");
}

export type DimensionSummary = {
	hits: number;
	applicable: number;
	hitRate: number | null;
};

/**
 * Aggregates a dimension's per-fixture boolean flags into a hit-rate.
 * `null`/`undefined` entries mean "not applicable to this fixture" (e.g. a
 * fixture with no `expectedSignals.citation`) and are excluded from both the
 * numerator and denominator. Returns `hitRate: null` (not 0) when nothing in
 * the batch was applicable, so a report never conflates "0% hit rate" with
 * "this dimension never applied".
 */
export function summarizeHitRate(
	flags: Array<boolean | null | undefined>,
): DimensionSummary {
	const applicable = flags.filter(
		(flag): flag is boolean => typeof flag === "boolean",
	);
	const hits = applicable.filter(Boolean).length;
	return {
		hits,
		applicable: applicable.length,
		hitRate: applicable.length > 0 ? hits / applicable.length : null,
	};
}
