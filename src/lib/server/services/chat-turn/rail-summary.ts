import { updateMessageRailSummary } from "$lib/server/services/messages";
import {
	generateShortLocalText,
	resolveShortTextLanguage,
} from "./short-local-text";

/**
 * A1 (owner idea) — the post-turn jump-rail summary step.
 *
 * After an assistant turn finalizes, ask the shared local control model (A2's
 * `generateShortLocalText` seam) for a short, glanceable headline of the
 * reply, in the conversation's language, and persist it additively into the
 * assistant message's `metadataJson.railSummary`. The jump-rail prefers this
 * headline over the verbatim truncated reply start (`railEntryText` in
 * src/lib/components/chat/jump-rail.ts).
 *
 * Discipline (ADR-0056 honesty + ADR-0015 post-turn side effects):
 *  - **Fire-and-forget / silent-degrade.** Runs in the deferred post-turn tail
 *    (`runPostTurnTasks`), never on the turn's critical path. A `null`/failed/
 *    rejected summary — or a write-back error — persists nothing; the rail's
 *    verbatim truncation is the honest fallback. This function never throws.
 *  - **Capped + timed.** A2's concurrency cap and hard timeout are OPT-IN
 *    (omitting them runs uncapped/untimed on the shared vLLM), so this step
 *    ALWAYS passes both, in the thought-step classifier's budget class.
 *  - **Skips the cheap cases.** A reply short enough that the verbatim start is
 *    already glanceable doesn't get a control-model call at all — the
 *    deterministic truncation covers it.
 *  - **Assistant turns only** (owner decision O-3): there is no user-turn
 *    summary; this only ever summarizes the assistant reply.
 */

/** Cost-attribution tag for the rail-summary control call (ADR-0047). */
export const RAIL_SUMMARY_FEATURE = "rail_summary";

// Concurrency cap for rail summaries on the shared local vLLM. A cap miss
// returns `null` immediately (no network attempt) and the rail degrades to the
// verbatim truncation. Kept small — 2, matching P2's instant-acknowledgment
// budget rather than the classifier's stricter 1, since this fires exactly
// once per turn (well after generation), not repeatedly across the turn.
export const RAIL_SUMMARY_MAX_CONCURRENT = 2;

// Hard timeout, same budget class as the thought-step classifier (6s): real
// headroom under a busy self-hosted endpoint while staying fire-and-forget. On
// timeout the call resolves `null` and the rail keeps its truncation fallback.
export const RAIL_SUMMARY_TIMEOUT_MS = 6000;

// Below this length the jump-rail's 120-char verbatim start already shows
// essentially the whole reply, so a control-model call would buy nothing — the
// deterministic truncation fallback is honest and complete. Skip generation.
export const RAIL_SUMMARY_MIN_CONTENT_LENGTH = 200;

// Only the opening of a long reply is sent to the control model — enough to
// capture what the turn is about without paying for the entire (possibly
// multi-thousand-char) answer on every turn.
const RAIL_SUMMARY_SOURCE_CHAR_BUDGET = 2000;

// A short headline: a few words. Kept tight in output tokens; the plausibility
// bounds below are the real gate on the returned text.
const RAIL_SUMMARY_MAX_TOKENS = 40;

// Cleanup plausibility bounds — a glanceable headline of a few words. ~100
// chars / ~14 words allows a slightly richer line than a bare title while
// still rejecting a run-on or a leaked paragraph.
const RAIL_SUMMARY_MAX_CHARS = 100;
const RAIL_SUMMARY_MAX_WORDS = 14;

function buildRailSummarySystemPrompt(language: "en" | "hu"): string {
	const languageLabel = language === "hu" ? "Hungarian" : "English";
	return `You are writing a very short, glanceable headline for a navigation rail that summarizes what an assistant's reply is about. You will be given the assistant's reply. Respond with ONLY the headline text — no quotes, no punctuation-only, no preamble, no explanation, no reasoning.

Rules:
- Write the headline in ${languageLabel}.
- Keep it to a few words (at most ~10 words), like a chapter title or a section heading.
- Describe the SUBSTANCE of the reply — the topic or outcome — not meta framing ("The assistant explains…", "This answer…").
- Never invent a fact or claim that is not in the reply.
- Output the headline text only.`;
}

/**
 * Generate and persist the rail summary for one finalized assistant turn.
 * Best-effort end to end: skips short/empty replies, degrades silently on a
 * `null` or failed generation, and swallows any write-back error. Never
 * throws, never blocks the turn.
 */
export async function persistAssistantRailSummary(params: {
	userId: string;
	conversationId: string;
	assistantMessageId: string;
	/** The turn's user message — the deterministic language signal. */
	userMessage: string;
	/** The assistant reply being summarized. */
	assistantResponse: string;
}): Promise<void> {
	const response = params.assistantResponse.trim();
	// Short/empty replies: the verbatim 120-char start is already glanceable,
	// so the deterministic fallback is honest and complete — no control call.
	if (response.length < RAIL_SUMMARY_MIN_CONTENT_LENGTH) return;

	const language = resolveShortTextLanguage(params.userMessage);

	const summary = await generateShortLocalText({
		prompt: response.slice(0, RAIL_SUMMARY_SOURCE_CHAR_BUDGET),
		feature: RAIL_SUMMARY_FEATURE,
		userId: params.userId,
		conversationId: params.conversationId,
		systemPrompt: buildRailSummarySystemPrompt(language),
		maxTokens: RAIL_SUMMARY_MAX_TOKENS,
		timeoutMs: RAIL_SUMMARY_TIMEOUT_MS,
		maxConcurrent: RAIL_SUMMARY_MAX_CONCURRENT,
		language,
		cleanup: {
			maxChars: RAIL_SUMMARY_MAX_CHARS,
			maxWords: RAIL_SUMMARY_MAX_WORDS,
		},
	});
	// Honesty (ADR-0056): a null/rejected summary persists nothing — the rail's
	// verbatim truncation covers it. Never write "".
	if (!summary) return;

	try {
		await updateMessageRailSummary(params.assistantMessageId, summary);
	} catch (error) {
		console.error("[RAIL_SUMMARY] Failed to persist rail summary:", error);
	}
}
