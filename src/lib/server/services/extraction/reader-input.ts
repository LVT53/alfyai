// What the document reader is handed for one attempt, and when it is made.
//
// Most files go to the reader as they are stored. A type the reader cannot take
// says so in the registry (`intake.readAs`: a HEIC or HEIF photo), and for one
// attempt the reader is handed a converted file of its own instead. The stored
// original is never touched: previews and vision read it.
//
// Nothing is made until the extractor asks. `prepareReaderInput` answers at once
// with what the file will be called and a way to ask for it (`openFile`), and the
// decode, which holds a thread for about half a second for a 12 MP photo, happens
// when the extractor first needs the bytes: after it has asked the document
// service what it can do, and not at all in an attempt that never gets that far
// (an outage waits and tries again) or that only polls a task it resumed. One
// attempt gets one file: `openFile` returns the same file every time, and a
// failure the same failure. The runner calls `prepareReaderInput` and `release`;
// this file only makes and removes the file.
//
// The decoder is the app's one HEIC decoder, `vision/prepare-image.ts`'s
// `decodeImageToPng`, loaded when a photo needs it, so a PDF's attempt does not
// load sharp. It runs the photo through a worker thread (`vision/heif-decode.ts`)
// and is called off by the attempt's signal: a decode in flight has its thread
// stopped, and a decode that was called off writes no file.
//
// `release` is what the runner owes once the extractor has settled. It never
// throws, may be called again, and waits for an open that is still going before it
// removes the file, so a file cannot be written after it has run; an `openFile`
// after it rejects. A resumed attempt converts again when it needs the bytes:
// nothing of the file outlives the attempt that made it, and a crash leaks at most
// that attempt's one file (`mineru/temp-sweep.ts` removes it once it is old
// enough). The PNG is the same bytes for the same input and build, so the digest
// the extractor keeps in its stored handle (it hashes the file on the first
// attempt only, since `contentSha256` is null here) still names the file it is
// handed.
//
// The runner stores the message of whatever this file throws on the job, and the
// job data sends it to the browser. So a file this helper cannot read or write is
// the ledger's error with the fixed sentence (`fileFailure`), and the raw text of a
// Node file error, an absolute storage or temp path, goes to the attempt's details.

import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import {
	ImageDecodeTimeoutError,
	ImagePreparationError,
	ImageTooLargeError,
} from "$lib/server/services/vision/image-errors";
import {
	FILE_TYPE_ENTRIES,
	getIntakeReadAs,
	resolveEntry,
} from "$lib/shared/file-types";
import {
	DocumentExtractionError,
	type ExtractionFile,
	extractionErrorMessage,
} from "./contracts";

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

/** The stored file, as the job knows it. */
interface StoredFile {
	fileName: string;
	mimeType: string | null;
	sizeBytes: number;
	filePathAbsolute: string;
	/** The ledger's verified digest of the stored bytes, if it has one. */
	contentSha256: string | null;
}

interface ReaderInputParams extends StoredFile {
	/** Names the converted file, so a crash leaks at most one file per attempt. */
	attemptId: string;
	/** Where the converted file goes. The OS temp directory by default. */
	tempDirRoot?: string;
	/**
	 * The attempt's. A cancel, or a claim taken away, calls the decode off: a
	 * decode in flight is stopped and `openFile` rejects with `signal.reason` as
	 * it is.
	 */
	signal: AbortSignal;
}

interface PreparedReaderInput {
	/** What the reader is told the file is called: the stored name, or the converted file's. */
	fileName: string;
	mimeType: string | null;
	/** The file, made when this is first called. See `ExtractDocumentRequest.openFile`. */
	openFile(): Promise<ExtractionFile>;
	/**
	 * Waits for an open still going, then removes the converted file, if there is
	 * one. Never throws; may be called again. An `openFile` after it rejects.
	 */
	release(): Promise<void>;
}

/**
 * The file the reader is handed for this job: the source as given, or a
 * conversion of it when the registry says the reader cannot take the type. It
 * reads and writes nothing until `openFile` is called; `release` removes the
 * conversion, and the caller owes it once the extractor has settled.
 */
export function prepareReaderInput(
	params: ReaderInputParams,
): PreparedReaderInput {
	const readAs = getIntakeReadAs(params.fileName, params.mimeType);
	return readAs === undefined
		? storedReaderInput(params)
		: readAsPng(params, readAs);
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

/**
 * A photo the decoder gave up on, as the ledger's error. Three things can be
 * wrong, and each has its own cure, so each has its own code:
 *
 *  - more pixels than the decoder takes (`ImageTooLargeError`): `image_too_large`,
 *    never retried. The same photo is over the limit every time; the person saves
 *    a smaller copy.
 *  - the decode did not finish in its time (`ImageDecodeTimeoutError`):
 *    `job_failed`, retried. It spends an attempt, like any parse the reader could
 *    not finish, so a slow box gets another try and a photo that always hangs ends
 *    after the attempt budget instead of waiting forever.
 *  - anything else the decoder refuses, libheif's refusals and a worker that
 *    crashed (a plain `ImagePreparationError`): `document_unreadable`, never
 *    retried. The same bytes are refused the same way.
 *
 * The decoder's own words are for an operator: they go to `details`, and the
 * sentence a person reads comes from the code.
 */
function decodeFailure(error: ImagePreparationError): DocumentExtractionError {
	if (error instanceof ImageTooLargeError) {
		return new DocumentExtractionError({
			code: "image_too_large",
			message: extractionErrorMessage(
				"image_too_large",
				"The photo has more pixels than can be read.",
			),
			retryable: false,
			details: {
				reason: error.message,
				pixels: error.pixels,
				limit: error.limit,
			},
			cause: error,
		});
	}
	if (error instanceof ImageDecodeTimeoutError) {
		return new DocumentExtractionError({
			code: "job_failed",
			message: extractionErrorMessage(
				"job_failed",
				"The photo took too long to decode.",
			),
			retryable: true,
			details: { reason: error.message, timeoutMs: error.timeoutMs },
			cause: error,
		});
	}
	return new DocumentExtractionError({
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

/** What `openFile` says once `release` has run: a bug in the caller, not a fact about the file. */
function releasedError(): Error {
	return new Error("The reader input was released before it was opened.");
}

/**
 * The stored file, as it is. Nothing is read to hand it over: the extractor looks
 * at it, and says what is wrong with it in its own words. This is also the runner's
 * input for a job that never converts (a direct-text one).
 */
export function storedReaderInput(file: StoredFile): PreparedReaderInput {
	const handed: ExtractionFile = {
		filePathAbsolute: file.filePathAbsolute,
		sizeBytes: file.sizeBytes,
		contentSha256: file.contentSha256,
	};
	let released = false;
	return {
		fileName: file.fileName,
		mimeType: file.mimeType,
		openFile: async () => {
			if (released) throw releasedError();
			return handed;
		},
		release: async () => {
			released = true;
		},
	};
}

// `readAs` is typed as the one value the registry has: widening
// `FileTypeIntake.readAs` fails to compile here, until this learns the new
// conversion.
function readAsPng(
	params: ReaderInputParams,
	readAs: "png",
): PreparedReaderInput {
	const { fileName, mimeType, filePathAbsolute, attemptId, signal } = params;

	// Before a byte is read: a registry that lacks the entry fails here.
	const reader = readerFileFor(fileName, readAs);
	const pathAbsolute = join(
		params.tempDirRoot ?? tmpdir(),
		`${READER_INPUT_FILE_PREFIX}${attemptId}${extname(reader.fileName)}`,
	);

	let opening: Promise<ExtractionFile> | null = null;
	let releasing: Promise<void> | null = null;
	let released = false;

	async function open(): Promise<ExtractionFile> {
		// An attempt that is already called off reads nothing.
		signal.throwIfAborted();

		const { decodeImageToPng } = await import(
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
					signal,
				},
			));
		} catch (error) {
			// Called off: that is the whole story, whatever the decoder said while its
			// thread was being stopped. Nobody is told the photo was bad.
			if (signal.aborted) throw signal.reason;
			if (!(error instanceof ImagePreparationError)) throw error;
			throw decodeFailure(error);
		}
		// The decode was called off as it finished: nobody is going to read the file.
		signal.throwIfAborted();

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
			filePathAbsolute: pathAbsolute,
			sizeBytes: png.length,
			contentSha256: null,
		};
	}

	async function removeWhenDone(): Promise<void> {
		// Never made, nothing to remove. An open still going finishes first, and the
		// file it writes is removed with the rest.
		if (!opening) return;
		await opening.catch(() => undefined);
		try {
			await rm(pathAbsolute, { force: true });
		} catch (error) {
			console.warn("[EXTRACTION] Reader input could not be removed", {
				attemptId,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return {
		fileName: reader.fileName,
		mimeType: reader.mimeType,
		openFile() {
			if (released) return Promise.reject(releasedError());
			opening ??= open();
			return opening;
		},
		release() {
			released = true;
			releasing ??= removeWhenDone();
			return releasing;
		},
	};
}
