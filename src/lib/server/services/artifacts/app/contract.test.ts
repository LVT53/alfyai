import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	APP_CONTRACT_PROMPT,
	APP_CONTRACT_RULES,
	APP_GLITCH_RULE_IDS,
	APP_MAX_OUTPUT_TOKENS,
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

	// The font is not a token (the frame has nothing to read `--font-sans` from,
	// so the contract spells the stack out), but its first face is the app's own,
	// and that is worth keeping true: if `--font-sans` changes face, the contract
	// must say so too.
	it("starts the font stack with the face --font-sans names", () => {
		const face = light
			.get("--font-sans")
			?.split(",")[0]
			?.trim()
			.replace(/^["']|["']$/g, "");
		expect(face).toBe("Nimbus Sans L");
		expect(APP_CONTRACT_PROMPT).toContain(
			`'${face}', Helvetica, Arial, sans-serif`,
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

	// The Apps are sans, headings included: the whole UI is, a page's own top
	// title apart. The stack is written out in full because the frame inherits
	// nothing, so a variable with no local definition would fall back silently.
	it("names one sans stack for every element and no serif, never --font-sans/--font-serif", () => {
		expect(APP_CONTRACT_PROMPT).toContain(
			"uses one sans-serif stack: 'Nimbus Sans L', Helvetica, Arial, sans-serif.",
		);
		expect(APP_CONTRACT_PROMPT).not.toMatch(
			/\b(?:georgia|times|baskerville|garamond)\b/i,
		);
		// The word "serif" stands alone once, in the prohibition, and is otherwise
		// the tail of "sans-serif": no stack in the prompt ends in the serif generic.
		const withoutSans = APP_CONTRACT_PROMPT.replaceAll("sans-serif", "");
		expect(withoutSans.match(/serif/gi)).toHaveLength(1);
		expect(withoutSans).toContain("No serif fonts");
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
	it("has twenty rules (the prototype's fifteen, ruling 58's four and ADR-0068's nested frames), each with a stable id and a severity", () => {
		expect(APP_CONTRACT_RULES).toHaveLength(20);
		const ids = new Set(APP_CONTRACT_RULES.map((rule) => rule.id));
		expect(ids.size).toBe(20);
		for (const rule of APP_CONTRACT_RULES) {
			expect(["glitch", "note", "violation"]).toContain(rule.severity);
		}
	});

	// The prototype's `georgia` note asked for Georgia in the headings. The Apps
	// went sans, so its place in the list (the eval harness reads the list in this
	// order) is `no-serif` now. It must stay a note: only glitch ids are stored
	// on an App (`glitchRuleIdsOf`), which is why the rename leaves nothing behind.
	it("has no-serif where the Georgia note was, still a note", () => {
		const ids: string[] = APP_CONTRACT_RULES.map((rule) => rule.id);
		expect(ids).not.toContain("georgia");
		expect(ids.indexOf("no-serif")).toBe(ids.indexOf("helvetica") - 1);
		expect(APP_CONTRACT_RULES.find((rule) => rule.id === "no-serif")).toEqual({
			id: "no-serif",
			label: "No serif fonts",
			severity: "note",
		});
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

	it("maps exactly the three violation-severity rules into APP_VIOLATION_RULE_IDS (ruling 58, ADR-0068)", () => {
		expect([...APP_VIOLATION_RULE_IDS].sort()).toEqual(
			["no-navigate", "no-nested-frames", "no-webrtc"].sort(),
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

	// ADR-0068: the generator is told what the browser will not let an app do,
	// so a retry is the exception.
	it("the contract prompt names every WebRTC and frame restriction of ADR-0068", () => {
		expect(APP_CONTRACT_PROMPT).toMatch(/RTCDataChannel/);
		expect(APP_CONTRACT_PROMPT).toMatch(/any other WebRTC API/);
		expect(APP_CONTRACT_PROMPT).toMatch(/<iframe>/);
		expect(APP_CONTRACT_PROMPT).toMatch(/srcdoc/);
		expect(APP_CONTRACT_PROMPT).toMatch(/XSLTProcessor/);
	});
});

describe("APP_MAX_OUTPUT_TOKENS", () => {
	it("is the prototype's ceiling, the feature's one owned value (its sampling is the family profile's, declared in provider-compatibility.ts)", () => {
		expect(APP_MAX_OUTPUT_TOKENS).toBe(24_000);
	});
});
