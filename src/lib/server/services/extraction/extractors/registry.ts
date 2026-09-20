// Which extractor serves which intake route.
//
// One entry per route, and nothing else in the slice decides this. Swapping the
// `mineru` route onto a new backend is therefore a one-line change here plus
// the new file — no ledger change, no schema change, no status change.

import type { DocumentExtractor } from "../contracts";
import type { DocumentExtractionIntakeRoute } from "../types";
import { directTextExtractor } from "./direct-text";
import { legacyMineru3Extractor } from "./legacy-mineru3";

export function resolveExtractor(
	intakeRoute: DocumentExtractionIntakeRoute,
): DocumentExtractor {
	return intakeRoute === "direct-text"
		? directTextExtractor
		: legacyMineru3Extractor;
}

export type ResolveExtractorDependency = typeof resolveExtractor;
