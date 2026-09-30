/**
 * A picture of a board, stored (Feature 2 · Artifacts, Slice 3, T7). Only the
 * browser has the board rendered, so the browser draws the picture and sends
 * it; this is what happens to it on the way in. Two kinds arrive here, through
 * the same door, and only the second is ever shown to anyone as a file:
 *
 *  - `canvas-export`: the PNG the reader downloads. It becomes an ordinary
 *    produced file (ruling 18): a `chat_generated_files` row on the chat's
 *    newest reply, the `generated_output` artifact `syncGeneratedFilesToMemory`
 *    makes of every produced file, and a `used_in_output` link from that
 *    artifact to the board, so it appears as a File in the chat and in the
 *    library like any other and knows what it is a picture of.
 *  - `canvas-poster`: the still image of one block a picture of the board
 *    cannot reproduce live (an App, a map, photos, a web search). It is only
 *    ever a picture INSIDE the board's own data (`PosterRef`), so it is stored
 *    as a chat file that hangs from no reply and has no artifact: nothing lists
 *    it. A block has one; a new one replaces the last.
 *
 * Both go through `storeGeneratedFile`, the one place a generated file is
 * written, and neither is a new store. What is checked here is the whole of
 * what a request can get wrong: whose board it is (the same scope as every
 * artifact read, so a stranger's board and a missing one answer alike), that
 * the bytes are a PNG (by their own signature and ends, not by what the request
 * says they are), and that they are no larger than the browser could have drawn.
 */
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { chatGeneratedFiles } from "$lib/server/db/schema";
import {
	deleteChatFile,
	getChatFilesByIdsForConversation,
	storeGeneratedFile,
	syncGeneratedFilesToMemory,
} from "$lib/server/services/chat-files";
import { createArtifactLink } from "$lib/server/services/knowledge";
import { getLatestAssistantMessageId } from "$lib/server/services/messages";
import {
	EXPORT_PNG_MAX_BYTES,
	POSTER_PNG_MAX_BYTES,
} from "$lib/shared/artifacts/canvas-limits";
import { sanitizeDocumentFilename } from "./export";
import { getArtifact } from "./record";

const CANVAS_IMAGE_SOURCES = ["canvas-export", "canvas-poster"] as const;
type CanvasImageSource = (typeof CANVAS_IMAGE_SOURCES)[number];

type StoreCanvasImageFailure =
	/** The board is not the caller's, does not exist, or is not a board (one answer for all three). */
	| "not_found"
	/** The board belongs to no conversation, so there is nowhere to keep a file for it. */
	| "no_conversation"
	/** The request is not shaped like one (an unknown source, a poster with no block). */
	| "invalid_request"
	/** The bytes are not a whole PNG. */
	| "not_png"
	/** The picture is larger than a browser could have been asked to draw. */
	| "too_large";

type StoreCanvasImageResult =
	| { ok: true; fileId: string; width: number; height: number }
	| { ok: false; reason: StoreCanvasImageFailure };

/** The status each failure answers with (`400`, `404`, `409`, `413`, `415`). */
export function canvasImageFailureStatus(
	reason: StoreCanvasImageFailure,
): number {
	switch (reason) {
		case "not_found":
			return 404;
		case "no_conversation":
			return 409;
		case "invalid_request":
			return 400;
		case "too_large":
			return 413;
		case "not_png":
			return 415;
	}
}

/** The most pixels a picture may be on either side: the export's clamp at twice the density, a poster's box at twice. */
const MAX_SIDE_PX = {
	"canvas-export": { width: 4_800, height: 3_600 },
	"canvas-poster": { width: 1_280, height: 800 },
} as const;
const MAX_BYTES = {
	"canvas-export": EXPORT_PNG_MAX_BYTES,
	"canvas-poster": POSTER_PNG_MAX_BYTES,
} as const;

const DATA_URL_PREFIX = "data:image/png;base64,";
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const PNG_SIGNATURE = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
/** The last twelve bytes of every PNG: the empty IEND chunk (length, type, checksum). */
const PNG_END = Buffer.from([
	0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

type DecodedPng =
	| { ok: true; bytes: Buffer; width: number; height: number }
	| { ok: false; reason: "not_png" | "too_large" };

/** A PNG's bytes out of a data URL, judged by the bytes: the signature, the header chunk with its size, and the end chunk. */
function decodePngDataUrl(
	dataUrl: unknown,
	source: CanvasImageSource,
): DecodedPng {
	if (typeof dataUrl !== "string" || !dataUrl.startsWith(DATA_URL_PREFIX)) {
		return { ok: false, reason: "not_png" };
	}
	const maxBytes = MAX_BYTES[source];
	const encoded = dataUrl.slice(DATA_URL_PREFIX.length);
	// Before anything is allocated: base64 is four characters to three bytes.
	if (encoded.length > Math.ceil(maxBytes / 3) * 4) {
		return { ok: false, reason: "too_large" };
	}
	if (!BASE64.test(encoded)) return { ok: false, reason: "not_png" };
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.length > maxBytes) return { ok: false, reason: "too_large" };
	if (
		bytes.length < PNG_SIGNATURE.length + 25 + PNG_END.length ||
		!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
		bytes.toString("ascii", 12, 16) !== "IHDR" ||
		!bytes.subarray(bytes.length - PNG_END.length).equals(PNG_END)
	) {
		return { ok: false, reason: "not_png" };
	}
	const width = bytes.readUInt32BE(16);
	const height = bytes.readUInt32BE(20);
	if (width < 1 || height < 1) return { ok: false, reason: "not_png" };
	const limit = MAX_SIDE_PX[source];
	if (width > limit.width || height > limit.height) {
		return { ok: false, reason: "too_large" };
	}
	return { ok: true, bytes, width, height };
}

/** A block's id as a piece of a file name: nothing but letters, digits, dashes and underscores. */
function fileNamePart(id: string): string {
	return id.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 64) || "block";
}

export async function storeCanvasImage(input: {
	userId: string;
	artifactId: string;
	/** The chat the panel is showing (ruling 51): what lets an incognito chat's own board be read. */
	conversationId?: string | null;
	source: unknown;
	/** A poster only: the block it is the picture of. */
	nodeId?: unknown;
	dataUrl: unknown;
}): Promise<StoreCanvasImageResult> {
	const source = CANVAS_IMAGE_SOURCES.find((known) => known === input.source);
	if (!source) return { ok: false, reason: "invalid_request" };
	if (
		source === "canvas-poster" &&
		(typeof input.nodeId !== "string" || input.nodeId.length === 0)
	) {
		return { ok: false, reason: "invalid_request" };
	}

	const board = await getArtifact({
		userId: input.userId,
		artifactId: input.artifactId,
		conversationId: input.conversationId,
	});
	if (!board || board.kind !== "canvas") {
		return { ok: false, reason: "not_found" };
	}
	const conversationId = board.conversationId;
	if (!conversationId) return { ok: false, reason: "no_conversation" };

	const png = decodePngDataUrl(input.dataUrl, source);
	if (!png.ok) return png;

	if (source === "canvas-poster") {
		return storePoster({
			userId: input.userId,
			conversationId,
			boardId: board.id,
			nodeId: input.nodeId as string,
			png,
		});
	}
	return storeExport({
		userId: input.userId,
		conversationId,
		board: { id: board.id, title: board.title },
		png,
	});
}

async function storePoster(params: {
	userId: string;
	conversationId: string;
	boardId: string;
	nodeId: string;
	png: Extract<DecodedPng, { ok: true }>;
}): Promise<StoreCanvasImageResult> {
	const filename = `canvas-poster-${params.boardId}-${fileNamePart(params.nodeId)}.png`;
	const stored = await storeGeneratedFile(
		params.conversationId,
		params.userId,
		{
			filename,
			mimeType: "image/png",
			content: params.png.bytes,
			assistantMessageId: null,
		},
	);
	// One poster per block: the picture it replaces goes, once the new one is safe.
	// (Read straight from the table: the conversation's file listing shows only
	// what hangs from a reply, and a poster hangs from none.)
	const earlier = await db
		.select({ id: chatGeneratedFiles.id })
		.from(chatGeneratedFiles)
		.where(
			and(
				eq(chatGeneratedFiles.conversationId, params.conversationId),
				eq(chatGeneratedFiles.userId, params.userId),
				eq(chatGeneratedFiles.filename, filename),
			),
		);
	for (const file of earlier) {
		if (file.id === stored.id) continue;
		await deleteChatFile(params.conversationId, file.id).catch(() => undefined);
	}
	return {
		ok: true,
		fileId: stored.id,
		width: params.png.width,
		height: params.png.height,
	};
}

async function storeExport(params: {
	userId: string;
	conversationId: string;
	board: { id: string; title: string };
	png: Extract<DecodedPng, { ok: true }>;
}): Promise<StoreCanvasImageResult> {
	// A produced file is shown, listed and remembered through the reply it belongs
	// to. A chat with none (its replies were deleted) still gets the file to
	// download; it just is not listed anywhere.
	const assistantMessageId = await getLatestAssistantMessageId(
		params.conversationId,
	);
	const filename = `${sanitizeDocumentFilename(params.board.title)}.png`;
	const stored = await storeGeneratedFile(
		params.conversationId,
		params.userId,
		{
			filename,
			mimeType: "image/png",
			content: params.png.bytes,
			assistantMessageId,
		},
	);
	if (assistantMessageId) {
		await syncGeneratedFilesToMemory({
			userId: params.userId,
			conversationId: params.conversationId,
			assistantMessageId,
			fileIds: [stored.id],
			assistantResponse: `Exported the board "${params.board.title}" as a PNG image, ${params.png.width} by ${params.png.height} pixels.`,
		});
		const [made] = await getChatFilesByIdsForConversation(
			params.conversationId,
			[stored.id],
		);
		if (made?.artifactId) {
			await createArtifactLink({
				userId: params.userId,
				artifactId: made.artifactId,
				relatedArtifactId: params.board.id,
				conversationId: params.conversationId,
				messageId: assistantMessageId,
				linkType: "used_in_output",
			});
		}
	}
	return {
		ok: true,
		fileId: stored.id,
		width: params.png.width,
		height: params.png.height,
	};
}
