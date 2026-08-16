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
import type { ThoughtStepAnchor } from "$lib/types";

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
