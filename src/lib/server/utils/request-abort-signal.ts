/**
 * One signal for a request: the caller's own (a stop, a turn's deadline) and a
 * timeout of its own, whichever fires first. No timeout (zero, negative or not
 * finite) is the caller's signal alone; neither is undefined.
 *
 * A leaf on purpose: the short control calls (chat-turn/short-local-text.ts)
 * and the thought-step classifier read it, and the make_video check
 * (normal-chat-tools/video-request.ts) reaches it through the first, so living
 * in chat-turn's model-run helpers closed an import cycle through the tool set.
 */
export function createRequestAbortSignal(
	timeoutMs: number,
	signal?: AbortSignal,
): AbortSignal | undefined {
	const timeoutSignal =
		Number.isFinite(timeoutMs) && timeoutMs > 0
			? AbortSignal.timeout(timeoutMs)
			: undefined;
	const signals = [signal, timeoutSignal].filter(
		(value): value is AbortSignal => Boolean(value),
	);
	if (signals.length === 0) return undefined;
	if (signals.length === 1) return signals[0];
	return AbortSignal.any(signals);
}
