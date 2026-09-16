// The chip grammar's closed kind enum and its tint mapping (chips redesign,
// owner-approved boards 2026-09-15: Main / ChipSystem / ComposerStates /
// InStream).
//
// One pill carries every chip in the product. What varies is the LEADING
// MARK (a 14px stroke icon, or an 18px thumbnail for an image) and — for the
// two kinds that change how the turn RUNS — a 7% tint. Nothing else: not the
// shape, not the radius, not an uppercase eyebrow.
//
// Tints, after the owner's amendment to the board: web search is rare now
// (only an explicit `/web` sets it), so it is material like everything else
// and carries NO tint. That leaves exactly two:
//
//   skill  -> --accent    (the turn runs someone's instructions)
//   atlas  -> --warning   (the slow, billable one)
//
// Attachments, images, quotes, linked Library documents and a queued message
// are neutral (--text-muted), because they are material, not behaviour.
//
// Pure data + pure functions on purpose (the `activity-presentation.ts`
// precedent): nothing Svelte-reactive, nothing that imports the `$t` store,
// so the mapping is unit-testable without mounting a component.

export const COMPOSER_CHIP_KINDS = [
	"skill",
	"web",
	"atlas",
	"file",
	"image",
	"quote",
	"library",
	"queued",
] as const;

export type ComposerChipKind = (typeof COMPOSER_CHIP_KINDS)[number];

/** The closed set of tints a chip can carry. "neutral" means no tint. */
export type ComposerChipTint = "accent" | "warning" | "neutral";

/**
 * The chip's tint. Exhaustive over `ComposerChipKind`; everything that is
 * material rather than behaviour falls through to neutral.
 */
export function composerChipTint(kind: ComposerChipKind): ComposerChipTint {
	if (kind === "skill") return "accent";
	if (kind === "atlas") return "warning";
	return "neutral";
}

/**
 * True when the chip's leading mark is a square thumbnail crop of the real
 * file rather than a stroke icon. Only an image attachment WITH a resolvable
 * source qualifies; an image whose thumbnail cannot be built falls back to
 * the stroke icon (see ComposerChip.svelte), which is why this takes the
 * source rather than only the kind.
 */
export function composerChipUsesThumbnail(
	kind: ComposerChipKind,
	thumbnailUrl: string | null | undefined,
): boolean {
	return kind === "image" && Boolean(thumbnailUrl);
}

/**
 * What a chip row tells the chips inside it (Svelte context, keyed by this
 * symbol so nothing else can collide with it). Today: where focus should go
 * when a chip removed from the keyboard leaves no neighbour to take it.
 */
export const COMPOSER_CHIP_ROW_CONTEXT = Symbol("composer-chip-row");

export type ComposerChipRowContext = {
	focusFallback: () => void;
};
