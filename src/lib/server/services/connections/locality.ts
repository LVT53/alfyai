import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import { resolveNormalChatModelRunProvider } from "$lib/server/services/normal-chat-model";
import { isPrivateHostname } from "./net";

/**
 * True when `modelId` resolves to a provider whose base URL is NOT a
 * private/loopback/on-box host — i.e. a third-party cloud model such as
 * DeepSeek, as opposed to the on-box local Qwen. Any failure to resolve the
 * provider (unknown model, disabled provider, malformed baseUrl, ...) is
 * treated as cloud: fail safe means "warn", not "silently allow".
 */
export async function isCloudModel(modelId: string): Promise<boolean> {
	try {
		const provider = await resolveNormalChatModelRunProvider(modelId);
		const { hostname } = new URL(provider.baseUrl);
		return !isPrivateHostname(hostname);
	} catch {
		return true;
	}
}

/** Whether the user has ever acknowledged the cloud-connector warning. */
export async function hasCloudConnectorAck(userId: string): Promise<boolean> {
	const [row] = await db
		.select({ connectionCloudAck: users.connectionCloudAck })
		.from(users)
		.where(eq(users.id, userId));
	return row?.connectionCloudAck ?? false;
}

/** Records that the user has acknowledged the cloud-connector warning. This is sticky — there is no way to un-acknowledge. */
export async function recordCloudConnectorAck(userId: string): Promise<void> {
	await db
		.update(users)
		.set({ connectionCloudAck: true, updatedAt: new Date() })
		.where(eq(users.id, userId));
}

/**
 * True iff the current turn should surface the "connector data is being sent
 * to a third-party cloud model" warning: the selected model is cloud, at
 * least one connector capability is actually active for the turn, and the
 * user has not already acknowledged the warning.
 *
 * `activeCapabilities` is whatever the caller determined to be enabled/in
 * use for this turn (e.g. via getEnabledConnectionCapabilities) — this
 * function does not look that up itself.
 */
export async function shouldWarnCloudConnector(params: {
	userId: string;
	modelId: string;
	activeCapabilities: Iterable<string>;
}): Promise<boolean> {
	const hasActiveCapabilities = !isEmpty(params.activeCapabilities);
	if (!hasActiveCapabilities) return false;

	const [cloud, acked] = await Promise.all([
		isCloudModel(params.modelId),
		hasCloudConnectorAck(params.userId),
	]);
	return cloud && !acked;
}

function isEmpty(values: Iterable<string>): boolean {
	for (const _ of values) return false;
	return true;
}
