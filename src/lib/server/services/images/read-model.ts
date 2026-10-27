// The cards of a conversation as the chat page draws them: each card with its
// visible takes, oldest first. Read-only; the actions live in `cards.ts`
// (use) and `card-actions.ts` (another, ownership).

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import { imageCards, imageFiles, imageJobs } from "$lib/server/db/schema";
import { NEW_PICTURE_CANVAS } from "./canvas";
import { type MadeFrom, parseTakeRequest } from "./take-request";

export type ImageTakePhase =
	| "submitted"
	| "starting"
	| "rendering"
	| "finishing";

const PHASES: readonly string[] = [
	"submitted",
	"starting",
	"rendering",
	"finishing",
];

export type ImageTakeView = {
	id: string;
	status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
	phase: ImageTakePhase | null;
	/** Milliseconds: when the take entered its phase. */
	phaseAt: number | null;
	queueAhead: number | null;
	progressPercent: number | null;
	etaSeconds: number | null;
	/** The request's canvas: the card reserves this box while the take renders. */
	canvas: { width: number; height: number };
	fileId: string | null;
	width: number | null;
	height: number | null;
	hasAlpha: boolean;
	baseFileId: string | null;
	sourceFileIds: string[];
	retried: boolean;
	errorCode: string | null;
	retryable: boolean;
	versionNumber: number | null;
	toolCallId: string | null;
	/** Milliseconds. */
	createdAt: number;
};

export type ImageCardView = {
	id: string;
	conversationId: string;
	turnId: string;
	artifactId: string | null;
	title: string;
	madeFrom: MadeFrom;
	sourceCount: number;
	pickedTakeId: string | null;
	takes: ImageTakeView[];
};

/** Most takes a card shows at once; Another is refused beyond it. */
export const MAX_VISIBLE_TAKES_PER_CARD = 8;

function viewStatus(status: string): ImageTakeView["status"] {
	return status === "queued" ||
		status === "running" ||
		status === "succeeded" ||
		status === "cancelled"
		? status
		: "failed";
}

export async function listConversationImageCards(
	userId: string,
	conversationId: string,
): Promise<ImageCardView[]> {
	const cards = await db
		.select()
		.from(imageCards)
		.where(
			and(
				eq(imageCards.userId, userId),
				eq(imageCards.conversationId, conversationId),
			),
		)
		.orderBy(asc(imageCards.createdAt), sql`${imageCards}.rowid`);
	if (cards.length === 0) return [];

	const takes = await db
		.select()
		.from(imageJobs)
		.where(
			and(
				eq(imageJobs.userId, userId),
				eq(imageJobs.conversationId, conversationId),
				eq(imageJobs.hidden, 0),
			),
		)
		.orderBy(asc(imageJobs.createdAt), sql`${imageJobs}.rowid`);

	const fileIds = takes.flatMap((take) =>
		take.resultFileId ? [take.resultFileId] : [],
	);
	const files =
		fileIds.length === 0
			? []
			: await db
					.select({
						id: imageFiles.id,
						width: imageFiles.width,
						height: imageFiles.height,
						hasAlpha: imageFiles.hasAlpha,
					})
					.from(imageFiles)
					.where(inArray(imageFiles.id, fileIds));
	const fileById = new Map(files.map((file) => [file.id, file]));

	const byCard = new Map<string, ImageTakeView[]>();
	for (const take of takes) {
		const request = parseTakeRequest(take.requestJson);
		const file = take.resultFileId ? fileById.get(take.resultFileId) : null;
		const view: ImageTakeView = {
			id: take.id,
			status: viewStatus(take.status),
			phase:
				take.phase && PHASES.includes(take.phase)
					? (take.phase as ImageTakePhase)
					: null,
			phaseAt: take.phaseAt,
			queueAhead: take.queueAhead,
			progressPercent: take.progressPercent,
			etaSeconds: take.etaSeconds,
			canvas: request?.canvas ?? NEW_PICTURE_CANVAS.landscape,
			fileId: file?.id ?? null,
			width: file?.width ?? null,
			height: file?.height ?? null,
			hasAlpha: Boolean(file?.hasAlpha),
			baseFileId:
				request?.inputs.find((input) => input.role === "base")?.fileId ?? null,
			sourceFileIds:
				request?.inputs
					.filter((input) => input.role === "reference")
					.map((input) => input.fileId) ?? [],
			retried: take.retried === 1,
			errorCode: take.errorCode,
			retryable: take.retryable,
			versionNumber: take.versionNumber,
			toolCallId: take.toolCallId,
			createdAt: take.createdAt.getTime(),
		};
		const list = byCard.get(take.cardId) ?? [];
		list.push(view);
		byCard.set(take.cardId, list);
	}

	return cards.map((card) => ({
		id: card.id,
		conversationId: card.conversationId,
		turnId: card.turnId,
		artifactId: card.artifactId,
		title: card.title,
		madeFrom: card.madeFrom as MadeFrom,
		sourceCount: card.sourceCount,
		pickedTakeId: card.pickedTakeId,
		takes: byCard.get(card.id) ?? [],
	}));
}
