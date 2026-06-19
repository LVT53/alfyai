import { describe, expect, it, vi } from "vitest";
import {
	enableBrowserPushNotifications,
	fetchBrowserPushCapability,
} from "./browser-push";
import type { FetchLike } from "./http";

describe("browser push client API", () => {
	it("loads public push capability", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => {
			return new Response(
				JSON.stringify({
					enabled: false,
					publicKey: null,
					reason: "missing_vapid_keys",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		await expect(fetchBrowserPushCapability(fetchImpl)).resolves.toEqual({
			enabled: false,
			publicKey: null,
			reason: "missing_vapid_keys",
		});
	});

	it("does not request permission when VAPID keys are missing", async () => {
		const fetchImpl = vi.fn<FetchLike>(async () => {
			return new Response(
				JSON.stringify({
					enabled: false,
					publicKey: null,
					reason: "missing_vapid_keys",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});
		const notificationRef = {
			requestPermission: vi.fn(async () => "granted" as NotificationPermission),
		} as unknown as typeof Notification;

		await expect(
			enableBrowserPushNotifications({ fetchImpl, notificationRef }),
		).resolves.toEqual({ ok: false, reason: "missing_vapid_keys" });
		expect(notificationRef.requestPermission).not.toHaveBeenCalled();
	});
});
