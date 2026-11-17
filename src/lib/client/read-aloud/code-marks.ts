/**
 * Read aloud's marks on code (spec §4.2, §4.4: "the word mark covers a whole code
 * name while its words are said"). The overlay behind the prose (`ReadAloudMarks`)
 * cannot show through code: inline code, a link chip and a code block paint an opaque
 * background above it. So marks inside them are drawn here, in two ways that change
 * no text and move nothing:
 *
 * - **Inline code and link chips** are tinted whole by an attribute on the element
 *   (`CODE_MARK_ATTRIBUTE`), drawn as an inset shadow: it covers the pill's padding,
 *   follows its rounded corners, and eases out at the end like the prose's marks. (A
 *   highlight tints only the glyphs, and WebKit drew its word mark taller than the pill.)
 * - **Code blocks** are drawn with the CSS Custom Highlight API, which paints above
 *   element backgrounds and below the text: one range per run of a sentence on a line,
 *   so the spaces between its words are tinted too, and not the next line's indentation.
 *   They fade at the end through a page-wide strength the highlights' colours use.
 *
 * The colours are rules this module adds to the page (`ensureCodeMarkStyle`), with the
 * same tokens as the overlay.
 */

import type { ReadAloudView } from "$lib/stores/read-aloud";
import { MOTION_DURATION, prefersReducedMotion } from "$lib/utils/motion";

export const CODE_MARK_NAMES = {
	sentence: "read-aloud-code-sentence",
	target: "read-aloud-code-target",
	word: "read-aloud-code-word",
} as const;

type MarkPart = keyof typeof CODE_MARK_NAMES;

/** The attribute that tints inline code or a link chip: a part's name, or `fading` at the end. */
export const CODE_MARK_ATTRIBUTE = "data-read-aloud-code-mark";
/** On the page's root while the code blocks' highlights fade out. */
export const CODE_MARK_FADING_CLASS = "read-aloud-code-fading";

type HighlightLike = { priority: number };
export type CodeMarkEnv = {
	registry: {
		set(name: string, highlight: never): unknown;
		delete(name: string): unknown;
		has?(name: string): boolean;
	};
	Highlight: new (...ranges: Range[]) => HighlightLike;
	/** Adds the marks' colours to the page (`ensureCodeMarkStyle`); absent in tests. */
	style?: () => void;
};

const PARTS = Object.keys(CODE_MARK_NAMES) as MarkPart[];

/**
 * The marks' colours, added to the page once. They are not in `app.css`: the build's CSS
 * minifier (esbuild) does not know the `::highlight()` pseudo-element or `@property` and
 * warned on each rule, and the build must print no warning (AGENTS.md). The CSP allows
 * inline styles.
 */
export function ensureCodeMarkStyle(doc: Document): void {
	if (doc.head.querySelector("style[data-read-aloud-code-marks]")) return;
	const style = doc.createElement("style");
	style.dataset.readAloudCodeMarks = "";
	const strength = "--read-aloud-code-strength";
	style.textContent = [
		// A number, so it can ease from 1 to 0 while the blocks' highlights fade.
		`@property ${strength} { syntax: "<number>"; inherits: true; initial-value: 1; }`,
		`:root.${CODE_MARK_FADING_CLASS} { ${strength}: 0; transition: ${strength} var(--duration-standard) var(--ease-out); }`,
		...PARTS.map(
			(part) =>
				`::highlight(${CODE_MARK_NAMES[part]}) { background-color: color-mix(in srgb, var(--read-aloud-${part}) calc(var(${strength}, 1) * 100%), transparent); }`,
		),
		...PARTS.map(
			(part) =>
				`.markdown-container [${CODE_MARK_ATTRIBUTE}="${part}"] { box-shadow: inset 0 0 0 100vmax var(--read-aloud-${part}); }`,
		),
		`.markdown-container [${CODE_MARK_ATTRIBUTE}="fading"] { box-shadow: inset 0 0 0 100vmax transparent; transition: box-shadow var(--duration-standard) var(--ease-out); }`,
	].join("\n");
	doc.head.append(style);
}

/** The browser's highlight registry, or null where there is none (SSR, older browsers, tests). */
function browserEnv(): CodeMarkEnv | null {
	if (
		typeof CSS === "undefined" ||
		!("highlights" in CSS) ||
		typeof Highlight === "undefined"
	)
		return null;
	return {
		registry: CSS.highlights as unknown as CodeMarkEnv["registry"],
		Highlight,
		style: () => ensureCodeMarkStyle(document),
	};
}

type CodePlace =
	| { kind: "block"; pre: Element }
	| { kind: "element"; element: Element };

/** Where a range sits: in a code block, in inline code or a link chip, or in neither (null). */
function placeOf(range: Range): CodePlace | null {
	const node = range.commonAncestorContainer;
	const element = node instanceof Element ? node : node.parentElement;
	if (!element) return null;
	const pre = element.closest("pre");
	if (pre) return { kind: "block", pre };
	// A link chip paints its own background too, above the overlay (early review R8).
	const pill = element.closest(".source-link-chip, code");
	return pill ? { kind: "element", element: pill } : null;
}

/** True when nothing but spaces on one line lies between the end of `run` and the start of `next`. */
function sameLine(run: Range, next: Range): boolean {
	const gap = (run.startContainer.ownerDocument ?? document).createRange();
	gap.setStart(run.endContainer, run.endOffset);
	gap.setEnd(next.startContainer, next.startOffset);
	return !gap.toString().includes("\n");
}

/** A block's ranges as one range per run on a line, in one block. */
function runsOf(ranges: Range[]): Range[] {
	const runs: Range[] = [];
	let run: Range | null = null;
	let runBlock: Element | null = null;
	for (const range of ranges) {
		const place = placeOf(range);
		if (place?.kind !== "block") continue;
		if (run && runBlock === place.pre && sameLine(run, range)) {
			run.setEnd(range.endContainer, range.endOffset);
			continue;
		}
		run = range.cloneRange();
		runBlock = place.pre;
		runs.push(run);
	}
	return runs;
}

/** The inline code and link chips a part's ranges fall in. */
function pillsOf(ranges: Range[]): Element[] {
	const pills = new Set<Element>();
	for (const range of ranges) {
		const place = placeOf(range);
		if (place?.kind === "element") pills.add(place.element);
	}
	return [...pills];
}

/** The pills tinted now, and what each shows. */
let tinted = new Map<Element, MarkPart>();
/** The blocks' highlights drawn now. */
const drawn = new Set<string>();
let fadeTimer: ReturnType<typeof setTimeout> | null = null;
let fading: { pills: Element[]; env: CodeMarkEnv } | null = null;

function root(): HTMLElement | null {
	return typeof document === "undefined" ? null : document.documentElement;
}

/** Ends a fade at once: its pills lose their mark, its highlights go, unless drawn again since. */
function endFade() {
	if (fadeTimer) clearTimeout(fadeTimer);
	fadeTimer = null;
	const ended = fading;
	fading = null;
	root()?.classList.remove(CODE_MARK_FADING_CLASS);
	if (!ended) return;
	for (const pill of ended.pills)
		if (pill.getAttribute(CODE_MARK_ATTRIBUTE) === "fading")
			pill.removeAttribute(CODE_MARK_ATTRIBUTE);
	for (const name of [...drawn]) {
		ended.env.registry.delete(name);
		drawn.delete(name);
	}
}

/** Draws the view's marks that fall inside code, and clears the rest. Called on every change of the view. */
export function paintCodeMarks(
	view: ReadAloudView,
	env: CodeMarkEnv | null = browserEnv(),
): void {
	if (!env) return;
	env.style?.();
	const marks = view.status === "idle" ? null : view.marks;
	const dragging = view.drag !== null;
	const showWord =
		!dragging && view.status !== "stopped" && view.status !== "waiting";
	const parts: Record<MarkPart, Range[]> = {
		sentence: marks && !dragging ? marks.sentence : [],
		target: marks && dragging ? marks.target : [],
		word: marks?.word && showWord ? [marks.word] : [],
	};

	const blocks = {
		sentence: runsOf(parts.sentence),
		target: runsOf(parts.target),
		word: runsOf(parts.word),
	};
	const pills = new Map<Element, MarkPart>();
	// The word over the target over the sentence, as the highlights' priorities say.
	for (const part of ["sentence", "target", "word"] as const)
		for (const pill of pillsOf(parts[part])) pills.set(pill, part);

	const anything =
		pills.size > 0 || PARTS.some((part) => blocks[part].length > 0);
	if (!anything) {
		if (fading) return;
		const leaving = [...tinted.keys()];
		if (leaving.length === 0 && drawn.size === 0) return;
		tinted = new Map();
		for (const pill of leaving)
			pill.setAttribute(CODE_MARK_ATTRIBUTE, "fading");
		fading = { pills: leaving, env };
		if (prefersReducedMotion()) {
			endFade();
			return;
		}
		root()?.classList.add(CODE_MARK_FADING_CLASS);
		fadeTimer = setTimeout(endFade, MOTION_DURATION.standard);
		return;
	}

	// Something to draw: a fade still running ends now, and only what is no longer drawn goes.
	if (fading) {
		const ended = fading;
		fading = null;
		if (fadeTimer) clearTimeout(fadeTimer);
		fadeTimer = null;
		root()?.classList.remove(CODE_MARK_FADING_CLASS);
		for (const pill of ended.pills)
			if (
				!pills.has(pill) &&
				pill.getAttribute(CODE_MARK_ATTRIBUTE) === "fading"
			)
				pill.removeAttribute(CODE_MARK_ATTRIBUTE);
	}
	for (const [pill] of tinted)
		if (!pills.has(pill)) pill.removeAttribute(CODE_MARK_ATTRIBUTE);
	for (const [pill, part] of pills)
		if (pill.getAttribute(CODE_MARK_ATTRIBUTE) !== part)
			pill.setAttribute(CODE_MARK_ATTRIBUTE, part);
	tinted = pills;

	const priority: Record<MarkPart, number> = {
		sentence: 0,
		target: 1,
		word: 2,
	};
	for (const part of PARTS) {
		const name = CODE_MARK_NAMES[part];
		const ranges = blocks[part];
		if (ranges.length === 0) {
			env.registry.delete(name);
			drawn.delete(name);
			continue;
		}
		const highlight = new env.Highlight(...ranges);
		highlight.priority = priority[part];
		env.registry.set(name, highlight as never);
		drawn.add(name);
	}
}
