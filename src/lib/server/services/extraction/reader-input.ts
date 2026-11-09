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
// made it, and a crash leaks at most that attempt's one file. The PNG is the same
// bytes for the same input and build, so the digest the extractor keeps in its
// stored handle (it hashes the file on the first attempt only, since
// `contentSha256` is null here) still names the file it is handed.

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

/** The converted file is `<this><attemptId>.<extension>`, one per attempt. */
const READER_INPUT_FILE_PREFIX = "alfyai-reader-input-";

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

	const target = FILE_TYPE_ENTRIES.find((entry) => entry.id === readAs);
	if (!target) {
		throw new Error(
			`The file-type registry has no entry to read ${fileName} as.`,
		);
	}
	const extension = target.extensions[0];

	const { decodeImageToPng, ImagePreparationError } = await import(
		"$lib/server/services/vision/prepare-image"
	);
	const bytes = await readFile(filePathAbsolute);
	let png: Buffer;
	try {
		({ png } = await decodeImageToPng(
			bytes,
			// The entry's own MIME type, not the job's: a `.heic` a browser sent as
			// application/octet-stream must still take the decoder's HEIC hop.
			resolveEntry(fileName, mimeType)?.mimeTypes[0] ?? null,
			{ maxLongEdge: READER_PNG_MAX_LONG_EDGE },
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
		`${READER_INPUT_FILE_PREFIX}${attemptId}.${extension}`,
	);
	try {
		await writeFile(pathAbsolute, png);
	} catch (error) {
		// A half-written file would outlive the attempt.
		await rm(pathAbsolute, { force: true }).catch(() => undefined);
		throw error;
	}

	return {
		input: {
			filePathAbsolute: pathAbsolute,
			fileName: `${basename(fileName, extname(fileName)) || "document"}.${extension}`,
			mimeType: target.mimeTypes[0],
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
