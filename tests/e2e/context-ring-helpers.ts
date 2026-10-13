// A real conversation with the numbers the context ring is made of.
//
// The ring only renders once there is something to measure, so the specs of its
// popup seed a conversation plus its persisted context status and usage row and
// load the ordinary chat route: the popup under test is the production one, with
// production data.
import { expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db";
import {
	conversationContextStatus,
	conversations,
	messages,
	usageEvents,
	users,
} from "../../src/lib/server/db/schema";

export async function seedConversationWithContext(
	id: string,
	title: string,
): Promise<void> {
	const [admin] = await db
		.select()
		.from(users)
		.where(eq(users.email, "admin@local"))
		.limit(1);
	expect(admin, "the e2e admin must exist").toBeTruthy();

	await db.delete(usageEvents).where(eq(usageEvents.conversationId, id));
	await db
		.delete(conversationContextStatus)
		.where(eq(conversationContextStatus.conversationId, id));
	await db.delete(messages).where(eq(messages.conversationId, id));
	await db.delete(conversations).where(eq(conversations.id, id));

	const now = new Date();
	await db.insert(conversations).values({
		id,
		userId: admin.id,
		title,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(messages).values([
		{
			id: `${id}-msg-1`,
			conversationId: id,
			messageSequence: 1,
			role: "user" as const,
			content: "Summarise what you know about this project.",
			createdAt: now,
		},
		{
			id: `${id}-msg-2`,
			conversationId: id,
			messageSequence: 2,
			role: "assistant" as const,
			content: "Here is the summary you asked for.",
			createdAt: now,
		},
	]);
	// Layers are what the popup's chip row renders, and the usage row is what
	// gives it its cost hero.
	await db.insert(conversationContextStatus).values({
		conversationId: id,
		userId: admin.id,
		estimatedTokens: 51200,
		promptTokens: 51200,
		promptTokensSource: "provider",
		maxContextTokens: 262144,
		thresholdTokens: 209715,
		targetTokens: 157286,
		compactionMode: "none",
		recentTurnCount: 12,
		layersUsedJson: JSON.stringify(["session", "documents", "working_set"]),
		updatedAt: now,
	});
	await db.insert(usageEvents).values({
		id: `${id}-usage-1`,
		userId: admin.id,
		conversationId: id,
		messageId: `${id}-msg-2`,
		modelId: "model1",
		promptTokens: 48000,
		completionTokens: 3200,
		totalTokens: 51200,
		billingMonth: "2026-09",
		costUsdMicros: 420000,
		createdAt: now,
	});
}
