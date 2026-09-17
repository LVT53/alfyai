import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The install manifest and the two theme-color metas are the only places the
// app's page-ground colour is written as a literal outside src/app.css — a
// JSON file and an HTML attribute cannot read a custom property. That makes
// them the places most likely to be forgotten when the palette moves, and
// the manifest had already drifted: it said #ffffff while the light page had
// been #fafaf8 for a long time, and a single unconditional white meta gave
// every dark-mode install a white status bar over a #1a1a1a page.
//
// So these assertions pull --surface-page out of app.css and compare.

const libDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(libDir, "..", "..");
const css = readFileSync(join(repoRoot, "src", "app.css"), "utf8");
const html = readFileSync(join(repoRoot, "src", "app.html"), "utf8");
const manifest = JSON.parse(
	readFileSync(join(repoRoot, "static", "site.webmanifest"), "utf8"),
) as Record<string, unknown>;

/** `--surface-page` from the light (`:root`) or dark (`.dark`) theme block. */
function pageGround(selector: ":root" | ".dark"): string {
	const start = css.indexOf(`\n\t${selector} {`);
	expect(start, `${selector} block not found in app.css`).toBeGreaterThan(-1);
	const block = css.slice(start, css.indexOf("\n\t}", start));
	const m = /--surface-page:\s*(#[0-9a-fA-F]{6})\s*;/.exec(block);
	if (!m) throw new Error(`--surface-page not found in ${selector}`);
	return m[1].toLowerCase();
}

function themeColorMeta(scheme: "light" | "dark"): string {
	const m = new RegExp(
		`<meta\\s+name="theme-color"\\s+media="\\(prefers-color-scheme:\\s*${scheme}\\)"\\s+content="(#[0-9a-fA-F]{6})"`,
	).exec(html);
	if (!m) {
		throw new Error(
			`app.html has no theme-color meta for prefers-color-scheme: ${scheme}. ` +
				`Without both, an installed app gets one colour for both themes.`,
		);
	}
	return m[1].toLowerCase();
}

describe("PWA install metadata", () => {
	it("declares the fields an installable manifest needs", () => {
		// Without start_url/scope a browser guesses from the manifest's own
		// location; without id, a later change to start_url is treated as a
		// DIFFERENT app and installs a second copy.
		expect(manifest.id).toBe("/");
		expect(manifest.start_url).toBe("/");
		expect(manifest.scope).toBe("/");
		expect(manifest.display).toBe("standalone");
		expect(manifest.name).toBe("AlfyAI");
		expect(manifest.short_name).toBe("AlfyAI");
	});

	it("paints the install chrome in the light page ground", () => {
		// The splash and install path have no media query to work with, so
		// both take the light value.
		const light = pageGround(":root");
		expect(manifest.theme_color).toBe(light);
		expect(manifest.background_color).toBe(light);
	});

	it("gives each colour scheme its own theme-color", () => {
		expect(themeColorMeta("light")).toBe(pageGround(":root"));
		expect(themeColorMeta("dark")).toBe(pageGround(".dark"));
		expect(themeColorMeta("light")).not.toBe(themeColorMeta("dark"));
	});

	it("has no unconditional theme-color left to win over the pair", () => {
		// A bare `<meta name="theme-color" content="…">` with no media
		// attribute applies to every scheme; whichever the browser picks
		// first, one of the two above stops mattering.
		const all = [...html.matchAll(/<meta\s+name="theme-color"[^>]*>/g)].map(
			(m) => m[0],
		);
		expect(all).toHaveLength(2);
		for (const tag of all) {
			expect(tag).toContain("prefers-color-scheme");
		}
	});

	it("only claims icons that exist, and claims no maskable one", () => {
		// Every square icon in static/ draws out to ~47% of its width over
		// transparent corners, so none survives a circular maskable crop.
		// Declaring `purpose: "maskable"` on one anyway is worse than having
		// none: the platform would stop applying its own safe letterboxing.
		const icons = manifest.icons as Array<Record<string, string>>;
		expect(icons.length).toBeGreaterThan(0);
		for (const icon of icons) {
			expect(icon.purpose ?? "any").toBe("any");
			expect(() =>
				readFileSync(join(repoRoot, "static", icon.src.replace(/^\//, ""))),
			).not.toThrow();
		}
	});
});
