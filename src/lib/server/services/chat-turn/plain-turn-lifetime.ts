import { TURN_FINALIZATION_WINDOW_MS } from "$lib/shared/normal-chat-completion";
import type { CompletionReceipt } from "./prepared-normal-chat-turn";
import { createTurnWatchdog } from "./turn-watchdog";

/**
 * Plain transport owns admission-to-receipt time without abandoning an in-flight commit.
 *
 * `deadlineAt` (or `timeoutMs` after admission) is the model deadline: it is what
 * the work is given as `deadlineAt` and what the engine must get, so the model
 * never has more than `requestTimeoutMs`. The turn itself is cut off
 * `TURN_FINALIZATION_WINDOW_MS` later, so a reply whose model work legally ran
 * until the deadline still has time to be finalized and saved, and a finalization
 * that hangs still ends in an explicit failure when that window closes.
 */
export async function runBoundedPlainTurn<T>(
	timeoutMs: number,
	work: (context: {
		wait: <V>(value: Promise<V>) => Promise<V>;
		model: <V extends { completionTurn?: CompletionReceipt }>(
			value: Promise<V>,
		) => Promise<V>;
		finalize: <V>(value: Promise<V>) => Promise<V>;
		persistenceSignal: AbortSignal;
		onPersistenceStarted: () => void;
		signal: AbortSignal;
		deadlineAt: number;
		touch: () => void;
	}) => Promise<T>,
	deadlineAt?: number,
): Promise<
	{ state: "complete"; value: T } | { state: "pending"; segmentId?: string }
> {
	const duration =
		Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 300000;
	const modelDeadlineAt = deadlineAt ?? Date.now() + duration;
	const watchdog = createTurnWatchdog(
		new AbortController(),
		modelDeadlineAt + TURN_FINALIZATION_WINDOW_MS,
	);
	let receipt: CompletionReceipt | undefined,
		finished = false,
		commitStarted = false;
	let commitTask: Promise<unknown> | undefined;
	let detached = false;
	const finish = async () => {
		if (receipt && !finished) {
			finished = true;
			await receipt.finish();
		}
	};
	const model = async <V extends { completionTurn?: CompletionReceipt }>(
		value: Promise<V>,
	): Promise<V> => {
		const captured = Promise.resolve(value).then((result) => {
			receipt = result.completionTurn;
			if (watchdog.signal.aborted) {
				void finish().catch(() => undefined);
				return result;
			}
			if (!receipt) return result;
			const original = receipt;
			return {
				...result,
				completionTurn: {
					...original,
					async finish(id?: string) {
						finished = true;
						await original.finish(id);
					},
				},
			};
		});
		return watchdog.wait(captured);
	};
	try {
		const value = await watchdog.wait(
			work({
				wait: (value) => watchdog.wait(value),
				model,
				finalize: (value) => {
					commitTask = Promise.resolve(value);
					return watchdog.wait(value, true);
				},
				persistenceSignal: watchdog.timeoutSignal,
				onPersistenceStarted: () => {
					commitStarted = true;
				},
				signal: watchdog.signal,
				deadlineAt: modelDeadlineAt,
				touch: watchdog.touch,
			}),
		);
		return { state: "complete", value };
	} catch (error) {
		if (watchdog.timeoutSignal.aborted && commitStarted && commitTask) {
			detached = true;
			void commitTask
				.catch(() => undefined)
				.finally(() => finish().catch(() => undefined));
			return { state: "pending", segmentId: receipt?.segmentId };
		}
		throw error;
	} finally {
		try {
			if (!detached) await watchdog.wait(finish(), true);
		} finally {
			watchdog.dispose();
		}
	}
}
