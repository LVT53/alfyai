import { getConfig } from "$lib/server/config-store";
import {
	hasLocalDistillEnabled,
	isCloudModel,
} from "$lib/server/services/connections/locality";
import { immichThumbnail } from "$lib/server/services/connections/providers/immich";
import {
	type NormalChatModelRunProvider,
	resolveNormalChatModelRunProvider,
} from "$lib/server/services/normal-chat-model";
import { describeImage } from "./describe";
import { modelIdCanSeeImages } from "./model-vision";
import type { PreparedImage } from "./prepare-image";
import type { StepImageQueue } from "./step-images";
import type { TurnImage } from "./turn-images";

// What the photos tool may do with the pixels of the photos it found, when the
// model asks to look (`look: true`). The pixels of a person's photos are raw
// connector data like their file names and places, so who may see them follows
// connections/locality.ts (vision/AGENTS.md, Who receives pixels).

/** Thumbnails one look shows or describes: the first results, no more. */
export const MAX_LOOK_THUMBNAILS = 8;

/**
 * Thumbnails fetched and prepared at once. A HEIC original would decode on the
 * calling thread, and a describing call is a model call on the person's own
 * box; two at a time keep both polite and still overlap one with another.
 */
const LOOK_CONCURRENCY = 2;

/** A file name goes into a user message as the label of a picture: one short line. */
const LABEL_NAME_MAX_CHARS = 80;

/**
 * What a look comes to:
 * - `pixels`: the model that is answering gets the thumbnails themselves;
 * - `describe_locally`: a local model that can see describes them and the text
 *   goes through the connector summary (connector-distill.ts), so a cloud model
 *   never has the pixels, nor the descriptions raw;
 * - `withhold`: nothing is looked at.
 */
export type PhotoLookDecision = "pixels" | "describe_locally" | "withhold";

/** A photo to look at: its Immich asset id, and what the model is told to call it. */
export type LookPhoto = { id: string; name: string };

/**
 * The model that does the looking for a cloud model: the one the connector
 * summary already uses (`distillConnectorPayload`, locality.ts), when it runs
 * on the box and can see. Throws when the model cannot be resolved; a caller
 * that cannot tell treats that as no model.
 */
async function resolveLocalSeeingProvider(): Promise<NormalChatModelRunProvider | null> {
	const config = getConfig();
	const modelId = config.memoryConsolidationModel;
	if (await isCloudModel(modelId)) return null;
	if (!(await modelIdCanSeeImages(modelId))) return null;
	return resolveNormalChatModelRunProvider(modelId, config);
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Who sees the pixels of a photo found for this question.
 *
 * A person who keeps summarising local (`connectionLocalDistill`) and whose chat
 * model is a cloud model never has a thumbnail sent to that model: a local model
 * that can see looks and returns text, and with no such model nothing is looked
 * at. The cloud model's own ability to see does not matter there. Everyone else
 * gets the pixels when the model answering can see, and nothing when it cannot.
 *
 * Not knowing is not a yes: a setting that cannot be read, or a model that
 * cannot be resolved, withholds.
 */
export async function decidePhotoLook(params: {
	userId: string;
	modelId: string;
	modelCanSee: boolean;
}): Promise<PhotoLookDecision> {
	try {
		const keepsItLocal =
			(await hasLocalDistillEnabled(params.userId)) &&
			(await isCloudModel(params.modelId));
		if (keepsItLocal) {
			return (await resolveLocalSeeingProvider())
				? "describe_locally"
				: "withhold";
		}
		return params.modelCanSee ? "pixels" : "withhold";
	} catch (error) {
		console.warn("[PHOTOS] Look not decided, so nothing is looked at", {
			reason: reasonOf(error),
		});
		return "withhold";
	}
}

/** One line, short, never empty: it is user data that lands in a user message. */
function labelNameOf(photo: LookPhoto): string {
	const oneLine = photo.name.replace(/[\p{Cc}\s]+/gu, " ").trim();
	if (oneLine === "") return photo.id;
	return oneLine.length > LABEL_NAME_MAX_CHARS
		? `${oneLine.slice(0, LABEL_NAME_MAX_CHARS - 3)}...`
		: oneLine;
}

function labelOf(names: readonly string[]): string {
	return `Thumbnails from the photos tool, in result order: ${names
		.map((name, index) => `${index + 1} = ${name}`)
		.join(", ")}`;
}

/**
 * Downloads the thumbnail of each photo from the person's Immich and prepares
 * it as a thumbnail (`THUMBNAIL_MAX_LONG_EDGE`), two at a time, then hands it to
 * `use`. The results keep the photos' order; a photo whose thumbnail would not
 * download, would not prepare, or whose `use` failed is `undefined` in its place,
 * and a call that was given up starts no more.
 */
async function eachThumbnail<T>(params: {
	userId: string;
	connectionId: string;
	photos: readonly LookPhoto[];
	signal?: AbortSignal;
	use: (photo: LookPhoto, image: PreparedImage) => Promise<T>;
}): Promise<Array<T | undefined>> {
	const { userId, connectionId, signal } = params;
	const photos = params.photos.slice(0, MAX_LOOK_THUMBNAILS);
	const results: Array<T | undefined> = new Array(photos.length).fill(
		undefined,
	);
	if (signal?.aborted) return results;
	// Loaded when a look happens, not when the chat turn's modules do: sharp and
	// the HEIC decoder are native code (see turn-images.ts).
	const { prepareImageForModel, THUMBNAIL_MAX_LONG_EDGE } = await import(
		"./prepare-image"
	);
	let next = 0;
	const worker = async () => {
		while (next < photos.length && !signal?.aborted) {
			const index = next;
			next += 1;
			try {
				const { bytes, contentType } = await immichThumbnail(
					userId,
					connectionId,
					{ assetId: photos[index].id },
				);
				const image = await prepareImageForModel(
					new Uint8Array(bytes),
					contentType,
					{ maxLongEdge: THUMBNAIL_MAX_LONG_EDGE },
				);
				results[index] = await params.use(photos[index], image);
			} catch (error) {
				// Content-free on purpose: why, never which photo or what was in it.
				console.warn("[PHOTOS] Thumbnail not looked at", {
					reason: reasonOf(error),
				});
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(LOOK_CONCURRENCY, photos.length) }, worker),
	);
	return results;
}

/**
 * Queues the thumbnails of the first results for the model that is answering,
 * as one entry the model run hands over in the step after the tool result
 * (step-images.ts). Returns the photos whose thumbnail was queued, in result
 * order: that is what the model was shown, and nothing is queued when no
 * thumbnail could be had or when the call was given up in the meantime (a
 * late push would give the next step pictures nobody asked for).
 *
 * The thumbnails are not attachments: they never ride `currentImages` and
 * `scheduleImageDescriptions` never sees them, so no description is made or
 * stored for them and no row refers to an artifact that does not exist.
 */
export async function queuePhotoThumbnails(params: {
	userId: string;
	connectionId: string;
	photos: readonly LookPhoto[];
	queue: StepImageQueue;
	signal?: AbortSignal;
}): Promise<{ viewed: LookPhoto[] }> {
	const looked = await eachThumbnail({
		userId: params.userId,
		connectionId: params.connectionId,
		photos: params.photos,
		signal: params.signal,
		use: async (photo, image): Promise<TurnImage> => ({
			// Not an artifact id: a thumbnail is not stored anywhere.
			artifactId: `immich:${photo.id}`,
			name: labelNameOf(photo),
			image,
		}),
	});
	if (params.signal?.aborted) return { viewed: [] };

	const viewed: LookPhoto[] = [];
	const images: TurnImage[] = [];
	looked.forEach((image, index) => {
		if (!image) return;
		viewed.push(params.photos[index]);
		images.push(image);
	});
	if (images.length === 0) return { viewed: [] };
	params.queue.push({
		label: labelOf(images.map((image) => image.name)),
		images,
	});
	return { viewed };
}

/**
 * Has the local model that can see describe the first results, for a cloud
 * model that must not have the pixels. The thumbnails go to that model and
 * nowhere else, and what it says is returned keyed by asset id for the caller
 * to hand to the connector summary, never to the cloud model directly. A photo
 * whose thumbnail or description failed is absent; with no such local model the
 * result is empty and nothing was downloaded.
 */
export async function describePhotoThumbnails(params: {
	userId: string;
	connectionId: string;
	photos: readonly LookPhoto[];
	signal?: AbortSignal;
}): Promise<Map<string, string>> {
	let provider: NormalChatModelRunProvider | null;
	try {
		provider = await resolveLocalSeeingProvider();
	} catch (error) {
		console.warn("[PHOTOS] No local model to look, so nothing is looked at", {
			reason: reasonOf(error),
		});
		return new Map();
	}
	if (!provider) return new Map();
	const localProvider = provider;

	const described = await eachThumbnail({
		userId: params.userId,
		connectionId: params.connectionId,
		photos: params.photos,
		signal: params.signal,
		use: (photo, image) =>
			describeImage({
				provider: localProvider,
				image,
				signal: params.signal,
			}).then((description) => ({ id: photo.id, description })),
	});
	return new Map(
		described
			.filter((entry): entry is { id: string; description: string } =>
				Boolean(entry),
			)
			.map((entry) => [entry.id, entry.description]),
	);
}
