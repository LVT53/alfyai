// Cards: how a take becomes a version of an Image item (the plan's calls 2 and
// 7). A card is one Image item's pictures for one turn; its takes are the jobs
// of `image-job.ts`. The card's PICK is the take in use as of that card.
//
// A take is HELD while its tool call still decides about it (`held_until`, ms).
// Nothing promotes a held take. When the call is done with it (`releaseHold`)
// or gives up waiting, the first good take of the card becomes the version in
// use; a take that lands later becomes it on landing (the runner calls
// `settleCard`). The claim of the pick is one conditional UPDATE, so "show me
// four" gives one version, however the four land.
//
// This file must not import `image-job.ts` (the runner imports this file, and
// `image-job.ts` loads the runner): "another take" lives in `card-actions.ts`.
// It writes only the take's own columns (`version_number`, `hidden`,
// `held_until`), never the job engine's lifecycle columns.

import { randomUUID } from "node:crypto";
import {
	and,
	asc,
	desc,
	eq,
	isNotNull,
	isNull,
	lte,
	or,
	sql,
} from "drizzle-orm";
import { db } from "$lib/server/db";
import { imageCards, imageJobs } from "$lib/server/db/schema";
import {
	createArtifact,
	deleteLibraryArtifact,
	updateArtifactBody,
} from "$lib/server/services/artifacts";
import {
	type ImageVersionBody,
	serializeImageVersionBody,
} from "$lib/shared/artifacts/image-body";
import { VERSION_SUMMARY } from "$lib/shared/artifacts/version-summaries";
import {
	attachImageFilesToArtifact,
	discardStoredImageFile,
	getImageFile,
	type ImageFile,
} from "./files";
import {
	type MadeFrom,
	parseTakeRequest,
	type StoredTakeMeasures,
	type TakeRequest,
} from "./take-request";

type CardRow = typeof imageCards.$inferSelect;
type TakeRow = typeof imageJobs.$inferSelect;

export async function createCard(input: {
	userId: string;
	conversationId: string;
	turnId: string;
	artifactId: string | null;
	title: string;
	madeFrom: MadeFrom;
	sourceCount: number;
}): Promise<{ cardId: string }> {
	const cardId = randomUUID();
	await db.insert(imageCards).values({
		id: cardId,
		userId: input.userId,
		conversationId: input.conversationId,
		turnId: input.turnId,
		artifactId: input.artifactId,
		title: input.title,
		madeFrom: input.madeFrom,
		sourceCount: input.sourceCount,
	});
	return { cardId };
}

function parseMeasures(json: string | null): StoredTakeMeasures | null {
	if (!json) return null;
	try {
		const value = JSON.parse(json) as Partial<StoredTakeMeasures> | null;
		if (!value || typeof value !== "object") return null;
		return value as StoredTakeMeasures;
	} catch {
		return null;
	}
}

/** The version a take is: its picture, what it was made from, and the anchor the guards measure against. */
export function versionBodyForTake(
	take: {
		id: string;
		seed: number;
		request: TakeRequest;
		measures: StoredTakeMeasures | null;
	},
	file: ImageFile,
): ImageVersionBody {
	const { request, measures } = take;
	let anchorFileId = file.id;
	let chainSinceAnchor = 0;
	if (request.mode === "edit") {
		if (measures?.anchorIsResult) {
			// The take's own picture is the new anchor.
		} else if (request.anchor) {
			anchorFileId = request.anchor.fileId;
			chainSinceAnchor =
				measures?.chainSinceAnchor ?? request.anchor.chainSinceAnchor;
		}
	}
	return {
		v: 1,
		fileId: file.id,
		width: file.width,
		height: file.height,
		hasAlpha: file.hasAlpha,
		baseFileId:
			request.inputs.find((input) => input.role === "base")?.fileId ?? null,
		sources: request.inputs
			.filter((input) => input.role === "reference")
			.map((input) => ({ fileId: input.fileId, name: input.name })),
		marks: request.marks,
		prompt: request.prompt,
		takeId: take.id,
		seed: take.seed,
		anchorFileId,
		chainSinceAnchor,
	};
}

/** The upload's normalized copy (the take's base input) as version 1: no prompt, seed or take, its own anchor. */
export function versionBodyForPhoto(file: ImageFile): ImageVersionBody {
	return {
		v: 1,
		fileId: file.id,
		width: file.width,
		height: file.height,
		hasAlpha: file.hasAlpha,
		baseFileId: null,
		sources: [],
		marks: null,
		prompt: null,
		takeId: null,
		seed: null,
		anchorFileId: file.id,
		chainSinceAnchor: 0,
	};
}

type ReadyTake = {
	row: TakeRow;
	request: TakeRequest;
	file: ImageFile;
	body: ImageVersionBody;
};

/** A take the card can show: succeeded, with a readable request and a picture the person may see. */
async function readyTake(row: TakeRow): Promise<ReadyTake | null> {
	if (row.status !== "succeeded" || !row.resultFileId) return null;
	const request = parseTakeRequest(row.requestJson);
	if (!request) return null;
	const file = await getImageFile({
		userId: row.userId,
		fileId: row.resultFileId,
		conversationId: row.conversationId,
	});
	if (!file) return null;
	return {
		row,
		request,
		file,
		body: versionBodyForTake(
			{
				id: row.id,
				seed: row.seed,
				request,
				measures: parseMeasures(row.measuresJson),
			},
			file,
		),
	};
}

function notHeld(now: number) {
	return or(isNull(imageJobs.heldUntil), lte(imageJobs.heldUntil, now));
}

async function readCard(cardId: string): Promise<CardRow | null> {
	const [row] = await db
		.select()
		.from(imageCards)
		.where(eq(imageCards.id, cardId))
		.limit(1);
	return row ?? null;
}

async function readTake(takeId: string): Promise<TakeRow | null> {
	const [row] = await db
		.select()
		.from(imageJobs)
		.where(eq(imageJobs.id, takeId))
		.limit(1);
	return row ?? null;
}

/** Eligible takes of a card, oldest first: succeeded, not hidden, not held, with a file. */
async function eligibleTakes(cardId: string): Promise<TakeRow[]> {
	return db
		.select()
		.from(imageJobs)
		.where(
			and(
				eq(imageJobs.cardId, cardId),
				eq(imageJobs.status, "succeeded"),
				eq(imageJobs.hidden, 0),
				isNotNull(imageJobs.resultFileId),
				notHeld(Date.now()),
			),
		)
		.orderBy(asc(imageJobs.createdAt), sql`${imageJobs}.rowid`);
}

function fileIdsOf(ready: ReadyTake): string[] {
	const ids = new Set<string>([ready.file.id]);
	for (const input of ready.request.inputs) ids.add(input.fileId);
	if (ready.body.anchorFileId) ids.add(ready.body.anchorFileId);
	return [...ids];
}

async function setVersionNumber(
	takeId: string,
	versionNumber: number,
): Promise<void> {
	await db
		.update(imageJobs)
		.set({ versionNumber })
		.where(eq(imageJobs.id, takeId));
}

function touchCard(
	cardId: string,
	set: Partial<typeof imageCards.$inferInsert>,
) {
	return db
		.update(imageCards)
		.set({ ...set, updatedAt: new Date() })
		.where(eq(imageCards.id, cardId))
		.run();
}

const NOTHING = {
	pickedTakeId: null,
	artifactId: null,
	versionNumber: null,
} as const;

/** The card has no item to show them on: every landed picture of it goes, file and row. */
async function discardLandedTakes(card: CardRow): Promise<void> {
	const rows = await db
		.select({ fileId: imageJobs.resultFileId })
		.from(imageJobs)
		.where(
			and(
				eq(imageJobs.cardId, card.id),
				eq(imageJobs.status, "succeeded"),
				isNotNull(imageJobs.resultFileId),
			),
		);
	for (const { fileId } of rows) {
		if (!fileId) continue;
		await discardStoredImageFile({
			id: fileId,
			conversationId: card.conversationId,
		}).catch(() => undefined);
	}
}

/** The item is gone: the card keeps no item and no pick, and the take's picture, which nothing will show, goes. */
async function itemGone(card: CardRow, ready: ReadyTake): Promise<void> {
	await touchCard(card.id, { artifactId: null, pickedTakeId: null });
	await discardStoredImageFile(ready.file).catch(() => undefined);
}

/**
 * Makes one take of the card the version in use when the card has none yet.
 * The winner is `preferTakeId` if eligible, else the oldest eligible take.
 * Only the caller whose conditional UPDATE changed a row goes on.
 */
export async function settleCard(
	cardId: string,
	options: { preferTakeId?: string } = {},
): Promise<{
	pickedTakeId: string | null;
	artifactId: string | null;
	versionNumber: number | null;
}> {
	const card = await readCard(cardId);
	if (!card) return NOTHING;
	if (card.pickedTakeId) {
		const picked = await readTake(card.pickedTakeId);
		return {
			pickedTakeId: card.pickedTakeId,
			artifactId: card.artifactId,
			versionNumber: picked?.versionNumber ?? null,
		};
	}
	// A change of an existing item whose item is gone has nothing to land on:
	// it must not make a new item out of a deleted one.
	if (card.madeFrom === "change" && !card.artifactId) {
		await discardLandedTakes(card);
		return NOTHING;
	}

	const takes = await eligibleTakes(cardId);
	const ordered = options.preferTakeId
		? [
				...takes.filter((take) => take.id === options.preferTakeId),
				...takes.filter((take) => take.id !== options.preferTakeId),
			]
		: takes;
	let ready: ReadyTake | null = null;
	for (const take of ordered) {
		ready = await readyTake(take);
		if (ready) break;
	}
	if (!ready) return NOTHING;

	const claimed = db
		.update(imageCards)
		.set({ pickedTakeId: ready.row.id, updatedAt: new Date() })
		.where(and(eq(imageCards.id, cardId), isNull(imageCards.pickedTakeId)))
		.run();
	if (claimed.changes === 0) return settleCardAfterLostClaim(cardId);

	const undo = () => touchCard(cardId, { pickedTakeId: null });
	const summary = ready.request.summary;
	let artifactId = card.artifactId;
	let versionNumber: number;
	let madeHere: string | null = null;
	try {
		if (artifactId) {
			const written = await updateArtifactBody({
				userId: card.userId,
				artifactId,
				body: serializeImageVersionBody(ready.body),
				author: "alfy",
				summary: summary ?? VERSION_SUMMARY.alfyChangedPicture,
				conversationId: card.conversationId,
			});
			if (!written.ok) {
				if (written.reason === "not_found") await itemGone(card, ready);
				else await undo();
				return NOTHING;
			}
			versionNumber = written.versionNumber;
		} else if (ready.request.baseFromUpload) {
			const baseId = ready.request.inputs.find(
				(input) => input.role === "base",
			)?.fileId;
			const baseFile = baseId
				? await getImageFile({
						userId: card.userId,
						fileId: baseId,
						conversationId: card.conversationId,
					})
				: null;
			if (!baseFile) {
				await undo();
				return NOTHING;
			}
			const created = await createArtifact({
				userId: card.userId,
				conversationId: card.conversationId,
				kind: "image",
				title: card.title,
				body: serializeImageVersionBody(versionBodyForPhoto(baseFile)),
				author: "user",
				versionSummary: VERSION_SUMMARY.userPhoto,
			});
			if (!created.ok) {
				await undo();
				return NOTHING;
			}
			artifactId = created.artifact.id;
			madeHere = artifactId;
			const written = await updateArtifactBody({
				userId: card.userId,
				artifactId,
				body: serializeImageVersionBody(ready.body),
				author: "alfy",
				summary: summary ?? VERSION_SUMMARY.alfyChangedPicture,
				conversationId: card.conversationId,
			});
			if (!written.ok) {
				await deleteLibraryArtifact(card.userId, artifactId).catch(
					() => undefined,
				);
				await undo();
				return NOTHING;
			}
			versionNumber = written.versionNumber;
			await attachImageFilesToArtifact([baseFile.id], artifactId);
		} else {
			const created = await createArtifact({
				userId: card.userId,
				conversationId: card.conversationId,
				kind: "image",
				title: card.title,
				body: serializeImageVersionBody(ready.body),
				author: "alfy",
				versionSummary: summary ?? VERSION_SUMMARY.alfyPicture,
			});
			if (!created.ok) {
				await undo();
				return NOTHING;
			}
			artifactId = created.artifact.id;
			versionNumber = created.artifact.versionNumber;
		}
	} catch (error) {
		if (madeHere) {
			await deleteLibraryArtifact(card.userId, madeHere).catch(() => undefined);
		}
		await undo();
		throw error;
	}

	const linked = touchCard(cardId, { artifactId });
	if (linked.changes === 0) {
		// The chat went while the item was being made: nothing may stay.
		if (!card.artifactId) {
			await deleteLibraryArtifact(card.userId, artifactId).catch(
				() => undefined,
			);
		}
		await discardStoredImageFile(ready.file).catch(() => undefined);
		return NOTHING;
	}
	await setVersionNumber(ready.row.id, versionNumber);
	await attachImageFilesToArtifact(fileIdsOf(ready), artifactId);
	return { pickedTakeId: ready.row.id, artifactId, versionNumber };
}

/** Another caller holds the claim: report the card as it stands. */
async function settleCardAfterLostClaim(cardId: string) {
	const card = await readCard(cardId);
	if (!card?.pickedTakeId) return NOTHING;
	const picked = await readTake(card.pickedTakeId);
	return {
		pickedTakeId: card.pickedTakeId,
		artifactId: card.artifactId,
		versionNumber: picked?.versionNumber ?? null,
	};
}

/** The tool call is done with the take: it may now become the version in use. */
export async function releaseHold(takeId: string): Promise<{
	pickedTakeId: string | null;
	artifactId: string | null;
	versionNumber: number | null;
}> {
	const take = await readTake(takeId);
	if (!take) return NOTHING;
	await db
		.update(imageJobs)
		.set({ heldUntil: null })
		.where(eq(imageJobs.id, takeId));
	return settleCard(take.cardId, { preferTakeId: takeId });
}

/**
 * The card's newest take (by creation) that finished and is still on the tray, held or not,
 * as the version it would be: what the next change in the same turn builds on.
 */
export async function newestFinishedTake(cardId: string): Promise<{
	file: ImageFile;
	seed: number;
	body: ImageVersionBody;
} | null> {
	const rows = await db
		.select()
		.from(imageJobs)
		.where(
			and(
				eq(imageJobs.cardId, cardId),
				eq(imageJobs.status, "succeeded"),
				eq(imageJobs.hidden, 0),
				isNotNull(imageJobs.resultFileId),
			),
		)
		.orderBy(desc(imageJobs.createdAt), sql`${imageJobs}.rowid desc`);
	for (const row of rows) {
		const ready = await readyTake(row);
		if (ready) return { file: ready.file, seed: row.seed, body: ready.body };
	}
	return null;
}

/** The take shown is one the tool made again after a miss; the card says "retried once". */
export async function markTakeRetried(takeId: string): Promise<void> {
	await db
		.update(imageJobs)
		.set({ retried: 1 })
		.where(eq(imageJobs.id, takeId));
}

/** Takes a take off the card's tray. The take in use cannot be hidden. */
export async function hideTake(takeId: string): Promise<void> {
	const take = await readTake(takeId);
	if (!take) return;
	const card = await readCard(take.cardId);
	if (card?.pickedTakeId === takeId) {
		throw new Error("The take in use cannot be hidden.");
	}
	await db.update(imageJobs).set({ hidden: 1 }).where(eq(imageJobs.id, takeId));
}

export async function useTake(params: {
	userId: string;
	takeId: string;
	conversationId?: string | null;
}): Promise<
	| { ok: true; versionNumber: number }
	| {
			ok: false;
			reason: "not_found" | "not_ready" | "already_in_use" | "item_deleted";
	  }
> {
	const take = await readTake(params.takeId);
	if (
		!take ||
		take.userId !== params.userId ||
		take.hidden === 1 ||
		(params.conversationId && take.conversationId !== params.conversationId)
	) {
		return { ok: false, reason: "not_found" };
	}
	let card = await readCard(take.cardId);
	if (!card) return { ok: false, reason: "not_found" };
	if (card.pickedTakeId === take.id) {
		return { ok: false, reason: "already_in_use" };
	}
	if (take.heldUntil !== null && take.heldUntil > Date.now()) {
		return { ok: false, reason: "not_ready" };
	}
	const ready = await readyTake(take);
	if (!ready) return { ok: false, reason: "not_ready" };

	if (!card.pickedTakeId) {
		if (card.madeFrom === "change" && !card.artifactId) {
			return { ok: false, reason: "item_deleted" };
		}
		const settled = await settleCard(card.id, { preferTakeId: take.id });
		if (settled.pickedTakeId === take.id && settled.versionNumber !== null) {
			return { ok: true, versionNumber: settled.versionNumber };
		}
		card = await readCard(card.id);
		if (!card) return { ok: false, reason: "not_found" };
		if (!card.pickedTakeId) return { ok: false, reason: "item_deleted" };
		if (card.pickedTakeId === take.id) {
			return { ok: false, reason: "already_in_use" };
		}
	}
	if (!card.artifactId) return { ok: false, reason: "item_deleted" };

	const written = await updateArtifactBody({
		userId: card.userId,
		artifactId: card.artifactId,
		body: serializeImageVersionBody(ready.body),
		author: "user",
		summary: VERSION_SUMMARY.pickedTake,
		conversationId: card.conversationId,
	});
	if (!written.ok) {
		if (written.reason === "not_found") {
			await touchCard(card.id, { artifactId: null });
			return { ok: false, reason: "item_deleted" };
		}
		return { ok: false, reason: "not_ready" };
	}
	await touchCard(card.id, { pickedTakeId: take.id });
	await setVersionNumber(take.id, written.versionNumber);
	await attachImageFilesToArtifact(fileIdsOf(ready), card.artifactId);
	return { ok: true, versionNumber: written.versionNumber };
}

/**
 * The model's retry of the take in use: the new take is appended as a version
 * (History keeps the missed one), becomes the pick, and the old take leaves the tray.
 */
export async function replacePick(params: {
	cardId: string;
	takeId: string;
}): Promise<{ versionNumber: number | null }> {
	const card = await readCard(params.cardId);
	const take = await readTake(params.takeId);
	if (!card || !take) return { versionNumber: null };
	if (!card.pickedTakeId) {
		return {
			versionNumber: (await settleCard(card.id, { preferTakeId: take.id }))
				.versionNumber,
		};
	}
	if (card.pickedTakeId === take.id || !card.artifactId) {
		return { versionNumber: null };
	}
	const ready = await readyTake(take);
	if (!ready) return { versionNumber: null };
	const old = await readTake(card.pickedTakeId);
	const oldSummary =
		(old ? parseTakeRequest(old.requestJson)?.summary : null) ??
		VERSION_SUMMARY.alfyChangedPicture;

	const written = await updateArtifactBody({
		userId: card.userId,
		artifactId: card.artifactId,
		body: serializeImageVersionBody(ready.body),
		author: "alfy",
		summary: oldSummary,
		conversationId: card.conversationId,
	});
	if (!written.ok) {
		if (written.reason === "not_found") await itemGone(card, ready);
		return { versionNumber: null };
	}
	await touchCard(card.id, { pickedTakeId: take.id });
	await setVersionNumber(take.id, written.versionNumber);
	await db
		.update(imageJobs)
		.set({ hidden: 1 })
		.where(eq(imageJobs.id, card.pickedTakeId));
	await attachImageFilesToArtifact(fileIdsOf(ready), card.artifactId);
	return { versionNumber: written.versionNumber };
}

/**
 * Boot sweep: cards with no pick and a take that succeeded whose hold has run
 * out (a process that died between landing and settling). Answers how many
 * cards got a pick.
 */
export async function settleHeldCards(now = Date.now()): Promise<number> {
	const rows = await db
		.selectDistinct({ cardId: imageJobs.cardId })
		.from(imageJobs)
		.innerJoin(imageCards, eq(imageCards.id, imageJobs.cardId))
		.where(
			and(
				isNull(imageCards.pickedTakeId),
				eq(imageJobs.status, "succeeded"),
				eq(imageJobs.hidden, 0),
				isNotNull(imageJobs.resultFileId),
				or(isNull(imageJobs.heldUntil), lte(imageJobs.heldUntil, now)),
			),
		);
	let settled = 0;
	for (const { cardId } of rows) {
		try {
			if ((await settleCard(cardId)).pickedTakeId) settled += 1;
		} catch (error) {
			console.error("[IMAGES] Could not settle a card:", error);
		}
	}
	return settled;
}

/**
 * The boot sweep. A hold belongs to a tool call, and no tool call survives a
 * restart, so every hold is cleared first; otherwise a take held when the
 * process went down would wait out its 130 s and then never be settled (the
 * runner skips held takes, and this sweep runs once). Answers how many cards
 * got a pick.
 */
export async function settleCardsAfterRestart(): Promise<number> {
	await db
		.update(imageJobs)
		.set({ heldUntil: null })
		.where(isNotNull(imageJobs.heldUntil));
	return settleHeldCards();
}
