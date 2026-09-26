// Fact verification before the App is shown (spec §2.10). The App contract
// forbids the generator from saying anything about its own content (§2.11:
// "the answer is the app and nothing else"), so a wrong fact — a cumulative
// table labelled per-year, a plural gloss among singulars, a quiz key naming
// the wrong city — reaches this module looking exactly like a working app.
// Three of ten P1 prototype apps shipped one of these; the automated
// contract audit could not see any of them, because none is a contract
// violation. This is new work: two calls, both thinking off, never the
// generator's own tools.
import { randomUUID } from "node:crypto";
import { getConfig } from "$lib/server/config-store";
import { recordControlModelUsage } from "$lib/server/services/analytics";
import {
	type JsonControlResponseSchema,
	sendJsonControlMessage,
} from "$lib/server/services/normal-chat-control-model";
import {
	buildNormalChatModelRunProviderOptions,
	type NormalChatModelRunProvider,
	resolveNormalChatModelRunProvider,
	runPlainNormalChatModelRun,
} from "$lib/server/services/normal-chat-model";
import { createNormalChatTools } from "$lib/server/services/normal-chat-tools";
// Thinking pinned off for BOTH calls this module makes (spec §2.9's rule is
// not just the generator's): the classifier goes through
// sendJsonControlMessage's own `thinkingMode: "off"` option; the verifier
// goes through the same provider-compatibility adapter the generator uses,
// via this function.

/** One shape for both call kinds, so the cost display does not learn two vocabularies. */
export interface AppModelCallUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cachedInputTokens?: number;
}

/** The three measured prototype bug classes, plus everything the verifier is sure about but cannot name. */
export type AppVerificationFindingClass =
	| "wrong_key"
	| "mislabelled_aggregate"
	| "wrong_unit"
	| "other";

export interface AppVerificationFinding {
	/** The claim as it appears in the app, quoted and shortened. Goes into Alfy's note, so: no HTML, no markup. */
	claim: string;
	/** One sentence, in the request's language, saying what is wrong. */
	problem: string;
	class: AppVerificationFindingClass;
	/** Where it is: a table column label, a question id, a heading. Null when the claim has no single home. */
	location: string | null;
	/** false when the verifier could not settle it — the honest half of "uncertain". */
	settled: boolean;
}

export type AppVerificationVerdict =
	| "clean" // checkable, checked, nothing wrong
	| "repaired" // checkable, something was wrong, the repair is in repairedHtml and re-verified
	| "uncertain" // checkable, something may be wrong, and no repair was safe to make
	| "unavailable"; // the check could not run to the standard it claims (no web search; a call failed)

export interface AppVerification {
	/** false when the classifier said there is nothing checkable (a timer, a colour picker). */
	checked: boolean;
	verdict: AppVerificationVerdict;
	findings: AppVerificationFinding[];
	/** The app with the repairs applied, when the verdict is "repaired", and the claim list is unchanged. */
	repairedHtml: string | null;
	/** Non-null whenever any model call happened: classifier, verifier and any re-verification pass, summed. */
	usage: AppModelCallUsage | null;
	/** The user-facing reason for "uncertain"/"unavailable", in the request's language; null otherwise. */
	reason: string | null;
}

export interface VerifyAppParams {
	userId: string;
	conversationId: string | null;
	html: string;
	prompt: string;
	language: "en" | "hu";
	abortSignal?: AbortSignal;
}

/**
 * Ruling 52: a proposed repair is re-verified — without `research_web` — before
 * it is accepted, and that pass has its OWN deadline so the whole verification
 * pass still finishes inside `create_artifact`'s 120s envelope (ruling 40)
 * alongside ~23s generation, ~5s classification and `research_web`'s own 60s
 * ceiling (slice-2.md Task A7's arithmetic: 23 + 5 + 60 + ~25 ≈ 113s, rounded
 * up). A deadline hit is reported as "uncertain" with the original HTML — the
 * repair is never accepted on trust, and `verifyApp` never throws for it, so
 * the App is still created (decisions.md ruling 52).
 */
export const APP_REVERIFICATION_TIMEOUT_MS = 25_000;

const CLASSIFIER_KINDS = [
	"table",
	"answer_key",
	"computed_numbers",
	"dates",
	"unit_conversion",
	"named_facts",
] as const;

const CLASSIFIER_SCHEMA: JsonControlResponseSchema = {
	name: "app_verification_classifier",
	strict: true,
	schema: {
		type: "object",
		properties: {
			checkable: { type: "boolean" },
			kinds: {
				type: "array",
				items: { type: "string", enum: [...CLASSIFIER_KINDS] },
			},
		},
		required: ["checkable", "kinds"],
		additionalProperties: false,
	},
};

const CLASSIFIER_PROMPT = `You decide whether a generated web app's OWN content contains any claim that could be checked for correctness — a table of numbers, an answer key, a computed total, a date, a unit conversion, or a real-world named fact (a place, a distance, a historical fact).

A timer, a stopwatch, a colour picker, a drawing canvas, or a game with no factual content is NOT checkable.

Read the app's HTML (given as the user message) and answer strictly as JSON: {"checkable": boolean, "kinds": string[]}. "kinds" is a subset of ["table","answer_key","computed_numbers","dates","unit_conversion","named_facts"] and MUST be empty when "checkable" is false.`;

/** Exported so the eval harness's `verification` suite (A9) sends the model
 * the exact same instructions the product's own verifier does. */
export function buildVerifierPrompt(
	hasResearchWeb: boolean,
	language: "en" | "hu",
): string {
	const languageLine =
		language === "hu"
			? "Write every claim, problem and location in Hungarian, matching the app's own language."
			: "Write every claim, problem and location in English, matching the app's own language.";
	const webLine = hasResearchWeb
		? "You have a research_web tool for real-world facts (places, distances, historical facts). Use it rather than answering from memory when a claim names one."
		: "You have no web research tool available. Never settle a real-world named fact from memory alone — mark it unsettled instead.";

	return `You check a generated web app's own factual, numeric and labelling claims — nothing else about the app.

Recompute every number from the app's own inputs: a total that is not the sum of its parts, a percentage that is not the ratio, a running total presented as a per-period figure, are all bugs. Check that every label agrees with what it labels (singular/plural, the right unit, the right column). Check that any answer key or "correct" marker actually names the correct option for the question as written. ${webLine}

${languageLine}

Answer with EXACTLY one fenced code block, tagged json, and nothing outside it:
\`\`\`json
{
  "claims": ["..."],
  "findings": [
    { "claim": "...", "problem": "...", "class": "wrong_key" | "mislabelled_aggregate" | "wrong_unit" | "other", "location": "..." | null, "settled": true | false }
  ],
  "repairedHtml": "..." | null,
  "repairSafe": true | false
}
\`\`\`

"claims" lists every distinct checkable claim you examined, named by its SUBJECT rather than its specific value (e.g. "the grand total amount", not "Total: 900") — a caller compares this list across a repair and its re-verification, so name a claim the same way whether or not it turns out to be correct. "findings" is [] when nothing is wrong. "repairedHtml" is the WHOLE corrected document, only when you are sure of a fix, else null. "repairSafe" must be true ONLY when the repair corrects or relabels an EXISTING claim — if the repair would require the reader to accept any fact, number or label that the original app did not already assert, set repairSafe to false and describe it as a finding instead. Never invent a new claim while "repairing" one.`;
}

/**
 * Ruling 52's second pass: re-checks a PROPOSED repair, without `research_web`
 * (its own 60s ceiling would not fit inside this pass's 25s budget). Named
 * facts the first pass already settled — with web research where one needed
 * it — are matched by claim TEXT rather than re-derived from memory.
 */
function buildReVerificationPrompt(
	previousClaims: string[],
	language: "en" | "hu",
): string {
	const languageLine =
		language === "hu"
			? "Write every claim, problem and location in Hungarian, matching the app's own language."
			: "Write every claim, problem and location in English, matching the app's own language.";
	const settledLine =
		previousClaims.length > 0
			? ` An earlier pass already examined this app — with web research where a claim needed it — and listed these claim subjects: ${previousClaims.map((claim) => `"${claim}"`).join(", ")}. If the same subject still appears here, treat it as already settled rather than unsettled merely because you have no web tool now.`
			: "";

	return `You are re-checking a REPAIRED version of a generated web app, after an earlier pass found a problem and proposed a fix. Confirm the repair leaves nothing wrong and introduces no claim beyond what the earlier pass already examined.

Recompute every number from the app's own inputs: a total that is not the sum of its parts, a percentage that is not the ratio, a running total presented as a per-period figure, are all bugs. Check that every label agrees with what it labels (singular/plural, the right unit, the right column). Check that any answer key or "correct" marker actually names the correct option for the question as written. You have no web research tool in this pass — never settle a NEW real-world named fact from memory alone; mark it unsettled instead.${settledLine}

${languageLine}

Answer with EXACTLY one fenced code block, tagged json, and nothing outside it:
\`\`\`json
{
  "claims": ["..."],
  "findings": [
    { "claim": "...", "problem": "...", "class": "wrong_key" | "mislabelled_aggregate" | "wrong_unit" | "other", "location": "..." | null, "settled": true | false }
  ],
  "repairedHtml": null,
  "repairSafe": false
}
\`\`\`

"claims" lists every distinct checkable claim you examined here, named by its SUBJECT rather than its specific value, exactly as the earlier pass would name it when it is the same claim. "findings" is [] when nothing is wrong. This pass never proposes a further repair: always answer "repairedHtml" as null and "repairSafe" as false.`;
}

const FENCE_RE = /```[ \t]*(?:json|JSON)[ \t]*\r?\n([\s\S]*?)```/;

export interface VerifierAnswer {
	/** Every distinct claim examined, named by subject (ruling 52) — see `claimListGainedAClaim`. */
	claims: string[];
	findings: AppVerificationFinding[];
	repairedHtml: string | null;
	repairSafe: boolean;
}

/** Exported so the eval harness's `verification` suite (A9) scores the model's
 * raw answer with the exact same parser the product's verifier uses. */
export function parseVerifierAnswer(text: string): VerifierAnswer | null {
	const match = FENCE_RE.exec(text);
	const jsonText = match?.[1] ?? text;
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as Record<string, unknown>;
	const rawFindings = Array.isArray(record.findings) ? record.findings : null;
	if (!rawFindings) return null;

	const findings: AppVerificationFinding[] = [];
	for (const entry of rawFindings) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as Record<string, unknown>;
		const cls =
			candidate.class === "wrong_key" ||
			candidate.class === "mislabelled_aggregate" ||
			candidate.class === "wrong_unit"
				? candidate.class
				: "other";
		if (
			typeof candidate.claim !== "string" ||
			typeof candidate.problem !== "string"
		) {
			continue;
		}
		findings.push({
			claim: candidate.claim,
			problem: candidate.problem,
			class: cls,
			location:
				typeof candidate.location === "string" ? candidate.location : null,
			settled: candidate.settled !== false,
		});
	}

	const claims = Array.isArray(record.claims)
		? record.claims.filter(
				(claim): claim is string => typeof claim === "string",
			)
		: [];

	return {
		claims,
		findings,
		repairedHtml:
			typeof record.repairedHtml === "string" &&
			record.repairedHtml.trim().length > 0
				? record.repairedHtml
				: null,
		repairSafe: record.repairSafe === true,
	};
}

/**
 * True when `after` names a claim (by normalized subject text) that `before`
 * never listed — ruling 52's "the claim list did not gain a claim". The
 * prompt asks for a claim's SUBJECT rather than its value, so correcting a
 * value (a rewrite) keeps the same listed subject and is allowed; asserting
 * something new (an add) introduces a subject that was never listed and is
 * not.
 */
function claimListGainedAClaim(before: string[], after: string[]): boolean {
	const normalize = (claim: string) =>
		claim.trim().toLowerCase().replace(/\s+/g, " ");
	const known = new Set(before.map(normalize));
	return after.some((claim) => !known.has(normalize(claim)));
}

function sumUsage(
	a: AppModelCallUsage | null,
	b: AppModelCallUsage | null,
): AppModelCallUsage | null {
	if (!a) return b;
	if (!b) return a;
	return {
		promptTokens: a.promptTokens + b.promptTokens,
		completionTokens: a.completionTokens + b.completionTokens,
		totalTokens: a.totalTokens + b.totalTokens,
		cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
	};
}

async function recordVerificationCost(params: {
	userId: string;
	conversationId: string | null;
	call: "classifier" | "verifier" | "reverify";
	modelId: string;
	modelDisplayName?: string | null;
	usage: AppModelCallUsage | null;
}): Promise<void> {
	if (!params.usage) return;
	await recordControlModelUsage({
		userId: params.userId,
		conversationId: params.conversationId,
		feature: `app_verification_${params.call}`,
		modelId: params.modelId,
		modelDisplayName: params.modelDisplayName,
		promptTokens: params.usage.promptTokens,
		completionTokens: params.usage.completionTokens,
		totalTokens: params.usage.totalTokens,
		cachedInputTokens: params.usage.cachedInputTokens,
	});
}

function unavailable(
	reason: string,
	usage: AppModelCallUsage | null,
): AppVerification {
	return {
		checked: true,
		verdict: "unavailable",
		findings: [],
		repairedHtml: null,
		usage,
		reason,
	};
}

type ReVerifyResult =
	| {
			ok: true;
			findings: AppVerificationFinding[];
			claims: string[];
			usage: AppModelCallUsage | null;
	  }
	| { ok: false; reason: string; usage: AppModelCallUsage | null };

/**
 * Ruling 52: re-verifies a PROPOSED repair before it is accepted. Never
 * `research_web` (its own 60s ceiling would not fit here) and never a second
 * repair — this pass only confirms or rejects the first one, inside its own
 * bounded deadline (`APP_REVERIFICATION_TIMEOUT_MS`) so the whole verification
 * pass stays inside `create_artifact`'s 120s envelope. Times out or errors →
 * `{ ok: false }`, never a throw: a repair that cannot be confirmed becomes
 * "uncertain", not a failed create.
 */
async function reVerifyRepair(params: {
	userId: string;
	conversationId: string | null;
	provider: NormalChatModelRunProvider;
	repairedHtml: string;
	prompt: string;
	language: "en" | "hu";
	previousClaims: string[];
	abortSignal?: AbortSignal;
}): Promise<ReVerifyResult> {
	const controller = new AbortController();
	let timedOut = false;
	// Races the call itself (below) rather than trusting the downstream model
	// run to unwind promptly once `controller` aborts: that keeps this pass's
	// deadline real even if a provider call is slow to notice an abort.
	let rejectOnTimeout: (error: Error) => void = () => undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		rejectOnTimeout = reject;
	});
	const timer = setTimeout(() => {
		timedOut = true;
		const timeoutError = new Error("app re-verification timed out");
		controller.abort(timeoutError);
		rejectOnTimeout(timeoutError);
	}, APP_REVERIFICATION_TIMEOUT_MS);
	// Node's timer keeps the process alive; this pass must never be the reason
	// a short-lived script or test process hangs waiting for it.
	(timer as unknown as { unref?: () => void }).unref?.();

	const onCallerAbort = () => controller.abort(params.abortSignal?.reason);
	if (params.abortSignal) {
		if (params.abortSignal.aborted) {
			controller.abort(params.abortSignal.reason);
		} else {
			params.abortSignal.addEventListener("abort", onCallerAbort, {
				once: true,
			});
		}
	}

	try {
		const result = await Promise.race([
			runPlainNormalChatModelRun({
				provider: params.provider,
				modelId: "model1",
				system: buildReVerificationPrompt(
					params.previousClaims,
					params.language,
				),
				// Same rule as the first pass (A3.9): the request and the repaired
				// HTML only, nothing else from the session.
				messages: [
					{
						role: "user",
						content: `The request that produced this app:\n${params.prompt}\n\nThe repaired app's HTML:\n${params.repairedHtml}`,
					},
				],
				resolveProviderOptions: (attemptProvider) =>
					buildNormalChatModelRunProviderOptions(attemptProvider, "off"),
				maxToolSteps: 1,
				abortSignal: controller.signal,
			}),
			timeout,
		]);

		const usage = toModelCallUsage(result.usage);
		await recordVerificationCost({
			userId: params.userId,
			conversationId: params.conversationId,
			call: "reverify",
			modelId: result.model.modelId,
			modelDisplayName: result.model.displayName,
			usage,
		});

		const answer = parseVerifierAnswer(result.text);
		if (!answer) {
			return {
				ok: false,
				reason: "the re-verification answer could not be read",
				usage,
			};
		}
		return {
			ok: true,
			findings: answer.findings,
			claims: answer.claims,
			usage,
		};
	} catch (caught) {
		if (timedOut) {
			return {
				ok: false,
				reason: "the repair could not be re-verified in time",
				usage: null,
			};
		}
		return { ok: false, reason: describeError(caught), usage: null };
	} finally {
		clearTimeout(timer);
		if (params.abortSignal) {
			params.abortSignal.removeEventListener("abort", onCallerAbort);
		}
	}
}

/**
 * Runs the App contract's fact-verification pass. Two calls, both thinking
 * off: a classifier (`model2`, structured JSON, no tools — the app contract
 * forbids the generator from describing its own content, so this is a
 * SEPARATE call) decides whether anything is checkable at all, and only when
 * it says yes does the verifier run — a timer must not cost a call.
 */
export async function verifyApp(
	params: VerifyAppParams,
): Promise<AppVerification> {
	let classifierResult: Awaited<ReturnType<typeof sendJsonControlMessage>>;
	try {
		classifierResult = await sendJsonControlMessage(params.html, "model2", {
			systemPrompt: CLASSIFIER_PROMPT,
			thinkingMode: "off",
			temperature: 0,
			maxTokens: 200,
			jsonSchema: CLASSIFIER_SCHEMA,
			signal: params.abortSignal,
		});
	} catch (caught) {
		return unavailable(describeError(caught), null);
	}

	const classifierUsage = toModelCallUsage(classifierResult.usage);
	await recordVerificationCost({
		userId: params.userId,
		conversationId: params.conversationId,
		call: "classifier",
		modelId: classifierResult.modelId,
		modelDisplayName: classifierResult.modelDisplayName,
		usage: classifierUsage,
	});

	let classifierAnswer: { checkable: boolean; kinds: string[] } | null = null;
	try {
		classifierAnswer = JSON.parse(classifierResult.text);
	} catch {
		classifierAnswer = null;
	}
	if (!classifierAnswer || typeof classifierAnswer.checkable !== "boolean") {
		return unavailable(
			"the classifier's answer could not be read",
			classifierUsage,
		);
	}

	if (!classifierAnswer.checkable) {
		return {
			checked: false,
			verdict: "clean",
			findings: [],
			repairedHtml: null,
			usage: classifierUsage,
			reason: null,
		};
	}

	// The verifier runs only now — the classifier said there is something
	// worth checking, so this call is not spent on a colour picker.
	let provider: NormalChatModelRunProvider;
	try {
		provider = await resolveNormalChatModelRunProvider("model1", getConfig());
	} catch (caught) {
		return unavailable(describeError(caught), classifierUsage);
	}

	const parallelConfigured = Boolean(getConfig().parallelApiKey?.trim());
	const researchWebTool = parallelConfigured
		? createNormalChatTools({
				userId: params.userId,
				conversationId: params.conversationId ?? `app-verify:${randomUUID()}`,
				turnId: randomUUID(),
				language: params.language,
			}).tools.research_web
		: undefined;
	// research_web is the ONE place a tool is allowed in this slice, and it is
	// a verifier tool, never the generator's (spec §2.11 forbids the generator
	// itself from reaching for anything). Registered only when Parallel is
	// configured — `createNormalChatTools` mirrors the exact same
	// `parallelConfigured` gate the chat turn's own tool catalogue uses, so
	// this verifier is never MORE optimistic about availability than the rest
	// of Normal Chat.
	const tools = researchWebTool ? { research_web: researchWebTool } : undefined;

	let verifierResult: Awaited<ReturnType<typeof runPlainNormalChatModelRun>>;
	try {
		verifierResult = await runPlainNormalChatModelRun({
			provider,
			modelId: "model1",
			system: buildVerifierPrompt(
				Boolean(tools?.research_web),
				params.language,
			),
			// The prompt carries the request and the HTML only (A3.9) — no chat
			// history, no other artifact.
			messages: [
				{
					role: "user",
					content: `The request that produced this app:\n${params.prompt}\n\nThe app's HTML:\n${params.html}`,
				},
			],
			resolveProviderOptions: (attemptProvider) =>
				buildNormalChatModelRunProviderOptions(attemptProvider, "off"),
			tools,
			maxToolSteps: tools ? 4 : 1,
			abortSignal: params.abortSignal,
		});
	} catch (caught) {
		return unavailable(describeError(caught), classifierUsage);
	}

	const verifierUsage = toModelCallUsage(verifierResult.usage);
	const totalUsage = sumUsage(classifierUsage, verifierUsage);
	await recordVerificationCost({
		userId: params.userId,
		conversationId: params.conversationId,
		call: "verifier",
		modelId: verifierResult.model.modelId,
		modelDisplayName: verifierResult.model.displayName,
		usage: verifierUsage,
	});

	const answer = parseVerifierAnswer(verifierResult.text);
	if (!answer) {
		return unavailable("the verifier's answer could not be read", totalUsage);
	}

	if (answer.findings.length === 0) {
		return {
			checked: true,
			verdict: "clean",
			findings: [],
			repairedHtml: null,
			usage: totalUsage,
			reason: null,
		};
	}

	const allUnsettled = answer.findings.every((finding) => !finding.settled);
	if (allUnsettled && !answer.repairedHtml) {
		return {
			checked: true,
			verdict: parallelConfigured ? "uncertain" : "unavailable",
			findings: answer.findings,
			repairedHtml: null,
			usage: totalUsage,
			reason: parallelConfigured
				? null
				: "settling this app's real-world claims needs web research, which is not configured",
		};
	}

	if (answer.repairedHtml) {
		// The model's own "safe" attestation is an extra guard, never the only
		// one (ruling 52) — but it can still veto a repair up front and save a
		// re-verification call the model itself does not trust.
		if (!answer.repairSafe) {
			return {
				checked: true,
				verdict: "uncertain",
				findings: answer.findings,
				repairedHtml: null,
				usage: totalUsage,
				reason: null,
			};
		}

		const reverify = await reVerifyRepair({
			userId: params.userId,
			conversationId: params.conversationId,
			provider,
			repairedHtml: answer.repairedHtml,
			prompt: params.prompt,
			language: params.language,
			previousClaims: answer.claims,
			abortSignal: params.abortSignal,
		});
		const usageWithReverify = sumUsage(totalUsage, reverify.usage);

		if (!reverify.ok) {
			// A deadline hit or a failed call: never accepted on trust, and
			// never a thrown error — the original finding stays so Alfy's note
			// has something to quote, and the create still succeeds.
			return {
				checked: true,
				verdict: "uncertain",
				findings: answer.findings,
				repairedHtml: null,
				usage: usageWithReverify,
				reason: reverify.reason,
			};
		}

		const gainedClaim = claimListGainedAClaim(answer.claims, reverify.claims);
		if (reverify.findings.length > 0 || gainedClaim) {
			return {
				checked: true,
				verdict: "uncertain",
				findings: answer.findings,
				repairedHtml: null,
				usage: usageWithReverify,
				reason: null,
			};
		}

		return {
			checked: true,
			verdict: "repaired",
			findings: answer.findings,
			repairedHtml: answer.repairedHtml,
			usage: usageWithReverify,
			reason: null,
		};
	}

	return {
		checked: true,
		verdict: "uncertain",
		findings: answer.findings,
		repairedHtml: null,
		usage: totalUsage,
		reason: null,
	};
}

function describeError(caught: unknown): string {
	return caught instanceof Error ? caught.message : String(caught);
}

function toModelCallUsage(
	usage:
		| {
				promptTokens?: number;
				completionTokens?: number;
				totalTokens?: number;
				cachedInputTokens?: number;
		  }
		| undefined,
): AppModelCallUsage | null {
	if (!usage) return null;
	const promptTokens = usage.promptTokens ?? 0;
	const completionTokens = usage.completionTokens ?? 0;
	return {
		promptTokens,
		completionTokens,
		totalTokens: usage.totalTokens ?? promptTokens + completionTokens,
		cachedInputTokens: usage.cachedInputTokens,
	};
}
