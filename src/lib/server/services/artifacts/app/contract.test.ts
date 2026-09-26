import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	APP_CONTRACT_PROMPT,
	APP_CONTRACT_RULES,
	APP_GLITCH_RULE_IDS,
	APP_MAX_OUTPUT_TOKENS,
	APP_SAMPLING_DEFAULTS,
	APP_TOKENS,
	APP_VIOLATION_RULE_IDS,
} from "./contract";

const APP_CSS_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../../../app.css",
);

/**
 * Extracts `--name: value;` declarations from the first CSS block whose
 * selector matches `selectorPattern` (a brace-depth-aware slice, not a
 * regex across the whole file — `:root` also appears later in the file for
 * an unrelated `prefers-reduced-motion` override, and a naive match would
 * risk picking that block up instead).
 */
function declarationsInFirstBlock(
	css: string,
	selectorPattern: RegExp,
): Map<string, string> {
	const selectorMatch = selectorPattern.exec(css);
	if (!selectorMatch) {
		throw new Error(`selector ${selectorPattern} not found in app.css`);
	}
	const openBraceIndex = css.indexOf("{", selectorMatch.index);
	let depth = 0;
	let index = openBraceIndex;
	for (; index < css.length; index += 1) {
		if (css[index] === "{") depth += 1;
		else if (css[index] === "}") {
			depth -= 1;
			if (depth === 0) break;
		}
	}
	const block = css.slice(openBraceIndex + 1, index);
	const declarations = new Map<string, string>();
	for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
		declarations.set(match[1], match[2].trim());
	}
	return declarations;
}

describe("APP_TOKENS vs src/app.css", () => {
	const css = readFileSync(APP_CSS_PATH, "utf8");
	// The real light palette lives on the file's first `:root { ... }` block
	// (inside `@layer base`). The dark palette is NOT behind a
	// `@media (prefers-color-scheme: dark)` block in this file — see the long
	// comment in contract.ts — it lives on the `.dark` class the app's own
	// theme store toggles at runtime. That mechanism cannot reach inside the
	// App's opaque-origin iframe, which is exactly why the CONTRACT still asks
	// the model for a `prefers-color-scheme` media query; this test only
	// changes where the "real" dark values are sourced FROM for comparison.
	const light = declarationsInFirstBlock(css, /:root\s*\{/);
	const dark = declarationsInFirstBlock(css, /\.dark\s*\{/);

	it.each(
		APP_TOKENS,
	)("$name matches src/app.css in both light and dark", (token) => {
		expect(light.get(token.name)).toBe(token.light);
		expect(dark.get(token.name)).toBe(token.dark);
	});

	it("covers exactly the six tokens the contract promises", () => {
		expect(APP_TOKENS.map((token) => token.name).sort()).toEqual(
			[
				"--accent",
				"--border-default",
				"--surface-elevated",
				"--surface-page",
				"--text-muted",
				"--text-primary",
			].sort(),
		);
	});
});

describe("APP_CONTRACT_PROMPT", () => {
	it("is a single string with no history/artifact/user-name placeholders", () => {
		expect(typeof APP_CONTRACT_PROMPT).toBe("string");
		expect(APP_CONTRACT_PROMPT).not.toMatch(/\{\{|\$\{(?!.*`)/);
	});

	it("declares the real token names, never the prototype's shorthand", () => {
		for (const token of APP_TOKENS) {
			expect(APP_CONTRACT_PROMPT).toContain(token.name);
		}
		for (const shorthand of ["--pg", "--el", "--tx", "--mu", "--bd", "--ac"]) {
			// A boundary-aware check: "--ac" is a true PREFIX of the real
			// "--accent" token, so a plain substring match would fail on the
			// correct contract. Only a shorthand token NOT followed by another
			// token-name character counts as the prototype's shorthand leaking in.
			expect(APP_CONTRACT_PROMPT).not.toMatch(
				new RegExp(`${shorthand}(?![a-z-])`),
			);
		}
	});

	it("carries a prefers-color-scheme: dark block", () => {
		expect(APP_CONTRACT_PROMPT).toMatch(/prefers-color-scheme:\s*dark/);
	});

	it("keeps the Helvetica/Georgia font stacks rather than --font-sans/--font-serif", () => {
		expect(APP_CONTRACT_PROMPT).toContain("Helvetica");
		expect(APP_CONTRACT_PROMPT).toContain("Georgia");
		expect(APP_CONTRACT_PROMPT).not.toContain("--font-sans");
		expect(APP_CONTRACT_PROMPT).not.toContain("--font-serif");
	});

	it("keeps the window.alfy.storage.get/set contract verbatim", () => {
		expect(APP_CONTRACT_PROMPT).toContain("window.alfy.storage.get");
		expect(APP_CONTRACT_PROMPT).toContain("window.alfy.storage.set");
		expect(APP_CONTRACT_PROMPT).toContain(
			"if (window.alfy && window.alfy.storage)",
		);
	});

	it("says exactly one html fence and nothing outside it", () => {
		expect(APP_CONTRACT_PROMPT).toMatch(/exactly ONE fenced code block/);
		expect(APP_CONTRACT_PROMPT).toMatch(/Write nothing outside the fence/);
	});
});

describe("APP_CONTRACT_RULES", () => {
	it("has nineteen rules (the prototype's fifteen plus ruling 58's four), each with a stable id and a severity", () => {
		expect(APP_CONTRACT_RULES).toHaveLength(19);
		const ids = new Set(APP_CONTRACT_RULES.map((rule) => rule.id));
		expect(ids.size).toBe(19);
		for (const rule of APP_CONTRACT_RULES) {
			expect(["glitch", "note", "violation"]).toContain(rule.severity);
		}
	});

	it("maps exactly the seven glitch-severity rules into APP_GLITCH_RULE_IDS", () => {
		expect([...APP_GLITCH_RULE_IDS].sort()).toEqual(
			[
				"no-script-src",
				"no-link-href",
				"no-remote-img",
				"no-network-api",
				"no-web-storage",
				"no-dialogs",
				"no-eval",
			].sort(),
		);
	});

	it("maps exactly the two violation-severity rules into APP_VIOLATION_RULE_IDS (ruling 58)", () => {
		expect([...APP_VIOLATION_RULE_IDS].sort()).toEqual(
			["no-navigate", "no-webrtc"].sort(),
		);
	});

	it("the contract prompt names every ruling-58 restriction", () => {
		expect(APP_CONTRACT_PROMPT).toMatch(/preventDefault/);
		expect(APP_CONTRACT_PROMPT).toMatch(/alert, confirm or prompt/);
		expect(APP_CONTRACT_PROMPT).toMatch(/eval or new Function/);
		expect(APP_CONTRACT_PROMPT).toMatch(/location/);
		expect(APP_CONTRACT_PROMPT).toMatch(/window\.open/);
		expect(APP_CONTRACT_PROMPT).toMatch(/RTCPeerConnection/);
	});
});

describe("APP_SAMPLING_DEFAULTS / APP_MAX_OUTPUT_TOKENS", () => {
	it("matches the qwen family's measured defaults and the prototype's ceiling", () => {
		expect(APP_SAMPLING_DEFAULTS).toEqual({
			temperature: 0.6,
			topP: 0.95,
			topK: 20,
			maxOutputTokens: 24_000,
		});
		expect(APP_MAX_OUTPUT_TOKENS).toBe(APP_SAMPLING_DEFAULTS.maxOutputTokens);
	});
});
