import type { Handle, ResolveOptions } from "@sveltejs/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

function makeHookEvent(path: string, sessionToken?: string): HookEvent {
	return {
		cookies: { get: vi.fn(() => sessionToken) },
		locals: {},
		url: new URL(`http://localhost${path}`),
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

	it.each([
		{ segments: ["api", "tools", "image-search"] },
		{ segments: ["api", "tools", "memory-context"] },
		{ segments: ["api", "tools", "research-web"] },
		{ segments: ["api", "webhook", "sentence"] },
		{ segments: ["api", "stream", "webhook", "session-1"] },
	])("redirects retired public route %# without a session", async ({
		segments,
	}) => {
		const { handle } = await import("./hooks.server");
		const path = `/${segments.join("/")}`;
		const event = makeHookEvent(path);

		await expect(handle({ event, resolve: vi.fn() })).rejects.toMatchObject({
			status: 303,
			location: "/login",
		});
	});

	it("redirects protected routes to /login when no user is present", async () => {
		const { handle } = await import("./hooks.server");
		const event = makeHookEvent("/");

		await expect(handle({ event, resolve: vi.fn() })).rejects.toMatchObject({
			status: 303,
			location: "/login",
		});
	});

	it("loads the session user when a valid token is present", async () => {
		const { handle } = await import("./hooks.server");
		const sessionUser = {
			id: "user-1",
			email: "test@example.com",
			displayName: "Test User",
			role: "user",
			avatarId: null,
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
			avatarId: null,
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
			avatarId: null,
			profilePicture: null,
		});
		const event = makeHookEvent("/login", "session-token");

		await expect(handle({ event, resolve: vi.fn() })).rejects.toMatchObject({
			status: 303,
			location: "/",
		});
	});
});
