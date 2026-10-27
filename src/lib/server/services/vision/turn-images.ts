import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage, UserContent, UserModelMessage } from "ai";
import type { PromptAttachmentResolutionItem } from "$lib/server/services/knowledge";
import type { Artifact } from "$lib/server/services/knowledge/types";
import { getCategory } from "$lib/shared/file-types";
import { isSeeableImage } from "$lib/shared/file-types/seeable-image";
// A type only: sharp and the HEIC decoder load when a picture is prepared, not
// when the chat turn's modules do (see prepareTurnImage).
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
	/** The prepared pictures to send: empty unless the model can see. */
	images: NumberedTurnImage[];
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
	return { images: [], heldBack: [], notShown: [], hasImageAttachments: false };
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

/** What stands right before a picture, and in the sentences about the ones not sent. */
export function pictureLabel(number: number, name: string): string {
	return `Picture ${number}: ${name}`;
}

/** The pictures as labelled pictures, for `buildCurrentUserMessage`. */
export function labelledPicturesOf(
	images: readonly NumberedTurnImage[],
): LabelledPicture[] {
	return images.map(({ number, name, artifactId, image }) => ({
		number,
		name: oneLineName(name) || artifactId,
		image,
	}));
}

/** Said to a model that can see when the limit left some attached pictures out. */
export function heldBackImagesGuidance(
	pictures: readonly NumberedName[],
): string {
	return `Not sent as pictures because of the limit: ${pictures
		.map(({ number, name }) => pictureLabel(number, oneLineName(name)))
		.join("; ")}.`;
}

/**
 * Said to a model that can see, once per attached picture it was not sent for
 * a reason other than the limit, so it does not answer as if it had looked.
 */
export function notShownImageGuidance(picture: NumberedName): string {
	return `${pictureLabel(picture.number, oneLineName(picture.name))} was attached, but it could not be shown to you.`;
}

/**
 * The image lines of a turn's guidance: a model that cannot see is told so, one
 * that can is told which pictures the limit left out and, one line each, which
 * it could not be shown. Nothing is added when every picture was sent or none
 * was attached.
 */
export function buildTurnImageGuidance(params: {
	canSee: boolean;
	turnImages: TurnImages;
}): string[] {
	if (!params.canSee) {
		return params.turnImages.hasImageAttachments
			? [CANNOT_SEE_IMAGES_GUIDANCE]
			: [];
	}
	return [
		...(params.turnImages.heldBack.length > 0
			? [heldBackImagesGuidance(params.turnImages.heldBack)]
			: []),
		...params.turnImages.notShown.map(notShownImageGuidance),
	];
}

/** An attachment in the image category, whether or not it can be decoded. */
function attachedImage(item: PromptAttachmentResolutionItem): Artifact | null {
	const artifact = item.displayArtifact;
	return artifact && getCategory(artifact.name, artifact.mimeType) === "image"
		? artifact
		: null;
}

/**
 * The image attachments, in the order they were attached, once each. Not
 * `promptReady`: a picture needs no extracted text to be looked at.
 */
function attachedImagesOf(items: PromptAttachmentResolutionItem[]): Artifact[] {
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

/** A picture that cannot be read or decoded is left out and the turn goes on. */
async function prepareTurnImage(artifact: Artifact): Promise<TurnImage | null> {
	try {
		if (!artifact.storagePath) {
			throw new Error("the attachment has no stored file");
		}
		const bytes = await readFile(join(process.cwd(), artifact.storagePath));
		const { ATTACHMENT_MAX_LONG_EDGE, prepareImageForModel } = await import(
			"./prepare-image"
		);
		const image = await prepareImageForModel(bytes, artifact.mimeType, {
			maxLongEdge: ATTACHMENT_MAX_LONG_EDGE,
		});
		return { artifactId: artifact.id, name: artifact.name, image };
	} catch (error) {
		console.warn("[ATTACHMENTS] Image not sent as a picture", {
			artifactId: artifact.id,
			reason: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * Prepares the pictures among a message's attachments, at most `maxImages` of
 * them and two at a time; the ones after the limit are named in `heldBack`. A
 * picture that cannot be read leaves its slot to the next one. The image
 * attachments that were not sent for any other reason (a format that cannot be
 * decoded, a file that would not read or prepare) are named in `notShown`, in
 * the order they were attached.
 */
export async function collectTurnImages(params: {
	items: PromptAttachmentResolutionItem[];
	maxImages: number;
}): Promise<{
	images: NumberedTurnImage[];
	heldBack: NumberedName[];
	notShown: NumberedName[];
}> {
	const attached = attachedImagesOf(params.items);
	// Numbered by place among the image attachments, seeable or not.
	const numberOf = new Map(
		attached.map((artifact, index) => [artifact.id, index + 1]),
	);
	const numbered = (artifact: Artifact): NumberedName => ({
		number: numberOf.get(artifact.id) ?? 0,
		name: artifact.name,
	});
	const candidates = attached.filter((artifact) =>
		isSeeableImage(artifact.name, artifact.mimeType),
	);
	const images: NumberedTurnImage[] = [];
	const unprepared = new Set<string>();
	let next = 0;
	while (next < candidates.length && images.length < params.maxImages) {
		const room = params.maxImages - images.length;
		const wave = candidates.slice(
			next,
			next + Math.min(PREPARE_CONCURRENCY, room),
		);
		next += wave.length;
		const prepared = await Promise.all(wave.map(prepareTurnImage));
		prepared.forEach((image, index) => {
			if (image) {
				images.push({ ...image, number: numberOf.get(image.artifactId) ?? 0 });
			} else unprepared.add(wave[index].id);
		});
	}
	const candidateIds = new Set(candidates.map((artifact) => artifact.id));
	return {
		images,
		heldBack: candidates.slice(next).map(numbered),
		notShown: attached
			.filter(
				(artifact) =>
					!candidateIds.has(artifact.id) || unprepared.has(artifact.id),
			)
			.map(numbered),
	};
}

/**
 * The turn's pictures: prepared when the model can see, and only reported
 * (nothing is read) when it cannot, so the turn can tell the model why.
 */
export async function resolveTurnImages(params: {
	items: PromptAttachmentResolutionItem[];
	collect: boolean;
}): Promise<TurnImages> {
	const hasImageAttachments = params.items.some(
		(item) => attachedImage(item) !== null,
	);
	if (!params.collect || !hasImageAttachments) {
		return { images: [], heldBack: [], notShown: [], hasImageAttachments };
	}
	const { images, heldBack, notShown } = await collectTurnImages({
		items: params.items,
		maxImages: MAX_TURN_IMAGES,
	});
	return { images, heldBack, notShown, hasImageAttachments };
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
export function sumTurnImageTokens(images: readonly TurnImage[] = []): number {
	return images.reduce((sum, { image }) => sum + image.estimatedTokens, 0);
}
