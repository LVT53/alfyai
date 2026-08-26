import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guard for Task 8 ("Retire leftover brand-gold menu tints").
//
// Header/sidebar menu hovers used to key off a hardcoded
// `rgba(194, 166, 106, …)` — the retired brand gold `#C2A66A` that ADR-0035
// explicitly names as a previous-brand color — instead of the terracotta
// `--accent` token used everywhere else. The paired danger hovers used a
// hardcoded `rgba(186, 77, 77, …)` instead of `--danger`. Both were replaced
// with `color-mix(in srgb, var(--accent|danger) <pct>, transparent)`.
//
// This asserts the gold/hardcoded-danger rgba() literals never creep back
// into the four touched components, and that each now sources its hover
// tint from the accent/danger tokens via color-mix.

const componentsDir = dirname(fileURLToPath(import.meta.url));

const TOUCHED_FILES = [
	"layout/Header.svelte",
	"sidebar/ProjectItem.svelte",
	"sidebar/ConversationItem.svelte",
	"ui/TypewriterText.svelte",
] as const;

function readComponent(relativePath: string): string {
	return readFileSync(join(componentsDir, relativePath), "utf-8");
}

describe("gold/hardcoded-danger rgba() literals are gone from menu-hover styles", () => {
	it.each(
		TOUCHED_FILES,
	)("%s contains no retired brand-gold rgba(194, 166, 106, …)", (relativePath) => {
		const source = readComponent(relativePath);

		expect(source).not.toContain("rgba(194, 166, 106");
		expect(source).not.toContain("194,166,106");
	});

	it.each(
		TOUCHED_FILES,
	)("%s contains no hardcoded danger rgba(186, 77, 77, …)", (relativePath) => {
		const source = readComponent(relativePath);

		expect(source).not.toContain("rgba(186, 77, 77");
		expect(source).not.toContain("186,77,77");
	});
});

describe("menu-hover backgrounds source their color from the accent/danger tokens", () => {
	it("Header.svelte: hover/accent/danger option backgrounds use color-mix(var(--accent|danger) …)", () => {
		const source = readComponent("layout/Header.svelte");

		expect(source).toContain(
			"background: color-mix(in srgb, var(--accent) 24%, transparent);",
		);
		expect(source).toContain(
			"background: color-mix(in srgb, var(--accent) 28%, transparent);",
		);
		expect(source).toContain(
			"background: color-mix(in srgb, var(--danger) 14%, transparent);",
		);
		expect(source).toContain(
			"background: color-mix(in srgb, var(--accent) 30%, transparent);",
		);
		expect(source).toContain(
			"background: color-mix(in srgb, var(--danger) 22%, transparent);",
		);
	});

	it("ProjectItem.svelte: option/danger hover backgrounds use color-mix(var(--accent|danger) …)", () => {
		const source = readComponent("sidebar/ProjectItem.svelte");

		expect(source).toContain(
			"background: color-mix(in srgb, var(--accent) 24%, transparent);",
		);
		expect(source).toContain(
			"background: color-mix(in srgb, var(--danger) 14%, transparent);",
		);
		expect(source).toContain(
			"background: color-mix(in srgb, var(--accent) 30%, transparent);",
		);
		expect(source).toContain(
			"background: color-mix(in srgb, var(--danger) 22%, transparent);",
		);
	});

	it("ConversationItem.svelte: hover/active/current/danger backgrounds use color-mix(var(--accent|danger) …), state rules keep !important", () => {
		const source = readComponent("sidebar/ConversationItem.svelte");

		expect(source).toContain(
			"background: color-mix(in srgb, var(--accent) 24%, transparent);",
		);
		expect(source).toContain(
			"background: color-mix(in srgb, var(--accent) 18%, transparent) !important;",
		);
		expect(source).toContain(
			"background: color-mix(in srgb, var(--accent) 15%, transparent) !important;",
		);
		expect(source).toContain(
			"background: color-mix(in srgb, var(--danger) 14%, transparent);",
		);
		expect(source).toContain(
			"background: color-mix(in srgb, var(--accent) 30%, transparent);",
		);
		expect(source).toContain(
			"background: color-mix(in srgb, var(--accent) 25%, transparent) !important;",
		);
		expect(source).toContain(
			"background: color-mix(in srgb, var(--danger) 22%, transparent);",
		);
	});

	it("TypewriterText.svelte: shimmer-in text-shadow glow uses color-mix(var(--accent) …)", () => {
		const source = readComponent("ui/TypewriterText.svelte");

		expect(source).toContain(
			"text-shadow: 0 0 8px color-mix(in srgb, var(--accent) 60%, transparent);",
		);
		expect(source).toContain(
			"text-shadow: 0 0 4px color-mix(in srgb, var(--accent) 30%, transparent);",
		);
	});
});

describe("sanctioned beige LogoMark color is untouched", () => {
	it("LogoMark.svelte still uses #C8A882 (not part of this task's scope)", () => {
		const logoMarkPath = join(componentsDir, "chat/LogoMark.svelte");
		const source = readFileSync(logoMarkPath, "utf-8");

		expect(source).toContain("#C8A882");
	});
});
