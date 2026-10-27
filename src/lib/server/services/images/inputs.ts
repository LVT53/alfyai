// The pictures a take is made from, as the picture server receives them: a PNG
// each, stored as a picture file of the chat so the take can be read again (a
// retry, a resume after ComfyUI restarts). The picture being changed is the
// BASE, at exactly the canvas the result will have; a reference is a picture
// to take something from, about one megapixel in its own shape; the person's
// marked copy is painted again on the canvas-sized base so its boxes sit where
// the person drew them.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { getArtifactForUser } from "$lib/server/services/knowledge";
import { decodeImageToPng } from "$lib/server/services/vision/prepare-image";
import type { ImageMark } from "$lib/shared/artifacts/image-body";
import type { CanvasSize } from "./canvas";
import { getImageFile, readImageFileBytes, storeImageFile } from "./files";
import { paintMarks } from "./marks";
import type { TakeInput } from "./take-request";
import type { TurnPictureSource } from "./turn-pictures";

/** About one megapixel: the size a reference rides at. */
const REFERENCE_AREA = 1_048_576;

export type LoadedPicture = {
	png: Uint8Array;
	width: number;
	height: number;
	/** The stored picture file when the source is one OF THIS CHAT, so an input of the right size can reuse it; a file of another chat is always copied. */
	fileId: string | null;
	/** The Image item that owns that file, if one does: only that item's in-place change reuses the file as an input. */
	fileArtifactId?: string | null;
};

/** One English sentence for a picture that cannot be read; the tool shows it to the model. */
export class PictureUnreadableError extends Error {
	constructor(name: string) {
		super(
			`The picture ${JSON.stringify(name)} could not be read, so nothing was made from it.`,
		);
		this.name = "PictureUnreadableError";
	}
}

/** Reads a picture of the turn as a PNG with its size; throws `PictureUnreadableError` for one that is gone or cannot be decoded. */
export async function loadPicture(params: {
	userId: string;
	conversationId: string;
	source: TurnPictureSource;
}): Promise<LoadedPicture> {
	const { source } = params;
	try {
		if (source.type === "upload") {
			const artifact = await getArtifactForUser(
				params.userId,
				source.artifactId,
			);
			if (!artifact?.storagePath) throw new Error("no stored file");
			const bytes = await readFile(join(process.cwd(), artifact.storagePath));
			const decoded = await decodeImageToPng(bytes, source.mimeType);
			return {
				png: decoded.png,
				width: decoded.width,
				height: decoded.height,
				fileId: null,
			};
		}
		const file = await getImageFile({
			userId: params.userId,
			fileId: source.fileId,
			conversationId: params.conversationId,
		});
		if (!file) throw new Error("no picture file");
		return {
			png: await readImageFileBytes(file, "full"),
			width: file.width,
			height: file.height,
			fileId: file.conversationId === params.conversationId ? file.id : null,
			fileArtifactId: file.artifactId,
		};
	} catch (error) {
		console.warn("[IMAGES] A picture could not be read for a take", {
			reason: error instanceof Error ? error.message : String(error),
		});
		throw new PictureUnreadableError(source.name);
	}
}

async function resized(
	picture: LoadedPicture,
	width: number,
	height: number,
): Promise<Buffer> {
	return sharp(picture.png)
		.resize(width, height, { fit: "fill" })
		.png()
		.toBuffer();
}

export async function prepareTakeInputs(params: {
	userId: string;
	conversationId: string;
	base: TurnPictureSource | null;
	references: TurnPictureSource[];
	marked: { source: TurnPictureSource; marks: ImageMark[] } | null;
	canvas: CanvasSize;
	/** The base when the caller already decoded it (to find the canvas), so an upload is read once. */
	loadedBase?: LoadedPicture;
	/** The Image item this take changes in place; its own files may be reused as they are. */
	changing?: string | null;
}): Promise<TakeInput[]> {
	const { userId, conversationId, canvas } = params;
	// A stored file is reused by id only for an in-place change of the item that
	// owns it. Anything else is copied, even a file nobody owns yet: an unpicked
	// take can still be picked by its own card later, and must then stay that
	// card's item's, whatever other item was made from it.
	const reusable = (loaded: LoadedPicture): string | null =>
		loaded.fileId &&
		loaded.fileArtifactId &&
		loaded.fileArtifactId === params.changing
			? loaded.fileId
			: null;
	const store = async (
		png: Uint8Array,
		role: "input" | "marked",
	): Promise<string> =>
		(await storeImageFile({ userId, conversationId, role, png })).id;
	const load = (source: TurnPictureSource) =>
		loadPicture({ userId, conversationId, source });

	const inputs: TakeInput[] = [];
	let basePng: Uint8Array | null = null;

	if (params.base) {
		const loaded = params.loadedBase ?? (await load(params.base));
		let fileId = reusable(loaded);
		if (
			fileId &&
			loaded.width === canvas.width &&
			loaded.height === canvas.height
		) {
			basePng = loaded.png;
		} else {
			basePng = await resized(loaded, canvas.width, canvas.height);
			fileId = await store(basePng, "input");
		}
		inputs.push({ fileId, role: "base", name: params.base.name });
	}

	for (const source of params.references) {
		const loaded = await load(source);
		const scale = Math.sqrt(REFERENCE_AREA / (loaded.width * loaded.height));
		let fileId = reusable(loaded);
		if (scale < 1 || !fileId) {
			const png =
				scale < 1
					? await resized(
							loaded,
							Math.max(1, Math.round(loaded.width * scale)),
							Math.max(1, Math.round(loaded.height * scale)),
						)
					: loaded.png;
			fileId = await store(png, "input");
		}
		inputs.push({ fileId, role: "reference", name: source.name });
	}

	if (params.marked) {
		// Painted on the canvas-sized base so the boxes sit where they were drawn;
		// without a base, the marked copy's own pixels are all there is.
		let under = basePng;
		if (!under) {
			const loaded = await load(params.marked.source);
			under = await resized(loaded, canvas.width, canvas.height);
		}
		const painted = await paintMarks(under, params.marked.marks);
		inputs.push({
			fileId: await store(painted, "marked"),
			role: "marked",
			name: params.marked.source.name,
		});
	}
	return inputs;
}
