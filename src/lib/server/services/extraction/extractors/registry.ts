// Which extractor serves which intake route.
//
// One entry per route, and nothing else in the slice decides this. Swapping the
// `mineru` route onto a new backend is therefore a one-line change here plus
// the new file — no ledger change, no schema change, no status change. This is
// that one line: the route now runs the MinerU 4.x V1 client, and the 3.x
// adapter it replaced is gone rather than kept as a fallback (D3 — there is no
// dual-protocol client and no silent degradation).

import type { DocumentExtractor } from "../contracts";
import type { DocumentExtractionIntakeRoute } from "../types";
import { directTextExtractor } from "./direct-text";
import { mineru4Extractor } from "./mineru4";

export function resolveExtractor(
	intakeRoute: DocumentExtractionIntakeRoute,
): DocumentExtractor {
	return intakeRoute === "direct-text" ? directTextExtractor : mineru4Extractor;
}

export type ResolveExtractorDependency = typeof resolveExtractor;
