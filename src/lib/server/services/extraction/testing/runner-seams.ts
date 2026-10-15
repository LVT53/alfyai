// The seams a test of the extraction handler drives it through.
//
// The handler is loaded by the engine, so a test cannot hand it its extractor,
// its indexing step or its config the way the old worker took them as arguments.
// These are spies on the three modules the handler (and the kind's definition)
// read them from. They are installed AFTER the module registry has been reset, so
// that they land on the instances the engine is about to load, and they are
// undone by `vi.restoreAllMocks()`.
//
// Shared rather than copied because the handler's test and its logging test both
// need them, and a seam that lives in one `.test.ts` gets copied and then drifts.

import { vi } from "vitest";
import type { DocumentExtractor } from "../contracts";
import type { DocumentExtractionIntakeRoute } from "../types";

export interface RunnerSeams {
	/** The extractor every route resolves to; null = the real registry. */
	extractor: DocumentExtractor | null;
	/** Picks an extractor per route, for a test that wants to see which routes ran. Wins over `extractor`. */
	resolveExtractor:
		| null
		| ((route: DocumentExtractionIntakeRoute) => DocumentExtractor);
	/** The indexing step; null = the real one. */
	persist:
		| null
		| ((params: unknown) => Promise<{
				id: string;
				metadata?: Record<string, unknown> | null;
		  }>);
	/**
	 * The real indexing step, as it was before the spy replaced it: for a test that
	 * wants to run it and then do something to the world (a cancel that lands while
	 * the chunks are inserted). Null until the seams are installed.
	 */
	realPersist:
		| null
		| ((params: never) => Promise<{
				id: string;
				metadata?: Record<string, unknown> | null;
		  }>);
	/** Config values laid over the real ones. */
	config: Record<string, unknown>;
	/** Runs when the handler resolves its extractor: after the claim, before the source lookup. */
	onResolve: null | (() => void);
	installed: boolean;
}

export const seams: RunnerSeams = {
	extractor: null,
	resolveExtractor: null,
	persist: null,
	realPersist: null,
	config: {},
	onResolve: null,
	installed: false,
};

/** Back to the real thing, for the next test. Call after `vi.resetModules()`. */
export function resetSeams(): void {
	seams.extractor = null;
	seams.resolveExtractor = null;
	seams.persist = null;
	seams.realPersist = null;
	seams.config = {};
	seams.onResolve = null;
	seams.installed = false;
}

/** Puts the seams on the modules the engine is about to load. Once per registry. */
export async function installSeams(): Promise<void> {
	if (seams.installed) return;
	seams.installed = true;
	const registry = await import("../extractors/registry");
	const persist = await import("../persist");
	const config = await import("../config");
	const resolveExtractor = registry.resolveExtractor;
	const createNormalized = persist.createNormalizedArtifactFromExtraction;
	seams.realPersist = createNormalized;
	const getExtractionConfig = config.getExtractionConfig;
	vi.spyOn(registry, "resolveExtractor").mockImplementation((route) => {
		seams.onResolve?.();
		return (
			seams.resolveExtractor?.(route) ??
			seams.extractor ??
			resolveExtractor(route)
		);
	});
	vi.spyOn(
		persist,
		"createNormalizedArtifactFromExtraction",
	).mockImplementation((params) =>
		seams.persist
			? (seams.persist(params) as ReturnType<typeof createNormalized>)
			: createNormalized(params),
	);
	vi.spyOn(config, "getExtractionConfig").mockImplementation(() => ({
		...getExtractionConfig(),
		...seams.config,
	}));
}
