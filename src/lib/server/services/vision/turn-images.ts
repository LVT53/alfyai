import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage, UserContent, UserModelMessage } from "ai";
import type { PromptAttachmentResolutionItem } from "$lib/server/services/knowledge";
import type { Artifact } from "$lib/server/services/knowledge/types";
import { getCategory } from "$lib/shared/file-types";
import { isSeeableImage } from "$lib/shared/file-types/seeable-image";
// A type only: sharp and the HEIC decoder load when a picture is prepared, not
// when the chat turn's modules do (see prepareUpload).
import type { PreparedImage } from "./prepare-image";

// The pictures of the current message: which attachments are sent as pixels,
// how they ride in the user message, and what the model is told about the
// ones that are not. Pixels belong to this one turn (vision/AGENTS.md).

/** Attachment pictures sent as pixels in one turn; the rest are named, not sent. */
export const MAX_TURN_IMAGES = 8;

/**
 * Pictures prepared at once. A HEIC photo decodes on the calling thread (about
 * a second for 12 MP), so eight at once would hold the server's one thread for
 * about eight seconds in a row; two at a time leave it free for other requests
 * between them and still overlap one picture's file read with another's work.
 */
const PREPARE_CONCURRENCY = 2;

/** A picture of the current message, prepared for the model. */
export type TurnImage = {
	artifactId: string;
	name: string;
	image: PreparedImage;
};

/**
 * A picture of the message with its number: its place among the message's
 * image attachments (see `attachedImagesOf`), whether or not it can be seen or
 * is sent, so "picture 2" means the same thing to the person and the model.
 */
export type NumberedTurnImage = TurnImage & { number: number };

/** A picture named by its number only, for the ones that are not sent. */
export type NumberedName = { number: number; name: string };

/** A picture ready to ride in the user message under its label. */
export type LabelledPicture = {
	number: number;
	name: string;
	image: PreparedImage;
};

/** What the current message's image attachments came to for this turn. */
export type TurnImages = {
	/**
	 * The prepared UPLOADED pictures: empty unless the model can see. This list
	 * feeds `scheduleImageDescriptions` alone (a picture that is not an uploaded
	 * artifact is never described, R15); the message is built from
	 * `pictureImages`.
	 */
	images: NumberedTurnImage[];
	/**
	 * Every picture sent, uploads and image files together, labelled and in
	 * number order: the one list `buildCurrentUserMessage` reads and the
	 * `viewing_images` count counts. Empty unless the model can see.
	 */
	pictureImages: LabelledPicture[];
	/** Every picture of the message, sent or not, in number order (named, not pixels). */
	pictures: NumberedName[];
	/** The pictures the per-turn limit left out. */
	heldBack: NumberedName[];
	/**
	 * The image attachments that were not sent as pictures for any
	 * reason other than the limit: a format that cannot be decoded (a BMP, a
	 * type the app does not know), or a file that could not be read or prepared.
	 * Empty unless the model can see: a model that cannot is told one line about
	 * images, whatever they are.
	 */
	notShown: NumberedName[];
	/** The message attaches at least one image, whether or not it is sent. */
	hasImageAttachments: boolean;
};

export function noTurnImages(): TurnImages {
	return {
		images: [],
		pictureImages: [],
		pictures: [],
		heldBack: [],
		notShown: [],
		hasImageAttachments: false,
	};
}

/**
 * Said to a model that cannot see when the message attaches an image. English
 * whatever the person writes: it is scaffolding the model reads (ruling 79).
 */
export const CANNOT_SEE_IMAGES_GUIDANCE =
	"The user attached an image, but you cannot see images; you only get any text extracted from it. Say so in one short sentence, then answer from that text.";

/**
 * One line, short: a file name is user data that lands in a user message. Control
 * characters and runs of whitespace become one space, and it is cut by code
 * points (never in the middle of a character). May return "": a caller that
 * needs a name falls back to an id.
 */
export function oneLineName(name: string, maxChars = 80): string {
	const oneLine = name.replace(/[\p{Cc}\s]+/gu, " ").trim();
	const points = Array.from(oneLine);
	return points.length > maxChars
		? `${points.slice(0, maxChars - 3).join("")}...`
		: oneLine;
}

/** A picture's name in a label: long enough for the app's own marks line (eight marks). */
const LABEL_NAME_MAX_CHARS = 200;

/**
 * What stands right before a picture, and in the sentences about the ones not
 * sent. The name goes through `oneLineName` here, the one cleaning rule, so no
 * caller can put a newline into a label; cleaning twice changes nothing.
 */
export function pictureLabel(number: number, name: string): string {
	return `Picture ${number}: ${oneLineName(name, LABEL_NAME_MAX_CHARS)}`;
}

/** Said to a model that can see when the limit left some attached pictures out. */
export function heldBackImagesGuidance(
	pictures: readonly NumberedName[],
): string {
	return `Not sent as pictures because of the limit: ${pictures
		.map(({ number, name }) => pictureLabel(number, name))
		.join("; ")}.`;
}

/**
 * Said to a model that can see, once per attached picture it was not sent for
 * a reason other than the limit, so it does not answer as if it had looked.
 */
export function notShownImageGuidance(picture: NumberedName): string {
	return `${pictureLabel(picture.number, picture.name)} was attached, but it could not be shown to you.`;
}

/**
 * The image lines of a turn's guidance: a model that cannot see is told so and
 * given the pictures by number (so it can still hand them to `make_image`), one
 * that can is told which pictures the limit left out and, one line each, which
 * it could not be shown. Either is told what one `make_image` call takes when
 * the message holds more pictures than that (`referenceCap`, null when picture
 * making is off). Nothing is added when every picture was sent and none needs
 * the cap's line.
 */
export function buildTurnImageGuidance(params: {
	canSee: boolean;
	turnImages: TurnImages;
	referenceCap?: number | null;
}): string[] {
	const { turnImages, referenceCap } = params;
	const capLine =
		referenceCap != null && turnImages.pictures.length > referenceCap
			? [makeImageCapGuidance(referenceCap)]
			: [];
	if (!params.canSee) {
		if (!turnImages.hasImageAttachments) return [];
		return [
			CANNOT_SEE_IMAGES_GUIDANCE,
			...(turnImages.pictures.length > 0
				? [picturesInMessageGuidance(turnImages.pictures)]
				: []),
			...capLine,
		];
	}
	return [
		...(turnImages.heldBack.length > 0
			? [heldBackImagesGuidance(turnImages.heldBack)]
			: []),
		...turnImages.notShown.map(notShownImageGuidance),
		...capLine,
	];
}

/** Said to a model that cannot see: the message's pictures by number. */
function picturesInMessageGuidance(pictures: readonly NumberedName[]): string {
	return `Pictures in this message: ${pictures
		.map(({ number, name }) => pictureLabel(number, name))
		.join("; ")}.`;
}

/** Said when the message holds more pictures than one `make_image` call takes. */
function makeImageCapGuidance(cap: number): string {
	return `make_image takes at most ${cap} pictures per call: pass the ones the picture needs.`;
}

/** An attachment in the image category, whether or not it can be decoded. */
function attachedImage(item: PromptAttachmentResolutionItem): Artifact | null {
	const artifact = item.displayArtifact;
	return artifact && getCategory(artifact.name, artifact.mimeType) === "image"
		? artifact
		: null;
}

/**
 * The image attachments, in the order they were attached, once each (the same
 * upload twice is one picture). Not `promptReady`: a picture needs no extracted
 * text to be looked at.
 */
export function attachedImagesOf(
	items: PromptAttachmentResolutionItem[],
): Artifact[] {
	const seen = new Set<string>();
	const found: Artifact[] = [];
	for (const item of items) {
		const artifact = attachedImage(item);
		if (!artifact || seen.has(artifact.id)) continue;
		seen.add(artifact.id);
		found.push(artifact);
	}
	return found;
}

/**
 * A picture of the message that is not an uploaded attachment (a card picture,
 * the open picture, the marked copy): its number comes from the turn's picture
 * index and its pixels from `load` (a stored picture file).
 */
export type ExtraPicture = {
	number: number;
	/** A key for the log and the fallback name (never the picture). */
	id: string;
	/** The name the label carries; cleaned here. */
	name: string;
	load: () => Promise<PreparedImage>;
};

/** One picture the turn may send, from either source, before it is prepared. */
type PictureEntry = {
	number: number;
	id: string;
	name: string;
	/** null: a type that cannot be decoded, named and never sent. */
	read: (() => Promise<PreparedImage>) | null;
	upload: boolean;
};

/**
 * A name for a label or a sentence: cleaned, and never empty. An upload's file
 * name is user data and is cut at 80; another picture's name is the app's own
 * words (an open picture's title is cut where it is read) and may be longer.
 */
function nameOrId(name: string, id: string, maxChars = 80): string {
	return oneLineName(name, maxChars) || id;
}

/** The longest name another picture carries: the marks line of eight marks. */
const EXTRA_NAME_MAX_CHARS = LABEL_NAME_MAX_CHARS;

async function prepareUpload(artifact: Artifact): Promise<PreparedImage> {
	if (!artifact.storagePath) {
		throw new Error("the attachment has no stored file");
	}
	const bytes = await readFile(join(process.cwd(), artifact.storagePath));
	const { ATTACHMENT_MAX_LONG_EDGE, prepareImageForModel } = await import(
		"./prepare-image"
	);
	return prepareImageForModel(bytes, artifact.mimeType, {
		maxLongEdge: ATTACHMENT_MAX_LONG_EDGE,
	});
}

/** A picture that cannot be read or decoded is left out and the turn goes on. */
async function prepareEntry(
	entry: PictureEntry,
): Promise<PreparedImage | null> {
	try {
		if (!entry.read) throw new Error("the picture cannot be decoded");
		return await entry.read();
	} catch (error) {
		console.warn("[ATTACHMENTS] Image not sent as a picture", {
			...(entry.upload ? { artifactId: entry.id } : { pictureId: entry.id }),
			reason: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/** The number an upload carries, from the index or, without one, from its place. */
function uploadNumbers(
	uploads: readonly Artifact[],
	numberOf: ((artifactId: string) => number) | undefined,
): (artifactId: string) => number {
	if (numberOf) return numberOf;
	const byPlace = new Map(
		uploads.map((artifact, index) => [artifact.id, index + 1]),
	);
	return (artifactId) => {
		const place = byPlace.get(artifactId);
		if (place === undefined) {
			throw new Error(`Attachment ${artifactId} has no picture number`);
		}
		return place;
	};
}

/**
 * Prepares the pictures of a message, at most `maxImages` of them and two at a
 * time, in number order; the ones after the limit are named in `heldBack`. A
 * picture that cannot be read leaves its slot to the next one. The pictures not
 * sent for any other reason (a format that cannot be decoded, a file that would
 * not read or prepare) are named in `notShown`.
 *
 * The numbers come from the caller: `numberOf` for the uploads (the turn's
 * picture index, so a card picture attached at 1 makes the first upload
 * `Picture 2`) and each extra picture's own. Without `numberOf` the uploads are
 * numbered by their place among the image attachments, the uploads-only case.
 */
export async function collectTurnImages(params: {
	items: PromptAttachmentResolutionItem[];
	maxImages: number;
	numberOf?: (artifactId: string) => number;
	extras?: readonly ExtraPicture[];
}): Promise<{
	images: NumberedTurnImage[];
	pictureImages: LabelledPicture[];
	pictures: NumberedName[];
	heldBack: NumberedName[];
	notShown: NumberedName[];
}> {
	const attached = attachedImagesOf(params.items);
	const numberOf = uploadNumbers(attached, params.numberOf);
	const entries: PictureEntry[] = [
		...attached.map(
			(artifact): PictureEntry => ({
				number: numberOf(artifact.id),
				id: artifact.id,
				name: artifact.name,
				read: isSeeableImage(artifact.name, artifact.mimeType)
					? () => prepareUpload(artifact)
					: null,
				upload: true,
			}),
		),
		...(params.extras ?? []).map(
			(extra): PictureEntry => ({
				number: extra.number,
				id: extra.id,
				name: extra.name,
				read: extra.load,
				upload: false,
			}),
		),
	].sort((a, b) => a.number - b.number);

	const nameOf = (entry: PictureEntry) =>
		nameOrId(entry.name, entry.id, entry.upload ? 80 : EXTRA_NAME_MAX_CHARS);
	const named = (entry: PictureEntry): NumberedName => ({
		number: entry.number,
		name: nameOf(entry),
	});
	const candidates = entries.filter((entry) => entry.read !== null);
	const shown: Array<{ entry: PictureEntry; image: PreparedImage }> = [];
	const unprepared = new Set<PictureEntry>();
	let next = 0;
	while (next < candidates.length && shown.length < params.maxImages) {
		const room = params.maxImages - shown.length;
		const wave = candidates.slice(
			next,
			next + Math.min(PREPARE_CONCURRENCY, room),
		);
		next += wave.length;
		const prepared = await Promise.all(wave.map(prepareEntry));
		prepared.forEach((image, index) => {
			if (image) shown.push({ entry: wave[index], image });
			else unprepared.add(wave[index]);
		});
	}
	const candidateSet = new Set(candidates);
	return {
		images: shown
			.filter(({ entry }) => entry.upload)
			.map(({ entry, image }) => ({
				artifactId: entry.id,
				name: entry.name,
				image,
				number: entry.number,
			})),
		pictureImages: shown.map(({ entry, image }) => ({
			number: entry.number,
			name: nameOf(entry),
			image,
		})),
		pictures: entries.map(named),
		heldBack: candidates.slice(next).map(named),
		notShown: entries
			.filter((entry) => !candidateSet.has(entry) || unprepared.has(entry))
			.map(named),
	};
}

/**
 * The turn's pictures: prepared when the model can see, and only reported
 * (nothing is read) when it cannot, so the turn can tell the model why. The
 * message's other pictures (`extras`) and the numbers all of them carry come
 * from the turn's picture index (`images/turn-pictures.ts`); without it the
 * message's pictures are its image uploads.
 */
export async function resolveTurnImages(params: {
	items: PromptAttachmentResolutionItem[];
	collect: boolean;
	numberOf?: (artifactId: string) => number;
	extras?: readonly ExtraPicture[];
}): Promise<TurnImages> {
	const extras = params.extras ?? [];
	const hasImageAttachments =
		params.items.some((item) => attachedImage(item) !== null) ||
		extras.length > 0;
	if (!hasImageAttachments) return noTurnImages();
	if (!params.collect) {
		// Nothing is read for a model that cannot see; the pictures are only named.
		const uploads = attachedImagesOf(params.items);
		const numberOf = uploadNumbers(uploads, params.numberOf);
		const pictures = [
			...uploads.map((artifact) => ({
				number: numberOf(artifact.id),
				name: nameOrId(artifact.name, artifact.id),
			})),
			...extras.map((extra) => ({
				number: extra.number,
				name: nameOrId(extra.name, extra.id, EXTRA_NAME_MAX_CHARS),
			})),
		].sort((a, b) => a.number - b.number);
		return { ...noTurnImages(), pictures, hasImageAttachments };
	}
	const collected = await collectTurnImages({
		items: params.items,
		maxImages: MAX_TURN_IMAGES,
		numberOf: params.numberOf,
		extras,
	});
	return { ...collected, hasImageAttachments };
}

function imagePart({ base64, mediaType }: PreparedImage) {
	return { type: "image" as const, image: base64, mediaType };
}

/**
 * The current user message: the text, then each picture as an image part with
 * its label ("Picture 2: name") in the text part right before it. The parts
 * carry base64 strings, never buffers, so the message hashes and logs like any
 * other.
 */
export function buildCurrentUserMessage(
	text: string,
	pictures: readonly LabelledPicture[] = [],
): ModelMessage {
	return {
		role: "user",
		content: [
			{ type: "text", text },
			...pictures.flatMap(({ number, name, image }) => [
				{ type: "text" as const, text: pictureLabel(number, name) },
				imagePart(image),
			]),
		],
	};
}

/**
 * The message that shows a tool's thumbnails mid-turn: the entry's own label,
 * then the pictures. They get no picture numbers; those belong to the message's
 * attachments.
 */
export function buildStepImagesMessage(
	label: string,
	images: readonly TurnImage[],
): UserModelMessage {
	return {
		role: "user",
		content: [
			{ type: "text", text: label },
			...images.map(({ image }) => imagePart(image)),
		],
	};
}

/**
 * Put in the place of a picture that a model which cannot see would have been
 * sent: a failover attempt on a model the admin did not tick. English whatever
 * the person writes: it is scaffolding the model reads (ruling 79).
 */
export const STRIPPED_IMAGE_NOTE =
	"[An image was attached here, but this model cannot see images.]";

/** A user message holding at least one picture (only a user message can). */
function carriesPicture(
	message: ModelMessage,
): message is UserModelMessage & { content: Exclude<UserContent, string> } {
	return (
		message.role === "user" &&
		Array.isArray(message.content) &&
		message.content.some((part) => part.type === "image")
	);
}

/**
 * The messages without their pictures, for an attempt on a model that cannot
 * see: each image part becomes `STRIPPED_IMAGE_NOTE` as a text part, so the
 * model is told one was there. Nothing else changes. A message without a picture
 * is the same object, and a list without any picture is returned as it is.
 */
export function stripImageParts(
	messages: readonly ModelMessage[],
): ModelMessage[] {
	// Nothing to strip: the list comes back as it is. It is typed readonly only
	// because this function never writes to it; callers hold a plain array.
	if (!messages.some(carriesPicture)) return messages as ModelMessage[];
	return messages.map((message) =>
		carriesPicture(message)
			? {
					...message,
					content: message.content.map((part) =>
						part.type === "image"
							? { type: "text" as const, text: STRIPPED_IMAGE_NOTE }
							: part,
					),
				}
			: message,
	);
}

/** Prompt tokens the pictures cost, by each one's own size (not a flat amount). */
export function sumTurnImageTokens(
	images: readonly { image: PreparedImage }[] = [],
): number {
	return images.reduce((sum, { image }) => sum + image.estimatedTokens, 0);
}
