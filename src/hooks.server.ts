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
import { ensureAtlasWorker } from "$lib/server/services/atlas";
import { validateSession } from "$lib/server/services/auth";
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

const PUBLIC_PATHS = [
	"/login",
	"/api/auth/login",
	"/api/chat/files/produce",
	"/api/health",
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
	await ensureRuntimeConfigReady();
	seedDefaultProviders().catch((error) =>
		console.error("Failed to seed default providers:", error),
	);
	ensureMemoryMaintenanceScheduler();
	ensureMemoryConsolidationScheduler();
	prewarmSandboxImageInBackground();
	ensureFileProductionWorker().catch((error) =>
		console.error("Failed to start file production worker:", error),
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
	return response;
};

export const handle = sequence(Sentry.sentryHandle(), appHandle);

export const handleError = Sentry.handleErrorWithSentry();
