import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import webPush from "web-push";
import { getConfig, type RuntimeConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { browserPushSubscriptions, users } from "$lib/server/db/schema";

export interface BrowserPushSubscriptionInput {
	endpoint: string;
	keys: {
		p256dh: string;
		auth: string;
	};
	userAgent?: string | null;
}

export interface BrowserPushCapability {
	enabled: boolean;
	publicKey: string | null;
	reason: "configured" | "missing_vapid_keys";
}

export interface BrowserPushPayload {
	title: string;
	body: string;
	url?: string;
	tag?: string;
}

function hasVapidConfig(config: RuntimeConfig): boolean {
	return Boolean(
		config.webPushVapidPublicKey?.trim() &&
			config.webPushVapidPrivateKey?.trim() &&
			config.webPushVapidSubject?.trim(),
	);
}

export function getBrowserPushCapability(
	config: RuntimeConfig = getConfig(),
): BrowserPushCapability {
	if (!hasVapidConfig(config)) {
		return {
			enabled: false,
			publicKey: null,
			reason: "missing_vapid_keys",
		};
	}
	return {
		enabled: true,
		publicKey: config.webPushVapidPublicKey,
		reason: "configured",
	};
}

export async function upsertBrowserPushSubscription(params: {
	userId: string;
	subscription: BrowserPushSubscriptionInput;
	now?: Date;
}): Promise<void> {
	const now = params.now ?? new Date();
	const endpoint = params.subscription.endpoint.trim();
	const p256dh = params.subscription.keys.p256dh.trim();
	const auth = params.subscription.keys.auth.trim();
	if (!endpoint || !p256dh || !auth) {
		throw new Error("Invalid browser push subscription.");
	}

	await db
		.insert(browserPushSubscriptions)
		.values({
			id: randomUUID(),
			userId: params.userId,
			endpoint,
			p256dh,
			auth,
			userAgent: params.subscription.userAgent?.trim() || null,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: browserPushSubscriptions.endpoint,
			set: {
				userId: params.userId,
				p256dh,
				auth,
				userAgent: params.subscription.userAgent?.trim() || null,
				updatedAt: now,
				lastFailureAt: null,
			},
		});
}

export async function deleteBrowserPushSubscription(params: {
	userId: string;
	endpoint: string;
}): Promise<void> {
	await db
		.delete(browserPushSubscriptions)
		.where(
			and(
				eq(browserPushSubscriptions.userId, params.userId),
				eq(browserPushSubscriptions.endpoint, params.endpoint),
			),
		);
}

function pushSubscriptionFromRow(
	row: typeof browserPushSubscriptions.$inferSelect,
) {
	return {
		endpoint: row.endpoint,
		keys: {
			p256dh: row.p256dh,
			auth: row.auth,
		},
	};
}

function isGonePushError(error: unknown): boolean {
	const statusCode =
		typeof error === "object" && error !== null && "statusCode" in error
			? (error as { statusCode?: unknown }).statusCode
			: null;
	return statusCode === 404 || statusCode === 410;
}

export async function sendBrowserPushToUser(params: {
	userId: string;
	payload: BrowserPushPayload;
	config?: RuntimeConfig;
	now?: Date;
}): Promise<{
	attempted: number;
	sent: number;
	removed: number;
	skipped: boolean;
}> {
	const config = params.config ?? getConfig();
	if (!hasVapidConfig(config)) {
		return { attempted: 0, sent: 0, removed: 0, skipped: true };
	}

	webPush.setVapidDetails(
		config.webPushVapidSubject,
		config.webPushVapidPublicKey,
		config.webPushVapidPrivateKey,
	);

	const rows = await db
		.select()
		.from(browserPushSubscriptions)
		.where(eq(browserPushSubscriptions.userId, params.userId));
	let sent = 0;
	let removed = 0;
	const now = params.now ?? new Date();
	for (const row of rows) {
		try {
			await webPush.sendNotification(
				pushSubscriptionFromRow(row),
				JSON.stringify(params.payload),
			);
			sent += 1;
		} catch (error) {
			if (isGonePushError(error)) {
				removed += 1;
				await db
					.delete(browserPushSubscriptions)
					.where(eq(browserPushSubscriptions.id, row.id));
				continue;
			}
			await db
				.update(browserPushSubscriptions)
				.set({ lastFailureAt: now, updatedAt: now })
				.where(eq(browserPushSubscriptions.id, row.id));
			console.warn("[BROWSER_PUSH] Failed to send notification", {
				userId: params.userId,
				error,
			});
		}
	}

	return { attempted: rows.length, sent, removed, skipped: false };
}

export async function notifyAtlasCompletion(params: {
	userId: string;
	conversationId: string;
	jobId: string;
	title: string;
}): Promise<void> {
	const [user] = await db
		.select({ uiLanguage: users.uiLanguage })
		.from(users)
		.where(eq(users.id, params.userId))
		.limit(1);
	const isHungarian = user?.uiLanguage === "hu";
	await sendBrowserPushToUser({
		userId: params.userId,
		payload: {
			title: isHungarian ? "Az Atlas elkészült" : "Atlas complete",
			body:
				params.title ||
				(isHungarian
					? "Az Atlas jelentésed megnyitható."
					: "Your Atlas report is ready."),
			url: `/chat/${encodeURIComponent(params.conversationId)}`,
			tag: `atlas:${params.jobId}`,
		},
	}).catch((error) => {
		console.warn("[BROWSER_PUSH] Atlas completion notification failed", {
			jobId: params.jobId,
			error,
		});
	});
}
