import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import {
	createQueryExecutor,
	type QueryExecutor,
} from "$lib/server/db/query-executor";
import * as schema from "$lib/server/db/schema";

vi.mock("web-push", () => ({
	default: {
		setVapidDetails: vi.fn(),
		sendNotification: vi.fn(async () => undefined),
	},
}));

// `config-store.ts` reads these into its module-level runtime config the
// first time it loads, so they must be set before the dynamic import below
// pulls it in transitively (mirrors the previous per-test env assignment,
// which relied on `vi.resetModules()` to force a fresh read per test).
process.env.WEB_PUSH_VAPID_PUBLIC_KEY = "public-key";
process.env.WEB_PUSH_VAPID_PRIVATE_KEY = "private-key";
process.env.WEB_PUSH_VAPID_SUBJECT = "mailto:test@example.com";

const {
	getBrowserPushCapability,
	notifyAtlasCompletion,
	sendBrowserPushToUser,
	upsertBrowserPushSubscription,
} = await import("./browser-push");

let memory: InMemoryDatabase;
let executor: QueryExecutor;

function seedUser() {
	memory.db
		.insert(schema.users)
		.values({
			id: "user-1",
			email: "push@example.com",
			passwordHash: "hash",
		})
		.run();
}

describe("browser push service", () => {
	beforeEach(() => {
		memory = createInMemoryDatabase();
		executor = createQueryExecutor(memory.db);
		seedUser();
	});

	afterEach(() => {
		memory.close();
	});

	it("reports missing VAPID keys as disabled without failing Atlas polling", async () => {
		const config = {
			webPushVapidPublicKey: "",
			webPushVapidPrivateKey: "",
			webPushVapidSubject: "",
		} as Parameters<typeof getBrowserPushCapability>[0];

		expect(getBrowserPushCapability(config)).toEqual({
			enabled: false,
			publicKey: null,
			reason: "missing_vapid_keys",
		});
		await expect(
			sendBrowserPushToUser(
				{
					userId: "user-1",
					payload: { title: "Atlas complete", body: "Report ready" },
					config,
				},
				executor,
			),
		).resolves.toEqual({ attempted: 0, sent: 0, removed: 0, skipped: true });
	});

	it("stores subscriptions and sends sanitized Atlas completion payloads", async () => {
		const webPush = (await import("web-push")).default;

		await upsertBrowserPushSubscription(
			{
				userId: "user-1",
				subscription: {
					endpoint: "https://push.example/sub-1",
					keys: { p256dh: "p256dh-key", auth: "auth-key" },
					userAgent: "vitest",
				},
			},
			executor,
		);
		vi.mocked(webPush.sendNotification).mockResolvedValueOnce({
			statusCode: 201,
			body: "",
			headers: {},
		});

		await notifyAtlasCompletion(
			{
				userId: "user-1",
				conversationId: "conv-1",
				jobId: "atlas-job-1",
				title: "Enterprise Search Atlas",
			},
			executor,
		);

		expect(webPush.setVapidDetails).toHaveBeenCalled();
		expect(webPush.sendNotification).toHaveBeenCalledWith(
			{
				endpoint: "https://push.example/sub-1",
				keys: { p256dh: "p256dh-key", auth: "auth-key" },
			},
			JSON.stringify({
				title: "Atlas complete",
				body: "Enterprise Search Atlas",
				url: "/chat/conv-1",
				tag: "atlas:atlas-job-1",
			}),
		);
	});
});
