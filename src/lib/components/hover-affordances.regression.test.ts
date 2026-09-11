import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guard for the hover-affordance pass over the redesigned
// surfaces.
//
// Two defects were found on the new home page and then across the wave:
//
//   1. a hover background with NO border radius — a square fill painted over
//      a rounded row, so the highlight visibly overshoots the row's corners;
//   2. a hover state with NO transition — the fill and colour snap instead of
//      easing.
//
// The house rule: every hoverable row, card, chip, tile, list line, sort
// header, pager button, tab and menu row eases its hover fill and colour over
// `var(--duration-standard) var(--ease-out)`, and the fill carries the
// element's own radius. `prefers-reduced-motion` is handled globally in
// src/app.css (it zeroes `--duration-*` and forces `transition-duration` to
// 0.01ms), so rules here do NOT need their own reduced-motion branch.
//
// This is a static analysis of the components' <style> blocks plus the
// Tailwind utilities their markup puts on the same element. It is deliberately
// conservative: it only fails when nothing anywhere on the hovered element
// supplies the transition (or, for a background, the radius). The self-checks
// at the bottom pin that it still catches the two original defects.

const componentsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(componentsDir, "..", "..", "..");

/**
 * Surfaces redesigned in this wave. Everything under `knowledge/`, the
 * composer (MessageInput / ComposerToolsMenu / composer-bar) and the home
 * route are owned elsewhere and are deliberately absent.
 */
const SCOPE = [
	"src/routes/(app)/settings/_components",
	"src/lib/components/search",
	"src/lib/components/analytics",
	"src/lib/components/ui/DialogShell.svelte",
	"src/routes/login/+page.svelte",
];

function collect(relPath: string): string[] {
	const abs = join(repoRoot, relPath);
	if (statSync(abs).isFile()) return [relPath];
	const out: string[] = [];
	for (const entry of readdirSync(abs, { withFileTypes: true })) {
		const child = `${relPath}/${entry.name}`;
		if (entry.isDirectory()) {
			out.push(...collect(child));
		} else if (/\.(svelte|css)$/.test(entry.name)) {
			out.push(child);
		}
	}
	return out;
}

const FILES = SCOPE.flatMap(collect).sort();

// ---------------------------------------------------------------------------
// A small CSS reader: enough to pair `:hover` rules with the `transition` and
// `border-radius` declared on the same element.
// ---------------------------------------------------------------------------

type Rule = { selector: string; declText: string };

function extractStyle(source: string, path: string): string {
	if (path.endsWith(".css")) return source;
	const blocks: string[] = [];
	for (const m of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g))
		blocks.push(m[1]);
	return blocks.join("\n");
}

function parseRules(css: string, parent: string | null = null): Rule[] {
	const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const rules: Rule[] = [];
	let buf = "";
	let i = 0;
	while (i < src.length) {
		if (src[i] !== "{") {
			buf += src[i];
			i++;
			continue;
		}
		let depth = 1;
		let k = i + 1;
		while (k < src.length && depth > 0) {
			if (src[k] === "{") depth++;
			else if (src[k] === "}") depth--;
			k++;
		}
		const inner = src.slice(i + 1, k - 1);
		const prelude = buf.replace(/^[\s;]+/, "").trim();
		buf = "";
		i = k;
		if (prelude.startsWith("@")) {
			// Nested rules inside @media/@supports still style the same elements.
			if (/^@(media|supports|container|layer|scope)/.test(prelude))
				rules.push(...parseRules(inner, parent));
			continue;
		}
		if (!prelude) continue;
		const full = parent ? `${parent} ${prelude}` : prelude;
		rules.push({
			selector: full,
			declText: inner.replace(/[^{}]*\{[\s\S]*?\}/g, ""),
		});
		rules.push(...parseRules(inner, full));
	}
	return rules;
}

function declarations(declText: string): Record<string, string> {
	const out: Record<string, string> = {};
	let depth = 0;
	let buf = "";
	const parts: string[] = [];
	for (const ch of declText) {
		if (ch === "(") depth++;
		else if (ch === ")") depth--;
		if (ch === ";" && depth === 0) {
			parts.push(buf);
			buf = "";
			continue;
		}
		buf += ch;
	}
	if (buf.trim()) parts.push(buf);
	for (const part of parts) {
		const idx = part.indexOf(":");
		if (idx < 0) continue;
		const prop = part.slice(0, idx).trim().toLowerCase();
		if (!prop || prop.startsWith("@") || /[{}]/.test(prop)) continue;
		out[prop] = part.slice(idx + 1).trim();
	}
	return out;
}

function splitSelectorList(selector: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let buf = "";
	for (const ch of selector) {
		if (ch === "(" || ch === "[") depth++;
		else if (ch === ")" || ch === "]") depth--;
		if (ch === "," && depth === 0) {
			parts.push(buf.trim());
			buf = "";
			continue;
		}
		buf += ch;
	}
	if (buf.trim()) parts.push(buf.trim());
	return parts;
}

/** Split a complex selector into its compound parts. */
function compounds(selector: string): string[] {
	return selector
		.replace(/:global\(([\s\S]*?)\)/g, "$1")
		.replace(/\s*[>+~]\s*/g, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
}

/**
 * Reduce a compound to the identity of the element it targets. Pseudo-classes
 * (`:hover`, `:not(...)`, `:disabled`) and attribute filters select *states*
 * of that same element, so they must not hide a `transition` on the base rule.
 */
function normalizeCompound(compound: string): string {
	let s = compound;
	let prev: string;
	do {
		prev = s;
		s = s.replace(/::?[a-zA-Z-]+\([^()]*\)/g, "");
	} while (s !== prev);
	return s
		.replace(/::?[a-zA-Z-]+/g, "")
		.replace(/\[[^\]]*\]/g, "")
		.trim();
}

function identityParts(compound: string): Set<string> {
	return new Set(
		normalizeCompound(compound).match(/[.#]?[a-zA-Z0-9_-]+/g) ?? [],
	);
}

/**
 * True when two compounds can name the same element — identical identities,
 * a subset, or a BEM-ish variant of the same base (markup writes
 * `class="dialog-btn dialog-btn--positive"`, so the base rule applies).
 */
function sameElement(a: string, b: string): boolean {
	const A = identityParts(a);
	const B = identityParts(b);
	if (A.size === 0 || B.size === 0) return false;
	const [small, big] = A.size <= B.size ? [A, B] : [B, A];
	for (const p of small) {
		if (big.has(p)) continue;
		let related = false;
		for (const q of big) {
			if (q.startsWith(`${p}-`) || p.startsWith(`${q}-`)) {
				related = true;
				break;
			}
		}
		if (!related) return false;
	}
	return true;
}

function transitionCovers(value: string, prop: string): boolean {
	const v = value.toLowerCase();
	if (/\ball\b/.test(v)) return true;
	if (prop === "background") return /background(-color)?/.test(v);
	// `transition: border ...` expands to include border-color.
	if (prop === "border-color" && /\bborder\b/.test(v)) return true;
	return v.includes(prop);
}

/** Utility classes sharing an element with `className` in the markup. */
function markupCompanions(source: string, className: string): Set<string> {
	const tokens = new Set<string>();
	const attrRe = /class=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g;
	const mention = new RegExp(
		`(^|[^a-zA-Z0-9_-])${className}([^a-zA-Z0-9_-]|$)`,
	);
	for (const m of source.matchAll(attrRe)) {
		const text = m[1] ?? m[2] ?? m[3] ?? "";
		if (!mention.test(text)) continue;
		for (const tok of text.split(/[\s"'`{}(),]+/)) if (tok) tokens.add(tok);
	}
	return tokens;
}

const BG_PROPS = new Set([
	"background",
	"background-color",
	"background-image",
]);
const COLOR_PROPS = new Set([
	"color",
	"border-color",
	"border",
	"border-bottom-color",
	"border-top-color",
	"border-left-color",
	"border-right-color",
	"fill",
	"stroke",
]);

type Finding = {
	file: string;
	selector: string;
	setsBackground: boolean;
	changedColorProps: string[];
	hasBackgroundTransition: boolean;
	hasColorTransition: boolean;
	hasRadius: boolean;
};

function analyze(source: string, path: string): Finding[] {
	const rules = parseRules(extractStyle(source, path));

	const transitions: { comps: string[]; value: string }[] = [];
	const radii: { comps: string[] }[] = [];
	for (const rule of rules) {
		const d = declarations(rule.declText);
		const t = d.transition ?? d["transition-property"];
		const radiusKey = Object.keys(d).find((p) => /^border-.*radius$/.test(p));
		for (const sel of splitSelectorList(rule.selector)) {
			const comps = compounds(sel);
			if (!comps.length) continue;
			if (t) transitions.push({ comps, value: t });
			if (radiusKey) radii.push({ comps });
		}
	}

	const findings: Finding[] = [];
	for (const rule of rules) {
		if (!rule.selector.includes(":hover")) continue;
		const d = declarations(rule.declText);
		const setsBackground = Object.keys(d).some((p) => BG_PROPS.has(p));
		const changedColorProps = Object.keys(d).filter((p) => COLOR_PROPS.has(p));
		if (!setsBackground && !changedColorProps.length) continue;

		for (const sel of splitSelectorList(rule.selector)) {
			if (!sel.includes(":hover")) continue;
			const comps = compounds(sel);
			const target = comps[comps.length - 1];
			if (!target) continue;

			// A transition only animates the element whose property changes: a
			// `transition` on an ancestor (a <tr> when the fill is painted on
			// the <td>s) never reaches the child.
			const onTarget = (pred: (value: string) => boolean) =>
				transitions.some(
					(t) =>
						pred(t.value) && sameElement(t.comps[t.comps.length - 1], target),
				);

			const classes = (normalizeCompound(target).match(/\.[\w-]+/g) ?? []).map(
				(c) => c.slice(1),
			);
			const utilities = new Set<string>();
			for (const cls of classes)
				for (const tok of markupCompanions(source, cls)) utilities.add(tok);
			const twTransition = [...utilities].some((t) =>
				/^transition(-(all|colors|opacity|shadow|transform))?$/.test(t),
			);
			const twRadius = [...utilities].some((t) => /^rounded(-|$)/.test(t));

			findings.push({
				file: path,
				selector: sel,
				setsBackground,
				changedColorProps,
				hasBackgroundTransition:
					!setsBackground ||
					twTransition ||
					onTarget((v) => transitionCovers(v, "background")),
				hasColorTransition:
					!changedColorProps.length ||
					twTransition ||
					onTarget((v) =>
						changedColorProps.some((p) => transitionCovers(v, p)),
					),
				hasRadius:
					!setsBackground ||
					twRadius ||
					radii.some((r) => sameElement(r.comps[r.comps.length - 1], target)),
			});
		}
	}
	return findings;
}

// ---------------------------------------------------------------------------

const ALL: Finding[] = FILES.flatMap((file) =>
	analyze(readFileSync(join(repoRoot, file), "utf-8"), file),
);

function describeAll(findings: Finding[]): string {
	return findings.map((f) => `  ${f.file}  ${f.selector}`).join("\n");
}

describe("hover affordances across the redesigned surfaces", () => {
	it("audits a meaningful number of hover rules", () => {
		// Guards the scope walk itself: if a refactor moves these components,
		// the suite must not silently pass on an empty set.
		expect(FILES.length).toBeGreaterThan(40);
		expect(ALL.length).toBeGreaterThan(25);
	});

	it("every hover background eases in (defect 2: no transition)", () => {
		const offenders = ALL.filter((f) => !f.hasBackgroundTransition);
		expect(
			offenders.length,
			`These :hover rules set a background with no transition on the same element.\n${describeAll(
				offenders,
			)}\n\nAdd \`transition: background-color var(--duration-standard) var(--ease-out)\` to the element's base rule (or a Tailwind \`transition-colors duration-150\`).`,
		).toBe(0);
	});

	it("every hover colour change eases in (defect 2: no transition)", () => {
		const offenders = ALL.filter((f) => !f.hasColorTransition);
		expect(
			offenders.length,
			`These :hover rules change colour/border-colour with no transition on the same element.\n${describeAll(
				offenders,
			)}`,
		).toBe(0);
	});

	it("every hover background carries the element's radius (defect 1: square fill)", () => {
		const offenders = ALL.filter((f) => !f.hasRadius);
		expect(
			offenders.length,
			`These :hover rules paint a background on an element with no border-radius, so the fill is a square block over a rounded row.\n${describeAll(
				offenders,
			)}`,
		).toBe(0);
	});
});

// The analysis is only worth running if it still fails on the shapes that
// started this pass. These fixtures are the two original defects, plus the
// subtler one found while fixing them.
describe("the hover analysis catches the defects it was written for", () => {
	const at = (css: string) =>
		analyze(`<style>${css}</style>`, "fixture.svelte");

	it("flags a hover fill with no transition", () => {
		const [f] = at(
			`.row { border-radius: 5px; } .row:hover { background: red; }`,
		);
		expect(f.hasBackgroundTransition).toBe(false);
		expect(f.hasRadius).toBe(true);
	});

	it("flags a hover fill with no radius", () => {
		const [f] = at(
			`.row { transition: background 1ms; } .row:hover { background: red; }`,
		);
		expect(f.hasRadius).toBe(false);
		expect(f.hasBackgroundTransition).toBe(true);
	});

	it("flags a colour hover with no transition", () => {
		const [f] = at(`.head { cursor: pointer; } .head:hover { color: red; }`);
		expect(f.hasColorTransition).toBe(false);
	});

	it("does not accept a transition declared on an ancestor", () => {
		// The <tr> transition never animates the <td>'s background.
		const [f] = at(
			`.user-row { transition: background 1ms; } .user-row:hover td { background: red; }`,
		);
		expect(f.hasBackgroundTransition).toBe(false);
	});

	it("accepts a transition on the element itself, through :not()", () => {
		const [f] = at(
			`.btn { border-radius: 5px; transition: background 1ms; } .btn:hover:not(:disabled) { background: red; }`,
		);
		expect(f.hasBackgroundTransition).toBe(true);
		expect(f.hasRadius).toBe(true);
	});

	it("accepts radius and transition supplied by Tailwind utilities", () => {
		const findings = analyze(
			`<button class="shell rounded-lg transition-colors duration-150"></button><style>.shell:hover { background: red; }</style>`,
			"fixture.svelte",
		);
		expect(findings[0].hasRadius).toBe(true);
		expect(findings[0].hasBackgroundTransition).toBe(true);
	});
});
