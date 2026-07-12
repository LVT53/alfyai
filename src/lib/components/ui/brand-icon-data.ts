// Vendored brand glyph path data for BrandIcon.svelte.
//
// Sourced from the `simple-icons` npm package (devDependency only — see
// package.json; NOT a runtime dependency). Each entry's `path` is copied
// verbatim from that package's icons/<slug>.svg at the version pinned in
// package.json (simple-icons ^16.25.0), and rendered monochrome via
// `fill="currentColor"` by BrandIcon.svelte — we intentionally drop Simple
// Icons' brand hex colors here (see BrandIcon.svelte's module doc for why).
// Simple Icons' SVGs are CC0-licensed; the brand marks themselves remain
// their respective trademark owners' property. Using them to label
// "connect to X" UI rows is standard practice.
//
// To refresh a glyph: bump the simple-icons devDependency, then copy the
// new `d` attribute from node_modules/simple-icons/icons/<slug>.svg, then
// re-run the optical-size normalization below (see `viewBox`/`bbox` doc).

/**
 * Optical-size normalization (R3-fix #2).
 *
 * Every Simple Icons glyph nominally ships a "0 0 24 24" viewBox, but the
 * PATH GEOMETRY inside that box varies a lot — Google's "G" nearly fills
 * the full 24x24 square, while Nextcloud's wordmark-free logo is a short,
 * wide band only ~11 units tall. Rendering both with the same literal
 * "0 0 24 24" viewBox at the same `size` prop makes Nextcloud/Plex read as
 * visibly smaller than Google/Immich, even though the <svg> box itself is
 * identical.
 *
 * Fix: each glyph below gets its OWN square `viewBox`, sized and centered
 * so the glyph's bounding box occupies the same fraction (`OPTICAL_TARGET_
 * FRACTION`) of that square, regardless of how much of the raw 24x24
 * source box the artwork actually used. Since BrandIcon.svelte always
 * renders `width={size} height={size}` with this viewBox, the visible
 * glyph ends up the same optical size across all providers at a given
 * `size` — this is a pure viewBox change, no path data is altered.
 *
 * The exact numbers (`bbox`, `viewBox`) are precomputed offline from each
 * path's real geometry (a headless-browser `getBBox()` pass — bbox math
 * isn't available in SSR/jsdom, so this can't be computed at runtime) using
 * the glyph's bounding-box "optical size" = sqrt(bbox.width * bbox.height)
 * (the side of the equal-area square — a better perceived-size proxy than
 * either raw dimension alone, since it doesn't get fooled by a glyph that's
 * wide-but-short like Nextcloud/Plex). `bbox` is kept alongside `viewBox`
 * as provenance and so BrandIcon.test.ts can assert the normalization
 * invariant (every provider's occupied fraction is the same) without
 * needing DOM bbox APIs itself.
 *
 * CLIPPING FIX (R3-fix2 #1): the geometric-mean optical size above is a good
 * *perceived*-size proxy, but for very oblong glyphs (Nextcloud and Plex are
 * both a short, wide band — width 24, height ~11) it can size the square
 * viewBox smaller than the glyph's LONGEST raw dimension. A square viewBox
 * centered on the bbox center only fully contains the bbox when
 * `side >= max(bbox.width, bbox.height)`; Nextcloud/Plex's optical-size side
 * (~20.2/20.5) was well under their 24-wide bbox, so ~1.9 units were cropped
 * off each side. Every `viewBox` below is therefore sized as
 * `max(opticalSide, containSide)`, where `containSide =
 * max(bbox.width, bbox.height) / MIN_CONTAINMENT_FRACTION` guarantees the
 * full path fits with a small margin regardless of aspect ratio. For
 * near-square glyphs (Google, Gmail, Immich, Apple) `opticalSide` already
 * exceeds `containSide`, so their viewBox is unchanged from R3-fix; only
 * Nextcloud and Plex actually grow.
 */
export const OPTICAL_TARGET_FRACTION = 0.8;

/**
 * The glyph's longest raw dimension (`max(bbox.width, bbox.height)`) may
 * occupy at most this fraction of the final square viewBox side — the
 * containment floor described above. Guarantees a small margin (~this
 * fraction's complement) so the full path never touches, let alone clips,
 * the rendered box edge, independent of the optical-size fraction.
 */
export const MIN_CONTAINMENT_FRACTION = 0.95;

export type BrandGlyph = {
	/** Optical-size-normalized square viewBox (see module doc above). */
	viewBox: string;
	/** The `d` attribute of the icon's single <path>, verbatim from Simple Icons. */
	path: string;
	/**
	 * The path's real bounding box in its own (pre-normalization) "0 0 24 24"
	 * coordinate space, used to derive `viewBox` above. Provenance only —
	 * BrandIcon.svelte never reads this at runtime.
	 */
	bbox: { x: number; y: number; width: number; height: number };
};

export type BrandIconProvider =
	| "google"
	| "gmail"
	| "nextcloud"
	| "immich"
	| "apple"
	| "plex"
	| "github";

// Source: simple-icons siGoogle
const GOOGLE: BrandGlyph = {
	viewBox: "-2.8069 -2.8069 29.6138 29.6138",
	bbox: { x: 0.307, y: 0, width: 23.386, height: 24 },
	path: "M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z",
};

// Source: simple-icons siGmail
const GMAIL: BrandGlyph = {
	viewBox: "-0.9924 -0.9921 25.9848 25.9848",
	bbox: { x: 0, y: 2.9975, width: 24, height: 18.0055 },
	path: "M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z",
};

// Source: simple-icons siNextcloud
// Containment-floor-sized (R3-fix2 #1) — see module doc above: this glyph's
// 24-wide, 10.9-tall bbox is so oblong that the optical-size (geometric
// mean) formula alone under-sized the box and clipped ~1.9 units off each
// side. viewBox side = max(w,h) / MIN_CONTAINMENT_FRACTION = 24 / 0.95.
const NEXTCLOUD: BrandGlyph = {
	viewBox: "-0.6316 -0.6316 25.2632 25.2632",
	bbox: { x: 0, y: 6.537, width: 24, height: 10.926 },
	path: "M12.018 6.537c-2.5 0-4.6 1.712-5.241 4.015-.56-1.232-1.793-2.105-3.225-2.105A3.569 3.569 0 0 0 0 12a3.569 3.569 0 0 0 3.552 3.553c1.432 0 2.664-.874 3.224-2.106.641 2.304 2.742 4.016 5.242 4.016 2.487 0 4.576-1.693 5.231-3.977.569 1.21 1.783 2.067 3.198 2.067A3.568 3.568 0 0 0 24 12a3.569 3.569 0 0 0-3.553-3.553c-1.416 0-2.63.858-3.199 2.067-.654-2.284-2.743-3.978-5.23-3.977zm0 2.085c1.878 0 3.378 1.5 3.378 3.378 0 1.878-1.5 3.378-3.378 3.378A3.362 3.362 0 0 1 8.641 12c0-1.878 1.5-3.378 3.377-3.378zm-8.466 1.91c.822 0 1.467.645 1.467 1.468s-.644 1.467-1.467 1.468A1.452 1.452 0 0 1 2.085 12c0-.823.644-1.467 1.467-1.467zm16.895 0c.823 0 1.468.645 1.468 1.468s-.645 1.468-1.468 1.468A1.452 1.452 0 0 1 18.98 12c0-.823.644-1.467 1.467-1.467z",
};

// Source: simple-icons siImmich
const IMMICH: BrandGlyph = {
	viewBox: "-2.8304 -2.8309 29.6609 29.6609",
	bbox: { x: 0, y: 0.2694, width: 24.0002, height: 23.4603 },
	path: "M11.9863.2695c-2.409 0-5.207 1.091-5.207 3.8946v.1523c1.3428.597 2.9347 1.6629 4.4121 2.9707 1.5713 1.3912 2.8374 2.8821 3.6524 4.2871 1.3997-2.5034 2.3358-5.4784 2.3476-7.373V4.164c0-2.8035-2.796-3.8946-5.205-3.8946m7.5117 4.4903c-.3778-.0081-.7747.0502-1.1914.1855-.0366.0118-.086.0278-.1445.0469-.1525 1.4611-.6756 3.304-1.4629 5.1133-.8373 1.9243-1.8627 3.5898-2.9472 4.7988 2.8132.558 5.9307.5273 7.7363-.0469.0126-.004.0246-.0065.0351-.0097 2.6665-.8666 2.84-3.8636 2.0957-6.1543-.6279-1.9332-2.081-3.89-4.121-3.9336m-14.996.039C2.4618 4.8424 1.0088 6.7973.3809 8.7305c-.7442 2.291-.5708 5.288 2.0957 6.1543l.1445.0468c.982-1.0926 2.4873-2.2761 4.1875-3.2773 1.8088-1.0646 3.619-1.808 5.207-2.1484-1.9483-2.1049-4.4884-3.9132-6.287-4.5098l-.0352-.0117c-.4167-.1354-.8136-.1936-1.1914-.1856m4.6718 6.7578c-2.6038 1.2025-5.1088 3.0598-6.2324 4.586l-.0215.0293c-1.6478 2.2683-.0272 4.7953 1.9219 6.211 1.9487 1.4159 4.8518 2.1765 6.5-.0919.0228-.0309.0536-.071.0898-.121-.7356-1.2717-1.396-3.0718-1.8222-4.9981-.4534-2.0492-.6023-4-.4356-5.6153m1.0723 3.338c.3387 2.8478 1.3315 5.8037 2.4355 7.3437l.0215.0293c1.6478 2.2683 4.551 1.5078 6.5.0918 1.9487-1.416 3.5697-3.943 1.9219-6.211-.0228-.0309-.0517-.073-.0879-.123-1.4367.3066-3.3522.3794-5.3164.1894-2.089-.2017-3.9895-.6623-5.4746-1.3203",
};

// Source: simple-icons siApple
const APPLE: BrandGlyph = {
	viewBox: "-1.5382 -1.5381 27.0764 27.0764",
	bbox: { x: 2.225, y: 0, width: 19.55, height: 24.0002 },
	path: "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701",
};

// Source: simple-icons siPlex
// Containment-floor-sized (R3-fix2 #1) — same oblong-bbox clipping as
// Nextcloud above; viewBox side = max(w,h) / MIN_CONTAINMENT_FRACTION = 24 / 0.95.
const PLEX: BrandGlyph = {
	viewBox: "-0.6316 -0.6315 25.2632 25.2632",
	bbox: { x: 0, y: 6.409, width: 24, height: 11.1821 },
	path: "M3.987 8.409c-.96 0-1.587.28-2.12.933v-.72H0v8.88s.038.018.127.037c.138.03.821.187 1.331-.249.441-.377.542-.814.542-1.318v-1.283c.533.573 1.147.813 2 .813 1.84 0 3.253-1.493 3.253-3.48 0-2.12-1.36-3.613-3.266-3.613Zm16.748 5.595.406.591c.391.614.894.906 1.492.908.621-.012 1.064-.562 1.226-.755 0 0-.307-.27-.686-.72-.517-.614-1.214-1.755-1.24-1.803l-1.198 1.779Zm-3.205-1.955c0-2.08-1.52-3.64-3.52-3.64s-3.467 1.587-3.467 3.573a3.48 3.48 0 0 0 3.507 3.52c1.413 0 2.626-.84 3.253-2.293h-2.04l-.093.093c-.427.4-.72.533-1.227.533-.787 0-1.373-.506-1.453-1.266h4.986c.04-.214.054-.307.054-.52Zm-7.671-.219c0 .769.11 1.701.868 2.722l.056.069c-.306.526-.742.88-1.248.88-.399 0-.814-.211-1.138-.579a2.177 2.177 0 0 1-.538-1.441V6.409H9.86l-.001 5.421Zm9.283 3.46h-2.39l2.247-3.332-2.247-3.335h2.39l2.248 3.335-2.248 3.332Zm1.593-1.286Zm-17.162-.342c-.933 0-1.68-.773-1.68-1.72s.76-1.666 1.68-1.666c.92 0 1.68.733 1.68 1.68 0 .946-.733 1.706-1.68 1.706Zm18.361-1.974L24 8.622h-2.391l-.87 1.293 1.195 1.773Zm-9.404-.466c.16-.706.72-1.133 1.493-1.133.773 0 1.373.467 1.507 1.133h-3Z",
};

// Source: simple-icons siGithub
const GITHUB: BrandGlyph = {
	viewBox: "-2.8131 -2.8133 29.6263 29.6263",
	bbox: { x: 0, y: 0.297, width: 24, height: 23.4057 },
	path: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
};

export const BRAND_GLYPHS: Record<BrandIconProvider, BrandGlyph> = {
	google: GOOGLE,
	gmail: GMAIL,
	nextcloud: NEXTCLOUD,
	immich: IMMICH,
	apple: APPLE,
	plex: PLEX,
	github: GITHUB,
};

export function isBrandIconProvider(
	provider: string,
): provider is BrandIconProvider {
	return provider in BRAND_GLYPHS;
}
