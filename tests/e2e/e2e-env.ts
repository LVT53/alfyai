// What the e2e run is made of, decided in one place: how many workers, which
// port and which database file each one has, and whether the servers run the
// production build or `vite dev`.
//
// The Playwright config, the global setup, the gate script and the specs all ask
// this module, so they cannot disagree. It is pure (environment in, values out)
// and imports nothing heavy: the config is evaluated again in every worker
// process, and a spec's `import { db }` runs after it.
//
// THE SLOT. Each worker has a stable slot, Playwright's `TEST_PARALLEL_INDEX`
// (0..workers-1; a worker that is replaced after a failed test takes the same
// slot, and `TEST_WORKER_INDEX` would not). A slot owns:
//   - a server on `E2E_PORT + slot`,
//   - a SQLite file (slot 0: `E2E_DATABASE_PATH`, default
//     `data/playwright-e2e-chat.db`; slot N: the same name with `-wN` before the
//     extension), seeded with its own admin,
//   so two files never see each other's rows, sessions, providers or settings.
// On-disk state under `data/` (chat files, knowledge uploads, avatars) is keyed
// by conversation, user and campaign ids, which are random per database, so the
// slots share the directory without sharing a path.
import { join } from "node:path";

export const E2E_HOST = "127.0.0.1";

/** Long enough for the session-secret check, and public: it only ever signs e2e cookies. */
export const E2E_SESSION_SECRET_FALLBACK =
	"e2e-test-session-secret-long-enough-1234567890";

/**
 * Workers when `E2E_WORKERS` is not set, for the production build: measured on a
 * 14-core Mac with vitest and the build running beside it (see the FG report).
 * `vite dev` compiles every page on demand in every server, so it defaults to one.
 */
export const DEFAULT_BUILD_WORKERS = 6;

export type E2eServerMode = "build" | "dev";

type Env = Record<string, string | undefined>;

export function e2eServerMode(env: Env = process.env): E2eServerMode {
	const raw = (env.E2E_SERVER ?? "build").trim().toLowerCase();
	if (raw === "build" || raw === "dev") return raw;
	throw new Error(
		`E2E_SERVER must be "build" (the production build, the default) or "dev" (vite dev), not "${env.E2E_SERVER}"`,
	);
}

export function e2eBasePort(env: Env = process.env): number {
	return Number(env.E2E_PORT || 5175);
}

/** `E2E_WORKERS`, else the default for the mode. Always a whole number of at least 1. */
export function e2eWorkerCount(env: Env = process.env): number {
	const raw = env.E2E_WORKERS;
	if (raw !== undefined && raw.trim() !== "") {
		const parsed = Number(raw);
		if (!Number.isInteger(parsed) || parsed < 1) {
			throw new Error(
				`E2E_WORKERS must be a whole number of at least 1, not "${raw}"`,
			);
		}
		return parsed;
	}
	return e2eServerMode(env) === "dev" ? 1 : DEFAULT_BUILD_WORKERS;
}

/** This process's slot: the worker's `TEST_PARALLEL_INDEX`, or 0 in the runner. */
export function e2eSlot(env: Env = process.env): number {
	const raw = env.TEST_PARALLEL_INDEX;
	if (raw === undefined || raw === "") return 0;
	const slot = Number(raw);
	return Number.isInteger(slot) && slot >= 0 ? slot : 0;
}

export function e2ePort(slot: number, env: Env = process.env): number {
	return e2eBasePort(env) + slot;
}

export function e2eBaseUrl(slot: number, env: Env = process.env): string {
	return `http://${E2E_HOST}:${e2ePort(slot, env)}`;
}

/** The slot's database file: `E2E_DATABASE_PATH` for slot 0, `<name>-w<slot>.db` after it. */
export function e2eDatabasePath(
	slot: number,
	env: Env = process.env,
	cwd: string = process.cwd(),
): string {
	const slotZero =
		env.E2E_DATABASE_PATH || join(cwd, "data", "playwright-e2e-chat.db");
	if (slot === 0) return slotZero;
	const dot = slotZero.lastIndexOf(".");
	const slash = slotZero.lastIndexOf("/");
	return dot > slash && dot > 0
		? `${slotZero.slice(0, dot)}-w${slot}${slotZero.slice(dot)}`
		: `${slotZero}-w${slot}`;
}

export function e2eSessionSecret(env: Env = process.env): string {
	return env.SESSION_SECRET || E2E_SESSION_SECRET_FALLBACK;
}

/** True when a run may use a server that is already listening on the slot's port. */
export function e2eReusesServers(env: Env = process.env): boolean {
	return env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "true";
}
