import { and, eq, sql } from "drizzle-orm";
import { memoryEvents } from "$lib/server/db/schema";
import type { Tx } from "../jobs/types";
import { parseJsonRecord } from "./internal-json";

export function readMemoryScopeMoves(
	tx: Tx,
	userId: string,
	epoch: number,
	conversationId?: string,
) {
	const moves = tx
		.select()
		.from(memoryEvents)
		.where(
			and(
				eq(memoryEvents.userId, userId),
				eq(memoryEvents.eventType, "memory_scope_moved"),
				conversationId
					? eq(memoryEvents.conversationId, conversationId)
					: undefined,
			),
		)
		.orderBy(sql`rowid DESC`)
		.all();
	const byConversation = new Map<string, typeof moves>();
	for (const move of moves) {
		if (
			!move.conversationId ||
			parseJsonRecord(move.payloadJson).epoch !== epoch
		)
			continue;
		const history = byConversation.get(move.conversationId) ?? [];
		history.push(move);
		byConversation.set(move.conversationId, history);
	}
	return byConversation;
}

/** Walk authorized moves back to the time of the particular message being considered. */
export function memoryScopeAt(
	moves: (typeof memoryEvents.$inferSelect)[],
	targetScope: string,
	messageAt: Date,
	firstSourceScope?: string,
): string | null {
	let origin = targetScope;
	for (const move of moves) {
		if (move.observedAt < messageAt) continue;
		// Earlier releases updated an edge in place. Its last timestamp does
		// not prove transit order, so only an independently scoped source
		// can disambiguate affected history from those rows.
		if (
			!move.subjectId ||
			move.relatedId !== origin ||
			!move.eventKey.startsWith(`u:${move.userId}:memory_scope_moved:`)
		)
			return firstSourceScope === targetScope || firstSourceScope === "personal"
				? firstSourceScope
				: null;
		if (
			move.observedAt.getTime() === messageAt.getTime() &&
			move.subjectId.startsWith("project:") &&
			move.subjectId !== targetScope &&
			firstSourceScope !== targetScope &&
			firstSourceScope !== "personal"
		)
			return null;
		origin = move.subjectId;
	}
	return origin;
}

export function hasConflictingScopeOrigin(
	moves: (typeof memoryEvents.$inferSelect)[],
	targetScope: string,
	messageAt: Date,
	firstSourceScope?: string,
): boolean {
	if (
		firstSourceScope?.startsWith("project:") &&
		firstSourceScope !== targetScope
	)
		return true;
	const origin = memoryScopeAt(moves, targetScope, messageAt, firstSourceScope);
	return !origin || (origin.startsWith("project:") && origin !== targetScope);
}
