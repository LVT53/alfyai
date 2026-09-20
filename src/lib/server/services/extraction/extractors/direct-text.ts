// Files that are already text. No backend, no handle, no resume.
//
// The size cap is enforced here as well as at upload intent, because the raw
// and chunked upload routes never re-run intent: without this backstop a 100 MB
// log reaching the ledger through one of those routes would be read whole,
// chunked into thousands of rows and pushed through as many embedding calls
// from a single upload.

import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { getExtractionConfig } from "../config";
import type {
	DocumentExtractor,
	ExtractDocumentRequest,
	ExtractDocumentResult,
} from "../contracts";
import { DocumentExtractionError } from "../contracts";

export const DIRECT_TEXT_EXTRACTOR_NAME = "direct-text";

function toNormalizedName(originalName: string): string {
	const stem = basename(originalName, extname(originalName));
	return `${stem || "document"}.md`;
}

function assertNotAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		throw new DocumentExtractionError({
			code: "canceled",
			message: "Extraction was canceled.",
			retryable: false,
		});
	}
}

export interface DirectTextExtractorOptions {
	/** Overrides the admin-configured cap. Test seam. */
	maxBytes?: number;
}

export function createDirectTextExtractor(
	options: DirectTextExtractorOptions = {},
): DocumentExtractor {
	return {
		name: DIRECT_TEXT_EXTRACTOR_NAME,
		supportsResume: false,

		async extract(
			request: ExtractDocumentRequest,
		): Promise<ExtractDocumentResult> {
			assertNotAborted(request.signal);
			const maxBytes =
				options.maxBytes ?? getExtractionConfig().maxDirectTextBytes;

			// Trust the file, not the caller's `sizeBytes`: the raw upload route
			// records a size before the body finished arriving, and a cap that can
			// be talked past by a wrong number is not a cap.
			const stats = await stat(request.filePathAbsolute).catch(() => null);
			const actualBytes = stats?.size ?? request.sizeBytes;

			if (actualBytes > maxBytes) {
				throw new DocumentExtractionError({
					code: "too_large",
					message: `This text file is ${actualBytes} bytes; the limit for reading a file directly is ${maxBytes} bytes.`,
					retryable: false,
					details: { sizeBytes: actualBytes, maxBytes },
				});
			}

			request.onProgress({ phase: "parsing" });
			assertNotAborted(request.signal);

			let buffer: Buffer;
			try {
				buffer = await readFile(request.filePathAbsolute);
			} catch (error) {
				throw new DocumentExtractionError({
					code: "internal",
					message: `Could not read ${request.fileName} from storage.`,
					retryable: false,
					cause: error,
				});
			}

			assertNotAborted(request.signal);

			// CRLF is normalised the same way `task-state/chunk-sync.ts` does, so a
			// Windows-authored file and its Unix twin produce identical chunk text
			// and therefore identical embeddings.
			const text = buffer.toString("utf8").replace(/\r\n/g, "\n").trim();

			if (!text) {
				throw new DocumentExtractionError({
					code: "empty_result",
					message: `${request.fileName} contains no readable text.`,
					retryable: false,
				});
			}

			return {
				text,
				normalizedName: toNormalizedName(request.fileName),
				mimeType: "text/markdown",
			};
		},
	};
}

export const directTextExtractor: DocumentExtractor =
	createDirectTextExtractor();
