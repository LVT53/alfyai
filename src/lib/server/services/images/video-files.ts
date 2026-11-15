// Video files: every mp4 Alfy keeps for a chat, as a file under
// data/image-files/<conversationId>/ beside the picture files it mirrors, with
// its poster frame and thumbnail derived from the clip's own path (like a
// picture's `.thumb.png`) and a row in the same `image_files` table. The
// artifact family and the serving route treat a video as a first-class item:
// `?variant=poster` serves the poster and `?variant=thumb` the thumbnail.
//
// This file mirrors `images/files.ts` (the picture store) and imports only the
// picture download-naming rule from it; it never imports the artifacts facade.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import { db } from "$lib/server/db";
import { imageFiles } from "$lib/server/db/schema";
import { getArtifactOwnershipScope } from "$lib/server/services/knowledge/ownership";
import { resolveDeletablePath } from "$lib/server/storage-containment";
import { IMAGE_THUMB_LONG_EDGE } from "$lib/shared/artifacts/image-body";
import {
	type ImageFile,
	type ImageFileRole,
	imageFileDownloadName,
} from "./files";
import type { FinishedPictureCheck } from "./picture-check";

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
 * The name a clip's download carries: the item's title with an mp4 extension.
 * The picture rule (`imageFileDownloadName`) owns the title lookup, the
 * format-character strip and the shared extension rule; this only swaps the
 * picture extension it always ends in for the clip's own.
 */
export async function videoFileDownloadName(file: ImageFile): Promise<string> {
	const pictureName = await imageFileDownloadName(file);
	return pictureName.replace(/\.png$/u, ".mp4");
}

/** The three paths a row's files live at, in deletion order. */
function pathsOf(storagePath: string): string[] {
	return [storagePath, posterPathOf(storagePath), thumbPathOf(storagePath)];
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
 * Removes a stored clip's mp4, poster and thumbnail by the paths
 * `storeVideoFile` gave them, and its row if it still has one. For a store that
 * finished after its chat's cleanup ran: the row may already be gone (the
 * cascade took it), and the files still must not stay.
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

/** Every clip of one chat, with its poster and thumbnail. Pictures in the same table are left alone. */
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
