import * as Sentry from "@sentry/sveltekit";
import type { Handle, ServerInit } from "@sveltejs/kit";
import { redirect } from "@sveltejs/kit";
import { sequence } from "@sveltejs/kit/hooks";
import { eq } from "drizzle-orm";
import {
	cleanSentryEnvValue,
	filterSentryEvent,
	parseSentryTracePropagationTargets,
	parseSentryTracesSampleRate,
} from "$lib/sentry-config";
import { refreshConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { ensureRuntimeSchemaCompatibility } from "$lib/server/db/compat";
import { users } from "$lib/server/db/schema";
import { prewarmSandboxImageInBackground } from "$lib/server/sandbox/config";
import {
	buildSecurityHeaders,
	isSecureRequest,
	parseCspModeEnv,
	sentryConnectSource,
} from "$lib/server/security-headers";
import { ensureAtlasWorker } from "$lib/server/services/atlas";
import { validateSession } from "$lib/server/services/auth";
import { ensureExtractionWorker } from "$lib/server/services/extraction";
import { ensureFileProductionWorker } from "$lib/server/services/file-production";
import {
	ensureMemoryConsolidationScheduler,
	stopMemoryConsolidationScheduler,
} from "$lib/server/services/memory-consolidation";
import { stopMemoryJudgeRunner } from "$lib/server/services/memory-judge/runner";
import {
	ensureMemoryMaintenanceScheduler,
	stopMemoryMaintenanceScheduler,
} from "$lib/server/services/memory-maintenance";
import { seedDefaultProviders } from "$lib/server/services/providers";
import {
	ensureRoutingRegionScheduler,
	stopRoutingRegionScheduler,
} from "$lib/server/services/routing/region-runtime";
import { assertSessionSecret } from "$lib/server/session-secret";

const PUBLIC_PATHS = [
	"/login",
	"/api/auth/login",
	// D2 (ADR-0054): the deploy script drains via a bearer token equal to
	// ALFYAI_API_SIGNING_KEY, with no session cookie. The route itself still
	// requires either an admin session or that bearer token — this only
	// keeps the global session gate above from redirecting the service call
	// to /login before the route's own auth check runs.
	"/api/admin/drain",
	"/api/chat/files/produce",
	"/api/health",
	// Redesign R6 (ADR 0044 Decision 5): the privacy policy's single surface
	// is this public route (linked to from the Settings profile row), so it
	// must be reachable unauthenticated to be submitted as the Google OAuth
	// verification URL.
	"/privacy",
];

const sentryDsn = cleanSentryEnvValue(
	process.env.SENTRY_DSN ?? process.env.PUBLIC_SENTRY_DSN,
);

Sentry.init({
	dsn: sentryDsn,
	enabled: Boolean(sentryDsn),
	environment: cleanSentryEnvValue(
		process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
	),
	tracesSampleRate: parseSentryTracesSampleRate(
		process.env.SENTRY_TRACES_SAMPLE_RATE,
	),
	tracePropagationTargets: parseSentryTracePropagationTargets(
		process.env.SENTRY_TRACE_PROPAGATION_TARGETS,
	),
	beforeSend: filterSentryEvent,
	// Disable OpenTelemetry setup and the import-in-the-middle ESM loader hook.
	// @sentry/node v10 uses OpenTelemetry internally for performance tracing, which
	// registers `import-in-the-middle/hook.mjs` as a global ESM loader hook via
	// `module.register()`. This hook intercepts ALL ESM module resolution including
	// SvelteKit's dynamic route chunk imports, and has known compatibility issues
	// with Svelte's compiled export patterns (nodejs/import-in-the-middle#171).
	// Disabling these hooks preserves error reporting, breadcrumbs, user context,
	// sentryHandle(), and handleErrorWithSentry() — only performance tracing is lost.
	skipOpenTelemetrySetup: true,
	registerEsmLoaderHooks: false,
});

// The browser POSTs Sentry envelopes straight to the DSN's host, so that one
// origin has to be in connect-src. Resolved once, here, from the same DSN
// Sentry.init() above uses — rather than being baked into svelte.config.js at
// build time, which would put the DSN in the build output and make rotating it
// a rebuild.
const sentryConnectSources = [sentryConnectSource(sentryDsn)].filter(
	(origin): origin is string => origin !== null,
);

// Throttled lastSeenAt tracking: fire-and-forget writes with 5-minute TTL per user.
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;
const lastSeenWriteTimestamps = new Map<string, number>();
let runtimeConfigReady = false;
let runtimeConfigReadyPromise: Promise<void> | null = null;

async function ensureRuntimeConfigReady(): Promise<void> {
	if (runtimeConfigReady) return;

	if (!runtimeConfigReadyPromise) {
		runtimeConfigReadyPromise = (async () => {
			await ensureRuntimeSchemaCompatibility();
			await refreshConfig();
			runtimeConfigReady = true;
		})().catch((error) => {
			runtimeConfigReadyPromise = null;
			throw error;
		});
	}

	await runtimeConfigReadyPromise;
}

function touchLastSeenAt(userId: string): void {
	const now = Date.now();
	const lastWrite = lastSeenWriteTimestamps.get(userId);
	if (lastWrite !== undefined && now - lastWrite < LAST_SEEN_THROTTLE_MS) {
		return;
	}
	lastSeenWriteTimestamps.set(userId, now);
	db.update(users)
		.set({ lastSeenAt: new Date() })
		.where(eq(users.id, userId))
		.catch((err) => console.error("lastSeenAt update failed:", err));
}

export const init: ServerInit = async () => {
	// FIRST, before anything touches the database or the config: in production a
	// missing, empty, too-short or placeholder SESSION_SECRET throws here.
	// adapter-node awaits `init` at module scope, so the throw aborts module
	// evaluation and the process exits non-zero with the message — a refusal to
	// boot, not a 500 on the first request that happens to read the config.
	//
	// The deploy's health poll then fails and rolls `current` back to the
	// previous release, which is the correct outcome: a release that cannot
	// protect stored credentials should not take traffic.
	assertSessionSecret();

	await ensureRuntimeConfigReady();
	seedDefaultProviders().catch((error) =>
		console.error("Failed to seed default providers:", error),
	);
	ensureMemoryMaintenanceScheduler();
	ensureMemoryConsolidationScheduler();
	ensureRoutingRegionScheduler();
	prewarmSandboxImageInBackground();
	ensureFileProductionWorker().catch((error) =>
		console.error("Failed to start file production worker:", error),
	);
	// Deliberately not awaited: the stale-attempt sweep and the first drain must
	// never sit between the process starting and it answering a health check.
	ensureExtractionWorker().catch((error) =>
		console.error("Failed to start document extraction worker:", error),
	);
	ensureAtlasWorker().catch((error) =>
		console.error("Failed to start Atlas worker:", error),
	);

	// Graceful shutdown: adapter-node's graceful_shutdown handler calls
	// closeIdleConnections(), then server.close(), then after SHUTDOWN_TIMEOUT
	// (default 30s) calls closeAllConnections(), then emits sveltekit:shutdown.
	// Without this handler the process would linger until systemd's
	// TimeoutStopSec (90s) sends SIGKILL.
	process.on("sveltekit:shutdown", (_reason: string) => {
		console.log("[SHUTDOWN] Server closed, stopping background workers");
		stopMemoryMaintenanceScheduler();
		stopMemoryConsolidationScheduler();
		stopRoutingRegionScheduler();
		stopMemoryJudgeRunner();
		// Give in-flight work (Atlas jobs, active responses) a grace period
		// to complete naturally. systemd TimeoutStopSec=90 is the hard cap.
		setTimeout(() => {
			console.log("[SHUTDOWN] Grace period expired, exiting");
			process.exit(0);
		}, 10_000);
	});
};

const appHandle: Handle = async ({ event, resolve }) => {
	await ensureRuntimeConfigReady();

	try {
		const token = event.cookies.get("session");

		if (token) {
			const sessionUser = await validateSession(token);
			event.locals.user = sessionUser ?? null;
		} else {
			event.locals.user = null;
		}
	} catch (err) {
		console.error("Session validation error:", err);
		event.locals.user = null;
	}

	// Fire-and-forget lastSeenAt update for authenticated users.
	if (event.locals.user) {
		touchLastSeenAt(event.locals.user.id);
		Sentry.setUser({
			id: event.locals.user.id,
			email: event.locals.user.email,
			username: event.locals.user.displayName,
		});
	} else {
		Sentry.setUser(null);
	}

	const path = event.url.pathname;

	if (!PUBLIC_PATHS.includes(path) && !event.locals.user) {
		throw redirect(303, "/login");
	}

	if (path === "/login" && event.locals.user) {
		throw redirect(303, "/");
	}

	const response = await resolve(event, {
		preload: ({ type }) => type === "js",
	});
	if (
		response.headers.get("content-type")?.includes("text/html") &&
		!event.url.pathname.startsWith("/api/")
	) {
		response.headers.set(
			"Cache-Control",
			"private, no-cache, no-store, must-revalidate",
		);
	}
	applySecurityHeaders(event, response);
	return response;
};

/**
 * Baseline security headers, plus whatever CSP_MODE says to do with the policy
 * SvelteKit built for this page (see the `csp` block in svelte.config.js).
 *
 * The `existingHeaders` set is the safety catch: a route that already set a
 * header keeps it. The generated-file preview responses ship a deliberately
 * tighter `Referrer-Policy: no-referrer` and a `default-src 'none'` CSP whose
 * exact text the preview runtime matches to decide whether a generated HTML
 * report may run scripts — overwriting either would downgrade every report to
 * the no-script renderer, and the failure would be silent.
 *
 * That last sentence is why the CSP is handed over ONLY for a SvelteKit page
 * response. `x-sveltekit-page: true` is set in the same `new Headers({...})`
 * literal that SvelteKit's `render_response` uses to attach the policy it
 * built, and it is set nowhere else — so it is an exact test for "this CSP is
 * ours to rewrite". Treating every CSP as SvelteKit's would hand the file
 * preview routes' own policy to the CSP_MODE machinery, and in the default
 * report-only mode that machinery DELETES `Content-Security-Policy`: the
 * preview's sandbox policy would stop being enforced and
 * `allowsTrustedHtmlPreviewRuntime` would see no header at all.
 */
function applySecurityHeaders(
	event: Parameters<Handle>[0]["event"],
	response: Response,
): void {
	const existingHeaders = new Set<string>();
	for (const [name] of response.headers) {
		existingHeaders.add(name.toLowerCase());
	}

	const isSvelteKitPage = response.headers.get("x-sveltekit-page") === "true";

	const plan = buildSecurityHeaders({
		pathname: event.url.pathname,
		contentType: response.headers.get("content-type"),
		isSecureRequest: isSecureRequest(event.url, event.request.headers),
		isProduction: process.env.NODE_ENV === "production",
		cspMode: parseCspModeEnv(process.env.CSP_MODE),
		csp: isSvelteKitPage
			? response.headers.get("content-security-policy")
			: null,
		extraConnectSources: sentryConnectSources,
		existingHeaders,
	});

	for (const name of plan.remove) response.headers.delete(name);
	for (const [name, value] of Object.entries(plan.set)) {
		response.headers.set(name, value);
	}
}

export const handle = sequence(Sentry.sentryHandle(), appHandle);

export const handleError = Sentry.handleErrorWithSentry();
