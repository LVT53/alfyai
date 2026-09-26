/**
 * The tracker chip's display layer (Feature 2 · Artifacts, Slice 1, T9):
 * canonical stored value → localized label, and the status dropdown's
 * options. Pure — no `@tiptap/*`, no Svelte — importable from the (Tiptap
 * `TrackerChip` node's) `renderHTML` in `extensions.ts` and from the toolbar's
 * status dropdown alike, so both draw the SAME label for the SAME token.
 *
 * Review Focus 8: "a stored `value="Booked"` is content and must not become
 * `value="Foglalt"`; only the label is translated." Every function here is a
 * pure `(kind, value, locale) -> label` mapping — nothing here ever writes
 * back into a document, and nothing here accepts a locale as anything but an
 * explicit parameter (no store subscription, no `$t` import), so this module
 * cannot itself localize stored content by accident.
 */
import artifactsDict from "$lib/i18n/artifacts";

export type ChipKind = "status" | "date";
export type ChipLocale = "en" | "hu";

/** The status kind's fixed vocabulary — canonical English tokens, in the order the dropdown offers them. */
export const STATUS_CHIP_VALUES = [
	"Booked",
	"To book",
	"Paid",
	"Cancelled",
] as const;
// Not exported: only this file's own label lookup names the status union today.
type StatusChipValue = (typeof STATUS_CHIP_VALUES)[number];

/** value → the i18n key suffix under `artifacts.document.chip.status.*` (the token itself is not a valid object-key-safe suffix — "To book" has a space). */
const STATUS_LABEL_SUFFIX: Record<StatusChipValue, string> = {
	Booked: "Booked",
	"To book": "ToBook",
	Paid: "Paid",
	Cancelled: "Cancelled",
};

/**
 * The values a chip of this kind may hold, for the status dropdown. `date`
 * has no fixed vocabulary (it is a free-form ISO date), so this returns `[]`
 * for it — the caller offers a date picker instead of a listbox.
 */
export function chipValues(kind: ChipKind): readonly string[] {
	return kind === "status" ? STATUS_CHIP_VALUES : [];
}

function localizedStatusLabel(value: string, locale: ChipLocale): string {
	const suffix = STATUS_LABEL_SUFFIX[value as StatusChipValue];
	if (!suffix) return value; // an unrecognised (e.g. hand-typed) value is shown verbatim, never a crash
	const dict = locale === "hu" ? artifactsDict.hu : artifactsDict.en;
	const key = `artifacts.document.chip.status.${suffix}` as keyof typeof dict;
	return (dict[key] as string | undefined) ?? value;
}

/** A stored ISO date (`YYYY-MM-DD`) formatted for display. An unparsable value is shown verbatim rather than as "Invalid Date". */
function localizedDateLabel(value: string, locale: ChipLocale): string {
	const parsed = new Date(`${value}T00:00:00`);
	if (Number.isNaN(parsed.getTime())) return value;
	return new Intl.DateTimeFormat(locale === "hu" ? "hu-HU" : "en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
	}).format(parsed);
}

/**
 * The one place a chip's canonical stored `value` becomes a display label.
 * `locale` defaults to `"en"` so a caller outside Svelte's reactive tree
 * (the Tiptap node's `renderHTML`, which reads the current UI language via
 * `get(uiLanguage)` rather than importing this module's caller context) still
 * gets a sane result if it is ever called without one.
 */
export function chipLabel(
	kind: ChipKind,
	value: string,
	locale: ChipLocale = "en",
): string {
	return kind === "date"
		? localizedDateLabel(value, locale)
		: localizedStatusLabel(value, locale);
}
