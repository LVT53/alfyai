// What a document's page COUNT actually counts.
//
// MinerU 4 reports `metadata.document.page_count_kind` alongside the count, and
// it is a richer enum than "pages": a PPTX counts slides, an XLSX counts
// sheets, a DOCX reports a `declared` count that is 1 for a four-heading
// document, and a CSV or HTML page reports a `logical` count that corresponds
// to nothing a reader could turn to. PNG and JPEG report no count at all.
//
// Saying "12 pages" for all of them is a small lie told on every chip, every
// row and every citation. This module is the single place that decides what a
// count may be called, so the model-facing citation and the user-facing chip
// cannot drift apart into two different answers about the same document.
//
// Zero value imports, like `extraction-status.ts`: this is reached from Svelte
// components, from `$lib/server` services and from route handlers alike.

/** Exactly the kinds MinerU 4.0.4 was observed to emit, plus our own fallback. */
export const PAGE_COUNT_KINDS = [
	"physical",
	"sheet",
	"slide",
	"spine",
	"declared",
	"logical",
	/** Ours, not MinerU's: `metadata.document` was `{}` (PNG/JPEG). */
	"unknown",
] as const;
export type PageCountKind = (typeof PAGE_COUNT_KINDS)[number];

const PAGE_COUNT_KIND_SET: ReadonlySet<string> = new Set(PAGE_COUNT_KINDS);

export function isPageCountKind(value: unknown): value is PageCountKind {
	return typeof value === "string" && PAGE_COUNT_KIND_SET.has(value);
}

/** The three things a count can honestly be a count OF. */
export const PAGE_COUNT_UNITS = ["page", "slide", "sheet"] as const;
export type PageCountUnit = (typeof PAGE_COUNT_UNITS)[number];

/**
 * The unit this kind counts in, or null when it counts nothing nameable.
 *
 * `spine` is EPUB's reading order, which is as close to a page as an EPUB
 * gets, so it is a page. `declared`, `logical` and `unknown` are the three that
 * have no honest unit: a number the producer asserted, a number derived from
 * nothing physical, and no number at all.
 */
export function pageCountUnit(
	kind: string | null | undefined,
): PageCountUnit | null {
	switch (kind?.trim().toLowerCase()) {
		case "physical":
		case "spine":
			return "page";
		case "slide":
			return "slide";
		case "sheet":
			return "sheet";
		default:
			return null;
	}
}

/**
 * The unit a count may be SHOWN in, or null when it must not be shown at all.
 *
 * Three refusals on top of `pageCountUnit`:
 *
 *  - a kind with no unit (`declared`, `logical`, `unknown`) — including every
 *    document parsed before `pageCountKind` existed, which is why an absent
 *    kind is a refusal rather than a guess at "physical";
 *  - a count that is not a positive integer;
 *  - a count of 1 in any unit but a physical page. "1 slide" is what a DOCX's
 *    `declared: 1` looks like after a mis-map, and "1 sheet" tells a reader
 *    nothing they did not know from the file's own name; a genuine one-page PDF
 *    is worth saying.
 */
export function displayablePageCountUnit(
	pageCount: number | null | undefined,
	kind: string | null | undefined,
): PageCountUnit | null {
	if (
		typeof pageCount !== "number" ||
		!Number.isInteger(pageCount) ||
		pageCount < 1
	) {
		return null;
	}
	const unit = pageCountUnit(kind);
	if (!unit) return null;
	if (pageCount === 1 && kind?.trim().toLowerCase() !== "physical") return null;
	return unit;
}
