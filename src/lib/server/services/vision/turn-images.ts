import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage, UserContent, UserModelMessage } from "ai";
import type { PromptAttachmentResolutionItem } from "$lib/server/services/knowledge";
import type { Artifact } from "$lib/server/services/knowledge/types";
import { getCategory, resolveEntry } from "$lib/shared/file-types";
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

/**
 * Image formats the registry knows that `prepareImageForModel` cannot decode:
 * sharp's prebuilt libvips has no BMP loader. A BMP is attached and read as
 * text like before; it is never sent as pixels.
 */
const UNDECODABLE_IMAGE_IDS: ReadonlySet<string> = new Set(["bmp"]);

/** A picture of the current message, prepared for the model. */
export type TurnImage = {
	artifactId: string;
	name: string;
	image: PreparedImage;
};

/** What the current message's image attachments came to for this turn. */
export type TurnImages = {
	/** The prepared pictures to send: empty unless the model can see. */
	images: TurnImage[];
	/** Names of the pictures the per-turn limit left out. */
	heldBack: string[];
	/** The message attaches at least one image, whether or not it is sent. */
	hasImageAttachments: boolean;
};

export function noTurnImages(): TurnImages {
	return { images: [], heldBack: [], hasImageAttachments: false };
}

/**
 * Said to a model that cannot see when the message attaches an image. English
 * whatever the person writes: it is scaffolding the model reads (ruling 79).
 */
export const CANNOT_SEE_IMAGES_GUIDANCE =
	"The user attached an image, but you cannot see images; you only get any text extracted from it. Say so in one short sentence, then answer from that text.";

/** Said to a model that can see when the limit left some attached pictures out. */
export function heldBackImagesGuidance(names: readonly string[]): string {
	return `${names.length} more attached images were not sent as pictures because of the limit: ${names.join(", ")}.`;
}

/**
 * The image lines of a turn's guidance: a model that cannot see is told so, one
 * that can is told which pictures the limit left out. Nothing is added when
 * every picture was sent or none was attached.
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
	return params.turnImages.heldBack.length > 0
		? [heldBackImagesGuidance(params.turnImages.heldBack)]
		: [];
}

/** An attachment in the image category, whether or not it can be decoded. */
function attachedImage(item: PromptAttachmentResolutionItem): Artifact | null {
	const artifact = item.displayArtifact;
	return artifact && getCategory(artifact.name, artifact.mimeType) === "image"
		? artifact
		: null;
}

/**
 * Whether an attachment can be sent as pixels: an image, in a format
 * `prepareImageForModel` decodes. A BMP is an image the model can never be
 * shown, so whatever treats a picture as needing no extracted text must ask
 * this first: for a BMP the text is all there is.
 */
export function isSeeableImage(name: string, mimeType: string | null): boolean {
	if (getCategory(name, mimeType) !== "image") return false;
	const entry = resolveEntry(name, mimeType);
	return entry === null || !UNDECODABLE_IMAGE_IDS.has(entry.id);
}

/** The attachments to send as pixels, in the order they were attached, once each. */
function seeableImagesOf(items: PromptAttachmentResolutionItem[]): Artifact[] {
	const seen = new Set<string>();
	const found: Artifact[] = [];
	for (const item of items) {
		// Not `promptReady`: a picture needs no extracted text to be looked at.
		const artifact = attachedImage(item);
		if (!artifact || seen.has(artifact.id)) continue;
		if (!isSeeableImage(artifact.name, artifact.mimeType)) continue;
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
 * picture that cannot be read leaves its slot to the next one.
 */
export async function collectTurnImages(params: {
	items: PromptAttachmentResolutionItem[];
	maxImages: number;
}): Promise<{ images: TurnImage[]; heldBack: string[] }> {
	const candidates = seeableImagesOf(params.items);
	const images: TurnImage[] = [];
	let next = 0;
	while (next < candidates.length && images.length < params.maxImages) {
		const room = params.maxImages - images.length;
		const wave = candidates.slice(
			next,
			next + Math.min(PREPARE_CONCURRENCY, room),
		);
		next += wave.length;
		for (const image of await Promise.all(wave.map(prepareTurnImage))) {
			if (image) images.push(image);
		}
	}
	return {
		images,
		heldBack: candidates.slice(next).map((artifact) => artifact.name),
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
		return { images: [], heldBack: [], hasImageAttachments };
	}
	const { images, heldBack } = await collectTurnImages({
		items: params.items,
		maxImages: MAX_TURN_IMAGES,
	});
	return { images, heldBack, hasImageAttachments };
}

/**
 * The current user message: the text, then each picture as an image part. The
 * parts carry base64 strings, never buffers, so the message hashes and logs
 * like any other.
 */
export function buildCurrentUserMessage(
	text: string,
	images: readonly TurnImage[] = [],
): ModelMessage {
	return {
		role: "user",
		content: [
			{ type: "text", text },
			...images.map(({ image }) => ({
				type: "image" as const,
				image: image.base64,
				mediaType: image.mediaType,
			})),
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
