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
 * How long a look may take, from its first download. The photos tool answers
 * inside 20 s (`TOOL_TIMEOUTS_MS.photos`), and a tool that times out answers with
 * a failure in place of the whole search, so a look gives up well before: it
 * keeps what it has by then and the search it came with goes back whole. Showing
 * the thumbnails (a LAN download and a resize each) has a short one. Describing
 * them is a model call each on the person's own box, and the summary the result
 * goes through (a model call without a deadline of its own) comes after it.
 */
export const PIXELS_LOOK_DEADLINE_MS = 8_000;
export const DESCRIBE_LOOK_DEADLINE_MS = 12_000;

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

const LABEL_HEAD = "Thumbnails from the photos tool, in result order:";

/** A picture is numbered by the result it comes from: result 3 is "3" whatever came before it. */
function labelOf(
	items: ReadonlyArray<{ position: number; name: string }>,
): string {
	return `${LABEL_HEAD} ${items
		.map(({ position, name }) => `${position} = ${name}`)
		.join(", ")}`;
}

/** The same label with no name in it, for an attempt that may not have the names. */
function labelWithoutNamesOf(positions: readonly number[]): string {
	return `${LABEL_HEAD} ${positions.join(", ")}`;
}

// Loaded when a look happens, not when the chat turn's modules do: sharp and the
// HEIC decoder are native code (see turn-images.ts). Looks asked for in the same
// moment share the one import, and one that failed is not remembered.
let preparer: Promise<typeof import("./prepare-image")> | undefined;

function loadPreparer(): Promise<typeof import("./prepare-image")> {
	if (!preparer) {
		preparer = import("./prepare-image").catch((error: unknown) => {
			preparer = undefined;
			throw error;
		});
	}
	return preparer;
}

/** Stands in for the result of work that was stopped. */
const STOPPED = Symbol("stopped");

/**
 * `work`'s result, or `STOPPED` as soon as `stop` is aborted, whether or not
 * `work` has finished: the caller does not wait for what it can not cancel. What
 * `work` does after that, it does for nobody (a rejection is taken here, too).
 */
function untilStopped<T>(
	work: Promise<T>,
	stop: AbortSignal,
): Promise<T | typeof STOPPED> {
	if (stop.aborted) return Promise.resolve(STOPPED);
	return new Promise((resolve, reject) => {
		const onStop = () => resolve(STOPPED);
		stop.addEventListener("abort", onStop, { once: true });
		work.then(
			(value) => {
				stop.removeEventListener("abort", onStop);
				resolve(value);
			},
			(error: unknown) => {
				stop.removeEventListener("abort", onStop);
				reject(error);
			},
		);
	});
}

/**
 * Downloads the thumbnail of each photo from the person's Immich and prepares
 * it as a thumbnail (`THUMBNAIL_MAX_LONG_EDGE`), two at a time, then hands it to
 * `use`. The results keep the photos' order; a photo whose thumbnail would not
 * download, would not prepare, or whose `use` failed is `undefined` in its place.
 *
 * It stops when the call is given up (`signal`) and when the look's own
 * deadline passes, and in both cases starts no more and does not wait for what
 * is under way: whatever was finished by then is returned, and `use` is handed
 * the signal that says to stop. A look is not allowed to be the reason the photos
 * tool times out (see `PIXELS_LOOK_DEADLINE_MS`).
 */
async function eachThumbnail<T>(params: {
	userId: string;
	connectionId: string;
	photos: readonly LookPhoto[];
	signal?: AbortSignal;
	deadlineMs: number;
	use: (
		photo: LookPhoto,
		image: PreparedImage,
		stop: AbortSignal,
	) => Promise<T>;
}): Promise<Array<T | undefined>> {
	const { userId, connectionId, signal } = params;
	const photos = params.photos.slice(0, MAX_LOOK_THUMBNAILS);
	const results: Array<T | undefined> = new Array(photos.length).fill(
		undefined,
	);
	if (signal?.aborted || photos.length === 0) return results;

	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(), params.deadlineMs);
	const stop = signal
		? AbortSignal.any([signal, deadline.signal])
		: deadline.signal;
	try {
		const { prepareImageForModel, THUMBNAIL_MAX_LONG_EDGE } =
			await loadPreparer();
		let next = 0;
		const worker = async () => {
			while (next < photos.length && !stop.aborted) {
				const index = next;
				next += 1;
				try {
					const used = await untilStopped(
						(async () => {
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
							return params.use(photos[index], image, stop);
						})(),
						stop,
					);
					if (used !== STOPPED) results[index] = used;
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
		if (deadline.signal.aborted && !signal?.aborted) {
			console.warn("[PHOTOS] Look stopped at its deadline", {
				finished: results.filter((result) => result !== undefined).length,
				of: photos.length,
			});
		}
		// A copy: what is still under way writes into `results` later, for nobody.
		return [...results];
	} finally {
		clearTimeout(timer);
	}
}

/** What a look at the photos for the model answering came to. */
export type QueuedLook = {
	/** The photos whose thumbnail was queued, in result order: what the model was shown. */
	viewed: LookPhoto[];
	/** How many pictures the turn gave this look (0: it had none left to give). */
	granted: number;
	/** How many the turn has left after this look. */
	left: number;
};

/**
 * Queues the thumbnails of the first results for the model that is answering,
 * as one entry the model run hands over in the step after the tool result
 * (step-images.ts).
 *
 * A turn may show the model so many pictures, however many looks it asks for
 * (`queue.room()`): the look takes what is left, at most 8, before it downloads
 * anything, so two looks in one step share the budget, and gives back what it
 * did not queue. With none left nothing is downloaded.
 *
 * For a person who keeps summarising local the entry is marked `localOnly`: the
 * pictures are cleared for a model on the person's own box, and the step that
 * hands them over holds them (and the file names in the label) back from an
 * attempt anywhere else. Pictures are numbered by the result they come from.
 * Nothing is queued when no thumbnail could be had, or when the call was given
 * up (a late push would give the next step pictures nobody asked for).
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
}): Promise<QueuedLook> {
	const { queue } = params;
	// Asked before anything is taken from the turn, so that a setting that cannot
	// be read (and so no look) leaves the turn's pictures as they were.
	const localOnly = await hasLocalDistillEnabled(params.userId);
	const granted = queue.reserve(
		Math.min(params.photos.length, MAX_LOOK_THUMBNAILS),
	);
	if (granted === 0) return { viewed: [], granted: 0, left: queue.room() };

	let queued = 0;
	const viewed: LookPhoto[] = [];
	try {
		const looked = await eachThumbnail({
			userId: params.userId,
			connectionId: params.connectionId,
			photos: params.photos.slice(0, granted),
			signal: params.signal,
			deadlineMs: PIXELS_LOOK_DEADLINE_MS,
			use: async (photo, image): Promise<TurnImage> => ({
				// Not an artifact id: a thumbnail is not stored anywhere.
				artifactId: `immich:${photo.id}`,
				name: labelNameOf(photo),
				image,
			}),
		});
		if (!params.signal?.aborted) {
			const items: Array<{ position: number; image: TurnImage }> = [];
			looked.forEach((image, index) => {
				if (!image) return;
				items.push({ position: index + 1, image });
				viewed.push(params.photos[index]);
			});
			if (items.length > 0) {
				queue.push({
					label: labelOf(
						items.map(({ position, image }) => ({
							position,
							name: image.name,
						})),
					),
					labelWithoutNames: labelWithoutNamesOf(
						items.map(({ position }) => position),
					),
					images: items.map(({ image }) => image),
					...(localOnly ? { localOnly: true as const } : {}),
				});
				queued = items.length;
			}
		}
	} finally {
		queue.release(granted - queued);
	}
	return { viewed, granted, left: queue.room() };
}

/**
 * Has the local model that can see describe the first results, for a cloud
 * model that must not have the pixels. The thumbnails go to that model and
 * nowhere else, and what it says is returned keyed by asset id for the caller
 * to hand to the connector summary, never to the cloud model directly. A photo
 * whose thumbnail or description failed, or did not come within the deadline
 * (`DESCRIBE_LOOK_DEADLINE_MS`), is absent; with no such local model the result
 * is empty and nothing was downloaded. Nothing here uses the turn's pictures:
 * what is described is text.
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
		deadlineMs: DESCRIBE_LOOK_DEADLINE_MS,
		use: (photo, image, stop) =>
			describeImage({ provider: localProvider, image, signal: stop }).then(
				(description) => ({ id: photo.id, description }),
			),
	});
	return new Map(
		described
			.filter((entry): entry is { id: string; description: string } =>
				Boolean(entry),
			)
			.map((entry) => [entry.id, entry.description]),
	);
}
