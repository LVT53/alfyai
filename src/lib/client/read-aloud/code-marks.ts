/**
 * Read aloud's marks on code (spec §4.2, §4.4: "the word mark covers a whole code
 * name while its words are said"). The overlay behind the prose (`ReadAloudMarks`)
 * cannot show through code: inline code and a code block paint an opaque background
 * above it. So ranges inside code are drawn with the CSS Custom Highlight API, which
 * paints above element backgrounds and below the text and changes no DOM. The colours
 * are `::highlight(read-aloud-code-*)` in `app.css`, the same tokens as the overlay.
 */

import type { ReadAloudView } from "$lib/stores/read-aloud";

export const CODE_MARK_NAMES = {
	sentence: "read-aloud-code-sentence",
	target: "read-aloud-code-target",
	word: "read-aloud-code-word",
} as const;

type HighlightLike = { priority: number };
export type CodeMarkEnv = {
	registry: {
		set(name: string, highlight: never): unknown;
		delete(name: string): unknown;
	};
	Highlight: new (...ranges: Range[]) => HighlightLike;
};

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
	};
}

function inCode(range: Range): boolean {
	const node = range.commonAncestorContainer;
	const element = node instanceof Element ? node : node.parentElement;
	// A link chip paints its own background too, above the overlay (early review R8).
	return element?.closest("code, pre, .source-link-chip") != null;
}

/** Draws the view's marks that fall inside code, and clears the rest. Called on every change of the view. */
export function paintCodeMarks(
	view: ReadAloudView,
	env: CodeMarkEnv | null = browserEnv(),
): void {
	if (!env) return;
	const marks = view.status === "idle" ? null : view.marks;
	const dragging = view.drag !== null;
	const sentence = marks && !dragging ? marks.sentence.filter(inCode) : [];
	const target = marks && dragging ? marks.target.filter(inCode) : [];
	const showWord =
		!dragging && view.status !== "stopped" && view.status !== "waiting";
	const word =
		marks?.word && showWord && inCode(marks.word) ? [marks.word] : [];
	const paint = (name: string, ranges: Range[], priority: number) => {
		if (ranges.length === 0) {
			env.registry.delete(name);
			return;
		}
		const highlight = new env.Highlight(...ranges);
		highlight.priority = priority;
		env.registry.set(name, highlight as never);
	};
	paint(CODE_MARK_NAMES.sentence, sentence, 0);
	paint(CODE_MARK_NAMES.target, target, 1);
	paint(CODE_MARK_NAMES.word, word, 2);
}
