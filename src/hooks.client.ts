import * as Sentry from "@sentry/sveltekit";
import {
	cleanSentryEnvValue,
	parseSentryReplayErrorSampleRate,
	parseSentryReplaySessionSampleRate,
	parseSentryTracePropagationTargets,
	parseSentryTracesSampleRate,
} from "$lib/sentry-config";

const sentryDsn = cleanSentryEnvValue(import.meta.env.PUBLIC_SENTRY_DSN);

if (sentryDsn) {
	Sentry.init({
		dsn: sentryDsn,
		environment: cleanSentryEnvValue(import.meta.env.PUBLIC_SENTRY_ENVIRONMENT),
		tracesSampleRate: parseSentryTracesSampleRate(
			import.meta.env.PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
		),
		tracePropagationTargets: parseSentryTracePropagationTargets(
			import.meta.env.PUBLIC_SENTRY_TRACE_PROPAGATION_TARGETS,
		),
		replaysSessionSampleRate: parseSentryReplaySessionSampleRate(
			import.meta.env.PUBLIC_SENTRY_REPLAYS_SESSION_SAMPLE_RATE,
		),
		replaysOnErrorSampleRate: parseSentryReplayErrorSampleRate(
			import.meta.env.PUBLIC_SENTRY_REPLAYS_ERROR_SAMPLE_RATE,
		),
		integrations: [
			Sentry.browserTracingIntegration(),
			Sentry.replayIntegration(),
		],
	});
}

export const handleError = Sentry.handleErrorWithSentry();
