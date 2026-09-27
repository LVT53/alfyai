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
