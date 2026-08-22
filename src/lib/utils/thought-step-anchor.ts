// P3c (ADR-0056) — a client-safe mirror of `resolveThoughtStepAnchorSpan`
// from src/lib/server/services/chat-turn/thought-steps.ts.
//
// Duplicated rather than imported: that module lives under `$lib/server`,
// and SvelteKit refuses to bundle anything under `$lib/server/*` into
// client-reachable code (ThinkingBlock.svelte, which needs this, is a
// client component). Both copies exist to resolve the exact same contract
// — a Thought Step Anchor's half-open `[start, end)` character span into a
// turn's `messages.thinking` text — and both are held to the same honesty
// rule the ADR states: an anchor that does not resolve to a real, in-bounds,
// non-empty span returns `null`, never clamps, never throws. The step rail
// uses this to decide which persisted steps are even eligible to render
// ("only render steps that exist with a resolvable anchor") and to compute
// the exact substring highlighted by the raw-trace jump-anchor view. If the
// server twin's behavior ever changes, this one must change with it.
import type { ThoughtStepAnchor } from "$lib/response-activity-types";

export function resolveThoughtStepAnchorSpan(
	anchor: ThoughtStepAnchor | null | undefined,
	thinkingText: string,
): string | null {
	if (!anchor) return null;
	const { start, end } = anchor;
	if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
	if (start < 0 || end <= start || end > thinkingText.length) return null;
	return thinkingText.slice(start, end);
}

// How far the display expansion below is allowed to reach in each direction
// when it can't find a sentence boundary sooner. A generous cap: the point is
// to complete the sentence the span sits in, never to dump an unbounded wall
// of the surrounding trace.
const MAX_DISPLAY_CONTEXT_CHARS = 500;

function isSentenceTerminator(ch: string): boolean {
	return ch === "." || ch === "!" || ch === "?";
}

// Walk left from `start` to the beginning of the sentence it sits in: just
// past the previous sentence terminator or line break, then forward over any
// whitespace so the context begins on a real word. Returns `start` unchanged
// when it is already at a clean boundary.
function expandStartToSentence(text: string, start: number): number {
	if (start <= 0) return 0;
	const prev = text[start - 1];
	if (prev === "\n" || isSentenceTerminator(prev)) return start;
	const floor = Math.max(0, start - MAX_DISPLAY_CONTEXT_CHARS);
	let i = start;
	while (i > floor) {
		const ch = text[i - 1];
		if (ch === "\n" || isSentenceTerminator(ch)) break;
		i -= 1;
	}
	while (i < start && /\s/.test(text[i])) i += 1;
	return i;
}

// Walk right from `end` to the end of the sentence it sits in: through the
// next sentence terminator (inclusive) or up to the next line break. Returns
// `end` unchanged when it is already at a clean boundary.
function expandEndToSentence(text: string, end: number): number {
	if (end >= text.length) return text.length;
	if (isSentenceTerminator(text[end - 1]) || text[end] === "\n") return end;
	const ceil = Math.min(text.length, end + MAX_DISPLAY_CONTEXT_CHARS);
	let i = end;
	while (i < ceil) {
		const ch = text[i];
		if (ch === "\n") break;
		i += 1;
		if (isSentenceTerminator(ch)) break;
	}
	return i;
}

/**
 * The step rail's per-step reveal used to show ONLY the raw anchored span,
 * which — because the classifier samples reasoning at arbitrary delta
 * boundaries, not sentence boundaries — routinely began and ended mid-sentence
 * ("beginning and end cut off"). This returns the same honest, in-bounds
 * anchored `span` PLUS the `before`/`after` text needed to complete the
 * sentence the span sits in, so the reveal reads as whole thoughts. It only
 * ever exposes MORE of the real `thinkingText` (never fabricates), and the
 * caller still highlights `span` alone — the surrounding sentence context is
 * shown un-highlighted. Returns `null` on exactly the anchors
 * `resolveThoughtStepAnchorSpan` rejects, so eligibility is unchanged.
 */
export function resolveThoughtStepDisplayContext(
	anchor: ThoughtStepAnchor | null | undefined,
	thinkingText: string,
): { before: string; span: string; after: string } | null {
	const span = resolveThoughtStepAnchorSpan(anchor, thinkingText);
	if (span === null || !anchor) return null;
	const contextStart = expandStartToSentence(thinkingText, anchor.start);
	const contextEnd = expandEndToSentence(thinkingText, anchor.end);
	return {
		before: thinkingText.slice(contextStart, anchor.start),
		span,
		after: thinkingText.slice(anchor.end, contextEnd),
	};
}
