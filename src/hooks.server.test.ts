import type { Handle, ResolveOptions } from "@sveltejs/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type HookEvent = Parameters<Handle>[0]["event"];

const mockValidateSession = vi.fn();
const mockRefreshConfig = vi.fn(async () => undefined);
const mockEnsureMemoryMaintenanceScheduler = vi.fn();
const mockPrewarmSandboxImageInBackground = vi.fn();
const mockEnsureRuntimeSchemaCompatibility = vi.fn(async () => undefined);
const mockEnsureFileProductionWorker = vi.fn(async () => undefined);
const mockEnsureAtlasWorker = vi.fn(async () => undefined);
const mockSentryInit = vi.fn();
const mockSentrySetUser = vi.fn();
const mockSentryHandle = vi.fn<() => Handle>(
	() =>
		async ({ event, resolve }) => {
			return resolve(event);
		},
);
const mockHandleErrorWithSentry = vi.fn((handler) => handler ?? vi.fn());

vi.mock("@sentry/sveltekit", () => ({
	init: mockSentryInit,
	setUser: mockSentrySetUser,
	sentryHandle: mockSentryHandle,
	handleErrorWithSentry: mockHandleErrorWithSentry,
}));

vi.mock("@sveltejs/kit/hooks", () => ({
	sequence:
		(...handlers: Handle[]): Handle =>
		async ({ event, resolve }) => {
			const run = (
				index: number,
				currentEvent: HookEvent,
			): ReturnType<Handle> => {
				const handler = handlers[index];
				if (!handler) return resolve(currentEvent);

				return handler({
					event: currentEvent,
					resolve:
						index === handlers.length - 1
							? resolve
							: (nextEvent) => run(index + 1, nextEvent),
				});
			};

			return run(0, event);
		},
}));

vi.mock("$lib/server/services/auth", () => ({
	validateSession: mockValidateSession,
}));

vi.mock("$lib/server/config-store", () => ({
	refreshConfig: mockRefreshConfig,
	getConfig: vi.fn(() => ({ memoryConsolidationIntervalMinutes: 0 })),
}));

vi.mock("$lib/server/services/memory-maintenance", () => ({
	ensureMemoryMaintenanceScheduler: mockEnsureMemoryMaintenanceScheduler,
}));

vi.mock("$lib/server/sandbox/config", () => ({
	prewarmSandboxImageInBackground: mockPrewarmSandboxImageInBackground,
}));

vi.mock("$lib/server/db/compat", () => ({
	ensureRuntimeSchemaCompatibility: mockEnsureRuntimeSchemaCompatibility,
}));

vi.mock("$lib/server/services/file-production", () => ({
	ensureFileProductionWorker: mockEnsureFileProductionWorker,
}));

vi.mock("$lib/server/services/atlas", () => ({
	ensureAtlasWorker: mockEnsureAtlasWorker,
}));

function deferred<T = undefined>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function makeHookEvent(
	path: string,
	sessionToken?: string,
	requestHeaders: Record<string, string> = {},
): HookEvent {
	const url = new URL(`http://localhost${path}`);
	return {
		cookies: { get: vi.fn(() => sessionToken) },
		locals: {},
		url,
		// The security-header pass reads x-forwarded-proto off the request, so
		// the fake needs one now.
		request: new Request(url, { headers: requestHeaders }),
	} as unknown as HookEvent;
}

describe("hooks.server.ts", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		mockRefreshConfig.mockResolvedValue(undefined);
		mockEnsureRuntimeSchemaCompatibility.mockResolvedValue(undefined);
		mockEnsureFileProductionWorker.mockResolvedValue(undefined);
		mockEnsureAtlasWorker.mockResolvedValue(undefined);
	});

	it("allows public routes without a session", async () => {
		const { handle } = await import("./hooks.server");
		const resolve = vi.fn(
			async ({ locals }: HookEvent, _options?: ResolveOptions) =>
				new Response(JSON.stringify({ user: locals.user })),
		);
		const event = makeHookEvent("/api/auth/login");

		await handle({ event, resolve });

		expect(resolve).toHaveBeenCalledOnce();
		expect(event.locals.user).toBeNull();
		expect("webhookBuffer" in event.locals).toBe(false);
		expect(mockSentrySetUser).toHaveBeenCalledWith(null);
	});

	it("drops SvelteKit redirect captures from server-side Sentry events", async () => {
		await import("./hooks.server");

		const initOptions = mockSentryInit.mock.calls[0]?.[0];
		const beforeSend = initOptions?.beforeSend;

		expect(beforeSend).toBeTypeOf("function");
		expect(
			beforeSend(
				{
					exception: {
						values: [
							{
								type: "Error",
								value:
									"'Redirect' captured as exception with keys: location, status",
							},
						],
					},
				},
				{
					originalException: { status: 303, location: "/login" },
				},
			),
		).toBeNull();
		expect(
			beforeSend(
				{
					exception: {
						values: [{ type: "Error", value: "Database unavailable" }],
					},
				},
				{ originalException: new Error("Database unavailable") },
			),
		).toEqual({
			exception: {
				values: [{ type: "Error", value: "Database unavailable" }],
			},
		});
	});

	it("disables OpenTelemetry setup and ESM loader hooks to prevent import-in-the-middle crashes", async () => {
		await import("./hooks.server");

		const initOptions = mockSentryInit.mock.calls[0]?.[0];

		expect(initOptions?.skipOpenTelemetrySetup).toBe(true);
		expect(initOptions?.registerEsmLoaderHooks).toBe(false);
	});

	it("runs config-dependent startup work after runtime config is refreshed", async () => {
		const { init } = await import("./hooks.server");

		await init();

		expect(mockEnsureRuntimeSchemaCompatibility).toHaveBeenCalledOnce();
		expect(mockRefreshConfig).toHaveBeenCalledOnce();
		expect(mockEnsureMemoryMaintenanceScheduler).toHaveBeenCalledOnce();
		expect(mockPrewarmSandboxImageInBackground).toHaveBeenCalledOnce();
		expect(mockEnsureFileProductionWorker).toHaveBeenCalledOnce();
		expect(mockEnsureAtlasWorker).toHaveBeenCalledOnce();
		expect(
			mockEnsureRuntimeSchemaCompatibility.mock.invocationCallOrder[0],
		).toBeLessThan(mockRefreshConfig.mock.invocationCallOrder[0]);
		expect(mockRefreshConfig.mock.invocationCallOrder[0]).toBeLessThan(
			mockEnsureMemoryMaintenanceScheduler.mock.invocationCallOrder[0],
		);
		expect(
			mockEnsureRuntimeSchemaCompatibility.mock.invocationCallOrder[0],
		).toBeLessThan(mockEnsureFileProductionWorker.mock.invocationCallOrder[0]);
		expect(
			mockEnsureRuntimeSchemaCompatibility.mock.invocationCallOrder[0],
		).toBeLessThan(mockEnsureAtlasWorker.mock.invocationCallOrder[0]);
	});

	it("waits for runtime config refresh before resolving the first request", async () => {
		const refresh = deferred();
		mockRefreshConfig.mockReturnValue(refresh.promise);
		const { handle } = await import("./hooks.server");
		const resolve = vi.fn(
			async (_event: HookEvent, _options?: ResolveOptions) =>
				new Response("ok"),
		);
		const event = makeHookEvent("/api/health");

		const handlePromise = handle({ event, resolve });

		try {
			await Promise.resolve();
			await Promise.resolve();
			expect(resolve).not.toHaveBeenCalled();
		} finally {
			refresh.resolve(undefined);
			await Promise.resolve(handlePromise).catch(() => undefined);
		}
	});

	it("allows the health check route without a session", async () => {
		const { handle } = await import("./hooks.server");
		const resolve = vi.fn(
			async (_event: HookEvent, _options?: ResolveOptions) =>
				new Response("ok"),
		);
		const event = makeHookEvent("/api/health");

		await handle({ event, resolve });

		expect(resolve).toHaveBeenCalledOnce();
		expect(event.locals.user).toBeNull();
	});

	it("allows the admin drain route without a session (D2 — deploy script's bearer-token auth)", async () => {
		const { handle } = await import("./hooks.server");
		const resolve = vi.fn(
			async (_event: HookEvent, _options?: ResolveOptions) =>
				new Response("ok"),
		);
		const event = makeHookEvent("/api/admin/drain");

		await handle({ event, resolve });

		expect(resolve).toHaveBeenCalledOnce();
		expect(event.locals.user).toBeNull();
	});

	it("allows /privacy without a session (Redesign R6 — Google OAuth verification URL)", async () => {
		const { handle } = await import("./hooks.server");
		const resolve = vi.fn(
			async (_event: HookEvent, _options?: ResolveOptions) =>
				new Response("ok"),
		);
		const event = makeHookEvent("/privacy");

		await handle({ event, resolve });

		expect(resolve).toHaveBeenCalledOnce();
		expect(event.locals.user).toBeNull();
	});

	it.each([
		{ segments: ["api", "tools", "image-search"] },
		{ segments: ["api", "tools", "memory-context"] },
		{ segments: ["api", "tools", "research-web"] },
		{ segments: ["api", "webhook", "sentence"] },
		{ segments: ["api", "stream", "webhook", "session-1"] },
	])("refuses retired public route %# without a session", async ({
		segments,
	}) => {
		const { handle } = await import("./hooks.server");
		const { SESSION_EXPIRED_HEADER } = await import("$lib/session-expiry");
		const path = `/${segments.join("/")}`;
		const resolve = vi.fn();
		const event = makeHookEvent(path);

		// Still gated, and as API paths they are now refused in the API's own
		// language rather than redirected to a login page.
		const response = await handle({ event, resolve });

		expect(resolve).not.toHaveBeenCalled();
		expect(response.status).toBe(401);
		expect(response.headers.get(SESSION_EXPIRED_HEADER)).toBe("1");
	});

	it("redirects protected routes to /login when no user is present", async () => {
		const { handle } = await import("./hooks.server");
		const event = makeHookEvent("/");

		await expect(handle({ event, resolve: vi.fn() })).rejects.toMatchObject({
			status: 303,
			location: "/login",
		});
	});

	it("marks the login redirect when the browser arrived with a dead session", async () => {
		const { handle } = await import("./hooks.server");
		// A cookie was sent and the session behind it is gone: the user was
		// signed in a moment ago, so the login screen gets to say why it is
		// showing.
		mockValidateSession.mockResolvedValue(null);
		const event = makeHookEvent("/chat/abc", "stale-token");

		await expect(handle({ event, resolve: vi.fn() })).rejects.toMatchObject({
			status: 303,
			location: "/login?session=expired",
		});
	});

	it("answers an API path with 401 instead of redirecting it to the login page", async () => {
		const { handle } = await import("./hooks.server");
		const { SESSION_EXPIRED_CODE, SESSION_EXPIRED_HEADER } = await import(
			"$lib/session-expiry"
		);
		mockValidateSession.mockResolvedValue(null);
		const resolve = vi.fn();
		const event = makeHookEvent("/api/conversations", "stale-token");

		// Not a redirect: `fetch` would follow it, the public login route would
		// answer 200 with HTML, and the caller would parse a web page as its
		// payload — the silent failure this gate exists to avoid.
		const response = await handle({ event, resolve });

		expect(resolve).not.toHaveBeenCalled();
		expect(response.status).toBe(401);
		expect(response.headers.get(SESSION_EXPIRED_HEADER)).toBe("1");
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toMatchObject({
			code: SESSION_EXPIRED_CODE,
		});
	});

	it("answers an API path with 401 even when no cookie was sent at all", async () => {
		const { handle } = await import("./hooks.server");
		const { SESSION_EXPIRED_HEADER } = await import("$lib/session-expiry");
		const event = makeHookEvent("/api/models");

		const response = await handle({ event, resolve: vi.fn() });

		expect(response.status).toBe(401);
		expect(response.headers.get(SESSION_EXPIRED_HEADER)).toBe("1");
	});

	it("puts the baseline security headers on the gate's 401, and keeps it out of caches", async () => {
		const { handle } = await import("./hooks.server");
		const event = makeHookEvent("/api/conversations");

		const response = await handle({ event, resolve: vi.fn() });

		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	});

	it("loads the session user when a valid token is present", async () => {
		const { handle } = await import("./hooks.server");
		const sessionUser = {
			id: "user-1",
			email: "test@example.com",
			displayName: "Test User",
			role: "user",
			profilePicture: null,
		};
		mockValidateSession.mockResolvedValue(sessionUser);
		const resolve = vi.fn(
			async (_event: HookEvent, _options?: ResolveOptions) =>
				new Response("ok"),
		);
		const event = makeHookEvent("/", "session-token");

		await handle({ event, resolve });

		expect(mockEnsureRuntimeSchemaCompatibility).toHaveBeenCalledOnce();
		expect(
			mockEnsureRuntimeSchemaCompatibility.mock.invocationCallOrder[0],
		).toBeLessThan(mockValidateSession.mock.invocationCallOrder[0]);
		expect(mockValidateSession).toHaveBeenCalledWith("session-token");
		expect(event.locals.user).toEqual(sessionUser);
		expect(mockSentrySetUser).toHaveBeenCalledWith({
			id: "user-1",
			email: "test@example.com",
			username: "Test User",
		});
		expect(resolve).toHaveBeenCalledOnce();
	});

	it("only preloads javascript chunks from server-rendered pages", async () => {
		const { handle } = await import("./hooks.server");
		mockValidateSession.mockResolvedValue({
			id: "user-1",
			email: "test@example.com",
			displayName: "Test User",
			role: "user",
			profilePicture: null,
		});
		const resolve = vi.fn(
			async (_event: HookEvent, _options?: ResolveOptions) =>
				new Response("ok"),
		);
		const event = makeHookEvent("/chat/conversation-1", "session-token");

		await handle({ event, resolve });

		const resolveOptions = resolve.mock.calls[0]?.[1] as
			| {
					preload?: (asset: { type: string; path: string }) => boolean;
			  }
			| undefined;
		expect(
			resolveOptions?.preload?.({
				type: "js",
				path: "/_app/immutable/chunks/app.js",
			}),
		).toBe(true);
		expect(
			resolveOptions?.preload?.({
				type: "css",
				path: "/_app/immutable/assets/DocumentWorkspace.css",
			}),
		).toBe(false);
		expect(
			resolveOptions?.preload?.({
				type: "font",
				path: "/_app/immutable/assets/nimbus.woff2",
			}),
		).toBe(false);
	});

	it("redirects authenticated users away from /login", async () => {
		const { handle } = await import("./hooks.server");
		mockValidateSession.mockResolvedValue({
			id: "user-1",
			email: "test@example.com",
			displayName: "Test User",
			role: "user",
			profilePicture: null,
		});
		const event = makeHookEvent("/login", "session-token");

		await expect(handle({ event, resolve: vi.fn() })).rejects.toMatchObject({
			status: 303,
			location: "/",
		});
	});

	// adapter-node awaits `init` at module scope (build/handler.js), so a throw
	// here is a refusal to boot: the process exits non-zero with the message
	// rather than serving requests that would encrypt credentials under a
	// public key. The deploy's health poll then rolls `current` back.
	describe("SESSION_SECRET startup gate", () => {
		const originalEnv = process.env;

		beforeEach(() => {
			process.env = { ...originalEnv };
		});

		afterEach(() => {
			process.env = originalEnv;
		});

		it("refuses to start in production without a real SESSION_SECRET", async () => {
			process.env.NODE_ENV = "production";
			delete process.env.PLAYWRIGHT_TEST;
			delete process.env.VITEST;
			delete process.env.SESSION_SECRET;

			const { init } = await import("./hooks.server");

			await expect(init?.()).rejects.toThrow(/refusing to start/i);
			// And it gives up before touching anything: no schema compatibility
			// pass, no config refresh, no background workers started against a
			// deployment that is about to be declared unfit.
			expect(mockEnsureRuntimeSchemaCompatibility).not.toHaveBeenCalled();
			expect(mockRefreshConfig).not.toHaveBeenCalled();
			expect(mockEnsureAtlasWorker).not.toHaveBeenCalled();
		});

		// The dev/test path (warn once, fall back, carry on) is covered in
		// src/lib/server/session-secret.test.ts against the pure function.
		// Calling the real `init` for it here would start the memory,
		// consolidation and routing schedulers for real, which no other test in
		// this file does and which would leave timers behind.
	});

	describe("security headers", () => {
		const originalEnv = process.env;

		beforeEach(() => {
			process.env = { ...originalEnv };
			mockValidateSession.mockResolvedValue({
				id: "user-1",
				email: "test@example.com",
				displayName: "Test User",
				role: "user",
				profilePicture: null,
			});
		});

		afterEach(() => {
			process.env = originalEnv;
		});

		async function handleHtml(
			options: {
				path?: string;
				requestHeaders?: Record<string, string>;
				responseHeaders?: Record<string, string>;
				/**
				 * SvelteKit stamps `x-sveltekit-page: true` on page responses, in
				 * the same Headers literal that carries the CSP it generated. It
				 * is how the hook tells its own policy from a policy an endpoint
				 * set for itself, so the harness models it.
				 */
				sveltekitPage?: boolean;
			} = {},
		): Promise<Response> {
			const { handle } = await import("./hooks.server");
			const event = makeHookEvent(
				options.path ?? "/",
				"session-token",
				options.requestHeaders,
			);
			return handle({
				event,
				resolve: vi.fn(
					async () =>
						new Response("<html></html>", {
							headers: {
								"content-type": "text/html; charset=utf-8",
								...(options.sveltekitPage === false
									? {}
									: { "x-sveltekit-page": "true" }),
								...options.responseHeaders,
							},
						}),
				),
			});
		}

		it("adds the baseline headers to a rendered page", async () => {
			const response = await handleHtml();

			expect(response.headers.get("x-content-type-options")).toBe("nosniff");
			expect(response.headers.get("referrer-policy")).toBe(
				"strict-origin-when-cross-origin",
			);
			expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
			expect(response.headers.get("cross-origin-opener-policy")).toBe(
				"same-origin",
			);
			expect(response.headers.get("permissions-policy")).toContain("camera=()");
		});

		it("does not send HSTS over plain HTTP", async () => {
			process.env.NODE_ENV = "production";
			const response = await handleHtml({
				requestHeaders: { "x-forwarded-proto": "http" },
			});
			expect(response.headers.get("strict-transport-security")).toBeNull();
		});

		it("sends HSTS over HTTPS in production", async () => {
			process.env.NODE_ENV = "production";
			const response = await handleHtml({
				requestHeaders: { "x-forwarded-proto": "https" },
			});
			expect(response.headers.get("strict-transport-security")).toContain(
				"max-age=",
			);
		});

		it("does not send HSTS outside production", async () => {
			process.env.NODE_ENV = "development";
			const response = await handleHtml({
				requestHeaders: { "x-forwarded-proto": "https" },
			});
			expect(response.headers.get("strict-transport-security")).toBeNull();
		});

		it("ships the CSP report-only by default", async () => {
			const response = await handleHtml({
				responseHeaders: {
					"content-security-policy": "default-src 'self'; connect-src 'self'",
				},
			});

			expect(response.headers.get("content-security-policy")).toBeNull();
			expect(
				response.headers.get("content-security-policy-report-only"),
			).toContain("default-src 'self'");
		});

		it("enforces the CSP when CSP_MODE=enforce", async () => {
			process.env.CSP_MODE = "enforce";
			const response = await handleHtml({
				responseHeaders: {
					"content-security-policy": "default-src 'self'; connect-src 'self'",
				},
			});

			expect(response.headers.get("content-security-policy")).toContain(
				"default-src 'self'",
			);
			expect(
				response.headers.get("content-security-policy-report-only"),
			).toBeNull();
		});

		it("drops the CSP entirely when CSP_MODE=off", async () => {
			process.env.CSP_MODE = "off";
			const response = await handleHtml({
				responseHeaders: {
					"content-security-policy": "default-src 'self'",
				},
			});

			expect(response.headers.get("content-security-policy")).toBeNull();
			expect(
				response.headers.get("content-security-policy-report-only"),
			).toBeNull();
		});

		// What /api/knowledge/[id]/preview actually returns: a tighter referrer
		// policy and a default-src 'none' CSP whose exact text
		// `allowsTrustedHtmlPreviewRuntime` matches to decide whether a
		// generated HTML report may run scripts. It is an endpoint response, so
		// it carries no x-sveltekit-page stamp.
		const previewCsp =
			"default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

		function handlePreview(): Promise<Response> {
			return handleHtml({
				path: "/api/knowledge/doc-1/preview",
				sveltekitPage: false,
				responseHeaders: {
					"referrer-policy": "no-referrer",
					"x-content-type-options": "nosniff",
					"content-security-policy": previewCsp,
				},
			});
		}

		it("leaves a file preview's own hardened headers untouched", async () => {
			const response = await handlePreview();

			expect(response.headers.get("referrer-policy")).toBe("no-referrer");
			expect(response.headers.get("x-frame-options")).toBeNull();
			expect(response.headers.get("cross-origin-opener-policy")).toBeNull();
		});

		// The regression these three guard: CSP_MODE owns the policy SvelteKit
		// generates for a PAGE, and nothing else. Handing an endpoint's own
		// policy to it would, in the default report-only mode, delete the
		// enforcing header — un-sandboxing model-generated HTML and, because
		// the trust check then sees no header at all, silently downgrading
		// every generated report to the no-script renderer.
		it.each([
			"report-only",
			"enforce",
			"off",
		] as const)("leaves a file preview's own CSP enforcing when CSP_MODE=%s", async (mode) => {
			process.env.CSP_MODE = mode;
			const response = await handlePreview();

			expect(response.headers.get("content-security-policy")).toBe(previewCsp);
			expect(
				response.headers.get("content-security-policy-report-only"),
			).toBeNull();
		});
	});
});
