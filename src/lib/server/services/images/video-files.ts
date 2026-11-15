// Video files: every mp4 Alfy keeps for a chat, as a file under
// data/image-files/<conversationId>/ beside the picture files it mirrors, with
// its poster frame and thumbnail derived from the clip's own path (like a
// picture's `.thumb.png`) and a row in the same `image_files` table. The
// artifact family and the serving route treat a video as a first-class item:
// `?variant=poster` serves the poster and `?variant=thumb` the thumbnail.
//
// A GIF is the one file made on demand rather than at store time: the first
// `?download=1&format=gif` makes `<id>.gif` beside the clip, atomically, and
// later requests serve it. It is deleted with the clip's own files.
//
// This file mirrors `images/files.ts` (the picture store) and imports only the
// picture download-naming rule from it; it never imports the artifacts facade.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import { db } from "$lib/server/db";
import { imageFiles } from "$lib/server/db/schema";
import { getArtifactOwnershipScope } from "$lib/server/services/knowledge/ownership";
import { resolveDeletablePath } from "$lib/server/storage-containment";
import { IMAGE_THUMB_LONG_EDGE } from "$lib/shared/artifacts/image-body";
import { getContentTypeForFile } from "$lib/shared/file-types";
import {
	type ImageFile,
	type ImageFileRole,
	imageFileDownloadName,
} from "./files";
import type { FinishedPictureCheck } from "./picture-check";
import {
	convertToGif,
	type MediaCallOptions,
	VideoMediaError,
} from "./video/media";

/**
 * The long edge of a clip's poster frame (`?variant=poster`), in pixels: the
 * measured 720p product size, and never an enlargement of a smaller clip.
 */
export const VIDEO_POSTER_LONG_EDGE = 1280;

export type VideoFile = {
	id: string;
	userId: string;
	conversationId: string;
	artifactId: string | null;
	role: ImageFileRole;
	width: number;
	height: number;
	/** The clip's length in milliseconds; a video row always has one. */
	durationMs: number | null;
	sizeBytes: number;
	/** Relative to the working directory, like every stored file path. */
	storagePath: string;
	/** Unix seconds, like every table. */
	createdAt: number;
};

/** Which bytes of a stored video a reader wants. */
export type VideoFileVariant = "video" | "poster" | "thumb";

/**
 * What the caller's explicit-picture check receives: the poster exactly as it
 * will be stored (a WebP), and the clip's frame size.
 */
export type VideoPosterCheckInput = {
	bytes: Uint8Array;
	width: number;
	height: number;
};

/**
 * A poster the explicit-picture filter refused, or one whose check could not
 * run. Nothing is stored when this is thrown (fail closed); the video runner
 * maps the verdict to its own failure code exactly as the picture runner does.
 */
export class VideoPosterRefusedError extends Error {
	readonly verdict: "blocked" | "unchecked";

	constructor(verdict: "blocked" | "unchecked") {
		super(`The video poster was refused (${verdict}).`);
		this.name = "VideoPosterRefusedError";
		this.verdict = verdict;
	}
}

const IMAGE_FILES_DIR = join("data", "image-files");
const MP4_BOX_TYPE = [0x66, 0x74, 0x79, 0x70]; // "ftyp"
const VIDEO_EXTENSION = ".mp4";
const GIF_EXTENSION = ".gif";
/** The `format` a caller asks for in place of the mp4 (`?download=1&format=gif`). */
export const VIDEO_GIF_FORMAT = GIF_EXTENSION.slice(1);
/**
 * A stand-in filename, used only to ask the file-type registry what each
 * representation is served as: the path helpers below put the real suffix on
 * it, so the answer always follows the formats they write.
 */
const CLIP_FILE_NAME = `clip${VIDEO_EXTENSION}`;
/** "GIF8", then the version's "7a" or "9a", then the trailer byte. */
const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38];
const GIF_TRAILER = 0x3b;

type Row = typeof imageFiles.$inferSelect;

function toVideoFile(row: Row): VideoFile {
	return {
		id: row.id,
		userId: row.userId,
		conversationId: row.conversationId,
		artifactId: row.artifactId,
		role: row.role as ImageFileRole,
		width: row.width,
		height: row.height,
		durationMs: row.durationMs,
		sizeBytes: row.sizeBytes,
		storagePath: row.storagePath,
		createdAt: Math.floor(row.createdAt.getTime() / 1000),
	};
}

/** The poster's path: derived from `storage_path` like a picture's thumbnail, so the DB stores nothing new. */
function posterPathOf(storagePath: string): string {
	return storagePath.replace(/\.mp4$/, ".poster.webp");
}

/** The thumbnail's path: derived from `storage_path`, beside the poster. */
function thumbPathOf(storagePath: string): string {
	return storagePath.replace(/\.mp4$/, ".thumb.webp");
}

/**
 * The GIF's path: derived from `storage_path` like the poster and the
 * thumbnail, so the DB stores nothing new. It exists only once a person has
 * asked for a GIF; nothing is made at store time.
 */
function gifPathOf(storagePath: string): string {
	return storagePath.replace(/\.mp4$/, GIF_EXTENSION);
}

/**
 * Whether the bytes begin with an ISO-BMFF `ftyp` box at offset 4, the same
 * leading bytes the shared file-type table reads for mp4 (the brand is not
 * narrowed there either). A signature alone is enough to refuse a PNG or a text
 * file handed in as a clip, exactly as `storeImageFile` refuses a non-PNG.
 */
function hasMp4Signature(bytes: Uint8Array): boolean {
	return (
		bytes.byteLength >= 12 &&
		MP4_BOX_TYPE.every((byte, index) => bytes[4 + index] === byte)
	);
}

async function removeFiles(storagePaths: readonly string[]): Promise<void> {
	for (const storagePath of storagePaths) {
		const absolute = await resolveDeletablePath(storagePath);
		if (!absolute) continue;
		try {
			await unlink(absolute);
		} catch {
			// Already gone.
		}
	}
}

/** A WebP fit inside `longEdge`, never enlarged. */
async function makeWebp(
	source: Uint8Array,
	longEdge: number,
	quality: number,
): Promise<Uint8Array> {
	return new Uint8Array(
		await sharp(source)
			.resize({
				width: longEdge,
				height: longEdge,
				fit: "inside",
				withoutEnlargement: true,
			})
			.webp({ quality, effort: 4 })
			.toBuffer(),
	);
}

/**
 * Stores one clip as `<id>.mp4` with its poster (`<id>.poster.webp`) and
 * thumbnail (`<id>.thumb.webp`), and one row carrying its size, shape and
 * length. The caller passes the extracted poster frame and the duration it
 * measured; this file never renders and never reads the mp4's boxes.
 *
 * The caller's explicit-picture check, if passed, runs on the poster exactly as
 * it will be stored, before anything is written: a `blocked` or `unchecked`
 * verdict throws `VideoPosterRefusedError` and stores nothing. The video
 * runner's own five-frame sample is the full gate; this is the poster's.
 */
export async function storeVideoFile(params: {
	userId: string;
	conversationId: string;
	artifactId?: string | null;
	role: ImageFileRole;
	mp4: Uint8Array;
	/** The poster frame (a PNG or JPEG frame of the clip). */
	poster: Uint8Array;
	/** The clip's measured length in whole milliseconds. */
	durationMs: number;
	checkPoster?: (
		poster: VideoPosterCheckInput,
	) => Promise<FinishedPictureCheck>;
}): Promise<VideoFile> {
	if (!hasMp4Signature(params.mp4)) {
		throw new Error("A video file must be an MP4.");
	}
	const posterMeta = await sharp(params.poster).metadata();
	if (!posterMeta.width || !posterMeta.height || !posterMeta.format) {
		throw new Error("A video poster must be a picture.");
	}
	if (!Number.isInteger(params.durationMs) || params.durationMs <= 0) {
		throw new Error(
			"A video must have a positive whole length in milliseconds.",
		);
	}
	// Any chat of the person's, incognito included: a clip made in an incognito
	// chat is stored like any other (the read rule is `getImageFile`'s).
	const owned = await getArtifactOwnershipScope(params.userId, {
		includeIncognito: true,
	});
	if (!owned.conversationIds.has(params.conversationId)) {
		throw new Error("The chat for this video is gone.");
	}

	const id = randomUUID();
	const storagePath = join(
		IMAGE_FILES_DIR,
		params.conversationId,
		`${id}${VIDEO_EXTENSION}`,
	);
	const posterPath = posterPathOf(storagePath);
	const thumbPath = thumbPathOf(storagePath);
	const absolute = join(process.cwd(), storagePath);
	const poster = await makeWebp(params.poster, VIDEO_POSTER_LONG_EDGE, 82);
	const thumb = await makeWebp(params.poster, IMAGE_THUMB_LONG_EDGE, 80);

	if (params.checkPoster) {
		const verdict = await params.checkPoster({
			bytes: poster,
			width: posterMeta.width,
			height: posterMeta.height,
		});
		if (verdict === "blocked" || verdict === "unchecked") {
			throw new VideoPosterRefusedError(verdict);
		}
	}

	await mkdir(dirname(absolute), { recursive: true });
	try {
		await writeFile(absolute, params.mp4);
		await writeFile(join(process.cwd(), posterPath), poster);
		await writeFile(join(process.cwd(), thumbPath), thumb);
		const [row] = await db
			.insert(imageFiles)
			.values({
				id,
				userId: params.userId,
				conversationId: params.conversationId,
				artifactId: params.artifactId ?? null,
				role: params.role,
				width: posterMeta.width,
				height: posterMeta.height,
				// A clip is never see-through; a picture row's null is this column's
				// "not a clip".
				hasAlpha: 0,
				sizeBytes: params.mp4.byteLength,
				durationMs: params.durationMs,
				storagePath,
			})
			.returning();
		if (!row) throw new Error("The video row was not written.");
		return toVideoFile(row);
	} catch (error) {
		await removeFiles([storagePath, posterPath, thumbPath]);
		throw error;
	}
}

/**
 * The video behind a file the caller has already read through `getImageFile`
 * (which owns the ownership scope), or `null` when that file is a picture. One
 * primary-key read by the id the caller already established, never a second
 * ownership decision.
 */
export async function getVideoFile(
	file: Pick<ImageFile, "id">,
): Promise<VideoFile | null> {
	const [row] = await db
		.select()
		.from(imageFiles)
		.where(eq(imageFiles.id, file.id))
		.limit(1);
	if (!row) return null;
	if (!row.storagePath.endsWith(VIDEO_EXTENSION)) return null;
	return toVideoFile(row);
}

async function storagePathOf(fileId: string): Promise<string> {
	const [row] = await db
		.select({ storagePath: imageFiles.storagePath })
		.from(imageFiles)
		.where(eq(imageFiles.id, fileId))
		.limit(1);
	if (!row) throw new Error("Video file not found.");
	return row.storagePath;
}

/** The clip's own bytes, its poster WebP or its thumbnail WebP. */
export async function readVideoFileBytes(
	file: Pick<VideoFile, "id">,
	variant: VideoFileVariant,
): Promise<Uint8Array> {
	const storagePath = await storagePathOf(file.id);
	const wanted =
		variant === "poster"
			? posterPathOf(storagePath)
			: variant === "thumb"
				? thumbPathOf(storagePath)
				: storagePath;
	const absolute = await resolveDeletablePath(wanted);
	if (!absolute) throw new Error("Video file is outside the storage roots.");
	return new Uint8Array(await readFile(absolute));
}

/**
 * Whether the bytes are a whole GIF: the signature and the trailer a finished
 * file ends with. A crash mid-write (or a disk that filled) leaves a file that
 * opens like a GIF and stops early; only the trailer tells it from a whole one.
 */
function isWholeGif(bytes: Uint8Array): boolean {
	return (
		bytes.byteLength >= 14 &&
		GIF_MAGIC.every((byte, index) => bytes[index] === byte) &&
		(bytes[4] === 0x37 || bytes[4] === 0x39) &&
		bytes[5] === 0x61 &&
		bytes[bytes.byteLength - 1] === GIF_TRAILER
	);
}

/**
 * One generation in flight per clip, in this process (the same rule the
 * display copy follows). A second request for a GIF being made waits for the
 * first rather than starting a second ffmpeg beside it.
 */
const gifGenerations = new Map<string, Promise<Uint8Array>>();

/** The cached GIF, or `null` when there is none and none can be trusted. */
async function readWholeGif(absolute: string): Promise<Uint8Array | null> {
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(await readFile(absolute));
	} catch {
		return null;
	}
	if (isWholeGif(bytes)) return bytes;
	// A file that is not a whole GIF is removed, so the next attempt starts
	// from nothing rather than appending to a half-written copy.
	await unlink(absolute).catch(() => undefined);
	return null;
}

/**
 * Makes the GIF beside the clip, atomically: ffmpeg writes into a temp file in
 * the same directory and one `rename` puts the whole thing in place, so a
 * reader never sees a partial GIF and a failure leaves no file behind.
 *
 * The clip's row is read again after the conversion: an item delete (or a chat
 * cleanup) that lands while ffmpeg runs has already taken the clip's files, and
 * writing the GIF back then would leave one nothing ever removes. The request
 * that is already in flight still gets the bytes it asked for; nothing is
 * cached for a clip that is gone.
 */
async function generateGif(
	fileId: string,
	storagePath: string,
	gifPath: string,
	options: MediaCallOptions,
): Promise<Uint8Array> {
	const clipPath = await resolveDeletablePath(storagePath);
	if (!clipPath) throw new Error("Video file is outside the storage roots.");
	const gif = await convertToGif(
		new Uint8Array(await readFile(clipPath)),
		options,
	);
	if (!isWholeGif(gif)) {
		throw new VideoMediaError("failed", "ffmpeg wrote no whole GIF.");
	}
	const [row] = await db
		.select({ id: imageFiles.id })
		.from(imageFiles)
		.where(eq(imageFiles.id, fileId))
		.limit(1);
	if (!row) return gif;
	const temp = `${gifPath}.${randomUUID()}.tmp`;
	try {
		await writeFile(temp, gif);
		await rename(temp, gifPath);
	} catch (error) {
		await unlink(temp).catch(() => undefined);
		throw error;
	}
	return gif;
}

/**
 * The clip as a GIF, made on the first request and served from beside the clip
 * after that. A missing ffmpeg throws the take's own `VideoMediaError`
 * (`unavailable`), a failed conversion `failed`; neither answers a different
 * format, and neither stores anything.
 */
export async function readVideoGifBytes(
	file: Pick<VideoFile, "id">,
	options: MediaCallOptions = {},
): Promise<Uint8Array> {
	const storagePath = await storagePathOf(file.id);
	const gifPath = await resolveDeletablePath(gifPathOf(storagePath));
	if (!gifPath) throw new Error("Video file is outside the storage roots.");
	const cached = await readWholeGif(gifPath);
	if (cached) return cached;

	const running = gifGenerations.get(file.id);
	if (running) return running;
	// No await between the map's read and its set, so two requests arriving
	// together cannot both start a generation.
	const generation = generateGif(
		file.id,
		storagePath,
		gifPath,
		options,
	).finally(() => {
		gifGenerations.delete(file.id);
	});
	gifGenerations.set(file.id, generation);
	return generation;
}

/**
 * The content type one stored clip representation is served as — the mp4, its
 * poster and thumbnail WebPs, or the GIF made beside it — read from the shared
 * file-type registry through the path helper that writes it.
 */
export function videoFileContentType(
	variant: VideoFileVariant | "gif",
): string {
	const name =
		variant === "poster"
			? posterPathOf(CLIP_FILE_NAME)
			: variant === "thumb"
				? thumbPathOf(CLIP_FILE_NAME)
				: variant === "gif"
					? gifPathOf(CLIP_FILE_NAME)
					: CLIP_FILE_NAME;
	return getContentTypeForFile(name, null);
}

/** The GIF representation's content type, asked of the shared registry once. */
export const VIDEO_GIF_CONTENT_TYPE = videoFileContentType("gif");

/**
 * The name a clip's GIF download carries: the item's title with a `.gif`
 * extension, the same title rule the mp4 and the picture use.
 */
export async function videoGifDownloadName(file: ImageFile): Promise<string> {
	const pictureName = await imageFileDownloadName(file);
	return pictureName.replace(/\.png$/u, GIF_EXTENSION);
}

/**
 * The name a clip's download carries: the item's title with an mp4 extension.
 * The picture rule (`imageFileDownloadName`) owns the title lookup, the
 * format-character strip and the shared extension rule; this only swaps the
 * picture extension it always ends in for the clip's own.
 */
export async function videoFileDownloadName(file: ImageFile): Promise<string> {
	const pictureName = await imageFileDownloadName(file);
	return pictureName.replace(/\.png$/u, ".mp4");
}

/** The four paths a row's files live at, in deletion order. */
function pathsOf(storagePath: string): string[] {
	return [
		storagePath,
		posterPathOf(storagePath),
		thumbPathOf(storagePath),
		gifPathOf(storagePath),
	];
}

async function removeVideoRows(rows: Row[]): Promise<number> {
	const videos = rows.filter((row) =>
		row.storagePath.endsWith(VIDEO_EXTENSION),
	);
	if (videos.length === 0) return 0;
	await db.delete(imageFiles).where(
		inArray(
			imageFiles.id,
			videos.map((row) => row.id),
		),
	);
	await removeFiles(videos.flatMap((row) => pathsOf(row.storagePath)));
	return videos.length;
}

/**
 * Removes a stored clip's mp4, poster, thumbnail and any GIF made beside it,
 * by the paths `storeVideoFile` gave them, and its row if it still has one. For
 * a store that finished after its chat's cleanup ran: the row may already be
 * gone (the cascade took it), and the files still must not stay.
 */
export async function discardStoredVideoFile(
	file: Pick<VideoFile, "id" | "conversationId">,
): Promise<void> {
	await db.delete(imageFiles).where(eq(imageFiles.id, file.id));
	const storagePath = join(
		IMAGE_FILES_DIR,
		file.conversationId,
		`${file.id}${VIDEO_EXTENSION}`,
	);
	await removeFiles(pathsOf(storagePath));
}

/** Every clip of one chat, with its poster, thumbnail and GIF. Pictures in the same table are left alone. */
export async function deleteVideoFilesForConversation(
	conversationId: string,
): Promise<number> {
	// The table is shared with pictures; a clip is what its path says, and the
	// filter (removeVideoRows) is in JS so no LIKE pattern is needed.
	const rows = await db
		.select()
		.from(imageFiles)
		.where(eq(imageFiles.conversationId, conversationId));
	return removeVideoRows(rows);
}

/** The clips an Image-like item owns, removed with it; pictures among the ids are left alone. */
export async function deleteVideoFilesById(
	fileIds: readonly string[],
): Promise<number> {
	if (fileIds.length === 0) return 0;
	const rows = await db
		.select()
		.from(imageFiles)
		.where(inArray(imageFiles.id, [...fileIds]));
	return removeVideoRows(rows);
}
