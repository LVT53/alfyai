// The tool envelope's hard ceiling (Slice 2 of
// docs/plans/context-budget-guards-spec.md). A single live tool result once
// carried 237k input tokens (a whole Nextcloud folder) and the next provider
// step failed on the window. `executeToolWithEnvelope` now caps every
// successful model-facing payload here, after compaction and before the
// recorder observes or records it, so no present or future tool can own the
// model context by itself.

import { estimateTokenCount } from "$lib/utils/tokens";
import { stableStringify } from "./stable-stringify";

export const TOOL_RESULT_MAX_TOKENS = 32_000;

const STRING_VALUE_MAX_CHARS = 4_000;
const ELLIPSIS = "…";
const HINT_TAIL =
	"returned more than one step can carry; narrow the request to see the rest.";
// When filling an array, charge each item its own estimated size plus the
// separator between items and the punctuation run it can merge with
// (`estimateTokenCount` reads `},{` as one segment). Overestimating the kept
// items is what keeps the finished payload under the ceiling.
const ITEM_SEPARATOR_TOKENS = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// `stableStringify` lives in `./stable-stringify`, which imports nothing, so
// this module can measure a payload with the same deterministic bytes the rest
// of the tool layer uses without making an import cycle through `./shared`.
function estimatePayloadTokens(value: unknown): number {
	return estimateTokenCount(stableStringify(value));
}

function truncationHint(payloadName: unknown): string {
	const name = typeof payloadName === "string" ? payloadName.trim() : "";
	return `${name || "The tool"} ${HINT_TAIL}`;
}

/**
 * Returns `payload` unchanged (by identity) when it is not an object or already
 * fits `maxTokens`; otherwise a shallow copy with over-long top-level strings
 * shortened, arrays filled from their share of the remaining budget, and the
 * envelope keys `truncated`/`hint` (plus `omitted` for any array that lost
 * items) added. Deterministic: same input, same output.
 */
export function capModelPayload<T>(
	payload: T,
	maxTokens: number = TOOL_RESULT_MAX_TOKENS,
): T {
	if (!isRecord(payload)) return payload;
	if (estimatePayloadTokens(payload) <= maxTokens) return payload;

	const capped: Record<string, unknown> = { ...payload };

	// 1. A top-level string is shortened first: a single 1 MB `message` or
	// `content` is the cheapest thing to bound, and the cut keeps its front.
	for (const [key, value] of Object.entries(capped)) {
		if (typeof value === "string" && value.length > STRING_VALUE_MAX_CHARS) {
			capped[key] = `${value.slice(0, STRING_VALUE_MAX_CHARS)}${ELLIPSIS}`;
		}
	}

	// 2. These two envelope keys are always added to an over-budget payload; the
	// hint names the tool from the payload's own `name`.
	capped.truncated = true;
	capped.hint = truncationHint(payload.name);

	// 3. Fill arrays from what the non-array payload leaves over, split evenly
	// between arrays and taken in key order. The baseline is measured with every
	// array empty and every `omitted` count at its widest (the original length),
	// so the real, smaller counts and the kept items fit what is left.
	const arrayKeys = Object.keys(capped).filter((key) =>
		Array.isArray(capped[key]),
	);
	if (arrayKeys.length > 0) {
		const baseline: Record<string, unknown> = { ...capped };
		const widestOmitted: Record<string, number> = {};
		for (const key of arrayKeys) {
			baseline[key] = [];
			widestOmitted[key] = (capped[key] as unknown[]).length;
		}
		baseline.omitted = widestOmitted;
		const remaining = maxTokens - estimatePayloadTokens(baseline);
		const share = remaining > 0 ? Math.floor(remaining / arrayKeys.length) : 0;

		const omitted: Record<string, number> = {};
		for (const key of arrayKeys) {
			const items = capped[key] as unknown[];
			let kept = 0;
			let used = 0;
			while (kept < items.length) {
				const cost =
					estimateTokenCount(stableStringify(items[kept])) +
					(kept > 0 ? ITEM_SEPARATOR_TOKENS : 0);
				if (used + cost > share) break;
				used += cost;
				kept += 1;
			}
			capped[key] = kept === items.length ? items : items.slice(0, kept);
			if (kept < items.length) omitted[key] = items.length - kept;
		}
		if (Object.keys(omitted).length > 0) capped.omitted = omitted;
	}

	return capped as T;
}
