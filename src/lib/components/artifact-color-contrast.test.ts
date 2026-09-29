import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Artifacts redesign §9.1 pulls four small-text/filled-button tokens out of
// the raw --accent/--warning/--success so they clear WCAG AA body text
// (4.5:1) — the raw --accent is only 4.0:1 on the page in light, and
// btn-primary was putting --accent text on a 12% accent tint at 3.5:1 before
// this redesign (see the separate commit that moves --accent to --accent-text
// there). §9.1 states the exact ratio each token was chosen for; this test
// does not trust the table, it recomputes each ratio from the literal values
// in app.css the same way `checkbox-tick-contrast.test.ts` already does for
// --accent, so a future edit to any of these six tokens fails loudly here
// instead of silently drifting back under 4.5:1.

const componentsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(componentsDir, "..", "..", "..");
const cssPath = join(repoRoot, "src", "app.css");
const css = readFileSync(cssPath, "utf8");

/** WCAG 1.4.3: minimum contrast for normal text. */
const MIN_RATIO = 4.5;

function srgbToLinear(channel: number): number {
	const c = channel / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) throw new Error(`Not a 6-digit hex colour: ${hex}`);
	const n = Number.parseInt(m[1], 16);
	const r = srgbToLinear((n >> 16) & 0xff);
	const g = srgbToLinear((n >> 8) & 0xff);
	const b = srgbToLinear(n & 0xff);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
	return (hi + 0.05) / (lo + 0.05);
}

function parseHex(hex: string): [number, number, number] {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) throw new Error(`Not a 6-digit hex colour: ${hex}`);
	const n = Number.parseInt(m[1], 16);
	return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function toHex([r, g, b]: [number, number, number]): string {
	return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * What `color-mix(in srgb, foreground percent%, transparent)` renders as
 * once painted over `surfaceHex` — btn-primary's actual background is this
 * composite, never a flat token-to-token pair, so testing --accent-text
 * against --surface-page alone (as the other cases in this file do) would
 * miss a regression in the tint percentage itself, exactly what motivated
 * this test (§9.1: the 18% hover tint measured under 4.5:1).
 */
function mixOverSurface(
	foregroundHex: string,
	percent: number,
	surfaceHex: string,
): string {
	const alpha = percent / 100;
	const fg = parseHex(foregroundHex);
	const bg = parseHex(surfaceHex);
	return toHex([
		alpha * fg[0] + (1 - alpha) * bg[0],
		alpha * fg[1] + (1 - alpha) * bg[1],
		alpha * fg[2] + (1 - alpha) * bg[2],
	]);
}

/**
 * Pull a theme block out of app.css, the same way as
 * `checkbox-tick-contrast.test.ts`: sliced from the selector to the first
 * line that closes the block at the same indentation, so the reduced-motion
 * media query's own `:root { ... }` override cannot be mistaken for the
 * light theme's.
 */
function themeBlock(selector: ":root" | ".dark"): string {
	const start = css.indexOf(`\n\t${selector} {`);
	expect(start, `${selector} block not found in app.css`).toBeGreaterThan(-1);
	const end = css.indexOf("\n\t}", start);
	expect(end, `${selector} block is unterminated`).toBeGreaterThan(start);
	return css.slice(start, end);
}

function tokenValue(selector: ":root" | ".dark", token: string): string {
	const m = new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(
		themeBlock(selector),
	);
	if (!m)
		throw new Error(`--${token} not found (as a 6-digit hex) in ${selector}`);
	return m[1];
}

describe("artifact redesign token contrast (§9.1)", () => {
	const themes = [":root", ".dark"] as const;
	const themeLabel = { ":root": "light", ".dark": "dark" } as const;

	for (const selector of themes) {
		const theme = themeLabel[selector];
		const surfacePage = tokenValue(selector, "surface-page");

		it(`${theme}: --accent-text clears ${MIN_RATIO}:1 on --surface-page`, () => {
			const accentText = tokenValue(selector, "accent-text");
			const ratio = contrastRatio(accentText, surfacePage);
			expect(
				ratio,
				`--accent-text ${accentText} on --surface-page ${surfacePage} in ${theme} is ${ratio.toFixed(2)}:1`,
			).toBeGreaterThanOrEqual(MIN_RATIO);
		});

		// Wave 2.5 review (F2): btn-primary's real background is a 12% --accent
		// tint composited over the page, in BOTH its resting and hover states
		// (app.css — the hover rule deliberately keeps the same 12% rather than
		// darkening to 18%, which measured 4.36:1 and prompted this test).
		// Recomputes the composite from the literal app.css values rather than
		// trusting the 12% figure, so a future edit to either the tint percent
		// or --accent-text fails loudly here instead of silently drifting
		// under 4.5:1 the way the 18% hover state once did.
		it(`${theme}: --accent-text clears ${MIN_RATIO}:1 on btn-primary's 12% accent tint (resting and hover)`, () => {
			const accent = tokenValue(selector, "accent");
			const accentText = tokenValue(selector, "accent-text");
			const tint = mixOverSurface(accent, 12, surfacePage);
			const ratio = contrastRatio(accentText, tint);
			expect(
				ratio,
				`--accent-text ${accentText} on the 12% --accent tint ${tint} (over --surface-page ${surfacePage}) in ${theme} is ${ratio.toFixed(2)}:1`,
			).toBeGreaterThanOrEqual(MIN_RATIO);
		});

		it(`${theme}: --on-accent clears ${MIN_RATIO}:1 on --accent-fill`, () => {
			const onAccent = tokenValue(selector, "on-accent");
			const accentFill = tokenValue(selector, "accent-fill");
			const ratio = contrastRatio(onAccent, accentFill);
			expect(
				ratio,
				`--on-accent ${onAccent} on --accent-fill ${accentFill} in ${theme} is ${ratio.toFixed(2)}:1`,
			).toBeGreaterThanOrEqual(MIN_RATIO);
		});

		it(`${theme}: --warning-text clears ${MIN_RATIO}:1 on --surface-page`, () => {
			const warningText = tokenValue(selector, "warning-text");
			const ratio = contrastRatio(warningText, surfacePage);
			expect(
				ratio,
				`--warning-text ${warningText} on --surface-page ${surfacePage} in ${theme} is ${ratio.toFixed(2)}:1`,
			).toBeGreaterThanOrEqual(MIN_RATIO);
		});

		it(`${theme}: --success-text clears ${MIN_RATIO}:1 on --surface-page`, () => {
			const successText = tokenValue(selector, "success-text");
			const ratio = contrastRatio(successText, surfacePage);
			expect(
				ratio,
				`--success-text ${successText} on --surface-page ${surfacePage} in ${theme} is ${ratio.toFixed(2)}:1`,
			).toBeGreaterThanOrEqual(MIN_RATIO);
		});
	}

	it("the raw --accent is still under 4.5:1 on the page in light — the reason --accent-text exists", () => {
		// Pins the defect this token was added to fix, for the record (§9.1:
		// "the raw accent is 4.0:1 in light"). If this ever climbs to 4.5:1 on
		// its own, --accent-text may no longer be pulling its weight, but that
		// is a design decision, not something this test should silently allow.
		const accent = tokenValue(":root", "accent");
		const surfacePage = tokenValue(":root", "surface-page");
		expect(contrastRatio(accent, surfacePage)).toBeLessThan(MIN_RATIO);
	});
});

// Feature 2, Slice 3 (Canvas): a note's text is --text-primary on every sticky
// fill, so each pair has to clear body-text contrast in both themes; a note
// must also stand off the board's page a little (a fill that vanishes into
// --surface-page is not a note); the four drawing inks are graphics, so 3:1
// (WCAG 1.4.11) against the page they are drawn on.
describe("Canvas token contrast (Slice 3)", () => {
	const themes = [":root", ".dark"] as const;
	const themeLabel = { ":root": "light", ".dark": "dark" } as const;
	const MIN_GRAPHIC_RATIO = 3;
	const MIN_NOTE_EDGE_RATIO = 1.05;

	for (const selector of themes) {
		const theme = themeLabel[selector];
		const surfacePage = tokenValue(selector, "surface-page");

		for (const tone of ["yellow", "mint", "blue", "plain"] as const) {
			it(`${theme}: --text-primary clears ${MIN_RATIO}:1 on --sticky-${tone}`, () => {
				const fill = tokenValue(selector, `sticky-${tone}`);
				const ink = tokenValue(selector, "text-primary");
				const ratio = contrastRatio(ink, fill);
				expect(
					ratio,
					`--text-primary ${ink} on --sticky-${tone} ${fill} in ${theme} is ${ratio.toFixed(2)}:1`,
				).toBeGreaterThanOrEqual(MIN_RATIO);
			});

			it(`${theme}: --sticky-${tone} stands off --surface-page`, () => {
				const fill = tokenValue(selector, `sticky-${tone}`);
				const ratio = contrastRatio(fill, surfacePage);
				expect(
					ratio,
					`--sticky-${tone} ${fill} against --surface-page ${surfacePage} in ${theme} is ${ratio.toFixed(2)}:1`,
				).toBeGreaterThanOrEqual(MIN_NOTE_EDGE_RATIO);
			});
		}

		for (const ink of ["blue", "red", "green", "graphite"] as const) {
			it(`${theme}: --ink-${ink} clears ${MIN_GRAPHIC_RATIO}:1 on --surface-page`, () => {
				const colour = tokenValue(selector, `ink-${ink}`);
				const ratio = contrastRatio(colour, surfacePage);
				expect(
					ratio,
					`--ink-${ink} ${colour} on --surface-page ${surfacePage} in ${theme} is ${ratio.toFixed(2)}:1`,
				).toBeGreaterThanOrEqual(MIN_GRAPHIC_RATIO);
			});
		}
	}
});
