// The ONLY module in this harness that reads an API key (Feature 2 ·
// Artifacts, Slice 5a — decisions.md rulings 25 and 44). Mirrors the
// SECURITY posture of scripts/evaluate-tool-guidance-ab.ts:40-41: the key is
// read here and nowhere else, it is captured in a closure rather than
// exposed on the returned client, and it is never logged. `--replay` mode
// (run.ts) never calls `resolveEvalArtifactsClient` at all, so a replay run
// needs no key and this module is never touched by CI.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	EVAL_ARTIFACTS_SAMPLING,
	type EvalArtifactsThinkingMode,
} from "./config";

const OPENCODE_CONFIG_PATH = join(
	homedir(),
	".config",
	"opencode",
	"opencode.json",
);

interface ResolvedEndpoint {
	baseUrl: string;
	model: string;
	apiKey: string | null;
}

/**
 * `~/.config/opencode/opencode.json`'s shape is opencode's own, not this
 * repo's, so this reads defensively and returns null on anything unexpected
 * — a missing file, invalid JSON, or a `provider` entry with no `baseURL`/
 * `models` — rather than throw. Exported (parsing only, no disk access) so
 * it is unit-testable against a fixture string without touching the real
 * file; `resolveOpencodeEndpoint` below is the disk-reading wrapper.
 */
export function parseOpencodeConfig(raw: string): ResolvedEndpoint | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const providerMap = (parsed as { provider?: unknown }).provider;
	if (!providerMap || typeof providerMap !== "object") return null;

	for (const entry of Object.values(providerMap as Record<string, unknown>)) {
		if (!entry || typeof entry !== "object") continue;
		const options = (entry as { options?: unknown }).options;
		const models = (entry as { models?: unknown }).models;
		const baseUrl =
			options && typeof options === "object"
				? (options as { baseURL?: unknown }).baseURL
				: undefined;
		if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) continue;
		const modelNames =
			models && typeof models === "object" ? Object.keys(models) : [];
		if (modelNames.length === 0) continue;
		const apiKey =
			options && typeof options === "object"
				? (options as { apiKey?: unknown }).apiKey
				: undefined;
		return {
			baseUrl: baseUrl.trim(),
			model: modelNames[0],
			apiKey:
				typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : null,
		};
	}
	return null;
}

function resolveOpencodeEndpoint(configPath: string): ResolvedEndpoint | null {
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch {
		return null;
	}
	return parseOpencodeConfig(raw);
}

export interface EvalArtifactsSendParams {
	prompt: string;
	thinking: EvalArtifactsThinkingMode;
	signal?: AbortSignal;
}

export interface EvalArtifactsSendResult {
	text: string;
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
	/**
	 * Override for `~/.config/opencode/opencode.json`'s path — tests point
	 * this at a fixture/temp file (or a path that does not exist) so the
	 * fallback is exercised deterministically, without depending on whether
	 * the machine running the suite happens to have opencode installed.
	 * Production callers never set this.
	 */
	opencodeConfigPath?: string;
}

/**
 * Resolves an endpoint from explicit config first (`EVAL_ARTIFACTS_BASE_URL`
 * / `_MODEL` / `_API_KEY`), then `~/.config/opencode/opencode.json`, and
 * returns a client — or null when nothing is configured, which `run.ts`
 * turns into "nothing configured, exiting 0" rather than a crash. Works with
 * NO key: a local OpenAI-compatible server that requires no auth gets no
 * `Authorization` header at all, rather than one carrying an empty token.
 */
export function resolveEvalArtifactsClient(
	params: ResolveEvalArtifactsClientParams,
): EvalArtifactsModelClient | null {
	const fromExplicitConfig: ResolvedEndpoint | null =
		params.baseUrl && params.model
			? { baseUrl: params.baseUrl, model: params.model, apiKey: params.apiKey }
			: null;
	const endpoint =
		fromExplicitConfig ??
		resolveOpencodeEndpoint(params.opencodeConfigPath ?? OPENCODE_CONFIG_PATH);
	if (!endpoint) return null;

	const baseUrl = endpoint.baseUrl.replace(/\/+$/, "");
	// Captured in this closure ONLY. The object returned below has no
	// `apiKey` property of its own — see the SECURITY note above.
	const apiKey = endpoint.apiKey;
	const model = endpoint.model;

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
			};
			return { text: json.choices?.[0]?.message?.content ?? "" };
		},
	};
}
