import { createHash } from "node:crypto";
import {
	and,
	count,
	eq,
	inArray,
	isNull,
	ne,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	conversations,
	imageSearchDisplays,
	messages,
} from "$lib/server/db/schema";
import { imageThumbnailRouteUrl, toolImages } from "$lib/shared/url-provenance";
import type { ThinkingSegment } from "../messages-types";

/** Only a picture the chat renderer actually embeds counts. Its protected route has one
 * encoded URL parameter, so it cannot contain markup or a second HTML attribute. */
async function selectedPictureKeys(
	content: string,
	segments: readonly ThinkingSegment[],
) {
	const candidates = toolImages(segments);
	const thumbnails = new Set(
		candidates.flatMap(({ thumbnail }) => (thumbnail ? [thumbnail] : [])),
	);
	if (!thumbnails.size) return [];
	const { loadMarkdownBlocks, renderMarkdown } = await import(
		"$lib/services/markdown"
	);
	const blocks = await loadMarkdownBlocks(content);
	const selected = new Set<string>();
	for (const block of blocks) {
		const prose =
			block.kind === "checklist"
				? block.items.map((item) => item.text)
				: ["html", "table", "callout", "accordion"].includes(block.kind)
					? [block.raw]
					: [];
		for (const part of prose) {
			const html = await renderMarkdown(part, false, {
				compactExternalLinks: true,
				toolImages: candidates,
			});
			for (const thumbnail of thumbnails) {
				if (
					html.includes(
						`<img class="markdown-image" src="${imageThumbnailRouteUrl(thumbnail)}"`,
					)
				) {
					selected.add(thumbnail);
				}
			}
		}
	}
	return [...selected].map((value) =>
		createHash("sha256").update(value).digest("hex"),
	);
}

export async function recordReplyImages(
	messageId: string,
	content: string,
	segments: readonly ThinkingSegment[],
) {
	const keys = await selectedPictureKeys(content, segments);
	if (!keys.length) return;
	db.transaction((tx) => {
		const message = tx
			.select({ createdAt: messages.createdAt })
			.from(messages)
			.innerJoin(conversations, eq(messages.conversationId, conversations.id))
			.where(
				and(
					eq(messages.id, messageId),
					eq(messages.role, "assistant"),
					isNull(messages.importSource),
					eq(conversations.memoryIncognito, false),
				),
			)
			.get();
		if (!message) return;
		const month = message.createdAt.toISOString().slice(0, 7);
		tx.insert(imageSearchDisplays)
			.values(keys.map((imageKey) => ({ messageId, imageKey, month })))
			.onConflictDoNothing()
			.run();
	});
}

/** A browser can settle only an existing final-reply selection belonging to its
 * signed-in user. Unknown is NULL; a successful visit wins over any failures. */
export async function recordImageLoad(
	userId: string,
	messageId: string,
	imageKey: string,
	outcome: "loaded" | "failed",
) {
	const ownedReply = db
		.select({ id: messages.id })
		.from(messages)
		.innerJoin(conversations, eq(conversations.id, messages.conversationId))
		.where(
			and(
				eq(messages.id, messageId),
				eq(messages.role, "assistant"),
				isNull(messages.importSource),
				eq(conversations.userId, userId),
				eq(conversations.memoryIncognito, false),
			),
		);
	await db
		.update(imageSearchDisplays)
		.set({ outcome })
		.where(
			and(
				inArray(imageSearchDisplays.messageId, ownedReply),
				eq(imageSearchDisplays.imageKey, imageKey),
				or(
					isNull(imageSearchDisplays.outcome),
					outcome === "loaded"
						? ne(imageSearchDisplays.outcome, "loaded")
						: undefined,
				),
			),
		);
}

export async function getMonthlyImageDisplays(scope?: {
	userId: string | null;
	excludedUserIds: string[];
}) {
	const ownership =
		scope && (scope.userId || scope.excludedUserIds.length)
			? inArray(
					imageSearchDisplays.messageId,
					db
						.select({ id: messages.id })
						.from(messages)
						.innerJoin(
							conversations,
							eq(conversations.id, messages.conversationId),
						)
						.where(
							and(
								scope.userId
									? eq(conversations.userId, scope.userId)
									: undefined,
								scope.excludedUserIds.length
									? notInArray(conversations.userId, scope.excludedUserIds)
									: undefined,
							),
						),
				)
			: undefined;
	return db
		.select({
			month: imageSearchDisplays.month,
			shown: count(),
			loaded: sql<number>`sum(case when ${imageSearchDisplays.outcome}='loaded' then 1 else 0 end)`,
			loadFailed: sql<number>`sum(case when ${imageSearchDisplays.outcome}='failed' then 1 else 0 end)`,
		})
		.from(imageSearchDisplays)
		.where(ownership)
		.groupBy(imageSearchDisplays.month);
}
