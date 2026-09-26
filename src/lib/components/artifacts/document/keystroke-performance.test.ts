/**
 * T7.7's local recording (`slice-1.md` Task T7, Step 1.7; ruling 9's
 * principle: "structural in CI, measured locally for the figure" — Slice 3's
 * own Canvas figure is not this one, but the rule is the same one). At the
 * prototype's roughly 5,691-word document, 200 synthetic keystrokes should
 * average under ~2 ms each. This asserts only a generous sanity ceiling (a
 * CI runner must never fail this the way a real regression should) — the
 * real number is a RECORDING, printed below and quoted in the slice report,
 * never tightened to make a slow machine look good.
 *
 * The measured operation is `DocumentBody.svelte`'s exact hot path on every
 * keystroke (`handleUpdate` → `currentCanonicalMarkdown`): `readMarkdown(editor)`
 * (two throwaway transactions) then `parseDocument` + `serializeDocument` — the
 * full cost a real keystroke pays, not just ProseMirror's own insert.
 */
import { describe, expect, it } from "vitest";
import {
	parseDocument,
	serializeDocument,
} from "$lib/shared/artifact-document/blocks";
import { createDocumentEditor, readMarkdown } from "./document-editor";

/**
 * ~5,691 words across a realistic BLOCK count — long prose paragraphs
 * (dominant, like an actual trip write-up), not many tiny ones. Block COUNT,
 * not word count, is what `readMarkdown`'s per-keystroke marker
 * insert/delete pays for (one marker per top-level block, every call), so a
 * fixture with hundreds of one-line blocks for the same word count would
 * measure a different, much worse, and unrepresentative number.
 */
function buildLargeDocument(): string {
	const parts: string[] = ["# A very long trip plan\n"];
	let words = 6; // the heading above
	let section = 0;
	while (words < 5_691) {
		section += 1;
		parts.push(`## Day ${section}`);
		words += 2;
		const paragraphWords = 150;
		const sentence = Array.from(
			{ length: paragraphWords },
			(_, i) => `word${section}_${i}`,
		).join(" ");
		parts.push(sentence);
		words += paragraphWords;
	}
	parts.push("- [ ] Book the morning activity");
	parts.push("- [ ] Reserve dinner");
	parts.push("| Day | Activity |\n| --- | --- |\n| 1 | Museum |\n| 2 | Hike |");
	return parts.join("\n\n");
}

describe("Document editor keystroke performance (T7.7 recording)", () => {
	it("types 200 synthetic keystrokes into a ~5,691-word document", () => {
		const markdown = buildLargeDocument();
		const wordCount = markdown.split(/\s+/).filter(Boolean).length;

		const element = document.createElement("div");
		document.body.appendChild(element);
		const editor = createDocumentEditor({
			element,
			markdown,
			placeholder: "Write anything, or ask Alfy to.",
		});

		// A stable position inside the first real paragraph, not the heading.
		let targetPos: number | null = null;
		editor.state.doc.forEach((node, offset) => {
			if (targetPos !== null) return;
			if (node.type.name === "paragraph") targetPos = offset + 1;
		});
		expect(targetPos).not.toBeNull();

		const KEYSTROKES = 200;
		const start = performance.now();
		for (let i = 0; i < KEYSTROKES; i += 1) {
			editor.commands.insertContentAt((targetPos ?? 0) + i, "x");
			const raw = readMarkdown(editor);
			serializeDocument(parseDocument(raw).blocks);
		}
		const elapsedMs = performance.now() - start;
		const perKeystrokeMs = elapsedMs / KEYSTROKES;

		editor.destroy();
		element.remove();

		console.log(
			`[T7.7] ${wordCount}-word document, ${KEYSTROKES} keystrokes: ` +
				`${elapsedMs.toFixed(1)} ms total, ${perKeystrokeMs.toFixed(3)} ms/keystroke`,
		);

		// A generous sanity ceiling only — 25x the ~2ms target the prototype
		// measured, so a loaded CI runner never fails this the way a real
		// regression should. The real number goes in the slice report.
		expect(perKeystrokeMs).toBeLessThan(50);
	}, 30_000);
});
