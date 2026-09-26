// The App generator (Feature 2 · Artifacts, Slice 2): one model call, thinking
// pinned off, that turns a request into a candidate app's HTML. This module
// never writes to the database — the caller (the `create_artifact` tool
// branch, or the regenerate route/service) decides, after `verify.ts` has run,
// whether to persist. That ordering is what makes "verified before the card
// appears" true (spec §2.10).
//
// The generator is a CONSUMER of `normal-chat-model/`: it does not reimplement
// provider-attempt policy, timeout/failover, or usage mapping (AGENTS.md). Its
// only two owned decisions are (1) which system prompt and sampling ceiling to
// send, and (2) how to turn the model's raw answer into an app or a named
// failure.

import type { ModelId } from "$lib/model-types";
import type { ThinkingMode } from "$lib/reasoning-depth-types";
import { getConfig } from "$lib/server/config-store";
import { recordControlModelUsage } from "$lib/server/services/analytics";
import {
	buildNormalChatModelRunProviderOptions,
	mapNormalChatModelRunUsageToProviderSnapshot,
	type NormalChatModelRunProvider,
	type NormalChatModelRunUsage,
	resolveNormalChatModelRunProvider,
	runStreamingNormalChatModelRun,
} from "$lib/server/services/normal-chat-model";
import { auditAppHtml, type ContractCheck } from "./audit";
import {
	APP_CONTRACT_PROMPT,
	APP_MAX_OUTPUT_TOKENS,
	APP_VIOLATION_RULE_IDS,
} from "./contract";

export interface AppGenerationRequest {
	userId: string;
	conversationId: string | null;
	/** The user's request, verbatim. The only thing from the session that reaches the model. */
	prompt: string;
	/** From the turn's own language detection (`services/language.ts`), not guessed here. */
	language: "en" | "hu";
	/** When the caller already knows it (a regeneration keeps the old title unless the user renamed it). */
	title?: string | null;
	/** The chat model this turn is using; the App call defaults to "model1" and never inherits thinking. */
	modelId?: ModelId;
	abortSignal?: AbortSignal;
}

/** The prototype's vocabulary, kept: which of its three extraction paths produced the HTML. */
export type AppExtractionStrategy = "fence" | "recovered-document" | "empty";

export type AppGenerationFailureReason =
	| "empty_content"
	| "no_fence"
	| "tool_call"
	| "too_long"
	| "provider_error"
	/** Ruling 58: a violation-severity audit rule (self-navigation, WebRTC)
	 * fired on both attempts — refused rather than shipped, even repaired. */
	| "contract_violation";

export type AppGenerationResult =
	| {
			ok: true;
			html: string;
			/** `<title>`, then `<h1>`, then a truncated prompt. Never the word "Artifact". */
			title: string;
			/** "fence" for a contract-shaped answer. `generateApp` never returns "recovered-document" as a success — see the note above `extractAppHtml`. */
			extraction: AppExtractionStrategy;
			fences: number;
			checks: ContractCheck[];
			/** Both attempts' usage summed; the cost display wants what this feature actually spent. */
			usage: NormalChatModelRunUsage;
			attempts: number;
			/** Non-fatal observations for the report and the eval harness — never shown to the user. */
			warnings: string[];
	  }
	| {
			ok: false;
			reason: AppGenerationFailureReason;
			detail: string;
			usage: NormalChatModelRunUsage | null;
			attempts: number;
	  };

/** The only thinking setting this feature ever uses. Typed so a later "make it configurable" reads as a change. */
export const APP_THINKING_MODE: ThinkingMode = "off";

/** One retry, as the prototype: a second failure is reported as itself, not retried again. */
export const APP_MAX_ATTEMPTS = 2;

const ZERO_USAGE: NormalChatModelRunUsage = {
	inputTokens: undefined,
	outputTokens: undefined,
	totalTokens: undefined,
};

function sumField(
	a: number | undefined,
	b: number | undefined,
): number | undefined {
	if (a === undefined && b === undefined) return undefined;
	return (a ?? 0) + (b ?? 0);
}

function sumUsage(
	a: NormalChatModelRunUsage,
	b: NormalChatModelRunUsage,
): NormalChatModelRunUsage {
	return {
		inputTokens: sumField(a.inputTokens, b.inputTokens),
		outputTokens: sumField(a.outputTokens, b.outputTokens),
		totalTokens: sumField(a.totalTokens, b.totalTokens),
		cachedInputTokens: sumField(a.cachedInputTokens, b.cachedInputTokens),
		cacheHitTokens: sumField(a.cacheHitTokens, b.cacheHitTokens),
		cacheMissTokens: sumField(a.cacheMissTokens, b.cacheMissTokens),
	};
}

function describeError(caught: unknown): string {
	if (caught instanceof Error) return caught.message;
	return String(caught);
}

/** The prototype's `model.ts` hit self-hosted endpoints that 400 on an unrecognised `top_k` body field. */
function isTopKRejection(caught: unknown): boolean {
	return /top_k/i.test(describeError(caught));
}

/**
 * The system prompt is the constant, unchanged by anything ambient (A1.6):
 * the one user message carries the request plus a language instruction. No
 * chat history, no other artifact, no memory, no user display name.
 */
export function buildAppRequestMessage(params: {
	prompt: string;
	language: "en" | "hu";
}): string {
	const languageInstruction =
		params.language === "hu"
			? "Write the whole app in Hungarian: every label, button, empty state and error message."
			: "Write the whole app in English: every label, button, empty state and error message.";
	return `${params.prompt}\n\n${languageInstruction}`;
}

const FENCE_RE = /```[ \t]*(?:html|HTML)[ \t]*\r?\n([\s\S]*?)```/g;

export interface Extraction {
	ok: boolean;
	html: string;
	strategy: AppExtractionStrategy;
	issue: string | null;
	fenceCount: number;
	/** true when the answer was cut off (max_tokens hit) before a usable document could be recovered. */
	truncatedFence: boolean;
}

/**
 * Ported from the prototype's `extract.ts` (`extractAppHtml`) — same three
 * strategies, same regex, same recovery path. What differs from the
 * prototype's own use of this function is `generateApp`'s POLICY on top of
 * it: the prototype's eval harness scores a recovered whole document as a
 * usable app (it is trying to measure "did the model produce something"),
 * but this product's contract is stricter — "Return exactly ONE fenced code
 * block... Write nothing outside the fence" is a hard rule (Task A1: "do not
 * accept a whole-document answer without a fence"). `generateApp` therefore
 * treats `strategy: "recovered-document"` the same as an unusable fence: a
 * `no_fence` failure after the retry, never a success. This function still
 * reports the strategy honestly (for `warnings`/the eval harness's own
 * scoring, which may want the prototype's more lenient reading later).
 * Exported so the eval harness's `app` suite scorer (A9) reuses this exact
 * extraction rather than a second copy of the fence regex.
 */
export function extractAppHtml(
	raw: string,
	finishReason: string | null,
): Extraction {
	const matches = [...raw.matchAll(FENCE_RE)];
	const proseOutsideFence = raw.replace(FENCE_RE, "").trim();
	const truncatedFence = finishReason === "length" && matches.length === 0;

	if (matches.length > 0) {
		const longest =
			matches.map((match) => match[1]).sort((a, b) => b.length - a.length)[0] ??
			"";
		const looksLikeDocument = /<\s*html[\s>]/i.test(longest);
		const issues: string[] = [];
		if (!looksLikeDocument)
			issues.push("fenced block is not a full html document");
		if (matches.length > 1) {
			issues.push(`${matches.length} html fences found, longest used`);
		}
		if (proseOutsideFence.length > 0) {
			issues.push(
				`${proseOutsideFence.length} chars of prose outside the fence`,
			);
		}
		return {
			ok: looksLikeDocument,
			html: longest.trim(),
			strategy: "fence",
			issue: issues.length > 0 ? issues.join("; ") : null,
			fenceCount: matches.length,
			truncatedFence,
		};
	}

	const docStart = raw.search(/<!doctype html|<html[\s>]/i);
	if (docStart !== -1 && /<\/html>/i.test(raw)) {
		const end = raw.toLowerCase().lastIndexOf("</html>");
		return {
			ok: true,
			html: raw.slice(docStart, end + "</html>".length).trim(),
			strategy: "recovered-document",
			issue: "no html fence; recovered the raw document instead",
			fenceCount: 0,
			truncatedFence: false,
		};
	}

	return {
		ok: false,
		html: "",
		strategy: "empty",
		issue: truncatedFence
			? "answer hit max_tokens (finish_reason=length) and contained no complete html document"
			: "no html fence and no complete html document in the answer",
		fenceCount: 0,
		truncatedFence,
	};
}

/**
 * Classifies WHY an extraction failed into the product's three failure
 * reasons (Task A1 Step 1.3/1.5) — factored out of `generateApp`'s retry loop
 * so the eval harness's `app` suite scorer (A9) applies the exact same rule
 * a real generation would, rather than a second copy of this three-way
 * split. See the three-shape note above `extractAppHtml`'s call site.
 */
export function classifyAppExtractionFailure(
	extraction: Pick<Extraction, "strategy" | "truncatedFence">,
): AppGenerationFailureReason {
	return extraction.strategy === "fence"
		? "empty_content"
		: extraction.strategy === "empty" && extraction.truncatedFence
			? "too_long"
			: "no_fence";
}

/** `<title>`, then `<h1>`, then a truncated prompt — never the word "Artifact" (spec §2.16/ADR-0066). */
function deriveAppTitle(html: string, prompt: string): string {
	const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	const fromTitle = titleMatch?.[1]?.replace(/\s+/g, " ").trim();
	if (fromTitle) return fromTitle;

	const h1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
	const fromH1 = h1Match?.[1]
		?.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (fromH1) return fromH1;

	const truncated = prompt.replace(/\s+/g, " ").trim().slice(0, 80);
	return truncated.length > 0 ? truncated : "App";
}

interface AttemptOutcome {
	text: string;
	finishReason: string | null;
	usage: NormalChatModelRunUsage;
	sawUndeclaredToolCall: boolean;
}

async function runOneAttempt(params: {
	provider: NormalChatModelRunProvider;
	modelId: ModelId;
	userMessage: string;
	maxOutputTokens: number;
	abortSignal?: AbortSignal;
}): Promise<AttemptOutcome> {
	let text = "";
	let finishReason: string | null = null;
	let usage: NormalChatModelRunUsage = ZERO_USAGE;
	let sawUndeclaredToolCall = false;

	for await (const event of runStreamingNormalChatModelRun({
		provider: params.provider,
		modelId: params.modelId,
		system: APP_CONTRACT_PROMPT,
		messages: [{ role: "user", content: params.userMessage }],
		// The thinking switch is this one call, always "off" — see
		// APP_THINKING_MODE. The provider-specific shape of "thinking
		// disabled" (e.g. qwen's chat_template_kwargs.enable_thinking) is
		// provider-compatibility.ts's job, not this module's.
		resolveProviderOptions: (attemptProvider) =>
			buildNormalChatModelRunProviderOptions(
				attemptProvider,
				APP_THINKING_MODE,
			),
		maxOutputTokens: params.maxOutputTokens,
		abortSignal: params.abortSignal,
	})) {
		switch (event.type) {
			case "text_delta":
				text += event.text;
				break;
			case "tool_call":
				// No tools were declared on this call at all: any tool_call event
				// is the prototype's "let me first explore the project structure"
				// reflex, not a legitimate step.
				sawUndeclaredToolCall = true;
				break;
			case "usage":
				usage = event.usage;
				break;
			case "finish":
				finishReason = event.rawFinishReason ?? event.finishReason;
				break;
			case "error":
				throw new Error(event.error);
			default:
				break;
		}
	}

	return { text, finishReason, usage, sawUndeclaredToolCall };
}

/**
 * Runs the App contract's one generation call. Never writes to the database.
 * Retries once (`APP_MAX_ATTEMPTS`) on a transport failure, empty content,
 * `finish_reason=length`, or an (undeclared) tool call — each recorded in
 * `warnings` — and reports the SECOND failure as itself.
 */
export async function generateApp(
	request: AppGenerationRequest,
): Promise<AppGenerationResult> {
	const modelId = (request.modelId ?? "model1") as ModelId;
	const warnings: string[] = [];
	let usage: NormalChatModelRunUsage = ZERO_USAGE;
	let attempts = 0;

	let provider: NormalChatModelRunProvider;
	try {
		provider = await resolveNormalChatModelRunProvider(modelId, getConfig());
	} catch (caught) {
		await recordAppGenerationCost({ request, modelId, usage: null });
		return {
			ok: false,
			reason: "provider_error",
			detail: describeError(caught),
			usage: null,
			attempts: 0,
		};
	}

	// The caller's value REPLACES the provider-model default rather than
	// being capped by it (normal-chat-model/index.ts), so asking for more
	// than the configured model can emit is how finish_reason=length
	// arrives — take the smaller of the two explicitly.
	const maxOutputTokens = Math.min(
		APP_MAX_OUTPUT_TOKENS,
		provider.maxOutputTokens ?? APP_MAX_OUTPUT_TOKENS,
	);
	// Reassigned, not const: a violation on attempt 1 (ruling 58) retries with
	// the violation named appended to the SAME single-turn message — still no
	// chat history (A1.6), just different text for the one user turn.
	let currentUserMessage = buildAppRequestMessage(request);

	let topKRetried = false;
	let finalizeFailure: AppGenerationResult | null = null;
	let success: (AppGenerationResult & { ok: true }) | null = null;

	while (!success && !finalizeFailure) {
		attempts += 1;
		let outcome: AttemptOutcome;
		try {
			outcome = await runOneAttempt({
				provider,
				modelId,
				userMessage: currentUserMessage,
				maxOutputTokens,
				abortSignal: request.abortSignal,
			});
		} catch (caught) {
			// The endpoint 400ing on an unrecognised top_k body field is a
			// transport-compatibility hiccup, not a content-quality failure: it
			// does not consume an APP_MAX_ATTEMPTS slot. Nothing about this
			// call ever added a sampling parameter of its own (AGENTS.md — the
			// qwen family's defaultSampling is applied below this module,
			// unconditionally), so "the retry omits the sampling options" is
			// true by construction at this layer; retrying is simply asking
			// the same question again.
			if (!topKRetried && isTopKRejection(caught)) {
				topKRetried = true;
				attempts -= 1;
				warnings.push(
					"retried once after the endpoint rejected top_k; this call adds no sampling options of its own",
				);
				continue;
			}
			finalizeFailure = {
				ok: false,
				reason: "provider_error",
				detail: describeError(caught),
				usage,
				attempts,
			};
			break;
		}

		usage = sumUsage(usage, outcome.usage);
		const finishedWithToolCall =
			outcome.sawUndeclaredToolCall || outcome.finishReason === "tool-calls";

		if (finishedWithToolCall) {
			warnings.push(
				`attempt ${attempts}: the model attempted a tool call instead of answering`,
			);
			if (attempts < APP_MAX_ATTEMPTS) continue;
			finalizeFailure = {
				ok: false,
				reason: "tool_call",
				detail: "the model tried to look around instead of writing the app",
				usage,
				attempts,
			};
			break;
		}

		const extraction = extractAppHtml(outcome.text, outcome.finishReason);

		// Three distinct failure shapes, each with its own user-facing reason
		// (Task A1 Step 1.3 and A1.5 name them explicitly — the "Contracts"
		// section's shorter summary, "only strategy 'empty' becomes
		// empty_content", elides this three-way split and is superseded by the
		// more specific per-case instructions; see the slice report):
		//
		// - a FENCE was found but its content is blank/not a full document
		//   ("an answer with an empty fence") -> empty_content: the app came
		//   out empty inside its own wrapper.
		// - NO fence and nothing recoverable, cut off by the token budget
		//   ("finish_reason=length with partial content") -> too_long.
		// - NO fence and nothing recoverable, for any other reason (a plain
		//   refusal, a short non-answer) -> no_fence: it answered, just not
		//   with a runnable app.
		// - a WHOLE DOCUMENT recovered without the required fence -> no_fence
		//   too (Global Constraints: never accept an unfenced answer, however
		//   complete it looks).
		if (extraction.strategy !== "fence" || !extraction.ok) {
			const reason: AppGenerationFailureReason =
				classifyAppExtractionFailure(extraction);
			warnings.push(
				`attempt ${attempts}: ${extraction.issue ?? "no runnable fence"}`,
			);
			if (attempts < APP_MAX_ATTEMPTS) continue;
			finalizeFailure = {
				ok: false,
				reason,
				detail: extraction.issue ?? "the answer did not contain a runnable app",
				usage,
				attempts,
			};
			break;
		}

		if (extraction.issue)
			warnings.push(`attempt ${attempts}: ${extraction.issue}`);

		const checks = auditAppHtml(extraction.html);

		// Ruling 58: a violation (self-navigation, WebRTC) is not a card-line
		// glitch — it is a sandbox-escape attempt the product must not ship.
		// Retry once with the violation named (still a single fresh user turn,
		// A1.6 — never chat history); a second violation is refused, never
		// silently degraded to a glitch.
		const violations = checks.filter(
			(check) => !check.passed && APP_VIOLATION_RULE_IDS.includes(check.rule),
		);
		if (violations.length > 0) {
			const named = violations.map((v) => `${v.rule} (${v.detail})`).join("; ");
			warnings.push(`attempt ${attempts}: contract violation — ${named}`);
			if (attempts < APP_MAX_ATTEMPTS) {
				currentUserMessage = `${currentUserMessage}\n\nYour previous answer is not allowed inside this app's sandboxed frame: ${named}. Do not do that. Rewrite the app without it — handle the interaction entirely inside the document, with no navigation and no WebRTC.`;
				continue;
			}
			finalizeFailure = {
				ok: false,
				reason: "contract_violation",
				detail: `the app tried to leave its sandbox: ${named}`,
				usage,
				attempts,
			};
			break;
		}

		success = {
			ok: true,
			html: extraction.html,
			title:
				request.title?.trim() ||
				deriveAppTitle(extraction.html, request.prompt),
			extraction: "fence",
			fences: extraction.fenceCount,
			checks,
			usage,
			attempts,
			warnings,
		};
	}

	await recordAppGenerationCost({ request, modelId, provider, usage });

	return success ?? (finalizeFailure as AppGenerationResult);
}

/**
 * Every call is recorded for cost (spec §8.6), success or failure: the model
 * still ran. Mirrors `recordControlModelUsage`'s existing precedent
 * (`analytics.ts`, synthetic `control:<feature>:<uuid>` message ids) so
 * `getConversationCostSummary` shows it as its own model run, never folded
 * into the chat turn's own token counts.
 */
async function recordAppGenerationCost(params: {
	request: AppGenerationRequest;
	modelId: ModelId;
	provider?: NormalChatModelRunProvider;
	usage: NormalChatModelRunUsage | null;
}): Promise<void> {
	if (!params.usage) return;
	const snapshot = mapNormalChatModelRunUsageToProviderSnapshot(params.usage);
	if (!snapshot) return;
	await recordControlModelUsage({
		userId: params.request.userId,
		conversationId: params.request.conversationId,
		feature: "app_generation",
		modelId: params.provider?.id ?? params.modelId,
		modelDisplayName: params.provider?.displayName,
		promptTokens: snapshot.promptTokens,
		completionTokens: snapshot.completionTokens,
		totalTokens: snapshot.totalTokens,
		cachedInputTokens: snapshot.cachedInputTokens,
		cacheHitTokens: snapshot.cacheHitTokens,
		cacheMissTokens: snapshot.cacheMissTokens,
	});
}
