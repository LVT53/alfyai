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
	/** The request's canvas. */
	canvas: { width: number; height: number };
	/**
	 * The exact pixel size the landed picture will have, known before it lands so
	 * the card reserves the right aspect ratio: for an edit, the size of the base
	 * file the guard composites onto; for a new picture, the canvas.
	 */
	box: { width: number; height: number };
	/** Where the take came from: the tool call (`turn`), the model's automatic second try (`retry`) or the person's Another (`another`). */
	origin: "turn" | "retry" | "another";
	/** The take this one retries (an automatic retry shows in its first take's slot). */
	retryOf: string | null;
	/** The tool call has not yet decided about this take: it cannot be used until released. */
	held: boolean;
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

	const requests = new Map(
		takes.map((take) => [take.id, parseTakeRequest(take.requestJson)]),
	);
	const fileIds = [
		...new Set(
			takes.flatMap((take) => {
				const baseId = requests
					.get(take.id)
					?.inputs.find((input) => input.role === "base")?.fileId;
				return [
					...(take.resultFileId ? [take.resultFileId] : []),
					...(baseId ? [baseId] : []),
				];
			}),
		),
	];
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
		const request = requests.get(take.id) ?? null;
		if (!request) {
			console.error("[IMAGES] A take's request could not be read:", take.id);
		}
		const file = take.resultFileId ? fileById.get(take.resultFileId) : null;
		const canvas = request?.canvas ?? NEW_PICTURE_CANVAS.landscape;
		const baseId =
			request?.mode === "edit"
				? request.inputs.find((input) => input.role === "base")?.fileId
				: undefined;
		const baseFile = baseId ? fileById.get(baseId) : null;
		const now = Date.now();
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
			canvas,
			box: baseFile
				? { width: baseFile.width, height: baseFile.height }
				: canvas,
			origin:
				take.origin === "retry" || take.origin === "another"
					? take.origin
					: "turn",
			retryOf: take.retryOf,
			held: take.heldUntil !== null && take.heldUntil > now,
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
