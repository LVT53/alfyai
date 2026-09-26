// Env switches for the artifact-contract eval harness (Feature 2 · Artifacts,
// Slice 5a — decisions.md ruling 44, modelled on the App prototype's own
// table per slice-5.md §The eval harness). Every switch is
// `EVAL_ARTIFACTS_*` prefixed and has a `--flag` equivalent in `run.ts`'s
// flag table; the env form is what a saved shell profile or CI sets, the
// flag is the quicker way to type it for one run. Pure: takes an env object
// (defaulting to `process.env`) rather than reading it ad hoc, so this is
// unit-testable with a plain object and never needs `process.env` mutated
// in a test.
import process from "node:process";

/** Fixed sampling, identical to the App prototype so results are comparable
 * across runs — never env-configurable. */
export const EVAL_ARTIFACTS_SAMPLING = {
	temperature: 0.6,
	topP: 0.95,
	topK: 20,
	maxTokens: 24_000,
} as const;

/** Strictly sequential, one retry maximum, stop after two consecutive
 * 429/5xx — the App prototype's own discipline (run.ts:13-14, :215-255),
 * applied generically here since this harness ships no real suite yet. */
export const EVAL_ARTIFACTS_MAX_RETRIES_PER_CASE = 1;
export const EVAL_ARTIFACTS_MAX_CONSECUTIVE_RATE_LIMIT_ERRORS = 2;

export type EvalArtifactsThinkingMode = "on" | "off";

export interface EvalArtifactsConfig {
	/** Same vocabulary as `--suite`: `document`, `app`, `canvas`, `slides`,
	 * `verification`, or `all`. */
	suite: string;
	/** Comma-separated fixture ids to run, or null for "every case". */
	only: string[] | null;
	/** Caps the fixture count, or null for "no cap". Never applies to the
	 * known-bad set — see run.ts's runSuite. */
	limit: number | null;
	/** Re-score committed responses; no model client is constructed. */
	replay: boolean;
	/** Call the model, write raw responses, do not score. */
	skipEval: boolean;
	/** App generation is thinking-off by policy (§2.9); a suite ASSERTS this
	 * against its own contract rather than offering a live choice, but the
	 * switch exists so a suite can request either mode explicitly. */
	thinking: EvalArtifactsThinkingMode;
	outDir: string;
	/** Provider override; falls back to `~/.config/opencode/opencode.json`
	 * (client.ts only) when unset. */
	baseUrl: string | null;
	model: string | null;
	apiKey: string | null;
}

function readTrimmed(env: NodeJS.ProcessEnv, name: string): string | null {
	const value = env[name];
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function readBoolEnv(env: NodeJS.ProcessEnv, name: string): boolean {
	const value = readTrimmed(env, name);
	return value === "1" || value?.toLowerCase() === "true";
}

function readListEnv(env: NodeJS.ProcessEnv, name: string): string[] | null {
	const value = readTrimmed(env, name);
	if (!value) return null;
	const entries = value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	return entries.length > 0 ? entries : null;
}

function readPositiveIntEnv(
	env: NodeJS.ProcessEnv,
	name: string,
): number | null {
	const value = readTrimmed(env, name);
	if (!value) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveEvalArtifactsConfig(
	env: NodeJS.ProcessEnv = process.env,
): EvalArtifactsConfig {
	return {
		suite: readTrimmed(env, "EVAL_ARTIFACTS_SUITE") ?? "all",
		only: readListEnv(env, "EVAL_ARTIFACTS_ONLY"),
		limit: readPositiveIntEnv(env, "EVAL_ARTIFACTS_LIMIT"),
		// EVAL_ARTIFACTS_SKIP_MODEL is the prototype's own env-switch spelling
		// (PROTO_APPS_SKIP_MODEL), kept as a recognisable alias of replay
		// rather than a second idea (slice-5.md §The eval harness).
		replay:
			readBoolEnv(env, "EVAL_ARTIFACTS_REPLAY") ||
			readBoolEnv(env, "EVAL_ARTIFACTS_SKIP_MODEL"),
		skipEval: readBoolEnv(env, "EVAL_ARTIFACTS_SKIP_EVAL"),
		thinking:
			readTrimmed(env, "EVAL_ARTIFACTS_THINKING")?.toLowerCase() === "on"
				? "on"
				: "off",
		outDir: readTrimmed(env, "EVAL_ARTIFACTS_OUT") ?? "results",
		baseUrl: readTrimmed(env, "EVAL_ARTIFACTS_BASE_URL"),
		model: readTrimmed(env, "EVAL_ARTIFACTS_MODEL"),
		apiKey: readTrimmed(env, "EVAL_ARTIFACTS_API_KEY"),
	};
}
