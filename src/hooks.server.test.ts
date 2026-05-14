import { beforeEach, describe, expect, it, vi } from "vitest";

const mockValidateSession = vi.fn();
const mockRefreshConfig = vi.fn(async () => undefined);
const mockGetConfig = vi.fn(() => ({
	deepResearchWorkerEnabled: false,
	deepResearchWorkerIntervalMs: 5000,
	deepResearchWorkerStaleTimeoutMs: 1800000,
	deepResearchWorkerGlobalConcurrency: 2,
	deepResearchWorkerUserConcurrency: 2,
}));
const mockEnsureMemoryMaintenanceScheduler = vi.fn();
const mockPrewarmSandboxImageInBackground = vi.fn();
const mockEnsureRuntimeSchemaCompatibility = vi.fn(async () => undefined);
const mockEnsureFileProductionWorker = vi.fn(async () => undefined);
const mockEnsureDeepResearchWorkerScheduler = vi.fn();

vi.mock("$lib/server/services/auth", () => ({
	validateSession: mockValidateSession,
}));

vi.mock("$lib/server/services/webhook-buffer", () => ({
	webhookBuffer: { id: "test-buffer" },
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: mockGetConfig,
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

vi.mock("$lib/server/services/deep-research/worker", () => ({
	ensureDeepResearchWorkerScheduler: mockEnsureDeepResearchWorkerScheduler,
}));

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("hooks.server.ts", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		mockRefreshConfig.mockResolvedValue(undefined);
		mockEnsureRuntimeSchemaCompatibility.mockResolvedValue(undefined);
		mockEnsureFileProductionWorker.mockResolvedValue(undefined);
	});

	it("allows public routes without a session", async () => {
		const { handle } = await import("./hooks.server");
		const resolve = vi.fn(
			async ({ locals }) => new Response(JSON.stringify({ user: locals.user })),
		);
		const event = {
			cookies: { get: vi.fn(() => undefined) },
			locals: {},
			url: new URL("http://localhost/api/auth/login"),
		} as any;

		await handle({ event, resolve });

		expect(resolve).toHaveBeenCalledOnce();
		expect(event.locals.user).toBeNull();
		expect(event.locals.webhookBuffer).toEqual({ id: "test-buffer" });
	});

	it("runs config-dependent startup work after runtime config is refreshed", async () => {
		const { init } = await import("./hooks.server");

		await init();

		expect(mockEnsureRuntimeSchemaCompatibility).toHaveBeenCalledOnce();
		expect(mockRefreshConfig).toHaveBeenCalledOnce();
		expect(mockEnsureMemoryMaintenanceScheduler).toHaveBeenCalledOnce();
		expect(mockPrewarmSandboxImageInBackground).toHaveBeenCalledOnce();
		expect(mockEnsureFileProductionWorker).toHaveBeenCalledOnce();
		expect(mockEnsureDeepResearchWorkerScheduler).toHaveBeenCalledOnce();
		expect(
			mockEnsureRuntimeSchemaCompatibility.mock.invocationCallOrder[0],
		).toBeLessThan(mockRefreshConfig.mock.invocationCallOrder[0]);
		expect(mockRefreshConfig.mock.invocationCallOrder[0]).toBeLessThan(
			mockEnsureMemoryMaintenanceScheduler.mock.invocationCallOrder[0],
		);
		expect(
			mockEnsureRuntimeSchemaCompatibility.mock.invocationCallOrder[0],
		).toBeLessThan(mockEnsureFileProductionWorker.mock.invocationCallOrder[0]);
	});

	it("waits for runtime config refresh before resolving the first request", async () => {
		const refresh = deferred();
		mockRefreshConfig.mockReturnValue(refresh.promise);
		const { handle } = await import("./hooks.server");
		const resolve = vi.fn(async () => new Response("ok"));
		const event = {
			cookies: { get: vi.fn(() => undefined) },
			locals: {},
			url: new URL("http://localhost/api/health"),
		} as Parameters<typeof handle>[0]["event"];

		const handlePromise = handle({ event, resolve });

		try {
			await Promise.resolve();
			await Promise.resolve();
			expect(resolve).not.toHaveBeenCalled();
		} finally {
			refresh.resolve();
			await handlePromise.catch(() => undefined);
		}
	});

	it("allows the health check route without a session", async () => {
		const { handle } = await import("./hooks.server");
		const resolve = vi.fn(async () => new Response("ok"));
		const event = {
			cookies: { get: vi.fn(() => undefined) },
			locals: {},
			url: new URL("http://localhost/api/health"),
		} as any;

		await handle({ event, resolve });

		expect(resolve).toHaveBeenCalledOnce();
		expect(event.locals.user).toBeNull();
	});

	it("allows the signed web research tool route without a browser session", async () => {
		const { handle } = await import("./hooks.server");
		const resolve = vi.fn(async () => new Response("ok"));
		const event = {
			cookies: { get: vi.fn(() => undefined) },
			locals: {},
			url: new URL("http://localhost/api/tools/research-web"),
		} as any;

		await handle({ event, resolve });

		expect(resolve).toHaveBeenCalledOnce();
		expect(event.locals.user).toBeNull();
	});

	it("redirects protected routes to /login when no user is present", async () => {
		const { handle } = await import("./hooks.server");
		const event = {
			cookies: { get: vi.fn(() => undefined) },
			locals: {},
			url: new URL("http://localhost/"),
		} as any;

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
		const resolve = vi.fn(async () => new Response("ok"));
		const event = {
			cookies: { get: vi.fn(() => "session-token") },
			locals: {},
			url: new URL("http://localhost/"),
		} as any;

		await handle({ event, resolve });

		expect(mockEnsureRuntimeSchemaCompatibility).toHaveBeenCalledOnce();
		expect(
			mockEnsureRuntimeSchemaCompatibility.mock.invocationCallOrder[0],
		).toBeLessThan(mockValidateSession.mock.invocationCallOrder[0]);
		expect(mockValidateSession).toHaveBeenCalledWith("session-token");
		expect(event.locals.user).toEqual(sessionUser);
		expect(resolve).toHaveBeenCalledOnce();
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
		const event = {
			cookies: { get: vi.fn(() => "session-token") },
			locals: {},
			url: new URL("http://localhost/login"),
		} as any;

		await expect(handle({ event, resolve: vi.fn() })).rejects.toMatchObject({
			status: 303,
			location: "/",
		});
	});
});
