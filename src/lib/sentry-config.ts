const DEFAULT_TRACES_SAMPLE_RATE = 0.1;
const DEFAULT_REPLAY_SESSION_SAMPLE_RATE = 0;
const DEFAULT_REPLAY_ERROR_SAMPLE_RATE = 1;

export function cleanSentryEnvValue(
	value: string | undefined,
): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function parseSentrySampleRate(
	value: string | undefined,
	fallback: number,
): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(1, Math.max(0, parsed));
}

export function parseSentryTracesSampleRate(value: string | undefined): number {
	return parseSentrySampleRate(value, DEFAULT_TRACES_SAMPLE_RATE);
}

export function parseSentryReplaySessionSampleRate(
	value: string | undefined,
): number {
	return parseSentrySampleRate(value, DEFAULT_REPLAY_SESSION_SAMPLE_RATE);
}

export function parseSentryReplayErrorSampleRate(
	value: string | undefined,
): number {
	return parseSentrySampleRate(value, DEFAULT_REPLAY_ERROR_SAMPLE_RATE);
}

export function parseSentryTracePropagationTargets(
	value: string | undefined,
): Array<string | RegExp> {
	const targets =
		value
			?.split(",")
			.map((target) => target.trim())
			.filter(Boolean) ?? [];

	return targets.length > 0 ? targets : ["localhost", /^\/api\//];
}
