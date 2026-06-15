const DEFAULT_TRACES_SAMPLE_RATE = 0.1;
const DEFAULT_REPLAY_SESSION_SAMPLE_RATE = 0;
const DEFAULT_REPLAY_ERROR_SAMPLE_RATE = 1;

const LEGACY_SENTRY_UI_ERROR =
	"Object [object Object] has no method 'updateFrom'";
const EXAMPLE_EVENT_URL = /^https?:\/\/example\.com(?:\/|$)/i;
const LEGACY_SENTRY_FRAME_PATTERNS = [
	/(^|\/)raven\.js$/i,
	/(^|\/)sentry\/scripts\/views\.js$/i,
];

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

export type FilterableSentryEvent = {
	type?: string;
	request?: {
		url?: string;
	};
	exception?: {
		values?: Array<{
			type?: string;
			value?: string;
			stacktrace?: {
				frames?: Array<{
					filename?: string;
					abs_path?: string;
					function?: string;
					in_app?: boolean;
				}>;
			};
		}>;
	};
};

function hasLegacySentryFrame(event: FilterableSentryEvent): boolean {
	return (
		event.exception?.values?.some((exception) =>
			exception.stacktrace?.frames?.some((frame) => {
				const filename = frame.filename ?? frame.abs_path ?? "";
				return LEGACY_SENTRY_FRAME_PATTERNS.some((pattern) =>
					pattern.test(filename),
				);
			}),
		) ?? false
	);
}

function hasLegacySentryUpdateFromError(event: FilterableSentryEvent): boolean {
	return (
		event.exception?.values?.some(
			(exception) => exception.value === LEGACY_SENTRY_UI_ERROR,
		) ?? false
	);
}

type SentryEventHintLike = {
	originalException?: unknown;
};

function isRedirectLike(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { location?: unknown; status?: unknown };
	return (
		typeof candidate.location === "string" &&
		typeof candidate.status === "number" &&
		candidate.status >= 300 &&
		candidate.status <= 308
	);
}

function hasSerializedRedirectException(event: FilterableSentryEvent): boolean {
	return (
		event.exception?.values?.some(
			(value) =>
				value.type === "Error" &&
				value.value ===
					"'Redirect' captured as exception with keys: location, status",
		) ?? false
	);
}

export function filterSentryEvent<T extends FilterableSentryEvent>(
	event: T,
	hint?: SentryEventHintLike,
): T | null {
	if (
		isRedirectLike(hint?.originalException) ||
		hasSerializedRedirectException(event)
	) {
		return null;
	}

	const eventUrl = event.request?.url;
	const isExampleEvent = eventUrl ? EXAMPLE_EVENT_URL.test(eventUrl) : false;

	if (
		isExampleEvent &&
		hasLegacySentryUpdateFromError(event) &&
		hasLegacySentryFrame(event)
	) {
		return null;
	}

	return event;
}
