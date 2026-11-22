// What a person does to a video card from the chat: Stop, Try again, and
// Another. The ownership scope every route shares lives here too. Apart from
// `video-job.ts` because queueing a take reaches it, and the read behind the
// card's id (`read-model.ts`, exported `videoCardKey`) keeps the two agreeing
// about which takes are one card.

import { and, asc, eq, sql } from "drizzle-orm";
import { isVideoMakingConfigured } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { videoJobs } from "$lib/server/db/schema";
import { getArtifactOwnershipScope } from "$lib/server/services/knowledge/ownership";
import { EXPLICIT_REQUEST_MESSAGE } from "$lib/server/services/normal-chat-tools/make-video";
import { isExplicitVariantAllowedFor } from "../picture-check/policy";
import { freshSeed } from "../seeds";
import { videoCardKey } from "./read-model";
import { parseVideoTakeRequest } from "./request";
import { enqueueVideoTake } from "./video-job";

/**
 * The one scope rule: the chat is the request's named chat (when one is named)
 * and is in the person's ownership scope (an incognito chat only when named).
 */
async function inOwnScope(
	userId: string,
	rowConversationId: string,
	named?: string | null,
): Promise<boolean> {
	if (named && rowConversationId !== named) return false;
	const scope = await getArtifactOwnershipScope(userId, {
		conversationId: named ?? null,
	});
	return scope.conversationIds.has(rowConversationId);
}

/**
 * The take when the signed-in person may act on it: it is theirs, and the chat
 * it belongs to is in their scope (an incognito chat only when the request
 * names it). Anything else is absent, so another person's take id is a 404.
 */
export async function findOwnVideoTake(params: {
	userId: string;
	takeId: string;
	conversationId?: string | null;
}): Promise<{
	id: string;
	status: string;
	conversationId: string;
	errorCode: string | null;
} | null> {
	const [row] = await db
		.select({
			id: videoJobs.id,
			status: videoJobs.status,
			userId: videoJobs.userId,
			conversationId: videoJobs.conversationId,
			errorCode: videoJobs.errorCode,
		})
		.from(videoJobs)
		.where(eq(videoJobs.id, params.takeId))
		.limit(1);
	if (!row || row.userId !== params.userId) return null;
	if (
		!(await inOwnScope(
			params.userId,
			row.conversationId,
			params.conversationId,
		))
	) {
		return null;
	}
	return row;
}

/**
 * Another take of the card: the newest take's request again (`request_json`),
 * origin "another", a seed unlike every seed the card has used, and the item
 * the card already has so the new clip appends a version instead of making a
 * second Video. `cardId` is the card's first take id — the id the read model
 * gives the card, and the one the tool's `videoCardId` metadata names.
 */
export async function anotherVideoTake(params: {
	userId: string;
	cardId: string;
	conversationId?: string | null;
}): Promise<
	| { ok: true; takeId: string }
	| { ok: false; reason: "not_found" | "not_configured" }
	| { ok: false; reason: "explicit_request"; message: string }
> {
	const [first] = await db
		.select()
		.from(videoJobs)
		.where(
			and(eq(videoJobs.id, params.cardId), eq(videoJobs.userId, params.userId)),
		)
		.limit(1);
	if (!first) return { ok: false, reason: "not_found" };
	if (
		!(await inOwnScope(
			params.userId,
			first.conversationId,
			params.conversationId,
		))
	) {
		return { ok: false, reason: "not_found" };
	}

	const takes = await db
		.select()
		.from(videoJobs)
		.where(
			and(
				eq(videoJobs.userId, params.userId),
				eq(videoJobs.conversationId, first.conversationId),
			),
		)
		.orderBy(asc(videoJobs.createdAt), sql`${videoJobs}.rowid`);
	const requests = new Map(
		takes.map((take) => [take.id, parseVideoTakeRequest(take.requestJson)]),
	);
	const key = videoCardKey(first, requests.get(first.id) ?? null);
	const group = takes.filter(
		(take) => videoCardKey(take, requests.get(take.id) ?? null) === key,
	);
	const shown = group[group.length - 1];
	const request = shown ? requests.get(shown.id) : null;
	if (!shown || !request) return { ok: false, reason: "not_found" };
	if (!isVideoMakingConfigured()) {
		return { ok: false, reason: "not_configured" };
	}
	// Another is a NEW take, not a reuse of this row: the cloned request's flag
	// is checked against the person making the request, and a value that is no
	// longer allowed keeps the take from being created.
	if (
		request.explicitVariant &&
		!(await isExplicitVariantAllowedFor(params.userId))
	) {
		return {
			ok: false,
			reason: "explicit_request",
			message: EXPLICIT_REQUEST_MESSAGE,
		};
	}

	const avoidSeeds = [...new Set(group.map((take) => take.seed))];
	const artifactId = shown.artifactId ?? request.artifactId ?? null;
	const { takeId } = await enqueueVideoTake({
		userId: params.userId,
		conversationId: shown.conversationId,
		artifactId,
		toolCallId: shown.toolCallId,
		origin: "another",
		retryOf: null,
		request: { ...request, artifactId },
		seed: freshSeed(avoidSeeds),
	});
	return { ok: true, takeId };
}
