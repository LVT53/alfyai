import * as Sentry from "@sentry/sveltekit";
import { config as configureZod } from "zod/v4/core";
import {
	cleanSentryEnvValue,
	filterSentryEvent,
	parseSentryReplayErrorSampleRate,
	parseSentryReplaySessionSampleRate,
	parseSentryTracePropagationTargets,
	parseSentryTracesSampleRate,
} from "$lib/sentry-config";

// The browser's Content-Security-Policy has no 'unsafe-eval', and must not get one.
// zod 4 builds a fast parser for every object schema with `new Function`, probing
// for the permission with `Function("")` the first time a schema is made, and the
// probe is a policy violation (reported on every page that builds one: the map
// route card's e2e caught it). Turning the fast path off costs the browser nothing
// it uses; the server keeps it. This runs before any route module is loaded, so
// before the first schema is built (FG's finding 2, FB-8).
configureZod({ jitless: true });

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
		beforeSend: filterSentryEvent,
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
