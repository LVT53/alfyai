// A thin adapter over today's extraction client, so the ledger has a working
// `mineru`-route backend from the first commit.
//
// It WRAPS `services/document-extraction.ts` and never edits it: that module is
// replaced wholesale by the next phase's client, and an adapter that had
// started editing it would have to be untangled first.
//
// Known imprecision, inherited not introduced: the underlying function swallows
// every failure into `{ text: null }`, so this adapter cannot tell a backend
// outage from a genuinely unreadable document. It reports `job_failed`
// (retryable) rather than `empty_result` (not), because the asymmetry favours
// it: a real outage then recovers on its own, while a genuinely empty document
// costs three cheap calls and still surfaces a Retry button. The replacement
// client throws precise codes and this file goes away with it.

import { extractDocumentText } from "$lib/server/services/document-extraction";
import type {
	DocumentExtractor,
	ExtractDocumentRequest,
	ExtractDocumentResult,
} from "../contracts";
import { DocumentExtractionError } from "../contracts";

export const LEGACY_MINERU3_EXTRACTOR_NAME = "mineru3";

export type ExtractDocumentTextDependency = typeof extractDocumentText;

function assertNotAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		throw new DocumentExtractionError({
			code: "canceled",
			message: "Extraction was canceled.",
			retryable: false,
		});
	}
}

export function createLegacyMineru3Extractor(
	extractText: ExtractDocumentTextDependency = extractDocumentText,
): DocumentExtractor {
	return {
		name: LEGACY_MINERU3_EXTRACTOR_NAME,
		// The 3.x endpoint is one synchronous POST with no job id to come back
		// to, so there is nothing a handle could point at. Saying so here is what
		// stops the ledger from ever handing this extractor a `resumeHandle`.
		supportsResume: false,

		async extract(
			request: ExtractDocumentRequest,
		): Promise<ExtractDocumentResult> {
			assertNotAborted(request.signal);
			request.onProgress({ phase: "uploading" });

			// The underlying call has no AbortSignal parameter. Racing it lets a
			// cancel return promptly instead of blocking on a five-minute HTTP
			// timeout; the in-flight request is then abandoned rather than aborted,
			// which is the best this wrapper can honestly offer.
			const aborted = new Promise<never>((_resolve, reject) => {
				if (request.signal.aborted) {
					reject(
						new DocumentExtractionError({
							code: "canceled",
							message: "Extraction was canceled.",
							retryable: false,
						}),
					);
					return;
				}
				request.signal.addEventListener(
					"abort",
					() =>
						reject(
							new DocumentExtractionError({
								code: "canceled",
								message: "Extraction was canceled.",
								retryable: false,
							}),
						),
					{ once: true },
				);
			});

			request.onProgress({ phase: "parsing" });

			const extraction = await Promise.race([
				extractText(
					request.filePathAbsolute,
					request.mimeType,
					request.fileName,
				),
				aborted,
			]);

			assertNotAborted(request.signal);

			if (!extraction.text) {
				throw new DocumentExtractionError({
					code: "job_failed",
					message: `The extraction backend returned no text for ${request.fileName}.`,
					retryable: true,
				});
			}

			return {
				text: extraction.text,
				normalizedName: extraction.normalizedName,
				mimeType: extraction.mimeType,
				...(extraction.pageCount === undefined
					? {}
					: { pageCount: extraction.pageCount }),
			};
		},
	};
}

export const legacyMineru3Extractor: DocumentExtractor =
	createLegacyMineru3Extractor();
