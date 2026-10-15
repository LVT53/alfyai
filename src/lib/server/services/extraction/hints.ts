// Caller-supplied extraction hints: how they are stored and how an extractor
// sees them.
//
// Hints are opaque to the job engine and to the handler: a tier a re-extraction
// asks for, the marker that says a queued job exists because somebody pressed
// Re-extract. They are stored as one JSON object in `hints_json` and handed to
// the extractor as they are, minus any key the ledger once reserved for itself.
//
// Nothing here imports the app, so the handler, the façade and the read path can
// all use it without pulling each other in.

/**
 * The previous release kept its outage counter in this column under a reserved,
 * `$`-prefixed key; the counter lives in `retry_state_json` now (migration
 * 1777140000115 moved it). The prefix is still stripped before hints reach an
 * extractor, so a row the previous release wrote in the deploy window and the
 * startup shim has not reached yet can never leak its bookkeeping to a backend.
 */
const RESERVED_HINT_PREFIX = "$";

export function serializeHints(
	hints: Readonly<Record<string, unknown>> | null | undefined,
): string | null {
	if (!hints) return null;
	return Object.keys(hints).length === 0 ? null : JSON.stringify(hints);
}

export function parseExtractionHints(
	json: string | null | undefined,
): Record<string, unknown> | null {
	if (!json) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		// A hint blob we cannot read is a hint we do not apply. It is advisory
		// input, never required for correctness, so dropping it is safe.
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	const caller = Object.fromEntries(
		Object.entries(parsed as Record<string, unknown>).filter(
			([key]) => !key.startsWith(RESERVED_HINT_PREFIX),
		),
	);
	return Object.keys(caller).length === 0 ? null : caller;
}
