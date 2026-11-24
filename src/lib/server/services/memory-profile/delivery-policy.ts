import { getMemoryNativeWaits } from "$lib/server/config-store";
import type {
	FailureDecision,
	FailureHistory,
	JobFailure,
} from "../jobs/types";
import { NATIVE_DELIVERY_ATTEMPT_LIMIT } from "./contracts";

/**
 * What a Memory job's failure does to it: the memory kind's `onFailure`.
 *
 * Hindsight finishes its work on its own clock: under one serialized local
 * model a retain takes minutes and a consolidation longer. A job polls the
 * operation in slices (`delivery-runner.ts`) and, when a slice ends while
 * Hindsight still reports it running, hands the job back under a waiting
 * code. A wait is not a failure: it is requeued without spending an attempt,
 * for as long as that kind's whole wait (config-store's `getMemoryNativeWaits`)
 * allows, measured from when the streak began. Past it the job ends
 * `native_operation_timeout`, retryable, so an operator's drain or the
 * person's retry can take it up again. Every other failure counts against
 * `NATIVE_DELIVERY_ATTEMPT_LIMIT` exactly as before, attempts spent waiting
 * left out.
 */
export type NativeWaitKind = "retain" | "consolidation";

/** The failure codes that mean "Hindsight is still working", and which wait each is. */
export const NATIVE_WAIT_CODES: Readonly<Record<string, NativeWaitKind>> = {
	native_retain_waiting: "retain",
	native_consolidation_waiting: "consolidation",
	// A failed retain's one resubmission, held back so it does not meet the
	// refusal that failed the first send: part of the retain's wait.
	native_retain_resubmit_due: "retain",
};

/** How soon a waiting job is claimable again when its failure names no delay. */
export const NATIVE_WAIT_REQUEUE_DELAY_MS = 5_000;

/** What the policy remembers between attempts, in the job's `retry_state_json`. */
export interface DeliveryRetryState {
	/** Attempts that ended waiting on Hindsight (or were discounted by a reopen): never counted. */
	waits: number;
	/** The wait the current streak is for. Null: no streak. */
	waiting: NativeWaitKind | null;
	/** When the current streak began, epoch ms. */
	since: number | null;
}

const EMPTY: DeliveryRetryState = { waits: 0, waiting: null, since: null };

export function parseDeliveryRetryState(state: unknown): DeliveryRetryState {
	if (!state || typeof state !== "object" || Array.isArray(state)) return EMPTY;
	const record = state as Record<string, unknown>;
	if (typeof record.waits !== "number" || !Number.isFinite(record.waits))
		return EMPTY;
	return {
		waits: Math.max(0, Math.trunc(record.waits)),
		waiting:
			record.waiting === "retain" || record.waiting === "consolidation"
				? record.waiting
				: null,
		since:
			typeof record.since === "number" && Number.isFinite(record.since)
				? record.since
				: null,
	};
}

function waitStartedAt(diagnostics: unknown): number | null {
	if (!diagnostics || typeof diagnostics !== "object") return null;
	const value = (diagnostics as Record<string, unknown>).waitStartedAt;
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function decideMemoryDeliveryFailure(
	failure: JobFailure,
	history: FailureHistory,
	waits: { retainMs: number; consolidationMs: number } = getMemoryNativeWaits(),
): FailureDecision {
	const state = parseDeliveryRetryState(history.state);
	const kind = NATIVE_WAIT_CODES[failure.code];
	if (kind) {
		const since =
			state.waiting === kind && state.since !== null
				? state.since
				: (waitStartedAt(failure.diagnostics) ?? history.nowMs);
		const total = kind === "retain" ? waits.retainMs : waits.consolidationMs;
		if (history.nowMs - since < total)
			return {
				requeue: true,
				delayMs: failure.retryAfterMs ?? NATIVE_WAIT_REQUEUE_DELAY_MS,
				code: failure.code,
				retryable: true,
				state: { waits: state.waits + 1, waiting: kind, since },
			};
		return {
			requeue: false,
			retryable: true,
			code: "native_operation_timeout",
			state: { waits: state.waits + 1, waiting: null, since: null },
		};
	}
	// A real failure ends any streak; the attempts spent waiting stay discounted.
	const counted = history.attempts - state.waits;
	const next: DeliveryRetryState = {
		waits: state.waits,
		waiting: null,
		since: null,
	};
	return failure.retryable && counted < NATIVE_DELIVERY_ATTEMPT_LIMIT
		? {
				requeue: true,
				delayMs: Math.min(60_000, 5_000 * counted),
				state: next,
			}
		: { requeue: false, retryable: failure.retryable, state: next };
}

/**
 * The retry state for a job an operator deliberately reopens (the resend and
 * reattach tools): every attempt it has had so far is discounted, so it gets
 * the whole attempt limit again. Never used by the person's Retry, which keeps
 * the job's history.
 */
export function freshDeliveryAttempts(
	state: unknown,
	attemptCount: number,
): DeliveryRetryState {
	return {
		waits: Math.max(parseDeliveryRetryState(state).waits, attemptCount),
		waiting: null,
		since: null,
	};
}

/**
 * Which real try this attempt is: its number less the attempts that only
 * waited on Hindsight before it. What a handler compares with
 * `NATIVE_DELIVERY_ATTEMPT_LIMIT` (curation's last-try rules), never the raw
 * attempt number, which waits push past the limit.
 */
export function countedDeliveryAttempt(
	row: { retryState: string | null },
	attemptNumber: number,
): number {
	let state: unknown = null;
	try {
		state = row.retryState ? JSON.parse(row.retryState) : null;
	} catch {
		state = null;
	}
	return Math.max(1, attemptNumber - parseDeliveryRetryState(state).waits);
}
