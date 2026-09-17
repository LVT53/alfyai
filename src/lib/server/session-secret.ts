// src/lib/server/session-secret.ts
//
// SESSION_SECRET is not only the session secret. It is the input to the
// PBKDF2 derivation behind BOTH credential vaults:
//
//   - src/lib/server/services/connections/vault.ts  (salt "alfyai-connections")
//   - src/lib/server/services/providers.ts          (salt "alfyai-providers")
//
// So a deployment that silently falls back to the shared, public,
// in-repo development literal encrypts every stored connection secret and
// every provider API key under a key that anyone with a copy of this
// repository can derive. Worse, it does so quietly: the app boots, logs in and
// works, and the damage is only visible to whoever reads the source.
//
// This module is the guard. It is deliberately separate from env.ts so it can
// be imported by the startup hook and by scripts/prepare-db.ts (which has its
// own copy of the fallback and runs as its own process on the `npm start`
// path) without dragging the whole config graph along.

/** Minimum length for a real secret. `openssl rand -hex 32` produces 64. */
export const SESSION_SECRET_MIN_LENGTH = 32;

/**
 * Secrets that ship in this repository, in its docs, or in its test harness.
 * Every one of them is public, so length alone cannot save a deployment that
 * uses one — they are rejected in production whatever their length.
 *
 * `change-me-to-a-random-long-secret` is the .env.example placeholder and is
 * 33 characters, i.e. it would pass a naive length check. That is exactly why
 * this list exists.
 */
export const KNOWN_PLACEHOLDER_SESSION_SECRETS: readonly string[] = [
	"mock-session-secret-for-dev-testing-only",
	"change-me-to-a-random-long-secret",
	"seed-placeholder-session-secret-12345678",
	"e2e-test-session-secret-long-enough-1234567890",
	"test-secret",
];

/** The value env.ts and scripts/prepare-db.ts fall back to outside production. */
export const DEV_FALLBACK_SESSION_SECRET =
	"mock-session-secret-for-dev-testing-only";

export type SessionSecretProblem =
	| "missing"
	| "too-short"
	| "known-placeholder";

/** What is wrong with this secret, or null when nothing is. */
export function inspectSessionSecret(
	value: string | undefined,
): SessionSecretProblem | null {
	// `??` rather than `||` further down would let an empty string through; the
	// original bug was exactly that `process.env.SESSION_SECRET || fallback`
	// treats SESSION_SECRET="" as unset. Trim too, because a secret pasted into
	// a .env with a trailing space is a secret with a trailing space, and an
	// operator who typed only whitespace has not set one.
	const trimmed = value?.trim() ?? "";
	if (trimmed === "") return "missing";
	if (KNOWN_PLACEHOLDER_SESSION_SECRETS.includes(trimmed)) {
		return "known-placeholder";
	}
	if (trimmed.length < SESSION_SECRET_MIN_LENGTH) return "too-short";
	return null;
}

/**
 * Is this process a real production server?
 *
 * NODE_ENV=production is set by deploy/langflow-chat.service. The two test
 * harnesses are excluded explicitly rather than relying on NODE_ENV, because
 * Playwright starts a *built* server and could plausibly be pointed at a
 * production-ish environment; when it does, playwright.config.ts supplies its
 * own long secret anyway, so the check would pass — the exclusion is belt and
 * braces for a harness that forgets to.
 */
export function isProductionRuntime(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (env.NODE_ENV !== "production") return false;
	if (env.PLAYWRIGHT_TEST && env.PLAYWRIGHT_TEST !== "0") return false;
	if (env.VITEST) return false;
	return true;
}

export function describeSessionSecretProblem(
	problem: SessionSecretProblem,
): string {
	switch (problem) {
		case "missing":
			return "SESSION_SECRET is not set (or is empty).";
		case "too-short":
			return `SESSION_SECRET is shorter than ${SESSION_SECRET_MIN_LENGTH} characters.`;
		case "known-placeholder":
			return "SESSION_SECRET is one of the placeholder values that ship in this repository, so it is public.";
	}
}

function buildFatalMessage(problem: SessionSecretProblem): string {
	return [
		`FATAL: refusing to start. ${describeSessionSecretProblem(problem)}`,
		"",
		"SESSION_SECRET also derives the encryption keys for stored connection",
		"secrets and provider API keys. Starting without a real one would encrypt",
		"every credential in this deployment under a key that is public.",
		"",
		"Set it in the environment (shared/.env on a release-layout deploy):",
		"",
		"    SESSION_SECRET=$(openssl rand -hex 32)",
		"",
		"Then restart the service. Note that CHANGING an existing secret makes",
		"already-stored connection secrets and provider API keys undecryptable —",
		"they have to be re-entered.",
	].join("\n");
}

// One warning per process, not one per call: assertSessionSecret is called from
// the startup hook and from readConfig(), and a repeated wall of text trains
// people to scroll past it.
let warnedInDevelopment = false;

/** Test-only: lets a case observe the once-per-process warning again. */
export function _resetSessionSecretWarningForTests(): void {
	warnedInDevelopment = false;
}

/**
 * Throws in production when SESSION_SECRET is missing, empty, too short, or a
 * known public placeholder. Outside production it warns once and returns, so
 * `npm run dev`, vitest and Playwright keep working with the fallback.
 *
 * Deliberately NOT called at module scope anywhere: `npm run build` bundles
 * this file, and a module-scope throw would turn a missing secret on a build
 * host into a failed build. The call sites are the server startup hook and
 * scripts/prepare-db.ts, both of which are real runtime.
 */
export function assertSessionSecret(
	env: NodeJS.ProcessEnv = process.env,
): void {
	const problem = inspectSessionSecret(env.SESSION_SECRET);
	if (!problem) return;

	if (isProductionRuntime(env)) {
		throw new Error(buildFatalMessage(problem));
	}

	if (warnedInDevelopment) return;
	warnedInDevelopment = true;
	console.warn(
		[
			"",
			"  ⚠  INSECURE SESSION_SECRET  ⚠",
			`  ${describeSessionSecretProblem(problem)}`,
			"  Falling back to the public development secret. This is fine for local",
			"  development and tests; a server started with NODE_ENV=production and",
			"  this configuration will refuse to boot.",
			"  Generate a real one with:  openssl rand -hex 32",
			"",
		].join("\n"),
	);
}

/**
 * The secret to actually use, after {@link assertSessionSecret} has decided
 * whether this process is allowed to run at all. In production this is always
 * the operator's value, because anything else has already thrown.
 *
 * Deliberately returns the RAW value, not a trimmed one, even though the
 * validation above trims before judging. Trimming here would change the
 * PBKDF2 input on any box whose secret happens to carry whitespace, and the
 * result of that is not a startup error — it is every stored connection secret
 * and provider API key on that box quietly failing to decrypt. Validation may
 * be stricter than reality; the key derivation may not.
 */
export function resolveSessionSecret(
	env: NodeJS.ProcessEnv = process.env,
): string {
	return env.SESSION_SECRET || DEV_FALLBACK_SESSION_SECRET;
}
