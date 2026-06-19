import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/browser-push", () => ({
	deleteBrowserPushSubscription: vi.fn(async () => undefined),
	getBrowserPushCapability: vi.fn(() => ({
		enabled: true,
		publicKey: "public-key",
		reason: "configured",
	})),
	upsertBrowserPushSubscription: vi.fn(async () => undefined),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	deleteBrowserPushSubscription,
	upsertBrowserPushSubscription,
} from "$lib/server/services/browser-push";
import { DELETE, GET, POST } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
type SubscriptionEvent = Parameters<typeof POST>[0];

function makeEvent(body?: unknown): SubscriptionEvent {
	return {
		request: new Request("http://localhost/api/browser-push/subscription", {
			method: "POST",
			headers: body ? { "Content-Type": "application/json" } : undefined,
			body: body ? JSON.stringify(body) : undefined,
		}),
		locals: { user: { id: "user-1" } },
		params: {},
		url: new URL("http://localhost/api/browser-push/subscription"),
		route: { id: "/api/browser-push/subscription" },
	} as SubscriptionEvent;
}

describe("/api/browser-push/subscription", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
	});

	it("returns public browser push capability", async () => {
		const response = await GET(makeEvent());
		await expect(response.json()).resolves.toMatchObject({
			enabled: true,
			publicKey: "public-key",
		});
	});

	it("stores a signed-in user's browser push subscription", async () => {
		const response = await POST(
			makeEvent({
				subscription: {
					endpoint: "https://push.example/sub",
					keys: { p256dh: "p256dh", auth: "auth" },
				},
			}),
		);

		expect(response.status).toBe(200);
		expect(upsertBrowserPushSubscription).toHaveBeenCalledWith({
			userId: "user-1",
			subscription: {
				endpoint: "https://push.example/sub",
				keys: { p256dh: "p256dh", auth: "auth" },
				userAgent: null,
			},
		});
	});

	it("deletes an expired or denied browser push subscription", async () => {
		const response = await DELETE(
			makeEvent({ endpoint: "https://push.example/sub" }),
		);

		expect(response.status).toBe(200);
		expect(deleteBrowserPushSubscription).toHaveBeenCalledWith({
			userId: "user-1",
			endpoint: "https://push.example/sub",
		});
	});
});
