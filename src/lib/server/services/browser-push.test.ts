import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

vi.mock("web-push", () => ({
	default: {
		setVapidDetails: vi.fn(),
		sendNotification: vi.fn(async () => undefined),
	},
}));

let dbPath: string;

async function seedUser() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	db.insert(schema.users)
		.values({
			id: "user-1",
			email: "push@example.com",
			passwordHash: "hash",
		})
		.run();
	sqlite.close();
}

describe("browser push service", () => {
	beforeEach(async () => {
		dbPath = `/tmp/alfyai-browser-push-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		process.env.WEB_PUSH_VAPID_PUBLIC_KEY = "public-key";
		process.env.WEB_PUSH_VAPID_PRIVATE_KEY = "private-key";
		process.env.WEB_PUSH_VAPID_SUBJECT = "mailto:test@example.com";
		vi.resetModules();
		await seedUser();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// DB module may not have loaded.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Best-effort temp DB cleanup.
		}
		delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
		delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
		delete process.env.WEB_PUSH_VAPID_SUBJECT;
	});

	it("reports missing VAPID keys as disabled without failing Atlas polling", async () => {
		const { getBrowserPushCapability, sendBrowserPushToUser } = await import(
			"./browser-push"
		);
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
			sendBrowserPushToUser({
				userId: "user-1",
				payload: { title: "Atlas complete", body: "Report ready" },
				config,
			}),
		).resolves.toEqual({ attempted: 0, sent: 0, removed: 0, skipped: true });
	});

	it("stores subscriptions and sends sanitized Atlas completion payloads", async () => {
		const webPush = (await import("web-push")).default;
		const { notifyAtlasCompletion, upsertBrowserPushSubscription } =
			await import("./browser-push");

		await upsertBrowserPushSubscription({
			userId: "user-1",
			subscription: {
				endpoint: "https://push.example/sub-1",
				keys: { p256dh: "p256dh-key", auth: "auth-key" },
				userAgent: "vitest",
			},
		});
		vi.mocked(webPush.sendNotification).mockResolvedValueOnce({
			statusCode: 201,
			body: "",
			headers: {},
		});

		await notifyAtlasCompletion({
			userId: "user-1",
			conversationId: "conv-1",
			jobId: "atlas-job-1",
			title: "Enterprise Search Atlas",
		});

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
