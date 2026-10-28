// From a `make_image` call to the take it asks for: which pictures it names,
// whether they may be used, which card the take belongs to and the full
// request the picture server will be given. Nothing here queues a take; the
// tool does, with the plan this returns. The refusals are the model's own
// mistakes, each with one sentence it can act on (ruling 79: English).
//
// The per-call limit lives here and only here (plan's call 10): the lower of
// the admin's `IMAGE_REFERENCE_CAP` and the pictures the graph has slots for.
// A message's own number of pictures is never refused.

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getImageReferenceCap } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { imageJobs } from "$lib/server/db/schema";
import { oneLineName } from "$lib/server/services/vision/turn-images";
import {
	type CanvasSize,
	canvasForEdit,
	canvasForNewPicture,
	type PictureSize,
} from "./canvas";
import { newestFinishedTake } from "./cards";
import {
	type GraphTemplate,
	graphFor,
	imageSlotCount,
} from "./comfyui/templates";
import { getImageItem } from "./files";
import { loadPicture, prepareTakeInputs } from "./inputs";
import type { MadeFrom, TakeRequest } from "./take-request";
import type { TurnPictureIndex, TurnPictureSource } from "./turn-pictures";
import { MAX_TAKES_PER_CARD_PER_TURN, type TurnTakes } from "./turn-takes";

export type MakeImageRefusal =
	| "unknown_picture"
	| "too_many_pictures"
	| "too_many_takes"
	| "too_many_calls"
	| "retry_unknown"
	| "retry_twice";

/** What a call carries (the tool's own schema is assignable to it). */
export type MakeImageRequestInput = {
	prompt: string;
	pictures?: string[];
	title?: string;
	summary?: string;
	size?: PictureSize;
	print?: boolean;
	transparent?: boolean;
	startNew?: boolean;
	retryOf?: string;
};

export type TakePlan = {
	cardKey: string;
	/** The card when this turn already has one for the request, else null: the tool creates it. */
	cardId: string | null;
	/** The Image item a change lands on, else null. */
	artifactId: string | null;
	madeFrom: MadeFrom;
	title: string;
	sourceCount: number;
	request: TakeRequest;
	/** The take this one repeats (a retry), else null. */
	retryOf: string | null;
	/** What this call asked for (see `TurnTakeRecord.callKey`). */
	callKey: string;
	/** The message picture being changed, else null. */
	baseNumber: number | null;
};

type Resolution =
	| { ok: true; plan: TakePlan }
	| { ok: false; refusal: MakeImageRefusal; message: string };

const TITLE_MAX_CHARS = 80;
const TITLE_FALLBACK_WORDS = 8;
const TITLE_FALLBACK = "Picture";

function refuse(refusal: MakeImageRefusal, message: string): Resolution {
	return { ok: false, refusal, message };
}

/**
 * The model's own title (the tool asks for one on every call that starts an
 * Image). Without one, the first words of the person's message, which are in
 * their language: at most eight, never past the first sentence's end, and
 * without its closing punctuation, so a sentence never becomes "room." (and its
 * download "room..png").
 */
function titleFor(given: string | undefined, requestText: string): string {
	const own = oneLineName(given ?? "", TITLE_MAX_CHARS);
	if (own) return own;
	return (
		oneLineName(
			firstSentenceWords(requestText, TITLE_FALLBACK_WORDS)
				.join(" ")
				.replace(/[\s.!?…,;:]+$/u, ""),
			TITLE_MAX_CHARS,
		) || TITLE_FALLBACK
	);
}

/** Short words whose dot is an abbreviation's, not a sentence's end (English and Hungarian). */
const ABBREVIATIONS = new Set([
	"dr",
	"mr",
	"mrs",
	"ms",
	"prof",
	"st",
	"no",
	"vs",
	"etc",
	"e.g",
	"i.e",
	"pl",
	"kb",
	"ld",
	"stb",
	"ill",
	"ún",
	"id",
	"ifj",
	"özv",
	"sz",
	"u",
]);

/**
 * The first words of a message, at most `max`, ending with its first sentence: a
 * word ending in ! ? … ends it, and so does a dot unless the word is an
 * initial ("J.") or a known abbreviation ("Dr.", "pl."), so "Dr. Kovács's
 * office" is not cut to "Dr" (fix round 1).
 */
function firstSentenceWords(text: string, max: number): string[] {
	const words: string[] = [];
	for (const word of text.trim().split(/\s+/).filter(Boolean)) {
		words.push(word);
		if (words.length >= max) break;
		if (/[!?…]$/u.test(word)) break;
		if (word.endsWith(".")) {
			const bare = word.slice(0, -1).toLowerCase();
			const initial = /^\p{L}$/u.test(bare);
			if (!initial && !ABBREVIATIONS.has(bare)) break;
		}
	}
	return words;
}

function newCardKey(input: MakeImageRequestInput): string {
	const hash = createHash("sha256")
		.update(
			JSON.stringify([
				input.prompt,
				input.pictures ?? [],
				input.size ?? null,
				Boolean(input.print),
				Boolean(input.transparent),
			]),
		)
		.digest("hex");
	return `new:${hash}`;
}

/** The identity of a picture, so naming it twice (its number and its id) is one picture. */
function identityOf(source: TurnPictureSource): string {
	if (source.type === "upload") return `upload:${source.artifactId}`;
	return source.artifactId
		? `item:${source.artifactId}`
		: `file:${source.fileId}`;
}

async function sourcesNamed(params: {
	userId: string;
	conversationId: string;
	names: readonly string[];
	turnPictures: TurnPictureIndex | null;
}): Promise<
	{ ok: true; sources: TurnPictureSource[] } | { ok: false; message: string }
> {
	const sources: TurnPictureSource[] = [];
	const seen = new Set<string>();
	for (const raw of params.names) {
		const name = raw.trim();
		let source: TurnPictureSource | null = null;
		if (/^\d{1,3}$/.test(name)) {
			source = params.turnPictures?.byNumber(Number(name))?.source ?? null;
		} else if (name !== "") {
			// An id: only an Image item the person can reach from this chat.
			const item = await getImageItem({
				userId: params.userId,
				artifactId: name,
				conversationId: params.conversationId,
			});
			if (item) {
				source = {
					type: "image_file",
					fileId: item.fileId,
					name: item.title,
					artifactId: item.artifactId,
					role: "attached",
				};
			}
		}
		if (!source) {
			return {
				ok: false,
				message: `make_image has no picture ${JSON.stringify(name)}. Use a picture number from this message or an Image id from "In this chat".`,
			};
		}
		const identity = identityOf(source);
		if (seen.has(identity)) continue;
		seen.add(identity);
		sources.push(source);
	}
	return { ok: true, sources };
}

/** The retry of an earlier take of this turn: the same request again, with a seed unlike the first's. */
async function planRetry(
	input: MakeImageRequestInput,
	turnTakes: TurnTakes,
): Promise<Resolution> {
	const takeId = input.retryOf ?? "";
	const record = turnTakes.take(takeId);
	const [row] = record
		? await db
				.select({ hidden: imageJobs.hidden })
				.from(imageJobs)
				.where(eq(imageJobs.id, takeId))
				.limit(1)
		: [];
	if (!record || !row || row.hidden === 1) {
		return refuse(
			"retry_unknown",
			"make_image has no take of this turn with that takeId. Leave retryOf out to make a new picture.",
		);
	}
	if (record.retried || record.isRetry) {
		return refuse(
			"retry_twice",
			"That take was already made again once. Tell the user what you have; do not retry it again.",
		);
	}
	const request: TakeRequest = {
		...record.request,
		avoidSeeds: [...new Set([...record.request.avoidSeeds, record.seed])],
	};
	return {
		ok: true,
		plan: {
			cardKey: record.cardKey,
			cardId: record.cardId,
			artifactId: null,
			madeFrom: request.mode === "generate" ? "words" : "change",
			title: request.title,
			sourceCount: request.inputs.filter((i) => i.role !== "marked").length,
			request,
			retryOf: record.takeId,
			callKey: record.callKey,
			baseNumber: record.baseNumber ?? null,
		},
	};
}

export async function resolveMakeImageRequest(params: {
	userId: string;
	conversationId: string;
	input: MakeImageRequestInput;
	turnPictures: TurnPictureIndex | null;
	turnTakes: TurnTakes;
	requestText: string;
	/** The graph whose slots bound the pictures of one call; defaults to the edit graph. */
	template?: GraphTemplate | null;
}): Promise<Resolution> {
	const { userId, conversationId, input, turnTakes } = params;
	if (input.retryOf) return planRetry(input, turnTakes);

	const named = await sourcesNamed({
		userId,
		conversationId,
		names: input.pictures ?? [],
		turnPictures: params.turnPictures,
	});
	if (!named.ok) return refuse("unknown_picture", named.message);

	const marked = named.sources.find(
		(s) => s.type === "image_file" && s.role === "marked",
	);
	let plain = named.sources.filter((s) => s !== marked);
	// Only the marked copy named: it is a copy of a picture the message holds,
	// and that picture is the one being changed.
	if (marked && plain.length === 0) {
		const baseFileId = params.turnPictures?.metadata?.marks?.imageFileId;
		const base = params.turnPictures?.pictures.find(
			(p) => p.source.type === "image_file" && p.source.fileId === baseFileId,
		);
		if (base) plain = [base.source];
	}

	const template =
		params.template === undefined
			? (graphFor("edit", Boolean(input.transparent))?.template ?? null)
			: params.template;
	const limit = Math.min(
		getImageReferenceCap(),
		template ? imageSlotCount(template) : Number.POSITIVE_INFINITY,
	);
	if (plain.length + (marked ? 1 : 0) > limit) {
		return refuse(
			"too_many_pictures",
			`make_image takes at most ${limit} pictures per call. Pass the ones the picture needs, or ask the user which.`,
		);
	}

	const first = plain[0] ?? null;
	const prompt = input.prompt.trim();

	// Does the first picture belong to an Image item, and may it be changed in place?
	const item =
		first && first.type === "image_file" && first.artifactId
			? await getImageItem({
					userId,
					artifactId: first.artifactId,
					conversationId,
				})
			: null;
	// An item of ANOTHER chat is never changed in place: its versions would
	// point at files of this chat's folder and break when this chat goes. It
	// starts a new item here, from a copy of the picture stored in this chat.
	const itemHere = item && item.conversationId === conversationId ? item : null;
	const fromOtherChat = Boolean(item) && !itemHere;
	const callKey = newCardKey(input);
	const inPlace = Boolean(itemHere) && !input.startNew;
	const cardKey = inPlace && itemHere ? `item:${itemHere.artifactId}` : callKey;

	const existingCard = turnTakes.cardFor(cardKey) ?? null;
	if (
		existingCard &&
		turnTakes.takesInCard(existingCard) >= MAX_TAKES_PER_CARD_PER_TURN
	) {
		return refuse(
			"too_many_takes",
			`This picture already has ${MAX_TAKES_PER_CARD_PER_TURN} takes in this turn, the limit. Do not call make_image for it again now; tell the user what you made.`,
		);
	}

	const title =
		inPlace && itemHere
			? itemHere.title
			: titleFor(input.title, params.requestText);
	const summary = input.summary?.trim() ? input.summary.trim() : null;
	const transparent = Boolean(input.transparent);
	const print = Boolean(input.print);

	if (!first) {
		const request: TakeRequest = {
			v: 1,
			mode: "generate",
			prompt,
			inputs: [],
			baseFromUpload: false,
			canvas: canvasForNewPicture(input.size, print),
			transparent,
			avoidSeeds: [],
			anchor: null,
			marks: null,
			title,
			summary,
		};
		return {
			ok: true,
			plan: {
				cardKey,
				cardId: existingCard,
				artifactId: null,
				madeFrom: "words",
				title,
				sourceCount: 0,
				request,
				retryOf: null,
				callKey,
				baseNumber: null,
			},
		};
	}

	// A change: the first picture is what is changed; the rest ride as references.
	let base: TurnPictureSource = first;
	let avoidSeeds: number[] = [];
	let anchor: TakeRequest["anchor"] = null;
	if (inPlace && itemHere) {
		// The same request again in this turn is another option on the SAME base;
		// a different request builds on this turn's newest finished take of the
		// card, else on the version in use. The first picture only names the item.
		const sameCall = existingCard
			? turnTakes.firstTakeOfCall(existingCard, callKey)
			: undefined;
		const earlier =
			!sameCall && existingCard ? await newestFinishedTake(existingCard) : null;
		let fileId = itemHere.fileId;
		if (sameCall) {
			fileId = sameCall.request.inputs[0]?.fileId ?? fileId;
			avoidSeeds = sameCall.request.avoidSeeds;
			anchor = sameCall.request.anchor;
		} else {
			const body = earlier?.body ?? itemHere.body;
			fileId = earlier?.file.id ?? itemHere.fileId;
			const seed = earlier?.seed ?? itemHere.body.seed;
			avoidSeeds = seed === null ? [] : [seed];
			anchor = {
				fileId: body.anchorFileId ?? fileId,
				chainSinceAnchor: body.chainSinceAnchor,
			};
		}
		base = {
			type: "image_file",
			fileId,
			name: itemHere.title,
			artifactId: itemHere.artifactId,
			role: "attached",
		};
	} else if (
		item &&
		first.type === "image_file" &&
		item.fileId === first.fileId
	) {
		// Not in place, but still never the seed that made the input.
		if (item.body.seed !== null) avoidSeeds = [item.body.seed];
	}
	const loadedBase = await loadPicture({
		userId,
		conversationId,
		source: base,
	});
	const canvas: CanvasSize = canvasForEdit(
		{ width: loadedBase.width, height: loadedBase.height },
		print,
	);
	const marks =
		marked?.type === "image_file" && marked.marks?.length ? marked.marks : null;
	const inputs = await prepareTakeInputs({
		userId,
		conversationId,
		base,
		references: [
			...plain.slice(1),
			// A marked copy with no boxes is just another picture.
			...(marked && !marks ? [marked] : []),
		],
		marked: marked && marks ? { source: marked, marks } : null,
		canvas,
		loadedBase,
		changing: inPlace && itemHere ? itemHere.artifactId : null,
	});
	// A copy of another chat's picture starts its item the way a photo does: version 1 is the copy.
	const baseFromUpload = first.type === "upload" || fromOtherChat;
	const others = plain.length - 1;
	const madeFrom: MadeFrom =
		others > 0
			? "pictures"
			: first.type === "upload"
				? "photo"
				: inPlace
					? "change"
					: "pictures";
	const request: TakeRequest = {
		v: 1,
		mode: "edit",
		prompt,
		inputs,
		baseFromUpload,
		canvas,
		transparent,
		avoidSeeds,
		// A picture that is no item's has itself, as the edit was made from it, for its anchor.
		anchor: anchor ?? { fileId: inputs[0]?.fileId ?? "", chainSinceAnchor: 0 },
		marks,
		title,
		summary,
	};
	return {
		ok: true,
		plan: {
			cardKey,
			cardId: existingCard,
			artifactId: inPlace && itemHere ? itemHere.artifactId : null,
			madeFrom,
			title,
			sourceCount: plain.length,
			request,
			retryOf: null,
			callKey,
			baseNumber:
				params.turnPictures?.pictures.find(
					(p) => identityOf(p.source) === identityOf(first),
				)?.number ?? null,
		},
	};
}
