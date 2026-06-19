import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	deleteBrowserPushSubscription,
	getBrowserPushCapability,
	upsertBrowserPushSubscription,
} from "$lib/server/services/browser-push";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	return json(getBrowserPushCapability());
};

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) return json({ error: "Unauthorized" }, { status: 401 });

	const body = await event.request.json().catch(() => null);
	const subscription = body?.subscription;
	if (
		!subscription ||
		typeof subscription.endpoint !== "string" ||
		typeof subscription.keys?.p256dh !== "string" ||
		typeof subscription.keys?.auth !== "string"
	) {
		return json({ error: "Invalid push subscription" }, { status: 400 });
	}

	await upsertBrowserPushSubscription({
		userId: user.id,
		subscription: {
			endpoint: subscription.endpoint,
			keys: {
				p256dh: subscription.keys.p256dh,
				auth: subscription.keys.auth,
			},
			userAgent: event.request.headers.get("user-agent"),
		},
	});
	return json({ ok: true });
};

export const DELETE: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) return json({ error: "Unauthorized" }, { status: 401 });

	const body = await event.request.json().catch(() => null);
	if (!body || typeof body.endpoint !== "string") {
		return json({ error: "endpoint is required" }, { status: 400 });
	}
	await deleteBrowserPushSubscription({
		userId: user.id,
		endpoint: body.endpoint,
	});
	return json({ ok: true });
};
