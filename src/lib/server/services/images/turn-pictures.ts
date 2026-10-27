// The numbered pictures of one chat turn. A message carries its uploads, the
// card pictures the person attached (Attach), the picture open in the panel and
// the marks they drew on one of those; each gets ONE number here, the number
// the person says ("picture 2") and the model reads ("Picture 2: ..."). This is
// the single numbering authority: `vision/turn-images.ts` takes every number
// from the index and computes none. The same picture reaching a turn twice (an
// Attach of the picture that is also open, the same upload twice) has one
// number and is sent once.
import type { ExtraPicture } from "$lib/server/services/vision/turn-images";
import { oneLineName } from "$lib/server/services/vision/turn-images";
import type {
	ImageMarksRequest,
	PictureRef,
	UserPicturesMetadata,
} from "$lib/shared/artifacts/image-body";
import {
	getImageFile,
	getImageItem,
	readImageFileBytes,
	storeImageFile,
} from "./files";
import { marksLabel, paintMarks } from "./marks";

export type TurnPictureSource =
	| {
			type: "upload";
			artifactId: string;
			name: string;
			mimeType: string | null;
	  }
	| {
			type: "image_file";
			fileId: string;
			name: string;
			artifactId: string | null;
			role: "attached" | "open" | "marked";
			marks?: ImageMarksRequest["marks"];
	  };

export type TurnPicture = { number: number; source: TurnPictureSource };

export type TurnPictureIndex = {
	/** Every picture of the message, in number order, each once. */
	pictures: TurnPicture[];
	byNumber(number: number): TurnPicture | null;
	/**
	 * What the user message keeps of these pictures (null when the message
	 * carried none besides its uploads).
	 */
	metadata: UserPicturesMetadata | null;
};

export type TurnPictureUpload = {
	artifactId: string;
	name: string;
	mimeType: string | null;
};

/** Said after an open picture's title in its label. */
const OPEN_SUFFIX = " (open in the panel)";
/** What a card picture with no item title is called. */
const ATTACHED_FALLBACK_NAME = "Attached picture";
const TITLE_MAX_CHARS = 80;

/** An empty index: a message with no uploads or other pictures. */
export function emptyTurnPictureIndex(): TurnPictureIndex {
	return indexOf([], null);
}

function indexOf(
	pictures: TurnPicture[],
	metadata: UserPicturesMetadata | null,
): TurnPictureIndex {
	const sorted = [...pictures].sort((a, b) => a.number - b.number);
	return {
		pictures: sorted,
		byNumber: (number) =>
			sorted.find((picture) => picture.number === number) ?? null,
		metadata,
	};
}

/**
 * The number an upload carries in this turn. It throws for an upload the index
 * does not hold: a caller that asks for a picture the turn does not have is a
 * bug, never a picture numbered 0.
 */
export function uploadNumberOf(
	index: TurnPictureIndex,
): (artifactId: string) => number {
	return (artifactId) => {
		const found = index.pictures.find(
			(picture) =>
				picture.source.type === "upload" &&
				picture.source.artifactId === artifactId,
		);
		if (!found) {
			throw new Error(`Attachment ${artifactId} has no picture number`);
		}
		return found.number;
	};
}

type OpenPicture = {
	fileId: string;
	artifactId: string;
	title: string;
};

/**
 * The picture open in the panel, when `artifactId` is an Image item of this
 * person whose newest version's file they may read. Anything else (a document,
 * another person's item, a deleted file) is no open picture and never an error.
 */
export async function resolveOpenPicture(params: {
	userId: string;
	conversationId: string;
	openImageArtifactId: string | null | undefined;
}): Promise<OpenPicture | null> {
	if (!params.openImageArtifactId) return null;
	const item = await getImageItem({
		userId: params.userId,
		artifactId: params.openImageArtifactId,
		conversationId: params.conversationId,
	});
	if (!item) return null;
	const file = await getImageFile({
		userId: params.userId,
		fileId: item.fileId,
		conversationId: params.conversationId,
	});
	if (!file) return null;
	return {
		fileId: file.id,
		artifactId: item.artifactId,
		title: oneLineName(item.title, TITLE_MAX_CHARS) || ATTACHED_FALLBACK_NAME,
	};
}

export type PictureRequestError = {
	status: number;
	error: string;
	code: string;
};

/**
 * Whether the person may use the pictures the request names. A picture file
 * that is not theirs (or lives in an incognito chat other than this one) is
 * refused as not found and never read; marks must be on the picture open in the
 * panel or on one that is attached. Nothing here counts the pictures: a message
 * carries any number of them.
 */
export async function validatePictureRequest(params: {
	userId: string;
	conversationId: string;
	pictureRefs: readonly PictureRef[];
	imageMarks: ImageMarksRequest | null;
	openImageArtifactId: string | null | undefined;
}): Promise<PictureRequestError | null> {
	const { userId, conversationId } = params;
	for (const ref of params.pictureRefs) {
		const file = await getImageFile({
			userId,
			fileId: ref.imageFileId,
			conversationId,
		});
		if (!file) {
			return {
				status: 404,
				error: "Picture not found",
				code: "picture_not_found",
			};
		}
	}
	if (params.imageMarks) {
		const markedId = params.imageMarks.imageFileId;
		const isRef = params.pictureRefs.some(
			(ref) => ref.imageFileId === markedId,
		);
		const open = isRef
			? null
			: await resolveOpenPicture({
					userId,
					conversationId,
					openImageArtifactId: params.openImageArtifactId,
				});
		if (!isRef && open?.fileId !== markedId) {
			return {
				status: 400,
				error: "Marks must be on the open picture or an attached one",
				code: "invalid_image_marks",
			};
		}
	}
	return null;
}

/**
 * The pictures a regenerated turn takes back from its user message's record,
 * kept only when the person can still read them: a ref whose file is gone is
 * dropped without being read, and marks stay only when their picture is a
 * surviving ref or the one open now. Never an error: a regenerate without the
 * pictures is what it was before they existed.
 */
export async function keepReadableRecordedPictures(params: {
	userId: string;
	conversationId: string;
	refs: PictureRef[];
	marks: ImageMarksRequest | null;
	openImageArtifactId: string | null;
}): Promise<{
	pictureRefs: PictureRef[];
	imageMarks: ImageMarksRequest | null;
}> {
	const pictureRefs: PictureRef[] = [];
	for (const ref of params.refs) {
		const file = await getImageFile({
			userId: params.userId,
			fileId: ref.imageFileId,
			conversationId: params.conversationId,
		});
		if (file) pictureRefs.push(ref);
	}
	let imageMarks: ImageMarksRequest | null = null;
	if (params.marks) {
		const markedId = params.marks.imageFileId;
		const open = pictureRefs.some((ref) => ref.imageFileId === markedId)
			? null
			: await resolveOpenPicture({
					userId: params.userId,
					conversationId: params.conversationId,
					openImageArtifactId: params.openImageArtifactId,
				});
		if (
			pictureRefs.some((ref) => ref.imageFileId === markedId) ||
			open?.fileId === markedId
		) {
			imageMarks = params.marks;
		}
	}
	return { pictureRefs, imageMarks };
}

/** The smallest number from 1 that is not taken. */
function nextFree(taken: Set<number>): number {
	let candidate = 1;
	while (taken.has(candidate)) candidate += 1;
	taken.add(candidate);
	return candidate;
}

async function titleOfItem(
	userId: string,
	conversationId: string,
	artifactId: string | null,
): Promise<string | null> {
	if (!artifactId) return null;
	const item = await getImageItem({ userId, artifactId, conversationId });
	if (!item) return null;
	return oneLineName(item.title, TITLE_MAX_CHARS) || null;
}

/**
 * Numbers every picture of the turn. The refs keep the numbers the person saw
 * them under; the uploads (image attachments in attachment order) fill the free
 * numbers; a ref whose number is repeated or out of range is numbered after
 * them, in the order given; the open picture comes next, then the marked copy.
 * A ref that is the open picture's file, a repeated ref and a repeated upload
 * are each one picture. The marked copy is painted from the full picture and
 * stored (role `marked`); if that fails the turn goes on without it.
 */
export async function resolveTurnPictures(params: {
	userId: string;
	conversationId: string;
	uploads: Array<{
		artifactId: string;
		name: string;
		mimeType: string | null;
	}>;
	pictureRefs: readonly PictureRef[];
	openImageArtifactId: string | null;
	marks: ImageMarksRequest | null;
}): Promise<TurnPictureIndex> {
	const { userId, conversationId } = params;
	const open = await resolveOpenPicture({
		userId,
		conversationId,
		openImageArtifactId: params.openImageArtifactId,
	});

	// The refs: each file once, still readable by the person.
	const seenFiles = new Set<string>();
	const refs: Array<{ ref: PictureRef; artifactId: string | null }> = [];
	for (const ref of params.pictureRefs) {
		if (seenFiles.has(ref.imageFileId)) continue;
		seenFiles.add(ref.imageFileId);
		const file = await getImageFile({
			userId,
			fileId: ref.imageFileId,
			conversationId,
		});
		if (!file) continue;
		refs.push({ ref, artifactId: file.artifactId });
	}
	const uploads: TurnPictureUpload[] = [];
	const seenUploads = new Set<string>();
	for (const upload of params.uploads) {
		if (seenUploads.has(upload.artifactId)) continue;
		seenUploads.add(upload.artifactId);
		uploads.push(upload);
	}

	const taken = new Set<number>();
	const range = refs.length + uploads.length;
	const kept: typeof refs = [];
	const late: typeof refs = [];
	for (const entry of refs) {
		const { number } = entry.ref;
		if (
			Number.isInteger(number) &&
			number >= 1 &&
			number <= range &&
			!taken.has(number)
		) {
			taken.add(number);
			kept.push(entry);
		} else late.push(entry);
	}

	const pictures: TurnPicture[] = [];
	const metadataRefs: UserPicturesMetadata["refs"] = [];
	const openIsRef =
		open !== null &&
		refs.some((entry) => entry.ref.imageFileId === open.fileId);

	const addRef = async (entry: (typeof refs)[number], number: number) => {
		const isOpen = open !== null && entry.ref.imageFileId === open.fileId;
		const title =
			(isOpen ? open.title : "") ||
			(await titleOfItem(userId, conversationId, entry.artifactId)) ||
			ATTACHED_FALLBACK_NAME;
		pictures.push({
			number,
			source: {
				type: "image_file",
				fileId: entry.ref.imageFileId,
				name: isOpen ? `${title}${OPEN_SUFFIX}` : title,
				artifactId: entry.artifactId,
				role: "attached",
			},
		});
		metadataRefs.push({
			imageFileId: entry.ref.imageFileId,
			number,
			name: title,
			...(isOpen ? { open: true as const } : {}),
		});
	};

	for (const entry of kept) await addRef(entry, entry.ref.number);
	for (const upload of uploads) {
		pictures.push({
			number: nextFree(taken),
			source: {
				type: "upload",
				artifactId: upload.artifactId,
				name: upload.name,
				mimeType: upload.mimeType,
			},
		});
	}
	for (const entry of late) await addRef(entry, nextFree(taken));

	let openNumber: number | null = null;
	if (open && !openIsRef) {
		openNumber = nextFree(taken);
		pictures.push({
			number: openNumber,
			source: {
				type: "image_file",
				fileId: open.fileId,
				name: `${open.title}${OPEN_SUFFIX}`,
				artifactId: open.artifactId,
				role: "open",
			},
		});
	}

	let markedMeta: UserPicturesMetadata["marks"] = null;
	if (params.marks && params.marks.marks.length > 0) {
		const baseFileId = params.marks.imageFileId;
		const base = pictures.find(
			(picture) =>
				picture.source.type === "image_file" &&
				picture.source.fileId === baseFileId,
		);
		if (base) {
			const marked = await storeMarkedCopy({
				userId,
				conversationId,
				baseFileId,
				marks: params.marks.marks,
			});
			if (marked) {
				pictures.push({
					number: nextFree(taken),
					source: {
						type: "image_file",
						fileId: marked.id,
						name: marksLabel(base.number, params.marks.marks),
						artifactId:
							base.source.type === "image_file" ? base.source.artifactId : null,
						role: "marked",
						marks: params.marks.marks,
					},
				});
				markedMeta = {
					imageFileId: baseFileId,
					markedFileId: marked.id,
					letters: params.marks.marks.map((mark) => mark.letter),
					boxes: params.marks.marks,
				};
			}
		}
	}

	const metadata: UserPicturesMetadata | null =
		metadataRefs.length > 0 || open || markedMeta
			? {
					refs: metadataRefs.sort((a, b) => a.number - b.number),
					// An open picture that was also attached is recorded once, on its ref.
					open:
						open && !openIsRef
							? { imageFileId: open.fileId, name: open.title }
							: null,
					marks: markedMeta,
				}
			: null;
	return indexOf(pictures, metadata);
}

async function storeMarkedCopy(params: {
	userId: string;
	conversationId: string;
	baseFileId: string;
	marks: ImageMarksRequest["marks"];
}) {
	try {
		const file = await getImageFile({
			userId: params.userId,
			fileId: params.baseFileId,
			conversationId: params.conversationId,
		});
		if (!file) return null;
		const bytes = await readImageFileBytes(file, "full");
		const png = await paintMarks(bytes, params.marks);
		return await storeImageFile({
			userId: params.userId,
			conversationId: params.conversationId,
			role: "marked",
			png,
		});
	} catch (error) {
		console.warn("[IMAGES] Marked copy not made", {
			reason: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * The index's pictures that are stored picture files, as the extras
 * `vision/turn-images.ts` prepares beside the uploads. The key is
 * `image-file:<fileId>` (as photo-look's is `immich:<id>`): it names the
 * picture in the log and stands in for an empty name. Each load reads the file
 * again through the person's own scope, so a file that left in between is left
 * out rather than read.
 */
export function extraPicturesOf(
	index: TurnPictureIndex,
	scope: { userId: string; conversationId: string },
): ExtraPicture[] {
	return index.pictures.flatMap((picture): ExtraPicture[] => {
		const { source } = picture;
		if (source.type !== "image_file") return [];
		return [
			{
				number: picture.number,
				id: `image-file:${source.fileId}`,
				name: source.name,
				attached: source.role === "attached",
				load: async () => {
					const file = await getImageFile({
						userId: scope.userId,
						fileId: source.fileId,
						conversationId: scope.conversationId,
					});
					if (!file) throw new Error("the picture file is gone");
					const bytes = await readImageFileBytes(file, "full");
					const { ATTACHMENT_MAX_LONG_EDGE, prepareImageForModel } =
						await import("$lib/server/services/vision/prepare-image");
					return prepareImageForModel(bytes, "image/png", {
						maxLongEdge: ATTACHMENT_MAX_LONG_EDGE,
					});
				},
			},
		];
	});
}
