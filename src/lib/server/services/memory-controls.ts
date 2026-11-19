import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { conversations, memoryAccounts, users } from "$lib/server/db/schema";

/**
 * Per-user + per-conversation memory controls.
 *
 * Two independent switches gate the memory subsystem:
 *  - users.memoryEnabled: the user's master toggle. When false, nothing is
 *    learned OR recalled for this user anywhere.
 *  - conversations.memoryIncognito: a per-conversation privacy mode. When true,
 *    that conversation is never fed to the memory pipeline AND never has memory
 *    or project context injected into its prompts.
 *
 * These helpers are the single source of truth for those gates so the write
 * side (judge intake, consolidation) and the read side (context injection) stay
 * consistent.
 */

export async function isUserMemoryEnabled(userId: string): Promise<boolean> {
	const [row] = await db
		.select({ memoryEnabled: users.memoryEnabled })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	// A missing account never grants permission to learn or recall.
	const account = db
		.select({ state: memoryAccounts.lifecycleState })
		.from(memoryAccounts)
		.where(eq(memoryAccounts.userId, userId))
		.get();
	return Boolean(
		row?.memoryEnabled && (!account || account.state === "active"),
	);
}

export async function isConversationIncognito(
	conversationId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ memoryIncognito: conversations.memoryIncognito })
		.from(conversations)
		.where(eq(conversations.id, conversationId))
		.limit(1);
	return row?.memoryIncognito ?? true;
}

/**
 * Whether memory should be captured/recalled for a specific conversation:
 * the user's master toggle is on AND the conversation is not incognito.
 * Missing accounts, conversations and failed control reads never authorize memory.
 */
export async function isMemoryActiveForConversation(params: {
	userId: string;
	conversationId: string;
}): Promise<boolean> {
	const [row] = await db
		.select({
			enabled: users.memoryEnabled,
			incognito: conversations.memoryIncognito,
		})
		.from(conversations)
		.innerJoin(users, eq(users.id, conversations.userId))
		.where(
			and(
				eq(conversations.id, params.conversationId),
				eq(conversations.userId, params.userId),
			),
		)
		.limit(1);
	const account = db
		.select({ state: memoryAccounts.lifecycleState })
		.from(memoryAccounts)
		.where(eq(memoryAccounts.userId, params.userId))
		.get();
	return Boolean(
		row?.enabled && !row.incognito && (!account || account.state === "active"),
	);
}

/** Only opaque jobs belonging to this authenticated account's tenant are exposed. */
export async function getNativeMemoryCleanupStatus(userId: string) {
	const { memoryAccounts, memoryDeliveryJobs } = await import(
		"$lib/server/db/schema"
	);
	const account = db
		.select()
		.from(memoryAccounts)
		.where(eq(memoryAccounts.userId, userId))
		.get();
	if (!account) return { nativeCleanupPending: false, cleanupOperations: [] };
	const jobs = db
		.select()
		.from(memoryDeliveryJobs)
		.where(
			and(
				eq(memoryDeliveryJobs.userId, account.tenantId),
				eq(memoryDeliveryJobs.kind, "cleanup"),
			),
		)
		.all();
	const cleanupOperations = jobs.map((job) => ({
		id: job.id,
		status: job.status,
		retryable: job.retryable,
	}));
	return {
		nativeCleanupPending: jobs.some((job) => job.status !== "succeeded"),
		cleanupOperations,
	};
}
export async function retryNativeMemoryCleanup(
	userId: string,
	operationId: string,
) {
	const { memoryAccounts, memoryDeliveryJobs } = await import(
		"$lib/server/db/schema"
	);
	const account = db
		.select()
		.from(memoryAccounts)
		.where(eq(memoryAccounts.userId, userId))
		.get();
	if (!account) return null;
	const job = db
		.select()
		.from(memoryDeliveryJobs)
		.where(
			and(
				eq(memoryDeliveryJobs.id, operationId),
				eq(memoryDeliveryJobs.userId, account.tenantId),
				eq(memoryDeliveryJobs.kind, "cleanup"),
			),
		)
		.get();
	if (!job) return null;
	const { retry } = await import("./jobs");
	const { memoryDeliveryJob } = await import("./memory-profile/delivery-job");
	await retry(memoryDeliveryJob, job.id, { userId: account.tenantId });
	return getNativeMemoryCleanupStatus(userId);
}
