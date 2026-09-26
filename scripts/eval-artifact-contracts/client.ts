// The ONLY module in this harness that reads an API key (Feature 2 ·
// Artifacts, Slice 5a — decisions.md rulings 25 and 44; ruling 54 removed
// this module's `~/.config/opencode/opencode.json` fallback — see below).
// Mirrors the SECURITY posture of scripts/evaluate-tool-guidance-ab.ts:40-41:
// the key is read here and nowhere else, it is captured in a closure rather
// than exposed on the returned client, and it is never logged. `--replay`
// mode (run.ts) never calls `resolveEvalArtifactsClient` at all, so a replay
// run needs no key and this module is never touched by CI.
import {
	EVAL_ARTIFACTS_SAMPLING,
	type EvalArtifactsThinkingMode,
} from "./config";

const MISSING_ENDPOINT_MESSAGE =
	"EVAL_ARTIFACTS_BASE_URL and EVAL_ARTIFACTS_MODEL are both required for a " +
	"live (non-replay) run — see the tunnel recipe in " +
	"scripts/eval-artifact-contracts/README.md. Pass --replay to re-score " +
	"committed responses instead; that needs neither.";

export interface EvalArtifactsSendParams {
	prompt: string;
	thinking: EvalArtifactsThinkingMode;
	signal?: AbortSignal;
}

/** The provider's own `usage` block, when the endpoint sends one — an
 * OpenAI-compatible completion always should, but this is read defensively
 * (undefined fields, not thrown) since the harness must still score an
 * attempt whose usage could not be read. */
export interface EvalArtifactsUsage {
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
}

export interface EvalArtifactsSendResult {
	text: string;
	/** Absent when the endpoint's response carried no `usage` block at all —
	 * never a guess. P1's own per-app token comparison (2,486–3,607 completion
	 * tokens) needs this recorded per case, which nothing before this read. */
	usage?: EvalArtifactsUsage;
}

/** Never exposes the resolved key — only what a scorer or a results file may
 * legitimately need to say about where an attempt came from. */
export interface EvalArtifactsModelClient {
	baseUrl: string;
	model: string;
	send(params: EvalArtifactsSendParams): Promise<EvalArtifactsSendResult>;
}

export interface ResolveEvalArtifactsClientParams {
	baseUrl: string | null;
	model: string | null;
	apiKey: string | null;
}

/**
 * Resolves an endpoint from explicit config only (`EVAL_ARTIFACTS_BASE_URL`
 * + `_MODEL`; `_API_KEY` stays optional). Ruling 54 removed the previous
 * `~/.config/opencode/opencode.json` fallback: it let a live run silently
 * talk to whatever provider that file names, under the owner's own key, and
 * one slice's "live" eval ended up measuring that provider instead of the
 * production model. A live (non-`--replay`) run now REQUIRES both env vars —
 * this throws one message naming both, and makes no network call, rather
 * than returning null when either is missing, so a misconfigured live run
 * fails loudly at startup instead of silently reaching an unintended
 * endpoint or no-opping. `run.ts` never calls this for `--replay`, which
 * needs neither var nor a key. Works with NO key: a local OpenAI-compatible
 * server that requires no auth gets no `Authorization` header at all, rather
 * than one carrying an empty token.
 */
export function resolveEvalArtifactsClient(
	params: ResolveEvalArtifactsClientParams,
): EvalArtifactsModelClient {
	if (!params.baseUrl || !params.model) {
		throw new Error(MISSING_ENDPOINT_MESSAGE);
	}

	const baseUrl = params.baseUrl.replace(/\/+$/, "");
	// Captured in this closure ONLY. The object returned below has no
	// `apiKey` property of its own — see the SECURITY note above.
	const apiKey = params.apiKey;
	const model = params.model;

	return {
		baseUrl,
		model,
		async send({ prompt, thinking, signal }) {
			const body: Record<string, unknown> = {
				model,
				messages: [{ role: "user", content: prompt }],
				temperature: EVAL_ARTIFACTS_SAMPLING.temperature,
				top_p: EVAL_ARTIFACTS_SAMPLING.topP,
				top_k: EVAL_ARTIFACTS_SAMPLING.topK,
				max_tokens: EVAL_ARTIFACTS_SAMPLING.maxTokens,
			};
			// Qwen defaults to thinking ON; a suite that needs it off sends this
			// the same way the app does for the identical reason — see
			// normal-chat-model/provider-compatibility.ts's
			// buildThinkingProviderOptions (the "qwen" case, ~:374-377).
			if (thinking === "off") {
				body.chat_template_kwargs = { enable_thinking: false };
			}

			const response = await fetch(`${baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
				},
				body: JSON.stringify(body),
				signal,
			});
			if (!response.ok) {
				const error = new Error(
					`Model endpoint returned ${response.status}`,
				) as Error & { status?: number };
				error.status = response.status;
				throw error;
			}
			const json = (await response.json()) as {
				choices?: Array<{ message?: { content?: string } }>;
				usage?: {
					prompt_tokens?: number;
					completion_tokens?: number;
					total_tokens?: number;
				};
			};
			const rawUsage = json.usage;
			const usage: EvalArtifactsUsage | undefined = rawUsage
				? {
						promptTokens: rawUsage.prompt_tokens,
						completionTokens: rawUsage.completion_tokens,
						totalTokens: rawUsage.total_tokens,
					}
				: undefined;
			return { text: json.choices?.[0]?.message?.content ?? "", usage };
		},
	};
}
