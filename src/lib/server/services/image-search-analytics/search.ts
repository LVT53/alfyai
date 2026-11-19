import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { conversations, imageSearchAttempts } from "$lib/server/db/schema";

/** Allocate on entry to the provider operation. Concurrent requests and an
 * ask_user continuation share start order even when the replies arrive reversed. */
export function startImageSearch(scope: {
	userId: string;
	conversationId: string;
	turnId: string;
}): string | undefined {
	try {
		return db.transaction((tx) => {
			const { userId, conversationId, turnId } = scope;
			const conversation = tx
				.select({ id: conversations.id })
				.from(conversations)
				.where(
					and(
						eq(conversations.id, conversationId),
						eq(conversations.userId, userId),
						eq(conversations.memoryIncognito, false),
					),
				)
				.get();
			if (!conversation) return;
			const earlier = tx
				.select({ id: imageSearchAttempts.id })
				.from(imageSearchAttempts)
				.where(
					and(
						eq(imageSearchAttempts.conversationId, conversationId),
						eq(imageSearchAttempts.turnId, turnId),
					),
				)
				.get();
			const id = randomUUID();
			tx.insert(imageSearchAttempts)
				.values({ id, conversationId, turnId, isExtra: !!earlier })
				.run();
			return id;
		});
	} catch {
		console.warn("[ANALYTICS] Image search start could not be recorded");
		return;
	}
}

export function finishImageSearch(
	id: string | undefined,
	candidateCount: number | null,
): void {
	if (!id) return;
	try {
		db.update(imageSearchAttempts)
			.set({
				status: candidateCount === null ? "failed" : "done",
				candidateCount: candidateCount ?? 0,
			})
			.where(
				and(
					eq(imageSearchAttempts.id, id),
					eq(imageSearchAttempts.status, "pending"),
				),
			)
			.run();
	} catch {
		console.warn("[ANALYTICS] Image search outcome could not be recorded");
	}
}
