import { eq } from "drizzle-orm";
import * as schema from "$lib/server/db/schema";

export async function readDeepResearchConversationState(
	conversationId = "conv-1",
) {
	const { db } = await import("$lib/server/db");
	const [conversation] = await db
		.select({
			status: schema.conversations.status,
			sealedAt: schema.conversations.sealedAt,
		})
		.from(schema.conversations)
		.where(eq(schema.conversations.id, conversationId));
	return conversation ?? null;
}

export async function listDeepResearchGeneratedOutputIds() {
	const { db } = await import("$lib/server/db");
	return await db
		.select({ id: schema.artifacts.id })
		.from(schema.artifacts)
		.where(eq(schema.artifacts.type, "generated_output"));
}
