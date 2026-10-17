import { sweepExpiredSessions } from "./auth";
import { sweepTwoStep } from "./two-step";

/**
 * The one periodic sweep of the account tables (R14): expired sessions and
 * the two-step rows nothing will ever use again. It runs from a single timer
 * started in `hooks.server.ts` beside the job engine — never from a route, a
 * test or a CLI script — so a process has exactly one owner for it.
 *
 * It is hygiene only: every read checks expiry itself, so a missed pass is a
 * few dead rows, never a session that wrongly works or an attempt that
 * wrongly outlives its five minutes.
 */

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * One pass, for the timer and for tests. Both sweeps run even when the first
 * one fails: they share the caller, not a failure. Errors are caught and
 * logged content-free — counts only, never a user id, an email, a code or a
 * secret.
 */
export async function runAuthSweep(now: Date = new Date()): Promise<void> {
	let sessions = 0;
	let challenges = 0;
	let unconfirmed = 0;
	let failed = false;

	try {
		sessions = await sweepExpiredSessions(now);
	} catch (error) {
		failed = true;
		console.error("[AUTH] sweep: expired sessions failed", {
			message: error instanceof Error ? error.message : "unknown error",
		});
	}

	try {
		const swept = await sweepTwoStep(now);
		challenges = swept.challenges;
		unconfirmed = swept.unconfirmed;
	} catch (error) {
		failed = true;
		console.error("[AUTH] sweep: two-step failed", {
			message: error instanceof Error ? error.message : "unknown error",
		});
	}

	if (!failed && (sessions > 0 || challenges > 0 || unconfirmed > 0)) {
		console.info("[AUTH] sweep removed dead rows", {
			sessions,
			challenges,
			unconfirmed,
		});
	}
}

/** Starts the five-minute timer once per process. `unref` keeps it from holding the process open. */
export function startAuthSweep(): void {
	if (timer) return;
	timer = setInterval(() => {
		void runAuthSweep();
	}, SWEEP_INTERVAL_MS);
	timer.unref?.();
}

export function stopAuthSweep(): void {
	if (!timer) return;
	clearInterval(timer);
	timer = null;
}
