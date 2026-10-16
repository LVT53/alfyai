import { randomBytes, randomUUID } from "node:crypto";
import type { Handle } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { db, sqlite } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import { createSession } from "$lib/server/services/auth";

// The request gate, with the REAL session check and the real sessions table
// (hooks.server.test.ts fakes `validateSession`). Sessions are stored as
// hashes now, so a cookie written by the release before this one carries a
// raw token that no row answers to. This pins what that person meets: a
// redirect to the login screen for a page, a 401 for an API call, and never a
// 500.

type HookEvent = Parameters<Handle>[0]["event"];

vi.mock("@sentry/sveltekit", () => ({
	init: vi.fn(),
	setUser: vi.fn(),
	sentryHandle: vi.fn(
		(): Handle =>
			async ({ event, resolve }) =>
				resolve(event),
	),
	handleErrorWithSentry: vi.fn((handler) => handler ?? vi.fn()),
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

vi.mock("$lib/server/config-store", () => ({
	refreshConfig: vi.fn(async () => undefined),
	getConfig: vi.fn(() => ({ memoryConsolidationIntervalMinutes: 0 })),
}));

vi.mock("$lib/server/services/memory-maintenance", () => ({
	ensureMemoryMaintenanceScheduler: vi.fn(),
	stopMemoryMaintenanceScheduler: vi.fn(),
}));

vi.mock("$lib/server/sandbox/config", () => ({
	prewarmSandboxImageInBackground: vi.fn(),
}));

vi.mock("$lib/server/db/compat", () => ({
	ensureRuntimeSchemaCompatibility: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/services/file-production/production-job", () => ({
	fileProductionJob: { name: "file-production" },
}));

vi.mock("$lib/server/services/atlas/research-job", () => ({
	atlasResearchJob: { name: "atlas" },
}));

vi.mock("$lib/server/services/extraction/extraction-job", () => ({
	extractionJob: { name: "extraction" },
}));

vi.mock("$lib/server/services/jobs", () => ({
	startJobs: vi.fn(async () => undefined),
	stopJobs: vi.fn(),
}));

vi.mock("$lib/server/services/chatgpt-import/import-row", () => ({
	settleInterruptedImports: vi.fn(() => 0),
}));

function makeHookEvent(
	path: string,
	sessionToken: string | undefined,
	requestHeaders: Record<string, string> = {},
): HookEvent {
	const url = new URL(`http://localhost${path}`);
	return {
		cookies: { get: vi.fn(() => sessionToken) },
		locals: {},
		url,
		request: new Request(url, { headers: requestHeaders }),
	} as unknown as HookEvent;
}

/** What a browser sends for an in-page `fetch()` to the app's own origin. */
const FETCH_HEADERS = {
	"sec-fetch-mode": "same-origin",
	"sec-fetch-dest": "empty",
	accept: "*/*",
};

let handle: Handle;
let userId: string;

beforeAll(async () => {
	({ handle } = await import("./hooks.server"));
});

beforeEach(async () => {
	userId = randomUUID();
	await db.insert(users).values({
		id: userId,
		email: `${userId}@example.com`,
		passwordHash: "not-a-real-hash",
	});
});

afterEach(async () => {
	// Its sessions go with it (the foreign key cascades).
	await db.delete(users).where(eq(users.id, userId));
});

/** A row as the release before this one wrote it: raw token, millisecond expiry. */
function insertRowTheOldReleaseWrote(rawToken: string) {
	sqlite
		.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
		.run(rawToken, userId, Date.now() + 14 * 24 * 60 * 60 * 1000);
}

describe("a session cookie from before the deploy, at the request gate", () => {
	it("sends a page request to the login screen", async () => {
		const rawToken = randomBytes(32).toString("hex");
		insertRowTheOldReleaseWrote(rawToken);
		const resolve = vi.fn(async () => new Response("a page"));
		const event = makeHookEvent("/chat/abc", rawToken);

		await expect(handle({ event, resolve })).rejects.toMatchObject({
			status: 303,
			location: "/login?session=expired",
		});
		expect(resolve).not.toHaveBeenCalled();
		expect(event.locals.user).toBeNull();
	});

	it("answers an API request with 401, not a 500", async () => {
		const rawToken = randomBytes(32).toString("hex");
		insertRowTheOldReleaseWrote(rawToken);
		const resolve = vi.fn(async () => new Response("some data"));
		const event = makeHookEvent("/api/conversations", rawToken, FETCH_HEADERS);

		const response = await handle({ event, resolve });

		expect(response.status).toBe(401);
		expect(resolve).not.toHaveBeenCalled();
		expect(event.locals.user).toBeNull();
	});

	it("still lets a real session through", async () => {
		const { token } = await createSession(userId);
		const resolve = vi.fn(async () => new Response("ok"));
		const event = makeHookEvent("/api/conversations", token, FETCH_HEADERS);

		const response = await handle({ event, resolve });

		expect(resolve).toHaveBeenCalledOnce();
		expect(response.status).toBe(200);
		expect(event.locals.user?.id).toBe(userId);
	});
});
