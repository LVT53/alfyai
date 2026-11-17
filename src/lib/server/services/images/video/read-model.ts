// A conversation's video cards as the chat page draws them: one card per Video
// item, carrying the take it currently shows. Read-only; the actions live in
// `card-actions.ts`.
//
// A video take has no card row of its own (docs/plans/ltx-video, slice 4: a
// take makes a `video` artifact or appends a version to the one it names), so
// this read derives the card from the takes themselves. All the takes of one
// item are one card, and the newest is what it shows: Another queues a take
// for the same item and replaces what the card draws. A take's `make_video`
// call names its card first (`videoCardKey`), so a first take that failed and
// the one Another queued beside it stay one card after the second lands and
// records the item it made.
//
// The card's id is its FIRST take's id, which never changes: the tool's
// `videoCardId` metadata names it, and a read after the clip lands, another
// take runs or a retry settles still finds the same card.

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type {
	VideoCardView,
	VideoTakeView,
} from "$lib/components/artifacts/video/video-card-view";
import { db } from "$lib/server/db";
import { imageFiles, videoJobs } from "$lib/server/db/schema";
import type { VideoVersionBody } from "$lib/shared/artifacts/video-body";
import { etaSecondsAt } from "../take-eta";
import {
	parseVideoTakeRequest,
	videoDurationMs,
	videoSizeForSource,
} from "./request";

/** The card body's own types: the chat's read model produces exactly what the card consumes. */
export type {
	VideoCardView,
	VideoTakeView,
} from "$lib/components/artifacts/video/video-card-view";

const PHASES: readonly string[] = [
	"submitted",
	"starting",
	"rendering",
	"finishing",
];

/** The clip's shape before one lands, when the source still cannot be read: the measured 720p product size. */
const FALLBACK_BOX = { width: 1280, height: 704 };

function viewStatus(status: string): VideoTakeView["status"] {
	return status === "queued" ||
		status === "running" ||
		status === "succeeded" ||
		status === "cancelled"
		? status
		: "failed";
}

/**
 * The key that says two takes are the same card: the `make_video` call that
 * made them whenever the take has one, so a take that later records the item
 * it made (or appends to one) does not move to a card of its own; else the item
 * the request asked to append to; a take with neither is a card alone. The
 * call comes first on purpose: Another queues under the first take's call with
 * no item named, so a card whose first take failed must keep the key its first
 * take had once the next take lands with an artifact. Exported so the card's
 * actions (Another) find the same takes this read draws.
 */
export function videoCardKey(
	take: { id: string; artifactId: string | null; toolCallId: string | null },
	request: ReturnType<typeof parseVideoTakeRequest>,
): string {
	if (take.toolCallId) return `call:${take.toolCallId}`;
	const artifactId = take.artifactId ?? request?.artifactId ?? null;
	if (artifactId) return `artifact:${artifactId}`;
	return `take:${take.id}`;
}

/**
 * The conversation's video cards, oldest first, each with the take it shows.
 * Only the person's own takes of this one chat are read.
 */
export async function listConversationVideoCards(
	userId: string,
	conversationId: string,
): Promise<VideoCardView[]> {
	const takes = await db
		.select()
		.from(videoJobs)
		.where(
			and(
				eq(videoJobs.userId, userId),
				eq(videoJobs.conversationId, conversationId),
			),
		)
		.orderBy(asc(videoJobs.createdAt), sql`${videoJobs}.rowid`);
	if (takes.length === 0) return [];

	const requests = new Map(
		takes.map((take) => [take.id, parseVideoTakeRequest(take.requestJson)]),
	);
	for (const take of takes) {
		if (!requests.get(take.id)) {
			console.error("[VIDEO] A take's request could not be read:", take.id);
		}
	}
	const fileIds = [
		...new Set(
			takes.flatMap((take) => {
				const request = requests.get(take.id);
				return [
					...(take.resultFileId ? [take.resultFileId] : []),
					...(request ? [request.sourceFileId] : []),
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
						durationMs: imageFiles.durationMs,
					})
					.from(imageFiles)
					.where(inArray(imageFiles.id, fileIds));
	const fileById = new Map(files.map((file) => [file.id, file]));

	// The takes of one card, oldest first; the last is the one it shows.
	const groups = new Map<string, typeof takes>();
	for (const take of takes) {
		const key = videoCardKey(take, requests.get(take.id) ?? null);
		const list = groups.get(key) ?? [];
		list.push(take);
		groups.set(key, list);
	}

	const now = Date.now();
	const cards: VideoCardView[] = [];
	for (const group of groups.values()) {
		const first = group[0];
		const shown = group[group.length - 1];
		if (!first || !shown) continue;
		const request = requests.get(shown.id) ?? null;
		const sourceFile = request ? fileById.get(request.sourceFileId) : null;
		const clip = clipForTake(shown, request, fileById);
		const box = sourceFile ? videoSizeForSource(sourceFile) : FALLBACK_BOX;
		const productMs = request ? videoDurationMs(request.durationSeconds) : 5000;
		cards.push({
			id: first.id,
			conversationId,
			artifactId: cardArtifactId(group),
			title: request?.title ?? "",
			// The box is the landed clip's own shape, else the shape its source
			// still gives (so the card never changes size under the player).
			width: clip?.width ?? box.width,
			height: clip?.height ?? box.height,
			durationMs: clip?.durationMs ?? productMs,
			take: {
				id: shown.id,
				status: viewStatus(shown.status),
				phase:
					shown.phase && PHASES.includes(shown.phase)
						? (shown.phase as VideoTakeView["phase"])
						: null,
				phaseAt: shown.phaseAt,
				queueAhead: shown.queueAhead,
				etaSeconds: etaSecondsAt(shown, now),
				errorCode: shown.errorCode,
				retryable: shown.retryable,
				toolCallId: shown.toolCallId,
				createdAt: shown.createdAt.getTime(),
				clip,
			},
		});
	}
	// Oldest card first: `groups` was built in take order, so a card enters
	// when its first take was queued and keeps that place as later takes run.
	return cards;
}

/** The item the card's takes name, when any of them has one. */
function cardArtifactId(takes: { artifactId: string | null }[]): string | null {
	for (const take of takes) {
		if (take.artifactId) return take.artifactId;
	}
	return null;
}

/**
 * The landed clip as the shared version body, built from the take's own result
 * file. A take that has not stored one, or whose row is gone, has none: the
 * card says so rather than play nothing.
 */
function clipForTake(
	take: { resultFileId: string | null },
	request: ReturnType<typeof parseVideoTakeRequest>,
	fileById: Map<
		string,
		{ id: string; width: number; height: number; durationMs: number | null }
	>,
): VideoVersionBody | null {
	if (!take.resultFileId) return null;
	const file = fileById.get(take.resultFileId);
	if (!file) return null;
	return {
		v: 1,
		fileId: file.id,
		// The poster is served from the clip's own id (`?variant=poster`), as the
		// runner writes it.
		posterFileId: file.id,
		width: file.width,
		height: file.height,
		durationMs:
			file.durationMs ??
			(request ? videoDurationMs(request.durationSeconds) : 5000),
		sourceFileId: request?.sourceFileId ?? null,
	};
}
