/**
 * What an empty Document, App or Canvas says (Slice 6 T6, rulings 4 and 32).
 *
 * The line is the kind's tour summary, so what the empty state says and what
 * the tour says are one sentence an admin can edit in one place; the
 * dictionary's line is the fallback for a reader with no tour answer (an
 * incognito chat asks for none, a request failed, the summary has no words in
 * this language). Both are shipped, and `empty-state.test.ts` fails when a
 * shipped summary and its fallback say different things.
 *
 * Bodies render the result through `EmptyState.svelte`, which also draws the
 * quiet "Show it again" link beneath it.
 */
import type { I18nKey } from "$lib/i18n";
import type {
	LocalizedText,
	ShippedArtifactTourType,
} from "$lib/shared/artifacts/tours";

/**
 * The dictionary line each kind's empty state falls back to. The Canvas's key
 * was there before the tours; the Document's and the App's are new with them.
 */
export const EMPTY_STATE_FALLBACK_KEYS = {
	document: "artifacts.document.emptyState",
	app: "artifacts.app.emptyState",
	canvas: "artifacts.canvas.emptyBoard",
} as const satisfies Record<ShippedArtifactTourType, I18nKey>;

/**
 * The kind's empty-state line in the reader's language: the tour's summary when
 * it has one there, otherwise the dictionary's. A language the summary lacks
 * reads as the dictionary's line in that language, never as the English
 * summary on a Hungarian page. `summary` is `tour.summary` as the panel kept it
 * (`ArtifactBodyProps.tourSummary`), or nothing when no tour answered.
 */
export function emptyStateLine(
	summary: LocalizedText | null | undefined,
	language: keyof LocalizedText,
	t: (key: I18nKey) => string,
	kind: ShippedArtifactTourType,
): string {
	const own = summary?.[language];
	if (typeof own === "string" && own.trim().length > 0) return own;
	return t(EMPTY_STATE_FALLBACK_KEYS[kind]);
}
