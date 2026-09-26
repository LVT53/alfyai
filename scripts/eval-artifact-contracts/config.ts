// Env switches for the artifact-contract eval harness (Feature 2 · Artifacts,
// Slice 5a — decisions.md ruling 44, modelled on the App prototype's own
// table per slice-5.md §The eval harness). Every switch is
// `EVAL_ARTIFACTS_*` prefixed and has a `--flag` equivalent in `run.ts`'s
// flag table; the env form is what a saved shell profile or CI sets, the
// flag is the quicker way to type it for one run. Pure: takes an env object
// (defaulting to `process.env`) rather than reading it ad hoc, so this is
// unit-testable with a plain object and never needs `process.env` mutated
// in a test.
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Fixed sampling, identical to the App prototype so results are comparable
 * across runs — never env-configurable. */
export const EVAL_ARTIFACTS_SAMPLING = {
	temperature: 0.6,
	topP: 0.95,
	topK: 20,
	maxTokens: 24_000,
} as const;

/**
 * Absolute, anchored to this module's own directory — NOT to
 * `process.cwd()`. `run.ts` resolves `outDir` with
 * `resolve(process.cwd(), outDir)`, which honours an absolute path as
 * given (`path.resolve` stops as soon as it hits an absolute segment) and
 * only falls back to joining onto cwd for a relative one. A plain
 * `"results"` default resolved against whatever cwd a run was invoked from
 * — `scripts/eval-artifact-contracts/results/*` is what `.gitignore`
 * actually excludes, so a run from the repo root wrote to
 * `<repo-root>/results/` instead, outside that ignore rule and one `git
 * add` away from being committed by accident. An explicit `--out`/
 * `EVAL_ARTIFACTS_OUT` still works exactly as given (relative resolves
 * against cwd, absolute is used as-is) — only the default changes.
 *
 * Deliberately `dirname(fileURLToPath(import.meta.url))`, NOT
 * `fileURLToPath(new URL(".", import.meta.url))`: the latter is Vite's own
 * documented static asset-URL convention (any literal `new URL(x,
 * import.meta.url)` source pattern), so under vitest — which loads this
 * file through Vite, not plain Node — it gets rewritten into a dev-server
 * URL (`http://localhost:3000/...`) instead of resolving the real `file:`
 * path, and `fileURLToPath` then throws. That rewrite is a source-level
 * match on the call shape itself, so it fires no matter which `URL`
 * binding is in scope. `fileURLToPath(import.meta.url)` alone (no `new
 * URL()` call at all, the same idiom run.ts already uses for its own
 * this-file check) isn't part of that convention and resolves correctly
 * under both plain `tsx` and vitest.
 */
const DEFAULT_OUT_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"results",
);

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
	/** Defaults to `DEFAULT_OUT_DIR` (absolute, under this harness's own
	 * gitignored `results/`) — never a bare `"results"` that would resolve
	 * against whatever cwd a run happens to be invoked from. An explicit
	 * `--out`/`EVAL_ARTIFACTS_OUT` overrides this and is used exactly as
	 * given. */
	outDir: string;
	/** Both required for a live (non-`--replay`) run — `client.ts`'s
	 * `resolveEvalArtifactsClient` throws naming both if either is unset.
	 * Ruling 54 removed the `~/.config/opencode/opencode.json` fallback, so
	 * there is no other source for these two. `apiKey` stays optional even
	 * for a live run: a local server may need no auth. */
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
		outDir: readTrimmed(env, "EVAL_ARTIFACTS_OUT") ?? DEFAULT_OUT_DIR,
		baseUrl: readTrimmed(env, "EVAL_ARTIFACTS_BASE_URL"),
		model: readTrimmed(env, "EVAL_ARTIFACTS_MODEL"),
		apiKey: readTrimmed(env, "EVAL_ARTIFACTS_API_KEY"),
	};
}
