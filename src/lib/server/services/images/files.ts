// Picture files: every PNG Alfy keeps for a chat (an input, a take, a marked
// copy) as a file under data/image-files/<conversationId>/ and a row in
// `image_files`. The artifacts service imports this file and nothing else of
// `images/`; this file must not import the artifacts facade (no import cycle),
// so the one thing it needs from an item, its title, is a plain select.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import { db } from "$lib/server/db";
import { artifacts, imageFiles } from "$lib/server/db/schema";
import { getArtifactOwnershipScope } from "$lib/server/services/knowledge/ownership";
import { resolveDeletablePath } from "$lib/server/storage-containment";
import { parseJsonRecord } from "$lib/server/utils/json";
import { parseImageVersionBody } from "$lib/shared/artifacts/image-body";

export type ImageFileRole = "input" | "take" | "marked";

export type ImageFile = {
	id: string;
	userId: string;
	conversationId: string;
	artifactId: string | null;
	role: ImageFileRole;
	width: number;
	height: number;
	hasAlpha: boolean;
	sizeBytes: number;
	/** Unix seconds, like every table. */
	createdAt: number;
};

export const IMAGE_THUMB_LONG_EDGE = 320;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IMAGE_FILES_DIR = join("data", "image-files");

type Row = typeof imageFiles.$inferSelect;

function toImageFile(row: Row): ImageFile {
	return {
		id: row.id,
		userId: row.userId,
		conversationId: row.conversationId,
		artifactId: row.artifactId,
		role: row.role as ImageFileRole,
		width: row.width,
		height: row.height,
		hasAlpha: row.hasAlpha === 1,
		sizeBytes: row.sizeBytes,
		createdAt: Math.floor(row.createdAt.getTime() / 1000),
	};
}

function thumbPathOf(storagePath: string): string {
	return storagePath.replace(/\.png$/, ".thumb.png");
}

/** Removes files by relative path; a missing file or a path outside the roots is skipped. */
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

async function removeConversationDir(conversationId: string): Promise<void> {
	const absolute = await resolveDeletablePath(
		join(IMAGE_FILES_DIR, conversationId),
	);
	if (!absolute) return;
	try {
		await rm(absolute, { recursive: true, force: true });
	} catch {
		// Best effort, like the chat files folder.
	}
}

function hasPngSignature(bytes: Uint8Array): boolean {
	return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

export async function storeImageFile(params: {
	userId: string;
	conversationId: string;
	artifactId?: string | null;
	role: ImageFileRole;
	png: Uint8Array;
}): Promise<ImageFile> {
	if (!hasPngSignature(params.png)) {
		throw new Error("A picture file must be a PNG.");
	}
	const meta = await sharp(params.png).metadata();
	if (meta.format !== "png" || !meta.width || !meta.height) {
		throw new Error("A picture file must be a PNG.");
	}
	const thumb = await sharp(params.png)
		.resize({
			width: IMAGE_THUMB_LONG_EDGE,
			height: IMAGE_THUMB_LONG_EDGE,
			fit: "inside",
			withoutEnlargement: true,
		})
		.png()
		.toBuffer();

	// Any chat of the person's, incognito included: a picture made in an
	// incognito chat is stored like any other (the read rule is `getImageFile`'s).
	const owned = await getArtifactOwnershipScope(params.userId, {
		includeIncognito: true,
	});
	if (!owned.conversationIds.has(params.conversationId)) {
		throw new Error("The chat for this picture is gone.");
	}

	const id = randomUUID();
	const storagePath = join(IMAGE_FILES_DIR, params.conversationId, `${id}.png`);
	const thumbPath = thumbPathOf(storagePath);
	const absolute = join(process.cwd(), storagePath);
	await mkdir(dirname(absolute), { recursive: true });
	try {
		await writeFile(absolute, params.png);
		await writeFile(join(process.cwd(), thumbPath), thumb);
		const [row] = await db
			.insert(imageFiles)
			.values({
				id,
				userId: params.userId,
				conversationId: params.conversationId,
				artifactId: params.artifactId ?? null,
				role: params.role,
				width: meta.width,
				height: meta.height,
				hasAlpha: meta.hasAlpha ? 1 : 0,
				sizeBytes: params.png.byteLength,
				storagePath,
			})
			.returning();
		if (!row) throw new Error("The picture row was not written.");
		return toImageFile(row);
	} catch (error) {
		await removeFiles([storagePath, thumbPath]);
		throw error;
	}
}

/**
 * The file when the person may see it: the owner, and an incognito chat's files
 * only when the request names that chat (the artifact ownership scope's rule).
 */
export async function getImageFile(params: {
	userId: string;
	fileId: string;
	conversationId?: string | null;
}): Promise<ImageFile | null> {
	const [row] = await db
		.select()
		.from(imageFiles)
		.where(
			and(
				eq(imageFiles.id, params.fileId),
				eq(imageFiles.userId, params.userId),
			),
		)
		.limit(1);
	if (!row) return null;
	const scope = await getArtifactOwnershipScope(params.userId, {
		conversationId: params.conversationId ?? null,
	});
	if (!scope.conversationIds.has(row.conversationId)) return null;
	return toImageFile(row);
}

async function storagePathOf(fileId: string): Promise<string> {
	const [row] = await db
		.select({ storagePath: imageFiles.storagePath })
		.from(imageFiles)
		.where(eq(imageFiles.id, fileId))
		.limit(1);
	if (!row) throw new Error("Picture file not found.");
	return row.storagePath;
}

export async function readImageFileBytes(
	file: ImageFile,
	variant: "full" | "thumb",
): Promise<Uint8Array> {
	const storagePath = await storagePathOf(file.id);
	const wanted = variant === "thumb" ? thumbPathOf(storagePath) : storagePath;
	const absolute = await resolveDeletablePath(wanted);
	if (!absolute) throw new Error("Picture file is outside the storage roots.");
	return new Uint8Array(await readFile(absolute));
}

export async function attachImageFilesToArtifact(
	fileIds: readonly string[],
	artifactId: string,
): Promise<void> {
	if (fileIds.length === 0) return;
	await db
		.update(imageFiles)
		.set({ artifactId })
		.where(inArray(imageFiles.id, [...fileIds]));
}

async function takeRows(rows: Row[]): Promise<number> {
	if (rows.length === 0) return 0;
	await db.delete(imageFiles).where(
		inArray(
			imageFiles.id,
			rows.map((row) => row.id),
		),
	);
	await removeFiles(
		rows.flatMap((row) => [row.storagePath, thumbPathOf(row.storagePath)]),
	);
	return rows.length;
}

/**
 * Removes a stored picture's PNG and thumbnail by the path `storeImageFile`
 * gave them, and its row if it still has one. For a store that finished after
 * its chat's cleanup ran: the row may already be gone (the cascade took it),
 * and the files still must not stay.
 */
export async function discardStoredImageFile(
	file: Pick<ImageFile, "id" | "conversationId">,
): Promise<void> {
	await db.delete(imageFiles).where(eq(imageFiles.id, file.id));
	const storagePath = join(
		IMAGE_FILES_DIR,
		file.conversationId,
		`${file.id}.png`,
	);
	await removeFiles([storagePath, thumbPathOf(storagePath)]);
}

export async function deleteImageFilesForConversation(
	conversationId: string,
): Promise<number> {
	const rows = await db
		.select()
		.from(imageFiles)
		.where(eq(imageFiles.conversationId, conversationId));
	const count = await takeRows(rows);
	await removeConversationDir(conversationId);
	return count;
}

/** The files an Image item owns, read before the item's row goes (its delete clears `artifact_id`). */
export async function listImageFileIdsForArtifact(
	artifactId: string,
): Promise<string[]> {
	const rows = await db
		.select({ id: imageFiles.id })
		.from(imageFiles)
		.where(eq(imageFiles.artifactId, artifactId));
	return rows.map((row) => row.id);
}

export async function deleteImageFilesById(
	fileIds: readonly string[],
): Promise<number> {
	if (fileIds.length === 0) return 0;
	const rows = await db
		.select()
		.from(imageFiles)
		.where(inArray(imageFiles.id, [...fileIds]));
	return takeRows(rows);
}

export async function deleteImageFilesForArtifact(
	artifactId: string,
): Promise<number> {
	return deleteImageFilesById(await listImageFileIdsForArtifact(artifactId));
}

export async function deleteImageFilesForUser(userId: string): Promise<number> {
	const rows = await db
		.select()
		.from(imageFiles)
		.where(eq(imageFiles.userId, userId));
	const count = await takeRows(rows);
	for (const conversationId of new Set(rows.map((r) => r.conversationId))) {
		await removeConversationDir(conversationId);
	}
	return count;
}

/**
 * An Image item the person may read, as a plain select (this file must not
 * import the artifacts facade): its title and the picture file its newest
 * version points at. `null` for anything else: another kind, another person's
 * item, an incognito chat's item outside that chat, an item with no readable
 * body. The scope is `getImageFile`'s own.
 */
export async function getImageItem(params: {
	userId: string;
	artifactId: string;
	conversationId: string;
}): Promise<{
	artifactId: string;
	title: string;
	fileId: string;
} | null> {
	const [row] = await db
		.select({
			id: artifacts.id,
			userId: artifacts.userId,
			conversationId: artifacts.conversationId,
			name: artifacts.name,
			metadataJson: artifacts.metadataJson,
			contentText: artifacts.contentText,
		})
		.from(artifacts)
		.where(eq(artifacts.id, params.artifactId))
		.limit(1);
	if (!row || row.userId !== params.userId || !row.conversationId) return null;
	const metadata = parseJsonRecord(row.metadataJson);
	if (metadata?.artifactType !== "image") return null;
	const scope = await getArtifactOwnershipScope(params.userId, {
		conversationId: params.conversationId,
	});
	if (!scope.conversationIds.has(row.conversationId)) return null;
	const body = parseImageVersionBody(row.contentText);
	if (!body) return null;
	const title =
		typeof metadata.title === "string" && metadata.title.trim()
			? metadata.title
			: row.name;
	return { artifactId: row.id, title, fileId: body.fileId };
}

/** The name a download carries: the item's title when the file belongs to one, else `picture.png`. */
export async function imageFileDownloadName(file: ImageFile): Promise<string> {
	let title = "";
	if (file.artifactId) {
		const [row] = await db
			.select({ name: artifacts.name, metadataJson: artifacts.metadataJson })
			.from(artifacts)
			.where(eq(artifacts.id, file.artifactId))
			.limit(1);
		const metaTitle = parseJsonRecord(row?.metadataJson ?? null)?.title;
		title =
			typeof metaTitle === "string" && metaTitle.trim()
				? metaTitle
				: (row?.name ?? "");
	}
	const clean = title
		// biome-ignore lint/suspicious/noControlCharactersInRegex: strips control characters from a file name
		.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, " - ")
		.replace(/\s*-\s*(?:-\s*)*/g, " - ")
		.replace(/\s+/g, " ")
		.replace(/^[\s.-]+|[\s.-]+$/g, "")
		.slice(0, 120)
		.trim();
	return `${clean || "picture"}.png`;
}
