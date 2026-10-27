// What a person does to a card from the chat: ask for another take, and the
// ownership check every card route shares. Lives apart from `cards.ts` because
// queueing a take reaches `image-job.ts`, and the runner (which `image-job.ts`
// loads) imports `cards.ts`: this file keeps that loop from closing.

import { and, asc, eq, sql } from "drizzle-orm";
import { getConfig, isImageMakingConfigured } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { imageCards, imageJobs } from "$lib/server/db/schema";
import { getArtifactOwnershipScope } from "$lib/server/services/knowledge/ownership";
import { enqueueTake } from "./image-job";
import { MAX_VISIBLE_TAKES_PER_CARD } from "./read-model";
import { freshSeed } from "./seeds";
import { parseTakeRequest } from "./take-request";

/**
 * The take when the signed-in person may act on it: it is theirs, and the chat
 * it belongs to is in their scope (an incognito chat only when the request
 * names it). Anything else is absent, so another person's take id is a 404.
 */
export async function findOwnTake(params: {
	userId: string;
	takeId: string;
	conversationId?: string | null;
}): Promise<{ id: string; status: string } | null> {
	const [row] = await db
		.select({
			id: imageJobs.id,
			status: imageJobs.status,
			userId: imageJobs.userId,
			conversationId: imageJobs.conversationId,
		})
		.from(imageJobs)
		.where(eq(imageJobs.id, params.takeId))
		.limit(1);
	if (!row || row.userId !== params.userId) return null;
	if (params.conversationId && row.conversationId !== params.conversationId) {
		return null;
	}
	const scope = await getArtifactOwnershipScope(params.userId, {
		conversationId: params.conversationId ?? null,
	});
	if (!scope.conversationIds.has(row.conversationId)) return null;
	return { id: row.id, status: row.status };
}

/**
 * Another take for the card: the card's first request again, origin
 * "another", a seed unlike every seed the card has used. Queued without a hold;
 * when it lands, the runner's `settleCard` makes it the pick only if the card
 * has none.
 */
export async function anotherTake(params: {
	userId: string;
	cardId: string;
	conversationId?: string | null;
}): Promise<
	| { ok: true; takeId: string }
	| { ok: false; reason: "not_found" | "too_many_takes" | "not_configured" }
> {
	const [card] = await db
		.select()
		.from(imageCards)
		.where(
			and(
				eq(imageCards.id, params.cardId),
				eq(imageCards.userId, params.userId),
			),
		)
		.limit(1);
	if (!card) return { ok: false, reason: "not_found" };
	if (params.conversationId && card.conversationId !== params.conversationId) {
		return { ok: false, reason: "not_found" };
	}
	const scope = await getArtifactOwnershipScope(params.userId, {
		conversationId: params.conversationId ?? null,
	});
	if (!scope.conversationIds.has(card.conversationId)) {
		return { ok: false, reason: "not_found" };
	}

	const takes = await db
		.select({
			seed: imageJobs.seed,
			hidden: imageJobs.hidden,
			requestJson: imageJobs.requestJson,
		})
		.from(imageJobs)
		.where(eq(imageJobs.cardId, card.id))
		.orderBy(asc(imageJobs.createdAt), sql`${imageJobs}.rowid`);
	const first = takes[0];
	const request = first ? parseTakeRequest(first.requestJson) : null;
	if (!first || !request) return { ok: false, reason: "not_found" };
	if (!isImageMakingConfigured(getConfig())) {
		return { ok: false, reason: "not_configured" };
	}
	if (
		takes.filter((take) => take.hidden === 0).length >=
		MAX_VISIBLE_TAKES_PER_CARD
	) {
		return { ok: false, reason: "too_many_takes" };
	}

	const avoidSeeds = [
		...new Set([...request.avoidSeeds, ...takes.map((take) => take.seed)]),
	];
	const { takeId } = await enqueueTake({
		userId: card.userId,
		conversationId: card.conversationId,
		cardId: card.id,
		toolCallId: null,
		origin: "another",
		retryOf: null,
		request: { ...request, avoidSeeds },
		seed: freshSeed(avoidSeeds),
		heldUntil: null,
	});
	return { ok: true, takeId };
}
