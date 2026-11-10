// What the document reader is handed for one attempt.
//
// Most files go to the reader as they are stored. A type the reader cannot take
// says so in the registry (`intake.readAs`: a HEIC or HEIF photo), and for one
// attempt the reader is handed a converted file of its own instead. The stored
// original is never touched: previews and vision read it.
//
// The runner calls `prepareReaderInput` and `release`; this file only makes and
// removes the file. The decoder is the app's one HEIC decoder,
// `vision/prepare-image.ts`'s `decodeImageToPng`, loaded when a photo needs it,
// so a PDF's attempt does not load sharp and the HEIC converter.
//
// A resumed attempt converts again: nothing of the file outlives the attempt that
// made it, and a crash leaks at most that attempt's one file (`mineru/temp-sweep.ts`
// removes it once it is old enough). The PNG is the same bytes for the same input
// and build, so the digest the extractor keeps in its stored handle (it hashes the
// file on the first attempt only, since `contentSha256` is null here) still names
// the file it is handed.
//
// The runner stores the message of whatever this file throws on the job, and the
// job data sends it to the browser. So a file this helper cannot read or write is
// the ledger's error with the fixed sentence (`fileFailure`), and the raw text of a
// Node file error, an absolute storage or temp path, goes to the attempt's details.

import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import {
	FILE_TYPE_ENTRIES,
	getIntakeReadAs,
	resolveEntry,
} from "$lib/shared/file-types";
import { DocumentExtractionError, extractionErrorMessage } from "./contracts";

/**
 * Longest side of a converted picture. A 12 MP phone photo (4032 px) keeps its
 * full size and a 48 MP one (8064 px) is halved, which bounds the size of the
 * PNG, and so the decode and the upload to the reader.
 */
const READER_PNG_MAX_LONG_EDGE = 4096;

/**
 * Where a transparent photo ends up for the reader: on a white page. libheif gives
 * the transparent pixels of a HEIC as RGBA 0,0,0,0, and a reader handed that sees
 * black text on black, so the document reads as empty and says nothing is wrong.
 */
const READER_PNG_BACKGROUND = "#ffffff";

/**
 * The converted file is `<this><attemptId>.<extension>`, one per attempt, directly
 * in the temp directory. `mineru/temp-sweep.ts` collects the ones a killed process
 * leaves, by this prefix: renaming it strands those, so the sweep reads it from
 * here and `reader-input.test.ts` pins the spelling.
 */
export const READER_INPUT_FILE_PREFIX = "alfyai-reader-input-";

/** The five fields of an extraction request that describe the file. */
interface ReaderInput {
	filePathAbsolute: string;
	fileName: string;
	mimeType: string | null;
	sizeBytes: number;
	contentSha256: string | null;
}

interface ReaderInputParams extends ReaderInput {
	/** Names the converted file, so a crash leaks at most one file per attempt. */
	attemptId: string;
	/** Where the converted file goes. The OS temp directory by default. */
	tempDirRoot?: string;
}

interface PreparedReaderInput {
	input: ReaderInput;
	/** Removes the converted file, if there is one. Never throws; may be called again. */
	release(): Promise<void>;
}

/**
 * The file the reader is handed for this job: the source as given, or a
 * conversion of it when the registry says the reader cannot take the type.
 * `release` removes the conversion, and the caller owes it once the extractor
 * has settled.
 */
export async function prepareReaderInput(
	params: ReaderInputParams,
): Promise<PreparedReaderInput> {
	const readAs = getIntakeReadAs(params.fileName, params.mimeType);
	return readAs === undefined ? unchanged(params) : readAsPng(params, readAs);
}

/**
 * What the reader is told a converted file is: the stored name's stem under the
 * extension of the type it is read as, and that type's MIME type. The one
 * definition. `readAsPng` makes the file under this name, and the guard in
 * `extractors/mineru4.test.ts` that holds the registry against what MinerU
 * accepts asks for it to learn the name MinerU is sent for such a type.
 */
export function readerFileFor(
	fileName: string,
	readAs: "png",
): { fileName: string; mimeType: string } {
	const target = FILE_TYPE_ENTRIES.find((entry) => entry.id === readAs);
	if (!target) {
		throw new Error(
			`The file-type registry has no entry to read ${fileName} as.`,
		);
	}
	return {
		fileName: `${basename(fileName, extname(fileName)) || "document"}.${target.extensions[0]}`,
		mimeType: target.mimeTypes[0],
	};
}

/**
 * A file error as the ledger's.
 *
 * `unavailable`, retryable, with its fixed sentence: what a missing PDF gets from
 * the MinerU extractor, whose fallback for an error it does not know (`ENOENT`,
 * `EACCES`, `ENOSPC`) is the same code, so the same fault reads the same whichever
 * type it hits. Nothing here says anything about the photo itself. The raw text is
 * kept in `details`, which only the attempt's diagnostics read, and the error
 * itself in `cause`.
 */
function fileFailure(
	step: "read" | "write",
	error: unknown,
): DocumentExtractionError {
	const errno = (error as { code?: unknown } | null)?.code;
	return new DocumentExtractionError({
		code: "unavailable",
		message: extractionErrorMessage(
			"unavailable",
			"The photo could not be prepared for the document service.",
		),
		details: {
			step,
			...(typeof errno === "string" ? { errno } : {}),
			rawMessage: error instanceof Error ? error.message : String(error),
		},
		cause: error,
	});
}

function unchanged(params: ReaderInputParams): PreparedReaderInput {
	return {
		input: {
			filePathAbsolute: params.filePathAbsolute,
			fileName: params.fileName,
			mimeType: params.mimeType,
			sizeBytes: params.sizeBytes,
			contentSha256: params.contentSha256,
		},
		release: async () => undefined,
	};
}

// `readAs` is typed as the one value the registry has: widening
// `FileTypeIntake.readAs` fails to compile here, until this learns the new
// conversion.
async function readAsPng(
	params: ReaderInputParams,
	readAs: "png",
): Promise<PreparedReaderInput> {
	const { fileName, mimeType, filePathAbsolute, attemptId } = params;

	// Before a byte is read: a registry that lacks the entry fails here.
	const reader = readerFileFor(fileName, readAs);

	const { decodeImageToPng, ImagePreparationError } = await import(
		"$lib/server/services/vision/prepare-image"
	);
	let bytes: Buffer;
	try {
		bytes = await readFile(filePathAbsolute);
	} catch (error) {
		throw fileFailure("read", error);
	}
	let png: Buffer;
	try {
		({ png } = await decodeImageToPng(
			bytes,
			// The entry's own MIME type, not the job's: a `.heic` a browser sent as
			// application/octet-stream must still take the decoder's HEIC hop.
			resolveEntry(fileName, mimeType)?.mimeTypes[0] ?? null,
			{
				maxLongEdge: READER_PNG_MAX_LONG_EDGE,
				background: READER_PNG_BACKGROUND,
			},
		));
	} catch (error) {
		if (!(error instanceof ImagePreparationError)) throw error;
		throw new DocumentExtractionError({
			code: "document_unreadable",
			message: extractionErrorMessage(
				"document_unreadable",
				"The photo could not be decoded.",
			),
			retryable: false,
			details: { reason: error.message },
			cause: error,
		});
	}

	const pathAbsolute = join(
		params.tempDirRoot ?? tmpdir(),
		`${READER_INPUT_FILE_PREFIX}${attemptId}${extname(reader.fileName)}`,
	);
	try {
		// For its owner alone: the temp directory is shared with every other service
		// on the host, and this is a person's photo.
		await writeFile(pathAbsolute, png, { mode: 0o600 });
	} catch (error) {
		// A half-written file would outlive the attempt.
		await rm(pathAbsolute, { force: true }).catch(() => undefined);
		throw fileFailure("write", error);
	}

	return {
		input: {
			filePathAbsolute: pathAbsolute,
			fileName: reader.fileName,
			mimeType: reader.mimeType,
			sizeBytes: png.length,
			contentSha256: null,
		},
		release: async () => {
			try {
				await rm(pathAbsolute, { force: true });
			} catch (error) {
				console.warn("[EXTRACTION] Reader input could not be removed", {
					attemptId,
					reason: error instanceof Error ? error.message : String(error),
				});
			}
		},
	};
}
