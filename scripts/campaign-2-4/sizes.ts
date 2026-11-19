// The 2.4 campaign's pictures: their names and sizes, shared by the page that
// draws them (`mount.ts`) and the script that photographs them (`render.ts`).

export const VARIANTS = ["desktop", "mobile"] as const;
export type Variant = (typeof VARIANTS)[number];

/**
 * One picture per card, in card order. The deck's file names are
 * `slides/0<n>-<name>-<variant>.png`.
 */
export const PICTURE_NAMES = [
	"read-aloud",
	"voices",
	"asks-first",
	"videos",
	"new",
	"smaller",
] as const;
export type PictureName = (typeof PICTURE_NAMES)[number];

/** The size a picture is designed at, in design pixels (`DrawingFrame`). */
export const DESIGN_SIZE: Record<Variant, { width: number; height: number }> = {
	desktop: { width: 352, height: 220 },
	mobile: { width: 198, height: 352 },
};

/**
 * The width in CSS pixels a picture is drawn at. The page is photographed at
 * twice that, which gives the crops `create-release-campaign.ts` asks for:
 * 1600 by 1000 (16:10) and 1080 by 1920 (9:16).
 */
export const PICTURE_WIDTH: Record<Variant, number> = {
	desktop: 800,
	mobile: 540,
};

export function deckFileName(name: PictureName, variant: Variant): string {
	const index = PICTURE_NAMES.indexOf(name) + 1;
	return `slides/0${index}-${name}-${variant}.png`;
}
