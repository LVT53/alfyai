/**
 * The mixed-output-family refusal, in the one place both callers can import.
 *
 * A produce request names output types from two families: the document-source
 * family (PDF, DOCX, HTML — rendered from our own source JSON) and the plain
 * text family (md, txt, csv, tsv, json, code — written verbatim).
 * `shouldUseDocumentSourceForOutputs` demands that EVERY type be a document
 * source, so `[pdf, md]` answered false, fell through to program mode, and
 * `resolveTextFilename` named the file after `requestedOutputs[0]` — a `.pdf`
 * holding raw markdown, which `pdf`'s `validation: "none"` then waved through.
 *
 * It used to live inside `normal-chat-tools/produce-file.ts`, i.e. only the
 * chat tool ran it. `/api/chat/files/produce` reaches
 * `submitFileProductionIntake` directly (Atlas and the signed service-assertion
 * path in that route's `resolveOwnerUserId`), so a direct caller sending the
 * same ambiguous shape got a generic `unsupported_source_mode` instead. The
 * predicate now lives here, below both callers:
 *
 *  - `file-production/intake.ts` — every caller of the HTTP route;
 *  - `normal-chat-tools/produce-file.ts` — the model tool, whose message this
 *    module keeps byte-identical.
 *
 * This is a LEAF module by design: no DB, no renderer, no sandbox, no import
 * of the tools layer, exactly like `error-message.ts`. `intake.ts` must stay
 * importable without dragging any of that in.
 *
 * WHO IS EXEMPT, and why. Only a caller that leaves the WRITER to us is
 * refused. A caller-authored `program.sourceCode` may legitimately write a PDF
 * and a Markdown file in one run, and a `document_source` job legitimately
 * renders `pdf` and `markdown` off one source (the spec's `document-markdown`
 * live row). Both stay allowed; the two call sites encode that.
 */

import { shouldUseDocumentSourceForOutputs } from "$lib/shared/file-types/production";

/** The intake error code for a refused mixed-family request. */
export const MIXED_OUTPUT_GROUPS_ERROR_CODE = "mixed_output_groups";

export interface MixedOutputGroupsRefusal {
	readonly code: typeof MIXED_OUTPUT_GROUPS_ERROR_CODE;
	readonly error: string;
}

/**
 * `null` when the request is fine: fewer than two types, all document-source
 * types, or all plain-text types.
 */
export function refuseMixedOutputGroups(
	types: readonly string[],
): MixedOutputGroupsRefusal | null {
	if (types.length < 2) return null;
	const documentTypes = types.filter((type) =>
		shouldUseDocumentSourceForOutputs([type]),
	);
	if (documentTypes.length === 0 || documentTypes.length === types.length) {
		return null;
	}
	const textTypes = types.filter((type) => !documentTypes.includes(type));
	return {
		code: MIXED_OUTPUT_GROUPS_ERROR_CODE,
		error:
			`Cannot produce ${types.join(", ")} from one request. ` +
			`Request one group of formats at a time: PDF, DOCX and HTML are rendered from a document source, ` +
			`while md, txt, csv, tsv, json and code files are written as plain text. ` +
			`Call produce_file once for ${documentTypes.join(", ")} (send documentSource, or content with only those formats in requestedOutputs), ` +
			`and again for ${textTypes.join(", ")}.`,
	};
}
