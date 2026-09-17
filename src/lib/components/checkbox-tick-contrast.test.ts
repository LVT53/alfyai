import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The shared `.custom-checkbox` paints its tick as an inline SVG data URI, and
// a data: URI cannot read a CSS custom property — the stroke colour has to be
// written out as a literal. That makes it the one place in the app where a
// colour is not a token reference, and therefore the one place where a token
// can drift away from the colour that was chosen against it.
//
// The drift already happened once: `--accent` is #c15f3c in light but lightens
// to #d4836b in dark so it reads against the dark page, and the white tick
// that clears 4.2:1 on the light accent was left at 2.9:1 on the dark one —
// under the 3:1 WCAG 1.4.11 minimum for graphical objects (a tick IS the only
// thing distinguishing a checked box from an unchecked one).
//
// So this test does what the CSS cannot: it reads src/app.css, resolves
// `--accent` per theme and the stroke literal per theme from the actual rules,
// and recomputes the ratio. Change either side and this fails.

const componentsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(componentsDir, "..", "..", "..");
const cssPath = join(repoRoot, "src", "app.css");
const css = readFileSync(cssPath, "utf8");

/** WCAG 1.4.11: non-text contrast for graphical objects. */
const MIN_RATIO = 3;

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
 * Pull a custom property out of a theme block in app.css.
 *
 * The light theme declares its tokens in the `:root` block inside
 * `@layer base`; the dark theme re-declares them in `.dark`. Both are matched
 * by slicing from the selector to the first line that closes the block at the
 * same indentation, so a later `:root` (the reduced-motion override) cannot
 * be mistaken for the light theme's.
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

/**
 * Pull the `stroke='…'` literal out of a `.custom-checkbox` data-URI rule.
 * `%23` is the percent-encoded `#` a data: URI requires.
 */
function tickStroke(rule: string): string {
	const start = css.indexOf(`\n\t${rule} {`);
	expect(start, `rule ${rule} not found in app.css`).toBeGreaterThan(-1);
	const end = css.indexOf("\n\t}", start);
	const body = css.slice(start, end);
	const m = /stroke='%23([0-9a-fA-F]{6})'/.exec(body);
	if (!m) {
		throw new Error(
			`${rule} has no stroke='%23rrggbb' literal. The tick colour must stay a ` +
				`6-digit hex so this test can check it against --accent.`,
		);
	}
	return `#${m[1]}`;
}

describe("custom checkbox tick contrast", () => {
	const cases = [
		{
			theme: "light",
			accent: tokenValue(":root", "accent"),
			checked: tickStroke(".custom-checkbox:checked"),
			indeterminate: tickStroke(".custom-checkbox:indeterminate"),
		},
		{
			theme: "dark",
			accent: tokenValue(".dark", "accent"),
			checked: tickStroke(".dark .custom-checkbox:checked"),
			indeterminate: tickStroke(".dark .custom-checkbox:indeterminate"),
		},
	] as const;

	for (const { theme, accent, checked, indeterminate } of cases) {
		it(`${theme}: the tick clears ${MIN_RATIO}:1 against --accent`, () => {
			const ratio = contrastRatio(checked, accent);
			expect(
				ratio,
				`tick ${checked} on --accent ${accent} in ${theme} is ${ratio.toFixed(2)}:1`,
			).toBeGreaterThanOrEqual(MIN_RATIO);
		});

		it(`${theme}: the indeterminate dash clears ${MIN_RATIO}:1 against --accent`, () => {
			const ratio = contrastRatio(indeterminate, accent);
			expect(
				ratio,
				`dash ${indeterminate} on --accent ${accent} in ${theme} is ${ratio.toFixed(2)}:1`,
			).toBeGreaterThanOrEqual(MIN_RATIO);
		});
	}

	it("the light theme still paints a white tick on the light accent", () => {
		// Pins the "keep light pixel-identical" half of the fix: the dark
		// override must not have been written as a change to the shared rule.
		expect(tickStroke(".custom-checkbox:checked").toLowerCase()).toBe(
			"#ffffff",
		);
		expect(tickStroke(".custom-checkbox:indeterminate").toLowerCase()).toBe(
			"#ffffff",
		);
	});

	it("the ratio maths agrees with the documented values", () => {
		// Self-check: black-on-white is 21:1, and a colour against itself is 1:1.
		expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
		expect(contrastRatio("#d4836b", "#d4836b")).toBeCloseTo(1, 5);
		// And the two numbers quoted in app.css's comment.
		expect(contrastRatio("#ffffff", "#c15f3c")).toBeCloseTo(4.23, 1);
		expect(contrastRatio("#1a1a1a", "#d4836b")).toBeCloseTo(6.02, 1);
		// The defect this test exists to stop, for the record.
		expect(contrastRatio("#ffffff", "#d4836b")).toBeLessThan(MIN_RATIO);
	});
});
