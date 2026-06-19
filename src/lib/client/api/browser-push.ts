import { type FetchLike, requestJson } from "./http";

export interface BrowserPushCapability {
	enabled: boolean;
	publicKey: string | null;
	reason: "configured" | "missing_vapid_keys";
}

export type BrowserPushSubscribeResult =
	| { ok: true }
	| {
			ok: false;
			reason:
				| "missing_vapid_keys"
				| "unsupported"
				| "permission_denied"
				| "service_worker_failed";
	  };

function base64UrlToArrayBuffer(value: string): ArrayBuffer {
	const padding = "=".repeat((4 - (value.length % 4)) % 4);
	const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(base64);
	const bytes = new Uint8Array(raw.length);
	for (let index = 0; index < raw.length; index += 1) {
		bytes[index] = raw.charCodeAt(index);
	}
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

export async function fetchBrowserPushCapability(
	fetchImpl: FetchLike = fetch,
): Promise<BrowserPushCapability> {
	return requestJson<BrowserPushCapability>(
		"/api/browser-push/subscription",
		{ method: "GET" },
		"Failed to load browser push capability",
		fetchImpl,
	);
}

export async function enableBrowserPushNotifications(
	params: {
		fetchImpl?: FetchLike;
		navigatorRef?: Navigator;
		notificationRef?: typeof Notification;
	} = {},
): Promise<BrowserPushSubscribeResult> {
	const fetchImpl = params.fetchImpl ?? fetch;
	const capability = await fetchBrowserPushCapability(fetchImpl);
	if (!capability.enabled || !capability.publicKey) {
		return { ok: false, reason: "missing_vapid_keys" };
	}

	const navigatorRef =
		params.navigatorRef ??
		(typeof navigator !== "undefined" ? navigator : undefined);
	const notificationRef =
		params.notificationRef ??
		(typeof Notification !== "undefined" ? Notification : undefined);
	const windowRef = typeof window !== "undefined" ? window : undefined;
	if (
		!navigatorRef ||
		!windowRef ||
		!notificationRef ||
		!("serviceWorker" in navigatorRef) ||
		!("PushManager" in windowRef)
	) {
		return { ok: false, reason: "unsupported" };
	}

	const permission = await notificationRef.requestPermission();
	if (permission !== "granted") {
		return { ok: false, reason: "permission_denied" };
	}

	let registration: ServiceWorkerRegistration;
	try {
		registration = await navigatorRef.serviceWorker.register(
			"/browser-push-sw.js",
		);
	} catch {
		return { ok: false, reason: "service_worker_failed" };
	}

	const subscription = await registration.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey: base64UrlToArrayBuffer(capability.publicKey),
	});
	await requestJson(
		"/api/browser-push/subscription",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ subscription: subscription.toJSON() }),
		},
		"Failed to save browser push subscription",
		fetchImpl,
	);
	return { ok: true };
}
